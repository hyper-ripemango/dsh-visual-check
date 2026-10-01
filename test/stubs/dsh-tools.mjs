/**
 * 假的 `@deepseek-ai/dsh-tools`。
 *
 * 真实现由 DSH 在运行时提供。这里除了 `defineTool(options) → options`，
 * 还**故意复刻真实现的 schema 校验**——把形状错误提前暴露在离线测试里，
 * 而不是等到重启 DSH 才发现工具注册失败。
 *
 * 最关键的一条：`parameters` 必须是**扁平属性表**（名 → 值 schema），不是 JSON Schema。
 * 写成 `{ type: 'object', properties: {...} }` 时，真实现会把 `type: 'object'` 当成一个
 * 名叫 `type` 的参数，报：
 *
 *   JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object
 *
 * 这个坑第一次真的漏到重启后才被发现（fiber 一直是 null，工具不出现），所以在这里拦住。
 * 反过来，`output.schema` **才是** JSON Schema 形状——两者容易弄反。
 */

/** 真实现接受的参数值类型。 */
const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'json', 'any'])

function assertPropertyMap(label, spec) {
  if (spec === null || typeof spec !== 'object') throw new TypeError(`${label} 需要对象`)
  for (const [key, node] of Object.entries(spec)) {
    if (node === null || typeof node !== 'object') {
      throw new TypeError(`${label}.${key} 必须是值 schema 对象`)
    }
    if (typeof node.type !== 'string' || !VALUE_TYPES.has(node.type)) {
      throw new TypeError(
        `${label}.${key} 的 type 非法（${JSON.stringify(node.type)}）。` +
          '若这是把 JSON Schema 误当成属性表，说明写法反了：parameters 要扁平属性表，output.schema 才是 JSON Schema。',
      )
    }
    if (node.required !== undefined && typeof node.required !== 'boolean') {
      throw new TypeError(`${label}.${key}.required 必须是 boolean`)
    }
  }
}

export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('defineTool 需要选项对象')
  if (typeof options.name !== 'string' || options.name.length === 0) throw new TypeError('defineTool 需要 name')
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new TypeError(`工具 ${options.name} 需要 description`)
  }
  if (options.parameters === null || typeof options.parameters !== 'object') {
    throw new TypeError(`工具 ${options.name} 需要 parameters`)
  }
  assertPropertyMap(`${options.name}.parameters`, options.parameters)
  if (typeof options.execute !== 'function') throw new TypeError(`工具 ${options.name} 需要 execute`)
  if (options.output === null || typeof options.output !== 'object') {
    throw new TypeError(`工具 ${options.name} 需要 output`)
  }
  if (typeof options.output.render !== 'function') {
    throw new TypeError(`工具 ${options.name} 需要 output.render`)
  }
  const schema = options.output.schema
  if (schema === null || typeof schema !== 'object') {
    throw new TypeError(`工具 ${options.name} 需要 output.schema`)
  }
  if (schema.type !== 'object' || schema.properties === null || typeof schema.properties !== 'object') {
    throw new TypeError(
      `工具 ${options.name} 的 output.schema 必须是 { type: 'object', properties: {...} }——` +
        '这一处才是 JSON Schema 形状，别和 parameters 弄反。',
    )
  }
  assertPropertyMap(`${options.name}.output.schema.properties`, schema.properties)
  return options
}

export default { defineTool }
