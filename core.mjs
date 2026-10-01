/**
 * dsh-visual-check / core —— 纯逻辑，故意不 import 任何 DSH 包。
 *
 * 这里只放可离线测试的东西：驱动输出解析、命名、窗口匹配、信封文本。
 * 任何需要 DSH 服务（tools / attachments / llm / userQuestions）的逻辑都在 main.mjs。
 *
 * @module dsh-visual-check/core
 */

/** 默认不做事前缩放：附件服务（6400 万像素）与模型侧都会处理，客户端缩放只会白白丢细节。 */
export const DEFAULT_MAX_PIXELS = 0

/** 单张图送进模型前的像素上限参考值（用于可选的省 token 档）。 */
export const FRUGAL_MAX_PIXELS = 1990000

// ------------------------------------------------------------------ 无损 JSON

/**
 * 递归剥掉 `undefined`。
 *
 * **这不是洁癖**：harness 拒绝任何"不是无损 JSON"的工具结果，而一个值为
 * `undefined` 的属性正好就是——它会让整次调用以
 * `value is not lossless JSON` 失败，哪怕截图已经成功落盘。
 * 工具结果由一堆可选片段拼成，所以交出前必须过这一层。
 *
 * `null` 要保留：它表示"明确没有"，与"没这个字段"语义不同。
 */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== undefined).map((entry) => stripUndefined(entry))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = stripUndefined(entry)
  }
  return out
}

// -------------------------------------------------------------- 驱动输出解析

/** 把 `k=v;k=v` 解析成对象，数值自动转 number。 */
export function parsePairs(text) {
  const out = {}
  for (const chunk of String(text ?? '').split(';')) {
    const at = chunk.indexOf('=')
    if (at <= 0) continue
    const key = chunk.slice(0, at).trim()
    const raw = chunk.slice(at + 1).trim()
    out[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw
  }
  return out
}

/**
 * 解析驱动的行协议。
 *
 * 协议刻意不用 JSON：PowerShell 5.1 的 `ConvertTo-Json` 在单元素数组、
 * 转义和编码上都有坑，而行协议在两边都难写错。
 *
 * @param {string} text - 驱动 stdout
 * @returns {{ok: boolean, error: string|null, fields: object, capture: object, windows: object[]}}
 */
export function parseDriverOutput(text) {
  const out = { ok: false, error: null, fields: {}, capture: {}, windows: [] }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.length === 0) continue

    if (line.startsWith('window\t')) {
      const parts = line.split('\t')
      if (parts.length < 12) continue
      out.windows.push({
        handle: Number(parts[1]),
        pid: Number(parts[2]),
        process: parts[3],
        x: Number(parts[4]),
        y: Number(parts[5]),
        w: Number(parts[6]),
        h: Number(parts[7]),
        foreground: parts[8] === '1',
        minimized: parts[9] === '1',
        overlay: parts[10] === '1',
        title: parts.slice(11).join('\t'),
      })
      continue
    }

    const at = line.indexOf('=')
    if (at <= 0) continue
    out.fields[line.slice(0, at)] = line.slice(at + 1)
  }
  out.ok = out.fields.ok === '1'
  if (typeof out.fields.error === 'string' && out.fields.error.length > 0) out.error = out.fields.error
  if (typeof out.fields.capture === 'string') out.capture = parsePairs(out.fields.capture)
  return out
}

// ------------------------------------------------------------------ 命名

