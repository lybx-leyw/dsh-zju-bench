/**
 * **Cordis 插件包装（薄）**：只做两件事 —— 从注入项取 llm、把加工器挂上 ctx。
 *
 * # 为什么是「薄」
 *
 * 本包的算法层（tree / register / polish）必须能**脱离宿主单测**：知识树是纯函数、
 * 验收是纯函数、习坎只依赖一个窄 llm 接口。宿主相关的取舍（用哪个模型、
 * 缓存放哪、并发配多少）一律留给集成层 —— 那些是会随宿主变化的东西，
 * 混进算法层就会让「同一份算法」在换宿主时被迫改。
 *
 * # ⚠️ 本文件**不碰** ctx.storage
 *
 * 课题约束：本包不落盘、不读环境变量。加工缓存（哪些知识点已经写成了稿）
 * 由集成层用宿主 `ctx.storage` 负责 —— 那是宿主已有的能力，
 * 在这里自己写一遍文件就是本仓明令禁止的「重复造轮子」。
 *
 * # llm 从哪来
 *
 * 宿主的 `ctx.llm` 服务形状是 `prepareCall / stream`（流式、带模型解析），
 * 而本包要的是窄接口 `call({stage, route, constant, variable, signal})`。
 * 那层适配**已经存在**：`dsh-zhiyun-parser` 的 `HarnessLlm` 就是它，
 * 且它挂在 `ctx.zhiyunParser.llm` 上（study 包已经在这样用）。
 * 所以这里直接取用，而不是再写第三个适配器 —— 本仓对「同一件事有两份实现」
 * 是明令禁止的（两条路会在半年内无声漂开）。
 *
 * 若集成层要用别的适配器，`config.llm` 可以直接注入一个同形状的对象。
 */

import { createLectureAssembler } from './polish.js';
import { buildLectureTree } from './tree.js';
import { judgeWritten } from './register.js';
import { LectureError } from './errors.js';

export const name = 'zhiyun-lecture';

/**
 * 依赖声明：`zhiyunParser` 提供宿主适配好的窄 llm。
 *
 * ⚠️ 声明它（而不是 `llm`）是有意的：直接用 `ctx.llm` 就得在本包内重写一遍
 *    `prepareCall / resolveModelInfo / stream` 的适配，那是解析器包已有的活。
 *    声明依赖也让「谁提供模型」这件事对宿主可见 —— 靠 `ctx.llm` 猜出来
 *    反而是隐式魔法。
 */
export const inject = ['zhiyunParser'];

export async function apply(ctx, config = {}) {
  const llm = config.llm ?? ctx.zhiyunParser?.llm;
  if (!llm || typeof llm.call !== 'function') {
    throw new LectureError('CONFIG', '讲义加工需要注入窄 llm 接口（{ call({stage,route,constant,variable,signal}) }）；'
      + '宿主侧由 zhiyunParser 提供，也可用 config.llm 直接给出');
  }

  // 路由**延迟解析**：插件激活不该因为「模型还没配好」而失败 ——
  // 没配模型时用户仍应能用知识树与书面语验收（那两条一次模型调用都不发）。
  let route;
  let resolving;
  const resolveRoute = async (signal) => {
    if (route !== undefined) return route;
    if (typeof llm.resolve !== 'function') return undefined;
    resolving ??= llm.resolve(signal)
      .then((routes) => { route = routes?.text ?? routes?.vision; return route; })
      .finally(() => { resolving = null; });
    return resolving;
  };

  const assembler = createLectureAssembler({
    llm: {
      call: async (request) => {
        const resolved = await resolveRoute(request.signal);
        return llm.call({ ...request, route: request.route ?? resolved });
      },
    },
    concurrency: config.concurrency,
    maxTopics: config.maxTopics,
    maxChars: config.maxChars,
  });

  // 暴露给集成层：光有 assemble 不够 —— 树与验收是它拼装输入前的两步。
  //
  // ⚠️ 把这两个纯函数**一起挂上来**是有意的：它们是 assemble 的输入契约
  //    （树决定分章分知识点、验收决定正文算不算成稿）。集成层如果自己
  //    `import` 子路径去拼，就等于把「输入到底该长什么样」在两处各写一遍 ——
  //    那正是本仓说过的「同一件事有两份实现，半年内无声漂开」。
  const service = {
    assemble: assembler.assemble,
    buildTree: buildLectureTree,
    judgeWritten,
    dispose: assembler.dispose,
    get concurrency() { return assembler.concurrency; },
    get active() { return assembler.active; },
    get closed() { return assembler.closed; },
  };

  const removeService = ctx.provide('zhiyunLecture', service);
  return () => {
    // ⚠️ 先中断在飞的请求，再摘服务：反过来会让刚被调用的 assemble 在
    //    服务已消失之后还往模型端点发请求（白花钱，而且没人收结果）。
    assembler.dispose();
    if (typeof removeService === 'function') removeService();
  };
}
