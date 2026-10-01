/**
 * 插件本体集成测试 —— 用假的 ctx 驱动 `apply()` 与两个工具。
 *
 * 零网络、零花费，且**不拍任何真实屏幕内容**：走的路径要么是 `source: file`，
 * 要么在授权 / 能力门处就被拦下。真机抓屏由 `test/smoke.mjs` 用自建测试窗口覆盖。
 *
 * 跑法：node --import ./test/register.mjs test/tool.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, inject, name as pluginName } from '../main.mjs'
import { defaultsOf } from './stubs/schemastery.mjs'

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

/** 期望一次调用失败，并返回错误信息。 */
async function expectError(label, fn) {
  try {
    await fn()
  } catch (error) {
    return error.message ?? String(error)
  }
  failures.push(`${label} — 期望抛错却成功返回`)
  return ''
}

// ------------------------------------------------------------------ 假环境

/** 1×1 红色 PNG，仅用于让 `source: file` 有一个真实存在的图片文件。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function makeEnv({ allow = true, imageCapable = true, withAttachments = true } = {}) {
  const registered = []
  const sections = []
  const asked = []
  const saved = []

  const services = {
    userQuestions: {
      async ask(request) {
        asked.push(request)
        const id = request.questions[0].id
        return { answers: [{ id, selected: [allow ? '允许截图' : '不截图'] }] }
      },
    },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: imageCapable ? ['text', 'image'] : ['text'] }
      },
    },
    attachments: withAttachments
      ? {
          async saveImage({ data, mediaType, name: fileName }) {
            saved.push({ bytes: data.length, mediaType, name: fileName })
            return {
              attachmentId: 'att_test_0001',
              mediaType,
              bytes: data.length,
              width: 1,
              height: 1,
              name: fileName,
            }
          },
        }
      : undefined,
  }

  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
      get: (toolName) => registered.find((definition) => definition.name === toolName),
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
      getSectionOrder: () => 0,
    },
    get: (serviceName) => services[serviceName],
  }

  const exec = {
    agent: {
      session: { requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) },
      options: {},
    },
    signal: undefined,
  }

  return { ctx, exec, registered, sections, asked, saved }
}

function configWith(overrides = {}) {
  return { ...defaultsOf(Config), ...overrides }
}

// ------------------------------------------------------------------ 用例

const scratch = await mkdtemp(join(tmpdir(), 'dsh-visual-tool-'))
try {
  const pngPath = join(scratch, 'tiny.png')
  await writeFile(pngPath, TINY_PNG)

  // ---- 1. 注册 ----
  const env = makeEnv()
  apply(env.ctx, configWith({ outputDir: scratch }))

  eq('插件名', pluginName, 'dsh-visual-check')
  check('inject 含 tools 与 systemPrompt', inject.includes('tools') && inject.includes('systemPrompt'))
  eq('注册了两个工具', env.registered.length, 2)
  const names = env.registered.map((definition) => definition.name).sort()
  eq('工具名', names.join(','), 'visual_capture,visual_windows')
  eq('注册了一段系统提示', env.sections.length, 1)

  const captureTool = env.registered.find((definition) => definition.name === 'visual_capture')
  const windowsTool = env.registered.find((definition) => definition.name === 'visual_windows')

  // parameters 是扁平属性表：required 写在属性自己身上（不是 JSON Schema）
  check(
    'capture 的 parameters 是扁平表',
    captureTool.parameters.type === undefined && captureTool.parameters.properties === undefined,
    JSON.stringify(Object.keys(captureTool.parameters)),
  )
  check('capture 需要 source 与 reason', captureTool.parameters.source.required === true && captureTool.parameters.reason.required === true)
  check('capture 声明了四种来源', captureTool.parameters.source.enum.join(',') === 'screen,window,region,file')
  check('capture 的 region 参数已拆成标量', captureTool.parameters.regionW !== undefined && captureTool.parameters.region === undefined)
  // output.schema 反过来才是 JSON Schema 对象
  check('output.schema 是 JSON Schema 形状', captureTool.output.schema.type === 'object')
  check('capture 输出含图片字段', captureTool.output.schema.properties.image !== undefined)
  check('系统提示在工具可见时非空', env.sections[0].text({ scope: undefined }).includes('visual_capture'))

  // ---- 2. visual_windows（读元数据，不需要授权）----
  const windowsResult = await windowsTool.execute({}, env.exec)
  check('窗口列表返回文本块', windowsResult.content[0].type === 'text')
  check('窗口列表内容可读', windowsResult.content[0].text.includes('可见窗口'))
  eq('窗口列表未触发授权', env.asked.length, 0)
  check('窗口列表是无损 JSON', JSON.parse(JSON.stringify(windowsResult)) !== null)

  // ---- 3. source=file：交图，不需要授权 ----
  const fileEnv = makeEnv()
  apply(fileEnv.ctx, configWith({ outputDir: scratch }))
  const fileTool = fileEnv.registered.find((definition) => definition.name === 'visual_capture')

  const fileResult = await fileTool.execute({ source: 'file', reason: '测试交付', filePath: pngPath }, fileEnv.exec)
  eq('file 来源不触发授权', fileEnv.asked.length, 0)
  eq('file 来源存了一次附件', fileEnv.saved.length, 1)
  eq('返回两个内容块', fileResult.content.length, 2)
  eq('第一块是文本', fileResult.content[0].type, 'text')
  eq('第二块是图片', fileResult.content[1].type, 'image')
  eq('图片块带附件引用', fileResult.content[1].attachment.attachmentId, 'att_test_0001')
  eq('图片块无 undefined 残留', Object.values(fileResult.content[1].attachment).includes(undefined), false)
  check('文本信封含路径', fileResult.content[0].text.includes(pngPath))
  check('render 返回内容块', Array.isArray(fileTool.output.render({}, fileResult)))

  // ---- 4. 用户拒绝授权 → 失败且不抓屏 ----
  const denyEnv = makeEnv({ allow: false })
  apply(denyEnv.ctx, configWith({ outputDir: scratch }))
  const denyTool = denyEnv.registered.find((definition) => definition.name === 'visual_capture')
  const denyMessage = await expectError('拒绝授权时应当失败', () =>
    denyTool.execute({ source: 'screen', reason: '测试拒绝路径' }, denyEnv.exec),
  )
  check('拒绝信息说明未取得授权', denyMessage.includes('未取得授权'), denyMessage)
  eq('拒绝时确实问过用户', denyEnv.asked.length, 1)
  eq('拒绝时不落任何附件', denyEnv.saved.length, 0)
  check('授权问题里带上了原因', denyEnv.asked[0].questions[0].question.includes('测试拒绝路径'))

  // ---- 5. 模型不支持图片 → 能力门拦下 ----
  const blindEnv = makeEnv({ imageCapable: false })
  apply(blindEnv.ctx, configWith({ outputDir: scratch }))
  const blindTool = blindEnv.registered.find((definition) => definition.name === 'visual_capture')
  const blindMessage = await expectError('纯文本模型应当被拦下', () =>
    blindTool.execute({ source: 'screen', reason: '测试能力门' }, blindEnv.exec),
  )
  check('能力门提示换模型', blindMessage.includes('没有声明图片输入'), blindMessage)
  eq('能力门在授权之前生效', blindEnv.asked.length, 0)

  // ---- 6. 未配置 outputDir → 明确报错 ----
  const noDirEnv = makeEnv()
  apply(noDirEnv.ctx, configWith({ outputDir: '' }))
  const noDirTool = noDirEnv.registered.find((definition) => definition.name === 'visual_capture')
  const noDirMessage = await expectError('缺 outputDir 应当报错', () =>
    noDirTool.execute({ source: 'screen', reason: '测试配置缺失' }, noDirEnv.exec),
  )
  check('提示如何配置 outputDir', noDirMessage.includes('outputDir'), noDirMessage)

  // ---- 6b. 窗口不存在且没给启动命令 → 明确指路（不要含糊地说"没找到"）----
  const missingEnv = makeEnv()
  apply(missingEnv.ctx, configWith({ outputDir: scratch }))
  const missingTool = missingEnv.registered.find((definition) => definition.name === 'visual_capture')
  const missingMessage = await expectError('窗口不存在应当报错', () =>
    missingTool.execute(
      { source: 'window', window: 'ZZZ这个窗口一定不存在ZZZ', reason: '测试启动指路' },
      missingEnv.exec,
    ),
  )
  check('提示可用 launch 参数', missingMessage.includes('launch'), missingMessage)
  check('提示可配置 launchers', missingMessage.includes('launchers'), missingMessage)
  check('说明最小化窗口无需 launch', missingMessage.includes('最小化'), missingMessage)
  eq('找不到窗口时不弹授权', missingEnv.asked.length, 0)

  // ---- 7. 附件服务缺席时不崩，仍交回路径 ----
  const noAttachEnv = makeEnv({ withAttachments: false })
  apply(noAttachEnv.ctx, configWith({ outputDir: scratch }))
  const noAttachTool = noAttachEnv.registered.find((definition) => definition.name === 'visual_capture')
  const noAttachResult = await noAttachTool.execute({ source: 'file', reason: '测试无附件', filePath: pngPath }, noAttachEnv.exec)
  eq('无附件时只回文本', noAttachResult.content.length, 1)
  check('无附件时说明原因', noAttachResult.content[0].text.includes('附件服务未挂载'))

  // ---- 8. 参数校验 ----
  const badEnv = makeEnv()
  apply(badEnv.ctx, configWith({ outputDir: scratch }))
  const badTool = badEnv.registered.find((definition) => definition.name === 'visual_capture')
  const badSource = await expectError('非法 source 应当报错', () => badTool.execute({ source: 'nope', reason: 'x' }, badEnv.exec))
  check('非法 source 提示可选值', badSource.includes('screen'), badSource)
  const noReason = await expectError('缺 reason 应当报错', () => badTool.execute({ source: 'screen' }, badEnv.exec))
  check('缺 reason 提示用途', noReason.includes('reason'), noReason)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 汇总

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const line of failures) console.log(`  · ${line}`)
  process.exit(1)
}
console.log('全部通过')
