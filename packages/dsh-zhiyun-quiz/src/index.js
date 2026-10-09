/**
 * **Cordis 插件包装（薄）**：只做两件事 —— 从注入项取窄 llm、把出题服务挂上 ctx。
 *
 * # 为什么是「薄」
 *
 * 本包的算法层（model / quality / generate / dedupe / lecture / store）必须能
 * **脱离宿主单测**：题形状是纯数据、硬检查是纯函数、出题器只依赖一个窄 llm 接口、
 * 领域服务不落盘。宿主相关的取舍（用哪个模型、并发配多少、缓存 / 数据放哪）
 * 一律留给集成层 —— 那些是会随宿主变化的东西，混进算法层就会让「同一份算法」
 * 在换宿主时被迫改。
 *
 * # ⚠️ 本文件**不碰宿主存储服务**
 *
 * 课题约束：本包不落盘、不读环境变量。题目 / 作答 / 额度台账的持久化
 * 由**集成层**用宿主的存储服务负责 —— 那是宿主已有的能力，
 * 在这里自己写一遍文件就是本仓明令禁止的「重复造轮子」。
 * 本文件只通过 `ctx.provide('zhiyunQuiz', …)` 交出**领域服务**，
 * 由集成层决定把它接到哪一层存储上。
 *
 * # llm 从哪来
 *
 * 宿主的 `ctx.llm` 服务形状是 `prepareCall / stream`（流式、带模型解析），
 * 而本包要的是窄接口 `call({stage, route, constant, variable, signal})`。
 * 那层适配**已经存在**：`dsh-zhiyun-parser` 的 `HarnessLlm` 就是它，
 * 且它挂在 `ctx.zhiyunParser.llm` 上（study / lecture 两个包已经在这样用）。
 * 所以这里直接取用，而不是再写第四个适配器 —— 本仓对「同一件事有两份实现」
 * 是明令禁止的（两条路会在半年内无声漂开）。
 *
 * 若集成层要用别的适配器，`config.llm` 可以直接注入一个同形状的对象。
 */

import { QuizError } from './quality.js';
import { createQuizGenerator } from './generate.js';
import { createQuizStore } from './store.js';

export const name = 'zhiyun-quiz';

/**
 * 依赖声明：`zhiyunParser` 提供宿主适配好的窄 llm。
 *
 * ⚠️ 声明它（而不是 `llm`）是有意的：直接用 `ctx.llm` 就得在本包内重写一遍
 * `prepareCall / resolveModelInfo / stream` 的适配，那是解析器包已有的活。
 * 声明依赖也让「谁提供模型」这件事对宿主可见 —— 靠 `ctx.llm` 猜出来
 * 反而是隐式魔法。
 *
 * ⚠️ **只声明它真正需要的**：本包不声明 `storage` —— 因为本包**不落盘**。
 * 谁要持久化谁去声明，那是集成层的依赖。
 */
export const inject = ['zhiyunParser'];

export async function apply(ctx, config = {}) {
  const llm = config.llm ?? ctx.zhiyunParser?.llm;
  if (!llm || typeof llm.call !== 'function') {
    throw new QuizError('CONFIG', '出题需要注入窄 llm 接口（{ call({stage,route,constant,variable,signal}) }）；'
      + '宿主侧由 zhiyunParser 提供，也可用 config.llm 直接给出');
  }

  // 路由**延迟解析**：插件激活不该因为「模型还没配好」而失败 ——
  // 没配模型时用户仍应能用题形状、硬检查、去重（那三条一次模型调用都不发）。
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

  const generator = createQuizGenerator({
    llm: {
      call: async (request) => {
        const resolved = await resolveRoute(request.signal);
        return llm.call({ ...request, route: request.route ?? resolved });
      },
    },
    concurrency: config.concurrency,
    now: config.now,
    idFactory: config.idFactory,
    pipeline: config.pipeline ?? null,
  });

  // 领域服务：**不落盘**，集成层用宿主的存储服务接手持久化。
  const store = createQuizStore({ now: config.now });

  const service = {
    generate: generator.generate,
    dispose: generator.dispose,
    /** 题库领域服务（题目 / 作答 / 额度台账的形状与判定）。 */
    store,
    get concurrency() { return generator.concurrency; },
    get active() { return generator.active; },
    get closed() { return generator.closed; },
  };

  const removeService = ctx.provide('zhiyunQuiz', service);
  return () => {
    // ⚠️ 先中断在飞的请求，再摘服务：反过来会让刚被调用的 generate 在
    //    服务已消失之后还往模型端点发请求（白花钱，而且没人收结果）。
    generator.dispose();
    if (typeof removeService === 'function') removeService();
  };
}