/** 目录名安全化：去非法字符、抗 Windows 保留名、限长。 */
export function safeName(text, fallback = 'capture') {
  let name = String(text ?? '').trim()
  if (name.length === 0) return fallback
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/\.+$/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`
  name = name.slice(0, 48)
  return name.length === 0 ? fallback : name
}

/** v01 形式的版本号。 */
export function versionTag(n) {
  return `v${String(Math.max(1, Math.floor(n))).padStart(2, '0')}`
}

/** 从已存在的文件名里推出下一个版本号。 */
export function nextVersion(existingNames) {
  let max = 0
  for (const name of existingNames ?? []) {
    const match = /^v(\d+)\.png$/i.exec(String(name))
    if (match === null) continue
    max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/** 取当天日期戳。 */
export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

// ------------------------------------------------------------------ 窗口

/**
 * 按关键字匹配窗口。支持 hwnd 数字、进程名、标题（均不区分大小写，子串匹配）。
 * 前台窗口与完全可见的窗口优先——它们最可能是用户想指的那个。
 */
export function matchWindows(windows, query) {
  const text = String(query ?? '').trim()
  if (text.length === 0) return []
  const list = windows ?? []
  if (/^\d+$/.test(text)) {
    const handle = Number(text)
    const byHandle = list.filter((win) => win.handle === handle)
    // 纯数字也可能只是标题片段（`localhost:5173`）。句柄没命中就退化为文本匹配，
    // 否则"用标题里的端口号指定窗口"会永远匹配不到。
    if (byHandle.length > 0) return byHandle
  }
  const needle = text.toLowerCase()
  const hits = list.filter(
    (win) => win.process.toLowerCase().includes(needle) || win.title.toLowerCase().includes(needle),
  )
  return hits.sort((a, b) => scoreWindow(b) - scoreWindow(a))
}

/** 候选窗口的可用性打分：前台加分、覆盖层与全屏减分。 */
export function scoreWindow(win) {
  let score = 0
  if (win.foreground) score += 4
  if (win.overlay) score -= 6
  if (win.minimized) score -= 3
  if (win.w >= 200 && win.h >= 200) score += 2
  if (win.w >= 1200 && win.h >= 800) score += 1
  return score
}

/** 这个窗口是否适合作为截图目标，不适合时给出原因。 */
export function windowCaveats(win, screen) {
  const notes = []
  if (win.overlay) notes.push('分层/穿透覆盖层：遮挡采样对它无意义，抓到的是它下方的屏幕内容')
  if (win.minimized) notes.push('已最小化：截图前会自动恢复，抓完再放回最小化')
  if (screen !== undefined && win.w >= screen.w * 0.95 && win.h >= screen.h * 0.95) notes.push('几乎全屏：内容等同于整个屏幕')
  return notes
}

// ------------------------------------------------------------------ 信封

/** 人类可读的窗口一行描述。 */
export function describeWindow(win) {
  const flags = [win.foreground ? '前台' : null, win.overlay ? '覆盖层' : null, win.minimized ? '最小化' : null]
    .filter((x) => x !== null)
    .join('/')
  return `hwnd=${win.handle} ${win.process} ${win.w}x${win.h} @${win.x},${win.y}${flags.length > 0 ? ` [${flags}]` : ''} 「${win.title}」`
}

/**
 * 生成与图片同行的文本信封。
 *
 * 照抄 `read_image` 的约定：当落盘图与送模型的图尺寸不同时，必须告诉模型
 * 换算比例，否则它给出的坐标无法映射回原图。
 *
 * @param {object} info - 采集结果
 * @returns {string} 信封文本
 */
export function buildEnvelope(info) {
  const lines = []
  lines.push(`<path>${info.path}</path>`)
  lines.push(`<type>image</type>`)
  lines.push(`<source>${info.source}${info.target !== undefined && info.target !== null ? ` — ${info.target}` : ''}</source>`)
  lines.push('<content>')

  const parts = [`${info.srcW}x${info.srcH} 采集`, `送到模型的版本 ${info.width}x${info.height}`, `${formatBytes(info.bytes)}`]
  lines.push(parts.join('，'))

  if (info.width !== info.srcW || info.height !== info.srcH) {
    const rx = (info.srcW / info.width).toFixed(2)
    const ry = (info.srcH / info.height).toFixed(2)
    const advice = rx === ry
      ? `把图中坐标乘以 ${rx}`
      : `把 x 坐标乘以 ${rx}、y 坐标乘以 ${ry}`
    lines.push(`（已从原图缩小；需要定位原图细节时，${advice}）`)
  }

  if (info.raised === true) {
    lines.push(
      info.restored === false
        ? '为避开遮挡，抓取前已把目标窗口临时置顶——但**焦点未能恢复**，请留意当前前台窗口。'
        : '为避开遮挡，抓取前已把目标窗口临时置顶，抓完已恢复原前台焦点。',
    )
  }
  if (info.unminimized === true) {
    lines.push(
      info.reminimized === true
        ? '目标窗口原本是最小化的，已临时恢复后抓取，抓完已放回最小化。'
        : '目标窗口原本是最小化的，已临时恢复后抓取；未能自动放回最小化，请留意桌面状态。',
    )
  }
  if (info.launched === true) {
    const waited = Number(info.launchWaitedMs)
    lines.push(
      `目标程序原本没在运行，已执行启动命令把它打开${Number.isFinite(waited) ? `（等待 ${waited}ms 后窗口出现）` : ''}。`,
    )
  }
  // 两个采样值必须分清：置顶前必然是 0/9（否则根本不会置顶），
  // 把它和一张成功的截图并排写出来，读起来像"这张图是遮挡状态的"。
  if (info.coverageAfterRaise !== undefined) {
    lines.push(`置顶后可见采样：${info.coverageAfterRaise}（置顶前为 ${info.coverage ?? '未知'}，正是置顶的原因）。`)
  } else if (info.coverage !== undefined) {
    lines.push(`抓取瞬间的可见采样：${info.coverage}（9 个采样点中属于该窗口的数量）。`)
  }

  const notes = []
  if (info.blank === true) notes.push('画面几乎单色，可能是空白/黑屏页面，或该区域没有内容。')
  if (info.caveats !== undefined) notes.push(...info.caveats)
  if (notes.length > 0) lines.push(`注意：${notes.join(' ')}`)

  if (info.console !== undefined && info.console.length > 0) {
    lines.push(`控制台报错 ${info.console.length} 条：${info.console.slice(0, 3).join(' | ')}`)
  }

  lines.push(`全分辨率原图：${info.path}（图片若在后续轮次被系统降级为占位符，可用它重新投递）`)
  lines.push('</content>')
  return lines.join('\n')
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 可选的省 token 档位换算。 */
export function pixelsForBudget(budget) {
  const key = String(budget ?? '').toLowerCase()
  if (key === 'frugal') return FRUGAL_MAX_PIXELS
  return DEFAULT_MAX_PIXELS
}
