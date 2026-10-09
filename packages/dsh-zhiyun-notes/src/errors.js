/**
 * 节笔记的失败类型。
 *
 * 单独一个模块，是为了打断 `note.js ↔ store.js` 的循环导入：两侧都要抛
 * 「输入不合法 / 存储没落成」这类**有名字**的失败。ESM 里循环导入能不能跑
 * 取决于使用点，那是运气，不是设计。
 *
 * code 取值（调用方按它决定降级还是重试）：
 * - `INPUT`   入参形状不对（缺 id、秒数不是整数…）—— 重试没用，调用方要改。
 * - `CONFIG`  注入的 store / domain 形状不认识 —— 是接线的错，不是数据的错。
 * - `LOAD`    读持久化失败 —— **必须抛出**：读不出来不等于「没有笔记」。
 * - `PERSIST` 写持久化失败 —— 抛出且**不改内存**（见 store.js 的提交顺序）。
 * - `CLOSED`  服务已卸载后又被调用。
 */
export class NoteError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'NoteError';
    this.code = code;
    this.details = details;
  }
}
