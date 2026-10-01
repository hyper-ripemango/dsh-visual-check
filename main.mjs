/**
 * dsh-visual-check —— 给 Agent 装"眼睛"的 host 插件。
 *
 * 注册两个工具：
 *   - `visual_windows`：列出当前可见的顶层窗口（含"可不可怕"的标记：前台 / 覆盖层 / 最小化）
 *   - `visual_capture`：把屏幕 / 窗口 / 区域 / 图片文件变成一张**能进入模型视野**的图
 *
 * 三条设计原则（都来自 probe/ 下的实测，细节见 README）：
 *
 *  1. **理解用会话原生视觉**。图片经附件通道作为 ImageBlock 回传，由当前模型直接看，
 *     插件不外呼任何视觉 API、不需要任何 key。模型不支持图片时**明确报错**，
 *     绝不降级成"让别的模型转述一段文字"——二手转述正是本插件要消灭的东西。
 *  2. **截图前必须取得用户授权**，与权限级别无关。这是工作区硬规则，
 *     所以 `screen`/`window`/`region` 三种来源一律先问；只有 `file`（读已有图片）不问。
 *  3. **遮挡必须处理**。屏幕裁切一个被别的窗口盖住的窗口，会**静默**返回遮挡者的像素
 *     ——不是黑图，不报错，所有内容校验都能通过。所以窗口抓取前一律先采样可见度，
 *     被遮挡时要么明确报错，要么按 `raise` 置顶后再抓、抓完把焦点恢复回去。
 *
 * @module dsh-visual-check
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_MAX_PIXELS,
  FRUGAL_MAX_PIXELS,
  buildEnvelope,
  dateStamp,
  describeWindow,
  matchWindows,
  nextVersion,
  safeName,
  stripUndefined,
  windowCaveats,
} from './core.mjs'
import {
  captureRegion,
  captureScreen,
  captureWindow,
  launchAndWait,
  listWindows,
  sampleCoverage,
  screenGeometry,
} from './capture.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-visual-check'

/** 本插件依赖的 DSH 服务；attachments / llm / userQuestions 是可选依赖，用 ctx.get 取。 */
export const inject = ['tools', 'systemPrompt']

/** 版本戳：用于确认真机上跑的到底是哪一份代码。 */
const MARKER = 'visual-check/2026-10-01'

/** 用户授权选项的固定文案——判定成功与否全靠它，集中在这里避免写歪。 */
const ALLOW_LABEL = '允许截图'
const DENY_LABEL = '不截图'

/** 需要用户授权的来源。`file` 只是读一张已存在的图，不触碰屏幕，因此不需要。 */
const AUTHORIZED_SOURCES = new Set(['screen', 'window', 'region'])

export const Config = z.object({
  /** 截图落盘根目录。必须显式配置：DSH 是长驻进程，cwd 不是会话工作区。 */
  outputDir: z.string().default(''),
  /** 编译缓存目录（C# 助手的 DLL）。留空则用系统临时目录。 */
  cacheDir: z.string().default(''),
  /** 默认是否缩图。0 = 不缩（附件服务与模型侧都会处理，客户端缩图只会丢细节）。 */
  defaultMaxPixels: z.number().default(DEFAULT_MAX_PIXELS),
  /** 省 token 档的像素上限。 */
  frugalMaxPixels: z.number().default(FRUGAL_MAX_PIXELS),
  /** 单次驱动调用超时。 */
  timeoutMs: z.number().default(60000),
  /** 启动程序后等待窗口出现的上限。 */
  launchWaitMs: z.number().default(20000),
  /**
   * 已知程序的启动器：目标窗口当前不存在时，用哪条命令把它拉起来。
   * `match` 按标题或进程名子串比对（不区分大小写）。
   *
   * 为什么需要它：Windows **没有"打开某个窗口"这种操作**——窗口由进程创建，
   * 进程没跑就没有窗口。所以"打开没打开的窗口"只能是启动对应程序。
   */
  launchers: z
    .array(
      z.object({
        match: z.string(),
        command: z.string(),
      }),
    )
    .default([]),
})

// ------------------------------------------------------------------ 小工具

