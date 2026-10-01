/**
 * 解析钩子：把两个 DSH 包映射到 test/stubs 下的替身。
 *
 * 为什么需要它：`main.mjs` 会 `import` DSH 运行时才提供的包，离线跑不起来。
 * 用 `node --import ./test/register.mjs` 挂上本钩子即可离线驱动插件本体。
 *
 * 注意：替身只存在于测试进程里。插件目录**不放** node_modules，
 * 免得真机上解析到替身。
 */

const MAP = {
  '@deepseek-ai/dsh-tools': './stubs/dsh-tools.mjs',
  '@deepseek-ai/schemastery': './stubs/schemastery.mjs',
}

export async function resolve(specifier, context, nextResolve) {
  const target = MAP[specifier]
  if (target !== undefined) {
    return { url: new URL(target, import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
