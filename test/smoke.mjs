/**
 * dsh-visual-check 冒烟测试 —— 零网络、零花费。
 *
 * 两层：
 *   1. 纯逻辑（core.mjs）：行协议解析、无损 JSON、命名、窗口匹配、信封文本
 *   2. 真机抓屏（capture.mjs + Win32 驱动）：自建一个品红测试窗口来验证
 *      「枚举 → 遮挡采样 → 置顶 → 抓取 → 恢复焦点」全链路
 *
 * 第 2 层**只拍自己造的测试窗口**，不涉及用户屏幕上的任何内容，
 * 因此不需要截图授权，也可以随时重跑。
 *
 * 跑法：node test/smoke.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildEnvelope,
  describeWindow,
  formatBytes,
  matchWindows,
  nextVersion,
  parseDriverOutput,
  parsePairs,
  pixelsForBudget,
  safeName,
  stripUndefined,
  versionTag,
  windowCaveats,
} from '../core.mjs'
import {
  captureScreen,
  captureWindow,
  listWindows,
  minimizeWindow,
  sampleCoverage,
  screenGeometry,
  windowState,
} from '../capture.mjs'

// ------------------------------------------------------------------ 断言

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(`${label}${detail.length > 0 ? ` — ${detail}` : ''}`)
  return false
}

const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)

// ---------------------------------------------------------- 1. 纯逻辑

// 行协议
const sample = [
  'ok=1',
  'window\t123\t456\tnotepad\t10\t20\t800\t600\t1\t0\t0\tUntitled - Notepad',
  'window\t789\t999\tchrome\t0\t0\t100\t100\t0\t0\t1\tSome | Piped Title',
  'capture=srcW=2560;srcH=1440;width=1880;height=1058;bytes=1234567;blank=0',
  'path=C:\\tmp\\shot.png',
].join('\n')
const parsed = parseDriverOutput(sample)
check('解析 ok=1', parsed.ok === true)
eq('窗口条数', parsed.windows.length, 2)
eq('窗口标题含竖线不被截断', parsed.windows[1].title, 'Some | Piped Title')
eq('窗口 overlay 标记', parsed.windows[1].overlay, true)
eq('capture 里的数值被转成 number', parsed.capture.srcW, 2560)
eq('capture 里的 bytes', parsed.capture.bytes, 1234567)

const bad = parseDriverOutput('ok=0\nerror=something broke')
check('解析失败态', bad.ok === false)
eq('解析错误信息', bad.error, 'something broke')

eq('parsePairs 空串', Object.keys(parsePairs('')).length, 0)
eq('parsePairs 单值', parsePairs('a=1').a, 1)

// 无损 JSON
const stripped = stripUndefined({ a: 1, b: undefined, c: null, d: { e: undefined, f: [1, undefined, 2] } })
eq('剥离 undefined 键', Object.hasOwn(stripped, 'b'), false)
eq('保留 null', stripped.c, null)
eq('递归剥离', Object.hasOwn(stripped.d, 'e'), false)
eq('数组里的 undefined 被丢弃', stripped.d.f.length, 2)

// 命名
eq('safeName 去非法字符', safeName('专辑/详情:页*?'), '专辑_详情_页__')
eq('safeName 保留中文', safeName('专辑详情页'), '专辑详情页')
eq('safeName 空值兜底', safeName('   ', 'cap'), 'cap')
eq('safeName 抗 Windows 保留名', safeName('con'), '_con')
check('safeName 截断', safeName('长'.repeat(200)).length <= 48)
eq('versionTag 补零', versionTag(3), 'v03')
eq('nextVersion 空目录', nextVersion([]), 1)
eq('nextVersion 顺延', nextVersion(['v01.png', 'v02.png', 'v02.json']), 3)
eq('nextVersion 忽略无关文件', nextVersion(['notes.md']), 1)

// 窗口匹配
const windows = [
  { handle: 1, pid: 1, process: 'Weixin', title: '微信', x: 0, y: 0, w: 800, h: 600, foreground: false, minimized: false, overlay: false },
  { handle: 2, pid: 2, process: 'chrome', title: 'localhost:5173', x: 0, y: 0, w: 1200, h: 800, foreground: true, minimized: false, overlay: false },
  { handle: 3, pid: 3, process: 'NVIDIA Overlay', title: 'Overlay', x: 0, y: 0, w: 2560, h: 1440, foreground: false, minimized: false, overlay: true },
]
eq('按 hwnd 匹配', matchWindows(windows, '2').length, 1)
eq('按进程名匹配', matchWindows(windows, 'weixin').length, 1)
eq('按标题匹配', matchWindows(windows, '5173').length, 1)
eq('前台窗口优先', matchWindows(windows, 'o').length > 0, true)
eq('空查询返回空', matchWindows(windows, '  ').length, 0)

// 可用性提示
check('overlay 有告警', windowCaveats(windows[2], { w: 2560, h: 1440 }).some((n) => n.includes('覆盖层')))
check('全屏有告警', windowCaveats({ w: 2560, h: 1440, overlay: false, minimized: false }, { w: 2560, h: 1440 }).some((n) => n.includes('全屏')))
check('正常窗口无告警', windowCaveats(windows[1], { w: 2560, h: 1440 }).length === 0)
check('describeWindow 可读', describeWindow(windows[1]).includes('chrome') && describeWindow(windows[1]).includes('前台'))

// 信封
const envelope = buildEnvelope({ path: 'C:\\x\\v01.png', source: 'window', target: '微信', srcW: 1941, srcH: 1243, width: 970, height: 621, bytes: 2000000, coverage: '9/9', raised: true, blank: false })
check('信封含路径', envelope.includes('C:\\x\\v01.png'))
check('信封含换算比例', envelope.includes('乘以 2.00'))
check('信封说明已恢复焦点', envelope.includes('恢复原前台焦点'))
check('信封提醒可重新投递', envelope.includes('重新投递'))

eq('formatBytes 小数', formatBytes(1536), '1.5 KB')
eq('formatBytes 兆', formatBytes(2 * 1024 * 1024), '2.00 MB')
eq('pixelsForBudget 默认不缩放', pixelsForBudget('balanced'), 0)
eq('pixelsForBudget 省 token', pixelsForBudget('frugal'), 1990000)

// ---------------------------------------------------- 2. 真机抓屏

const onWindows = process.platform === 'win32'
if (!onWindows) {
  console.log('（跳过真机抓屏：非 Windows）')
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-visual-smoke-'))
  let testProc = null
  try {
    const geometry = await screenGeometry()
    check('拿到屏幕几何', geometry !== null && geometry.w > 0, JSON.stringify(geometry))

    const enumerated = await listWindows()
    check('枚举到窗口', enumerated.length > 0, `共 ${enumerated.length} 个`)
    check('枚举结果字段完整', enumerated.every((w) => Number.isFinite(w.handle) && typeof w.process === 'string'))

    // 自建品红测试窗口：位置已知、像素可对答案、不含任何用户内容
    const winCode = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$f = New-Object System.Windows.Forms.Form',
      "$f.Text = 'DSHVISUALSMOKE'",
      '$f.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)',
      '$f.ClientSize = New-Object System.Drawing.Size(520, 320)',
      "$f.StartPosition = 'Manual'",
      '$f.Location = New-Object System.Drawing.Point(160, 160)',
      '[void]$f.Show()',
      '$f.Activate()',
      '[System.Windows.Forms.Application]::Run($f)',
    ].join('\n')
    const encoded = Buffer.from(winCode, 'utf16le').toString('base64')
    testProc = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true })

    let target = null
    for (let i = 0; i < 60 && target === null; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const list = await listWindows()
      target = list.find((w) => w.title === 'DSHVISUALSMOKE') ?? null
    }
    check('测试窗口出现', target !== null)

    if (target !== null) {
      const pngPath = join(scratch, 'v01.png')
      const result = await captureWindow(pngPath, target.handle, { raise: true, maxPixels: 0 })
      const info = await stat(pngPath)
      check('抓取产出 PNG', info.size > 1000, `${info.size} 字节`)
      check('抓取尺寸合理', result.capture.width > 100 && result.capture.height > 100, JSON.stringify(result.capture))
      check('抓取内容非空白', result.capture.blank === 0, JSON.stringify(result.capture))
      check('置顶后恢复焦点', result.fields.restored === '1' || result.fields.restored === 1, `restored=${result.fields.restored}`)

      // PNG 头部自检：签名 + IHDR 里的宽高
      const head = (await readFile(pngPath)).subarray(0, 26)
      const sig = head.subarray(0, 8).toString('hex')
      eq('PNG 签名正确', sig, '89504e470d0a1a0a')
      const ihdrW = head.readUInt32BE(16)
      const ihdrH = head.readUInt32BE(20)
      eq('IHDR 宽度与报告一致', ihdrW, result.capture.width)
      eq('IHDR 高度与报告一致', ihdrH, result.capture.height)

      const coverage = await sampleCoverage(target.handle)
      check('可见采样可读', /^\d+\/\d+$/.test(coverage), coverage)

      // 全屏抓取也要能出图
      const screenPath = join(scratch, 'screen.png')
      const screenResult = await captureScreen(screenPath, { maxPixels: 1990000 })
      const screenInfo = await stat(screenPath)
      check('整屏抓取产出 PNG', screenInfo.size > 1000, `${screenInfo.size} 字节`)
      check('整屏抓取非空白', screenResult.capture.blank === 0, JSON.stringify(screenResult.capture))
      void rm(screenPath, { force: true })

      // ---- 最小化窗口：应能列出、自动恢复后抓取、抓完放回最小化 ----
      // 这条以前是坏的：最小化窗口的 GetWindowRect 返回屏幕外的极小矩形，
      // 被尺寸过滤整批丢掉，于是"窗口明明开着却列不出来"。
      check('测试窗口已最小化', await minimizeWindow(target.handle))
      await new Promise((r) => setTimeout(r, 700))

      const afterMinimize = await listWindows()
      const minimizedEntry = afterMinimize.find((w) => w.handle === target.handle) ?? null
      check('最小化窗口仍出现在列表里', minimizedEntry !== null)
      eq('最小化标记正确', minimizedEntry?.minimized, true)
      check(
        '最小化窗口报的是恢复后矩形（不是屏幕外那个假的）',
        (minimizedEntry?.w ?? 0) > 100 && (minimizedEntry?.h ?? 0) > 100,
        `${minimizedEntry?.w}x${minimizedEntry?.h}`,
      )

      const minPath = join(scratch, 'minimized.png')
      const minResult = await captureWindow(minPath, target.handle, { maxPixels: 0 })
      const minStat = await stat(minPath)
      check('最小化窗口能抓到内容', minStat.size > 1000, `${minStat.size} 字节`)
      check('抓取非空白（确实恢复了才抓得到）', minResult.capture.blank === 0, JSON.stringify(minResult.capture))
      eq('报告了自动恢复', minResult.fields.unminimized, '1')
      eq('报告了放回最小化', minResult.fields.reminimized, '1')

      await new Promise((r) => setTimeout(r, 700))
      const stateAfter = await windowState(target.handle)
      const entryAfter = (await listWindows()).find((w) => w.handle === target.handle) ?? null
      check(
        '抓完确实回到最小化状态',
        stateAfter.minimized === true,
        `state=${JSON.stringify(stateAfter)} listEntry=${JSON.stringify(entryAfter)} reminimizedField=${minResult.fields.reminimized}`,
      )
      void rm(minPath, { force: true })
    }
  } finally {
    if (testProc !== null) testProc.kill()
    await rm(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ 汇总

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const line of failures) console.log(`  · ${line}`)
  process.exit(1)
}
console.log('全部通过')