/**
 * 把配置补齐成"无论 loader 是否填过默认值都能用"的形状。
 *
 * 正常情况下 schemastery 已经在 `resolveConfig` 阶段补好了默认值；这里再兜一次底，
 * 是因为插件的正确性不该依赖"配置解析恰好按预期发生"——少一个字段就整段功能失效
 * 的失败方式太脆了。代码里只认这一份归一化结果。
 */
function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  const positive = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    outputDir: String(raw.outputDir ?? '').trim(),
    cacheDir: String(raw.cacheDir ?? '').trim(),
    defaultMaxPixels: positive(raw.defaultMaxPixels, DEFAULT_MAX_PIXELS),
    frugalMaxPixels: positive(raw.frugalMaxPixels, FRUGAL_MAX_PIXELS) || FRUGAL_MAX_PIXELS,
    timeoutMs: positive(raw.timeoutMs, 60000) || 60000,
    launchWaitMs: positive(raw.launchWaitMs, 20000) || 20000,
    launchers: Array.isArray(raw.launchers)
      ? raw.launchers.filter((entry) => entry !== null && typeof entry === 'object')
      : [],
  }
}

const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * 决定用哪条命令把目标程序拉起来：显式 `launch` 参数优先，其次配置里的启动器表。
 *
 * 只在窗口确实不存在时才会被调用——最小化和被遮挡都不需要启动程序。
 *
 * @returns {string|null} 启动命令；无法确定时返回 null
 */
function resolveLaunchCommand(args, config, query) {
  const explicit = String(args?.launch ?? '').trim()
  if (explicit.length > 0) return explicit

  const needle = String(query ?? '').toLowerCase()
  for (const entry of config.launchers ?? []) {
    const match = String(entry?.match ?? '').trim().toLowerCase()
    const command = String(entry?.command ?? '').trim()
    if (match.length === 0 || command.length === 0) continue
    if (needle.includes(match) || match.includes(needle)) return command
  }
  return null
}

/**
 * 交付工具结果前过一遍无损 JSON。
 *
 * 值为 `undefined` 的属性会让整次调用以 `value is not lossless JSON` 失败，
 * 哪怕图已经成功落盘——工具结果由一堆可选片段拼成，所以必须剥干净。
 */
function deliver(payload) {
  return stripUnsafe(stripUndefined(payload))
}

/** 把值物化成"外来的纯对象"：跨 realm 的代理对象也会被判定成非法结果。 */
function stripUnsafe(value) {
  return JSON.parse(JSON.stringify(value))
}

// ------------------------------------------------------------------ 授权

/**
 * 向用户申请截图授权。
 *
 * 这条路径**不可绕过**：工作区规则要求任何屏幕截图都必须先取得用户同意，
 * 与 Agent 是否拥有完全权限无关。
 *
 * @returns {Promise<{approved: boolean, detail: string}>}
 */
async function requestAuthorization(ctx, exec, { target, reason }) {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) {
    return { approved: false, detail: '当前环境没有挂载用户问答服务，无法取得截图授权。' }
  }
  const agent = exec.agent
  if (agent === undefined) {
    return { approved: false, detail: '无法确定发起会话，无法取得截图授权。' }
  }

  const question = [
    '是否允许这次截图？',
    '',
    `目标：${target}`,
    `原因：${reason}`,
    '',
    '允许后我只会拍这一次；若目标被别的窗口挡住，会把目标临时置顶、拍完立刻把焦点恢复原样。',
  ].join('\n')

  let answer
  try {
    answer = await userQuestions.ask({
      questions: [
        {
          id: 'authorize-capture',
          header: '截图授权',
          question,
          options: [
            { label: ALLOW_LABEL, description: '拍这一张。截图可能包含屏幕上的敏感信息，拍完即用即弃。' },
            { label: DENY_LABEL, description: '不拍。我会改用读代码或请你自己描述的方式继续。' },
          ],
        },
      ],
      agent,
      signal: exec.signal,
    })
  } catch (error) {
    const code = error?.code ?? ''
    const hint =
      code === 'DELEGATED_CALLER'
        ? '（当前会话是子 Agent，没有向人类提问的权限；请让主会话发起截图。）'
        : code === 'CALLER_NOT_LIVE'
          ? '（发起会话已不在运行。）'
          : code === 'ASK_ABORTED'
            ? '（提问被中断。）'
            : ''
    return { approved: false, detail: `授权询问失败${hint}：${error?.message ?? String(error)}` }
  }

  const selected = answer?.answers?.[0]?.selected ?? []
  const approved = selected.includes(ALLOW_LABEL)
  return { approved, detail: approved ? '用户已授权' : `用户未授权（选择：${selected.join('、') || '无'}）` }
}

