/**
 * 假的 `@deepseek-ai/schemastery`，只用于离线测试。
 *
 * **只存在于测试进程**：插件目录刻意不放 node_modules。运行时这两个包由 DSH 的
 * `loader.internal.import` 提供真实现（`dsh-bili-notes` 没有任何 node_modules
 * 却能在生产里正常工作，这就是证据）。若在插件目录建软链，Node 会优先用最近
 * 的 node_modules，反而把 DSH 的真 schemastery 换成替身，`Config` 解析当场坏掉。
 *
 * 表面与 design-sketch 的替身保持一致，只支持本插件用到的部分。
 */

function makeNode(type, meta = {}) {
  const node = { type, ...meta }
  node.default = (value) => makeNode(type, { ...meta, defaultValue: value })
  node.description = (text) => makeNode(type, { ...meta, description: text })
  node.optional = () => makeNode(type, { ...meta, optional: true })
  node.required = () => makeNode(type, { ...meta, isRequired: true })
  return node
}

function object(shape = {}) {
  return { type: 'object', shape }
}

const z = {
  object,
  string: () => makeNode('string'),
  number: () => makeNode('number'),
  boolean: () => makeNode('boolean'),
  array: () => makeNode('array'),
  any: () => makeNode('any'),
  /** 与真实实现同签名：返回 `[resolvedConfig]`，默认值真的被填上。 */
  resolve(raw, schema) {
    const out = {}
    for (const [key, node] of Object.entries(schema?.shape ?? {})) {
      const value = raw?.[key]
      if (value !== undefined) {
        out[key] = value
        continue
      }
      if (node?.defaultValue !== undefined) out[key] = node.defaultValue
    }
    for (const [key, value] of Object.entries(raw ?? {})) if (!(key in out)) out[key] = value
    return [out]
  },
}

/** 取出 schema 里声明的默认值，用来在测试中构造配置对象。 */
export function defaultsOf(schema) {
  const out = {}
  for (const [key, node] of Object.entries(schema?.shape ?? {})) {
    if (node !== null && typeof node === 'object' && node.defaultValue !== undefined) out[key] = node.defaultValue
  }
  return out
}

export { z }
export default z
