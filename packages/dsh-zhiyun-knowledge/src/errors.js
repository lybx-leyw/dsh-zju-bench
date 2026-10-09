/**
 * 知识入库的具名失败。
 *
 * 单独一个模块的理由与 parser / lecture 两包相同：host（宿主解析）、domain（键与
 * 记录校验）、index（插件与生命周期）三层都要抛同一族错误，各自 import 对方会成环。
 * 环在 ESM 里能不能跑取决于使用点，那是运气，不是设计。
 *
 * code 的取值就是集成层的分支依据：
 * - `CONFIG`   宿主存储栈解析不出来 / 形状不对 —— 环境问题，重试无用。
 * - `INPUT`    调用方给的编号、记录或检索词不合法 —— 输入问题，重试无用。
 * - `DISPOSED` 服务已随插件卸载 —— 生命周期问题，不该再调。
 */
export class KnowledgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.details = details;
  }
}