// ------------------------------------------------------------------ 能力门

/**
 * 确认当前模型路由**明确声明**了图片输入。
 *
 * 照搬 DSH 内置 `read_image` 的严格口径：模型没声明就不给图，而不是把一张
 * 模型看不见的图塞进上下文，让它对着空气瞎猜。模型选错时给出可操作的提示。
 */
async function assertImageCapable(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('无法解析当前模型路由，不能确认模型是否支持图片输入。')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active?.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `当前模型「${model}」没有声明图片输入，把截图交给它没有意义。` +
        '请切换到支持视觉的模型（例如 deepseek-flash、glm-5.3-flash）后重试。',
    )
  }
  return { provider, model }
}

// ------------------------------------------------------------------ 落盘

/** 解析落盘根目录，未配置时给出可操作的错误。 */
function resolveOutputRoot(config) {
  const dir = String(config?.outputDir ?? '').trim()
  if (dir.length === 0) return { ok: false, dir: '' }
  return { ok: true, dir }
}

/** 为这次截图准备一个版本化目录，返回目标文件路径与新版本号。 */
async function prepareTarget(root, slug) {
  const dir = join(root, slug)
  let existing = []
  try {
    existing = await readdir(dir)
  } catch {
    /* 目录还不存在 */
  }
  const version = nextVersion(existing)
  const tag = `v${String(version).padStart(2, '0')}`
  return { dir, version, tag, path: join(dir, `${tag}.png`) }
}

// ------------------------------------------------------------------ 工具

/** `visual_windows` —— 列出可截的窗口。 */
function createWindowsTool(ctx, config) {
  return defineTool({
    name: 'visual_windows',
    description:
      '列出当前屏幕上可见的顶层窗口，供 `visual_capture` 选择目标。' +
      '每个窗口带有可捕获性标记：前台 / 覆盖层 / 最小化，以及尺寸与位置。' +
      '这是元数据（窗口标题与几何），不是截图，因此不需要用户授权。',
    // DSH 的 defineTool 要的是**扁平属性表**（名 → 值 schema），不是 JSON Schema：
    // 写成 { type: 'object', properties: {...} } 会被当成一个名叫 `type` 的参数，
    // 报 "parameters.type must be a value schema object"。required 写在属性自己身上。
    parameters: {
      filter: {
        type: 'string',
        description: '可选关键字，按窗口标题或进程名子串过滤（不区分大小写）。留空则列出全部。',
      },
    },
    // output.schema 反过来——它才是 JSON Schema 对象。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          screen: { type: 'string', required: true },
          content: { type: 'json', required: true },
        },
      },
      render: (_args, value) => value.content,
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: '枚举屏幕窗口', kind: 'read' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: `可见窗口 ${String(result?.count ?? 0)} 个`,
      kind: 'read',
    }),

    async execute(args) {
      const filter = String(args?.filter ?? '').trim()
      const [windows, screen] = await Promise.all([listWindows({ cacheDir: config.cacheDir }), screenGeometry({ cacheDir: config.cacheDir })])
      const list = filter.length === 0 ? windows : matchWindows(windows, filter)

      const lines = []
      lines.push(`屏幕：${screen === null ? '未知' : `${screen.w}x${screen.h}`}`)
      lines.push(`可见窗口 ${list.length} 个${filter.length > 0 ? `（过滤：${filter}）` : ''}：`)
      for (const win of list) {
        const caveats = windowCaveats(win, screen ?? undefined)
        lines.push(`- ${describeWindow(win)}${caveats.length > 0 ? `\n  ⚠ ${caveats.join('；')}` : ''}`)
      }
      if (list.length === 0) {
        lines.push('（没有匹配的窗口。可先不带 filter 列全部。）')
      }
      lines.push('')
      lines.push('用 `visual_capture{ source: "window", window: "<标题或进程名片段>" }` 抓其中一个。')

      return deliver({
        count: list.length,
        screen: screen === null ? '' : `${screen.w}x${screen.h}`,
        content: [{ type: 'text', text: lines.join('\n') }],
      })
    },
  })
}

