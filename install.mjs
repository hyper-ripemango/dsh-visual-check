#!/usr/bin/env node
/**
 * 把 dsh-visual-check 安装进 DSH profile。
 *
 * 做三件事（与 `dsh plugin --profile <p> add <dir>` 等价，但不需要 dsh CLI）：
 *   1. 把插件包复制到 `%DSH_HOME%\local-plugins\dsh-visual-check`
 *   2. 在 profile 的 package.json 里登记 `file:` 依赖与 `dsh.profile.bundles`
 *   3. 打印要加进 profile `cordis.patch.yml` 的 insert 片段
 *
 * 默认是 **dry-run**：只报告将要发生的改动，不落盘。确认无误后加 `--apply`。
 *
 * 为什么第 3 步不自动改 cordis.patch.yml：那个文件是人工维护的、带注释，
 * 而且 `insert` 只能写在这一处（两边都写会 duplicate loader entry id，
 * 整棵插件树加载失败）。让改动显式可见，比脚本偷偷追加更安全。
 *
 * 用法：
 *   node install.mjs                 # 预览
 *   node install.mjs --apply         # 复制并登记
 *   node install.mjs --apply --profile web --dsh-home D:\dsh
 */

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-visual-check'

/** 只复制运行需要的文件；probe / test 是开发资料，不进安装副本。 */
const INCLUDE = ['main.mjs', 'core.mjs', 'capture.mjs', 'grab', 'package.json', 'cordis.patch.yml', 'README.md']

