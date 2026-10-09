/**
 * 解析器的失败类型。
 *
 * 单独一个模块是为了打断 `llm.js ↔ accel.js` 的循环导入：档位归一与截断升档
 * 都要能抛「配置错」这种**有名字**的失败（不许静默降级成默认值），而它们被
 * `llm.js` 复用。循环导入在 ESM 里能不能跑取决于使用点，那是运气，不是设计。
 */
export class ParserError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ParserError'; this.code = code; this.details = details; }
}
