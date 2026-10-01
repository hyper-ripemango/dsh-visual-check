/**
 * dsh-visual-check / capture —— Node 与 Win32 抓屏驱动之间的桥。
 *
 * 驱动是一个 PowerShell 脚本 + 一份 C# 源码（`grab/`）。这里只负责：
 * 传参（走环境变量，避免任何引号问题）、收 stdout、按行协议解析、超时兜底。
 *
 * 不 import 任何 DSH 包，便于离线测试。
 *
 * @module dsh-visual-check/capture
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseDriverOutput } from './core.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 驱动与 C# 源码所在目录。 */
export const GRAB_DIR = join(here, 'grab')

/** 抓屏能力所需的固定文件。 */
export const CS_PATH = join(GRAB_DIR, 'VisualGrab.cs')
export const DRIVER_PATH = join(GRAB_DIR, 'driver.ps1')

/** 默认调用超时：抓屏本身约 0.3–1s，留足编译与等待置顶的余量。 */
const DEFAULT_TIMEOUT_MS = 60000

/**
 * 跑一次驱动。
 *
 * 参数全部经环境变量传递：路径里可能带空格、中文、引号，argv 拼接容易出事。
 *
 * @param {Record<string, string|number|boolean|undefined>} params - VG_* 参数（不带前缀）
 * @param {{cacheDir?: string, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<ReturnType<typeof parseDriverOutput>>}
 */
export async function runDriver(params, options = {}) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    env[`VG_${key.toUpperCase()}`] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  }
  env.VG_CS = CS_PATH
  if (options.cacheDir !== undefined && options.cacheDir !== null && String(options.cacheDir).length > 0) {
    env.VG_CACHE = String(options.cacheDir)
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdout = await spawnCollect(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVER_PATH],
    { env, timeoutMs, signal: options.signal },
  )

  const parsed = parseDriverOutput(stdout)
  if (!parsed.ok) {
    const detail = parsed.error ?? '驱动未报告成功'
    throw new Error(`抓屏驱动失败：${detail}`)
  }
  return parsed
}

/**
 * 起子进程并收集 stdout。
 *
 * `windowsHide: true` 是硬要求：否则会闪出控制台窗口，而那个窗口**会被自己
 * 的截图拍到**（这是"截图里多了一个黑框"这类怪问题的来源）。
 */
function spawnCollect(command, args, { env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish(reject, new Error(`抓屏驱动超时（${timeoutMs}ms）`))
    }, timeoutMs)

    const onAbort = () => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish(reject, new Error('抓屏被取消'))
    }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener?.('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => finish(reject, new Error(`无法启动 PowerShell：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, out)
      else {
        const parsed = parseDriverOutput(out)
        const detail = parsed.error ?? err.trim().split(/\r?\n/).slice(0, 3).join(' ') ?? ''
        finish(reject, new Error(`抓屏驱动退出码 ${code}${detail.length > 0 ? `：${detail}` : ''}`))
      }
    })
  })
}

// ---------------------------------------------------------------- 便捷封装

/** 枚举可见顶层窗口。 */
export async function listWindows(options) {
  const parsed = await runDriver({ mode: 'list', out: '', handle: '' }, options)
  return parsed.windows
}

/** 抓整块虚拟屏幕。 */
export async function captureScreen(outPath, options) {
  const parsed = await runDriver({ mode: 'screen', out: outPath, maxpixels: options?.maxPixels ?? 0 }, options)
  return { capture: parsed.capture, fields: parsed.fields }
}

/** 抓指定矩形区域。 */
export async function captureRegion(outPath, region, options) {
  const parsed = await runDriver(
    { mode: 'region', out: outPath, x: region.x, y: region.y, w: region.w, h: region.h, maxpixels: options?.maxPixels ?? 0 },
    options,
  )
  return { capture: parsed.capture, fields: parsed.fields }
}

/** 抓一个窗口；`raise` 为真时先置顶、抓完恢复原前台焦点。 */
export async function captureWindow(outPath, handle, options) {
  const parsed = await runDriver(
    {
      mode: 'window',
      out: outPath,
      handle,
      raise: options?.raise === true,
      // 最小化窗口的矩形在屏幕外，直接抓只会得到空白。默认先恢复、抓完再放回最小化。
      restoreminimized: options?.restoreMinimized !== false,
      maxpixels: options?.maxPixels ?? 0,
    },
    options,
  )
  return { capture: parsed.capture, fields: parsed.fields }
}

/** 查询窗口是否仍然存在、是否最小化、是否在前台。 */
export async function windowState(handle, options) {
  const parsed = await runDriver({ mode: 'state', handle, out: '' }, options)
  return {
    exists: parsed.fields.exists === '1',
    minimized: parsed.fields.minimized === '1',
    foreground: parsed.fields.foreground === '1',
    w: Number(parsed.fields.w ?? 0),
    h: Number(parsed.fields.h ?? 0),
  }
}

/**
 * 启动一个程序，并等待匹配的窗口出现。
 *
 * Windows **没有"打开某个窗口"这种操作**——窗口是进程创建的，进程没跑就没有窗口。
 * 所以"把没打开的窗口打开"只能是**启动对应的程序**，再等它的窗口出现。
 * 启动命令必须由调用方给出（配置里的启动器，或工具参数 `launch`）；
 * 这里只负责跑起来并按标题/进程名轮询等待。
 *
 * @returns {{window: object|null, waitedMs: number}} 超时未出现时 window 为 null
 */
export async function launchAndWait(command, { match = '', timeoutMs = 20000, pollMs = 500, options } = {}) {
  const child = spawn('cmd.exe', ['/c', command], { windowsHide: true, stdio: 'ignore', detached: true })
  child.unref()

  const started = Date.now()
  const needle = String(match).trim().toLowerCase()
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const windows = await listWindows(options)
    if (windows.length === 0) continue
    if (needle.length === 0) return { window: windows[0], waitedMs: Date.now() - started }
    for (const win of windows) {
      if (win.title.toLowerCase().includes(needle) || win.process.toLowerCase().includes(needle)) {
        return { window: win, waitedMs: Date.now() - started }
      }
    }
  }
  return { window: null, waitedMs: Date.now() - started }
}

/** 采样窗口的可见程度，返回 `"9/9"` 这样的字符串。 */
export async function sampleCoverage(handle, options) {
  const parsed = await runDriver({ mode: 'coverage', handle, out: '' }, options)
  return parsed.fields.coverage ?? '0/0'
}

/** 把某个窗口切到前台（也能用来把 DSH 自己切回来）。 */
export async function activateWindow(handle, options) {
  const parsed = await runDriver({ mode: 'activate', handle, out: '' }, options)
  return { log: parsed.fields.activateLog ?? '', foreground: Number(parsed.fields.foreground ?? 0) }
}

/** 最小化一个窗口（测试与还原用）。 */
export async function minimizeWindow(handle, options) {
  const parsed = await runDriver({ mode: 'minimize', handle, out: '' }, options)
  return parsed.fields.minimized === '1'
}

/** 当前前台窗口句柄。 */
export async function foregroundHandle(options) {
  const parsed = await runDriver({ mode: 'foreground', out: '', handle: '' }, options)
  return Number(parsed.fields.handle ?? 0)
}

/** 虚拟屏幕几何。 */
export async function screenGeometry(options) {
  const parsed = await runDriver({ mode: 'geometry', out: '', handle: '' }, options)
  const raw = String(parsed.fields.screen ?? '')
  const match = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(raw)
  if (match === null) return null
  return { w: Number(match[1]), h: Number(match[2]), x: Number(match[3]), y: Number(match[4]) }
}