function arg(flag, fallback) {
  const at = process.argv.indexOf(flag)
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

const apply = process.argv.includes('--apply')
const dryRun = !apply

const dshHome = resolve(arg('--dsh-home', process.env.DSH_HOME ?? ''))
const profile = arg('--profile', process.env.DSH_PROFILE ?? 'desktop')

if (dshHome.length === 0 || !existsSync(dshHome)) {
  console.error('找不到 DSH_HOME。请设置环境变量 DSH_HOME，或用 --dsh-home 指定。')
  process.exit(1)
}

const profileDir = join(dshHome, 'profiles', profile)
if (!existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`)
  console.error('用 --profile 指定正确的 profile 名。')
  process.exit(1)
}

const installDir = join(dshHome, 'local-plugins', PACKAGE_NAME)
const profilePkgPath = join(profileDir, 'package.json')

console.log(`${dryRun ? '【预览模式】' : '【写入模式】'}`)
console.log(`  源目录   : ${here}`)
console.log(`  DSH_HOME : ${dshHome}`)
console.log(`  profile  : ${profile}`)
console.log(`  安装到   : ${installDir}`)
console.log()

// ---- 1. 检查源文件 ---------------------------------------------------------
console.log('1) 待复制的文件')
for (const entry of INCLUDE) {
  const source = join(here, entry)
  if (!existsSync(source)) {
    console.error(`   ✗ 缺少 ${entry}`)
    process.exit(1)
  }
  if (entry === 'grab') {
    const inner = await readdir(source)
    console.log(`   · grab/ (${inner.length} 个文件)`)
  } else {
    console.log(`   · ${entry}`)
  }
}
console.log()

// ---- 2. profile package.json ----------------------------------------------
const profilePkg = JSON.parse(await readFile(profilePkgPath, 'utf8'))
profilePkg.dependencies ??= {}
profilePkg.dsh ??= {}
profilePkg.dsh.profile ??= {}
profilePkg.dsh.profile.bundles ??= []

const depSpec = `file:${installDir.replaceAll('\\', '/')}`
const depExists = profilePkg.dependencies[PACKAGE_NAME] === depSpec
const bundleExists = profilePkg.dsh.profile.bundles.includes(PACKAGE_NAME)
const profileNodeModules = join(profileDir, 'node_modules', PACKAGE_NAME)

console.log('2) profile package.json')
console.log(`   ${depExists ? '·' : '+'} dependencies["${PACKAGE_NAME}"] = "${depSpec}"`)
console.log(`   ${bundleExists ? '·' : '+'} dsh.profile.bundles += "${PACKAGE_NAME}"`)
console.log()
console.log('2b) profile node_modules')
// 这一步不能省。profile 用的是 pnpm `nodeLinker: hoisted`，loader 按**包名**从
// `profileDir/node_modules/<name>` 解析插件；只往 package.json 写依赖是不够的
// （除非再跑一次 pnpm install）。第一次就是漏了这里，插件装完 fiber 一直是 null、
// 工具始终不出现，而且没有任何日志，排查了很久。
console.log(`   ${existsSync(profileNodeModules) ? '·' : '+'} ${profileNodeModules}`)
console.log()

// ---- 3. cordis.patch.yml 片段 ---------------------------------------------
const snippet = [
  '  # 视觉复核插件：注册 visual_capture / visual_windows 工具，把屏幕、窗口、',
  '  # 区域或已有图片变成能进入模型视野的图，用于核对界面显示而不是解包 CSS/DOM。',
  '  #',
  '  # 硬规则：屏幕类截图每次都会先向用户申请授权；窗口被遮挡时默认报错，',
  '  # 只有显式 raise 才会临时置顶目标并在抓完后恢复原焦点。',
  '  #',
  '  # outputDir 必须显式配置：DSH 是长驻进程，cwd 不是会话工作区。',
  '  # cacheDir 留空则用系统临时目录（存放编译好的抓屏助手 DLL）。',
  '- insert:',
  `    - id: ${PACKAGE_NAME}`,
  `      name: '${PACKAGE_NAME}'`,
  '      config:',
  // YAML 单引号里反斜杠是**字面量**（只有 '' 表示一个单引号），所以绝不能把 `\`
  // 转义成 `\\`——那样写出来是双反斜杠的非法 Windows 路径。参照 profile 里既有的
  // `keyFile: 'C:\Users\...'` 写法。
  `        outputDir: '${join(dshHome, 'visual-checks')}'`,
  "        cacheDir: ''",
  '        defaultMaxPixels: 0',
  '        frugalMaxPixels: 1990000',
  '        timeoutMs: 60000',
].join('\n')

console.log(`3) 需要手动加进 ${join(profileDir, 'cordis.patch.yml')} 的片段：`)
console.log()
console.log(snippet)
console.log()
console.log('   注意：`insert` 只能写在这一处。写两处会 duplicate loader entry id，整棵树加载失败。')
console.log()

// ---- 4. 落盘 ---------------------------------------------------------------
if (dryRun) {
  console.log('预览结束，未做任何改动。确认后加 --apply 执行。')
  process.exit(0)
}

if (existsSync(installDir)) {
  const { rm } = await import('node:fs/promises')
  await rm(installDir, { recursive: true, force: true })
  console.log(`已清除旧副本 ${installDir}`)
}
await mkdir(installDir, { recursive: true })
for (const entry of INCLUDE) {
  await cp(join(here, entry), join(installDir, entry), { recursive: true })
}
console.log(`✓ 已复制插件 → ${installDir}`)

// profile node_modules：loader 真正按包名解析的位置。照 pnpm `hoisted` 的布局放一份。
// （等价的规范做法是跑一次 `pnpm install`，但那会改动整个 node_modules 树；
//   这里只添加本包一个目录，风险低得多。）
if (existsSync(profileNodeModules)) {
  const { rm } = await import('node:fs/promises')
  await rm(profileNodeModules, { recursive: true, force: true })
}
await mkdir(profileNodeModules, { recursive: true })
for (const entry of INCLUDE) {
  await cp(join(installDir, entry), join(profileNodeModules, entry), { recursive: true })
}
console.log(`✓ 已放入 profile node_modules → ${profileNodeModules}`)

profilePkg.dependencies[PACKAGE_NAME] = depSpec
if (!bundleExists) profilePkg.dsh.profile.bundles.push(PACKAGE_NAME)
await writeFile(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8')
console.log(`✓ 已登记依赖与 bundle → ${profilePkgPath}`)

console.log()
console.log('还需要两步：')
console.log(`  1. 把上面的片段加进 ${join(profileDir, 'cordis.patch.yml')}`)
console.log('  2. 重启 DSH（bundle 在进程启动时组装，必须完整退出后重开）')
console.log()
console.log('重启后可以让 Agent 调 visual_windows 验证是否装载成功。')
console.log('注意：Node 按 URL 缓存 ESM，改完插件代码必须重启才生效——开关插件条目不够。')
