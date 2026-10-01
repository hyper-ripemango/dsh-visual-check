/** 注册测试用的解析钩子。配合 `node --import ./test/register.mjs` 使用。 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./loader.mjs', pathToFileURL(import.meta.filename))