/** `visual_capture` —— 主角。 */
function createCaptureTool(ctx, config) {
  return defineTool({
    name: 'visual_capture',
    description:
      '把屏幕、某个窗口、一块区域或一张已有图片拍成图，**图片会直接进入你的视野**，用于核对界面显示。' +
      '适合"看比读代码便宜"的场合：布局与对齐、颜色与状态、图片内容、以及代码里查不出来的视觉异常。\n' +
      '注意：屏幕 / 窗口 / 区域截图**会先向用户申请授权**，用户拒绝时本工具直接失败，' +
      '这时应改用读代码或请用户自己描述，不要反复重试。\n' +
      '抓窗口时若目标被别的窗口挡住，默认会明确报错（因为静默拍到的是遮挡者的画面）；' +
      '确实需要时用 `raise: true` 让插件临时置顶目标并在抓完后恢复原焦点。\n' +
      '**最小化的窗口会被自动恢复后抓取，抓完再放回最小化**，不需要额外参数；' +
      '程序完全没在运行时，用 `launch` 给出启动命令（或预先在配置的 `launchers` 里登记），' +
      '插件会启动它并等窗口出现——Windows 没有"打开某个窗口"的操作，所以必须知道启动哪个程序。',
    // 扁平属性表（名 → 值 schema），required 写在属性自己身上。
    // region 拆成四个标量：嵌套对象在这个参数规格里未必支持，拆开对模型也更直白。
    parameters: {
      source: {
        type: 'string',
        required: true,
        enum: ['screen', 'window', 'region', 'file'],
        description:
          'screen=整块屏幕；window=某个窗口（配合 window 或 handle）；' +
          'region=一块矩形区域（配合 regionX/Y/W/H）；file=把一张已有图片交给模型看（不需要授权）。',
      },
      reason: {
        type: 'string',
        required: true,
        description: '为什么要这张截图。会展示给用户作为授权依据，请写具体（例如"核对保存按钮是否在右上角"）。',
      },
      window: {
        type: 'string',
        description: 'source=window：窗口标题或进程名的片段，也可直接填 hwnd 数字。可用 visual_windows 先查。',
      },
      handle: { type: 'number', description: 'source=window：直接指定窗口句柄（优先级高于 window）。' },
      regionX: { type: 'integer', description: 'source=region：区域左上角 x（相对虚拟屏幕原点）。' },
      regionY: { type: 'integer', description: 'source=region：区域左上角 y。' },
      regionW: { type: 'integer', description: 'source=region：区域宽度（必须为正）。' },
      regionH: { type: 'integer', description: 'source=region：区域高度（必须为正）。' },
      filePath: { type: 'string', description: 'source=file：已有图片的路径（PNG/JPEG/WebP/GIF）。' },
      raise: {
        type: 'boolean',
        description:
          '目标被遮挡时是否先临时置顶再抓（抓完自动把焦点恢复原样）。默认 false；' +
          '置顶会短暂抢走用户焦点，所以只在确实需要看被挡住的窗口时才开。',
      },
      launch: {
        type: 'string',
        description:
          'source=window：目标窗口当前不存在（程序没在运行）时，先执行这条命令把它打开，等到窗口出现再截图。' +
          'Windows 没有"打开某个窗口"这种操作，所以这里给的是**启动程序的命令**，' +
          '例如 `start "" "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"`。' +
          '插件配置的 `launchers` 若已能匹配目标，可以省略本参数。' +
          '注意：最小化的窗口不需要它——那类窗口会被自动恢复后抓取。',
      },
      budget: {
        type: 'string',
        enum: ['balanced', 'frugal'],
        description: 'balanced（默认）保留细节；frugal 把图压到约 200 万像素以内以省视觉 token。',
      },
      title: { type: 'string', description: '这次截图的短名字，用于落盘目录命名。留空则按来源自动命名。' },
    },
    // output.schema 才是 JSON Schema 对象（与 parameters 的扁平表相反）。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          srcWidth: { type: 'number', required: true },
          srcHeight: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          coverage: { type: 'string', required: true },
          raised: { type: 'boolean', required: true },
          restored: { type: 'boolean', required: true },
          unminimized: { type: 'boolean', required: true },
          reminimized: { type: 'boolean', required: true },
          launched: { type: 'boolean', required: true },
          blank: { type: 'boolean', required: true },
          image: { type: 'json', required: true },
          content: { type: 'json', required: true },
        },
      },
      render: (_args, value) => value.content,
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `截图：${String(args?.title ?? args?.source ?? '')}`.slice(0, 60),
      kind: 'read',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: `截图 ${String(result?.width ?? '')}x${String(result?.height ?? '')}`,
      kind: 'read',
    }),

    async execute(args, exec) {
      const source = String(args?.source ?? '').trim().toLowerCase()
      const reason = String(args?.reason ?? '').trim()
      const raise = args?.raise === true
      const maxPixels = String(args?.budget ?? 'balanced').toLowerCase() === 'frugal'
        ? config.frugalMaxPixels
        : config.defaultMaxPixels

      if (!['screen', 'window', 'region', 'file'].includes(source)) {
        throw new Error(`source 必须是 screen / window / region / file 之一，收到「${source}」。`)
      }
      if (reason.length === 0) {
        throw new Error('缺少 reason：请说明为什么要这张截图（它会作为向用户申请授权的依据）。')
      }

      const driverOptions = { cacheDir: config.cacheDir, timeoutMs: config.timeoutMs, signal: exec.signal }

      // 能力门先行：模型看不见图的话，任何来源都没有意义，早失败早给出可操作的提示。
      await assertImageCapable(ctx, exec)

      // ---- source=file：不碰屏幕，也不需要授权 ----
      if (source === 'file') {
        const filePath = String(args?.filePath ?? '').trim()
        if (!isNonEmpty(filePath)) throw new Error('缺少 filePath：source=file 需要一张已有图片的路径。')
        if (!existsSync(filePath)) throw new Error(`图片不存在：${filePath}`)
        return await deliverImage(ctx, exec, {
          filePath,
          source,
          target: filePath,
          title: String(args?.title ?? '').trim() || basename(filePath).replace(/\.[^.]+$/, ''),
          capture: {},
          coverage: undefined,
          raised: false,
          restored: true,
        })
      }

      // ---- 屏幕类来源：需要落盘位置，并要用户授权 ----
      const outputRoot = resolveOutputRoot(config)
      if (!outputRoot.ok) {
        throw new Error(
          '未配置 outputDir：请在插件配置里指定截图落盘根目录（例如 C:\\<工作区>\\inspiration\\visual-checks）。' +
            'DSH 是长驻进程，cwd 不是会话工作区，所以这里要求显式配置而不是猜一个位置。',
        )
      }

      // 先解析目标，好让授权提示里写清楚"要拍什么"
      let targetHandle = 0
      let targetWindow = null
      let region = null
      let targetLabel = ''
      let launchInfo = null

      if (source === 'screen') {
        const screen = await screenGeometry(driverOptions)
        targetLabel = `整块屏幕${screen === null ? '' : `（${screen.w}x${screen.h}）`}`
      } else if (source === 'region') {
        const nums = [args?.regionX, args?.regionY, args?.regionW, args?.regionH].map((value) => Number(value))
        if (nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0 || nums[3] <= 0) {
          throw new Error('region 需要 regionX / regionY / regionW / regionH 四个数字，且 W、H 必须为正。')
        }
        region = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] }
        targetLabel = `屏幕区域 ${region.w}x${region.h} @${region.x},${region.y}`
      } else {
        const explicit = Number(args?.handle ?? 0)
        const query = String(args?.window ?? '').trim()
        let windows = await listWindows(driverOptions)

        if (Number.isFinite(explicit) && explicit > 0) {
          targetWindow = windows.find((win) => win.handle === explicit) ?? null
          if (targetWindow === null) throw new Error(`找不到句柄 ${explicit} 对应的可见窗口，先用 visual_windows 看一下。`)
        } else {
          if (!isNonEmpty(query)) throw new Error('source=window 需要 window（标题/进程名片段）或 handle。')
          let hits = matchWindows(windows, query)

          // 窗口不存在时，"把它打开"只能靠启动对应程序——Windows 没有打开窗口这种操作。
          if (hits.length === 0) {
            const command = resolveLaunchCommand(args, config, query)
            if (command === null) {
              throw new Error(
                `没有匹配「${query}」的窗口。\n` +
                  '如果它只是被最小化，现在应该已经能列出来了（最小化窗口会自动恢复后抓取）；' +
                  '如果程序确实没在运行，请用 `launch` 给出启动命令，' +
                  '或在插件配置的 `launchers` 里登记一条 `{ match, command }`。',
              )
            }
            launchInfo = { command }
            const launched = await launchAndWait(command, {
              match: query,
              timeoutMs: config.launchWaitMs,
              options: driverOptions,
            })
            if (launched.window === null) {
              throw new Error(
                `已执行启动命令，但 ${config.launchWaitMs}ms 内没等到匹配「${query}」的窗口出现。` +
                  '可能是启动命令不对、程序启动较慢，或窗口标题与关键字不符。',
              )
            }
            launchInfo.waitedMs = launched.waitedMs
            windows = await listWindows(driverOptions)
            hits = matchWindows(windows, query)
            if (hits.length === 0) hits = [launched.window]
          }

          targetWindow = hits[0]
          if (hits.length > 1 && !hits[0].foreground) {
            const candidates = hits.slice(0, 4).map((win) => `  · ${describeWindow(win)}`).join('\n')
            throw new Error(
              `「${query}」匹配到 ${hits.length} 个窗口，且没有一个在前台，请用更精确的关键字或直接给 handle：\n${candidates}`,
            )
          }
        }
        targetHandle = targetWindow.handle
        targetLabel = `窗口 ${describeWindow(targetWindow)}`
      }

      // ---- 授权（硬规则） ----
      if (AUTHORIZED_SOURCES.has(source)) {
        const auth = await requestAuthorization(ctx, exec, { target: targetLabel, reason })
        if (!auth.approved) {
          throw new Error(`${auth.detail}。未取得授权，已放弃截图；请改用读代码或请用户自行描述。`)
        }
      }

      // ---- 抓取 ----
      const slug = safeName(String(args?.title ?? '').trim() || `${source}-${dateStamp()}`, 'capture')
      const target = await prepareTarget(outputRoot.dir, slug)
      let captured
      let coverage
      const caveats = []

      if (source === 'screen') {
        captured = await captureScreen(target.path, { ...driverOptions, maxPixels })
      } else if (source === 'region') {
        captured = await captureRegion(target.path, region, { ...driverOptions, maxPixels })
      } else {
        // 覆盖层无法用采样判断可见性（WindowFromPoint 会跳过它），所以只在普通窗口上采样
        if (targetWindow.overlay !== true) {
          coverage = await sampleCoverage(targetHandle, driverOptions)
          const [hit, total] = coverage.split('/').map(Number)
          const mostlyCovered = Number.isFinite(hit) && Number.isFinite(total) && total > 0 && hit <= total / 3
          if (mostlyCovered && !raise) {
            throw new Error(
              `目标窗口当前被遮挡（可见采样 ${coverage}，即 9 个采样点里只有 ${hit} 个属于它）。` +
                '此时屏幕裁切抓到的是**遮挡者**的画面，不是目标窗口——静默返回错误内容。\n' +
                '两个选择：① 加 `raise: true` 让插件临时置顶目标并在抓完后恢复焦点；' +
                '② 请用户把目标窗口切到前台后再试。',
            )
          }
        } else {
          caveats.push('这是分层/穿透覆盖层，抓到的是它下方的屏幕内容')
        }
        captured = await captureWindow(target.path, targetHandle, { ...driverOptions, maxPixels, raise })
      }

      const info = captured.capture ?? {}
      const fields = captured.fields ?? {}
      if (info.blank === 1) caveats.push('画面几乎单色，可能是空白页面或该区域没有内容')

      const restored = fields.restored === '1' || fields.restored === 1
      const raised = fields.raised === '1' || fields.raised === 1
      const unminimized = fields.unminimized === '1' || fields.unminimized === 1
      const reminimized = fields.reminimized === '1' || fields.reminimized === 1
      // 置顶后的可见采样。置顶前那个必然是 0/9（否则不会置顶），
      // 拿它配一张成功的截图会让人以为抓的是遮挡状态。
      const coverageAfterRaise = typeof fields.coverageRaised === 'string' ? fields.coverageRaised : undefined

      return await deliverImage(ctx, exec, {
        filePath: target.path,
        source,
        target: targetLabel,
        title: slug,
        capture: info,
        coverage,
        coverageAfterRaise,
        raised,
        restored,
        unminimized,
        reminimized,
        launched: launchInfo !== null,
        launchWaitedMs: launchInfo?.waitedMs,
        caveats,
      })
    },
  })
}

/** 把落盘图交给模型：存成附件，返回 [文本信封 + 图片块]。 */
async function deliverImage(ctx, exec, spec) {
  const attachments = ctx.get('attachments')
  const data = await readFile(spec.filePath)

  // 先存附件：附件的规范化结果带有权威尺寸，`source: file` 这类没有采集信息的情况要靠它。
  const ref =
    attachments === undefined
      ? null
      : await attachments.saveImage({ data, mediaType: 'image/png', name: basename(spec.filePath) })

  const width = Number(spec.capture?.width ?? ref?.width ?? 0)
  const height = Number(spec.capture?.height ?? ref?.height ?? 0)
  const srcW = Number(spec.capture?.srcW ?? ref?.originalDimensions?.width ?? width)
  const srcH = Number(spec.capture?.srcH ?? ref?.originalDimensions?.height ?? height)
  const bytes = data.length

  const envelope = buildEnvelope({
    path: spec.filePath,
    source: spec.source,
    target: spec.target,
    srcW,
    srcH,
    width,
    height,
    bytes,
    coverage: spec.coverage,
    coverageAfterRaise: spec.coverageAfterRaise,
    raised: spec.raised === true,
    restored: spec.restored === true,
    unminimized: spec.unminimized === true,
    reminimized: spec.reminimized === true,
    launched: spec.launched === true,
    launchWaitedMs: spec.launchWaitedMs,
    blank: spec.capture?.blank === 1,
    caveats: spec.caveats,
  })

  // 这几个字段必须与 output.schema 里标了 required 的完全一致：
  // 声明成必填却不在返回值里，会让工具结果校验失败（而不是悄悄放过）。
  // coverage 用空串兜底——`source: file` 没有采集信息，但它仍是必填字段。
  const base = {
    source: spec.source,
    target: spec.target,
    path: spec.filePath,
    width,
    height,
    srcWidth: srcW,
    srcHeight: srcH,
    bytes,
    coverage: spec.coverage ?? '',
    raised: spec.raised === true,
    restored: spec.restored === true,
    unminimized: spec.unminimized === true,
    reminimized: spec.reminimized === true,
    launched: spec.launched === true,
    blank: spec.capture?.blank === 1,
  }

  if (ref === null) {
    return deliver({
      ...base,
      image: {},
      content: [{ type: 'text', text: `${envelope}\n（附件服务未挂载，无法把图片直接交给模型。）` }],
    })
  }

  // 照抄 DSH 内置 read_image 的做法：附件引用在 render 侧按字段重建，
  // 这样经过 JSON 物化之后依然是纯对象。
  const imageRef = stripUndefined({
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    name: ref.name,
    originalDimensions: ref.originalDimensions,
  })

  return deliver({
    ...base,
    image: imageRef,
    content: [
      { type: 'text', text: envelope },
      { type: 'image', attachment: imageRef },
    ],
  })
}

// ------------------------------------------------------------------ 装载

/** Cordis 入口。 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  ctx.tools.register(createWindowsTool(ctx, config))
  ctx.tools.register(createCaptureTool(ctx, config))

  ctx.systemPrompt.section({
    name: 'tool:visual_capture',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH'),
    text: ({ scope }) =>
      ctx.tools.get('visual_capture', scope) === undefined
        ? ''
        : [
            '需要**核对画面**而不是读代码时，用 `visual_capture` 截图——图片会直接进入你的视野，比解包 CSS/DOM 便宜得多，也不会因为读代码而误判渲染结果。',
            '',
            '典型场合：布局与对齐、间距与溢出、颜色与主题、组件交互态、图片/图表内容、以及代码里根本查不出来的视觉异常。',
            '',
            '两条硬规则：① 屏幕 / 窗口 / 区域截图**一定会先弹给用户授权**，被拒绝就换别的办法，不要重试；② 抓窗口如果被挡住会明确报错，确实需要时用 `raise: true` 置顶，插件会在抓完后把焦点恢复原样。',
            '',
            '先用 `visual_windows` 看清有哪些窗口可抓，再决定抓哪个。',
          ].join('\n'),
  })

  void MARKER
}

export default { name, inject, Config, apply }
