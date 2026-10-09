/**
 * **Cordis 插件包装（薄）**：把宿主存储栈接上，把知识库服务挂到 `ctx`。
 *
 * # 唯一的持久化通道是宿主存储栈
 *
 * 本包**没有**任何文件读写：不 `node:fs`、不 tmp+rename、不自建 JSON 索引。
 * 数据由 `ctx.storageDomain` 打开的域负责落盘（本仓 profile 里 `storage-domain`
 * 配的是 `backend: json`，root = `dshHomePath('storages')`，即
 * `~/.dsh/storages/zhiyun_knowledge.json` 这样一份**宿主看管的**文档）。
 * 这一条不是风格偏好：之前学习面板自己写 `results/<sha256>.json`，键是哈希，
 * 「这份结果属于哪个账号的哪门课」从盘上根本读不出来，也就谈不上按课程检索。
 *
 * # 为什么 `inject` 声明的是 `storageDomain` 而不是运行时再查 `ctx.storage`
 *
 * Cordis 的 `inject` 是**等待**语义：服务没就绪时 `apply` 不会被调用，所以不存在
 * 「hub 起来了、域层还没挂上」那个竞窗（域层自己也要先等它路由的后端就绪）。
 * 运行期再查会把这个竞窗变成偶发失败。代价是：若 profile 根本没挂
 * `storage-domain`，本插件会一直等下去（Cordis 的挂起语义）—— 这是 profile
 * 的配置问题，本包 README 写明了前提。
 *
 * # 卸载
 *
 * 返回的 disposer 按「先封入口、再释放域」的顺序收尾：反过来的话，句柄释放后
 * 仍在飞的调用会以一个看不懂的宿主错误（`closed`）失败，而不是本包的
 * `DISPOSED` —— 后者才说得清「是插件卸载了」。
 */
import { KnowledgeError } from './errors.js';
import { createLectureSpec, DOMAIN_NAME, LECTURES_TABLE } from './domain.js';
import { createKnowledgeService } from './service.js';
import { loadHostStorage, assertHostStorage } from './host.js';

export const name = 'zhiyun-knowledge';

/**
 * 依赖声明。
 *
 * - `storageDomain`：域的宿主入口（`ctx.storageDomain.open(spec)`）。
 * - `profileContext`：模块解析的锚点（宿主启动时注入 profile 目录）。
 *
 * ⚠️ 两条都是**硬依赖**（Cordis 的 `inject` 是等待语义，不是可选提示）：缺
 *    `profileContext` 时插件不会被激活，而不是"退化成不用存储"。
 *    即便用 `config.storage` 直接注入宿主栈（离线用例/别的嵌入方），
 *    `profileContext` 仍然要在 —— 它与「用哪份宿主栈」是两件事：
 *    前者是本包声明的宿主前提，后者只决定**从哪里取**那份栈。
 */
export const inject = ['storageDomain', 'profileContext'];

/**
 * 挂载知识库。
 *
 * @param ctx Cordis 上下文。
 * @param config 可选配置：
 * - `config.storage`：直接给出宿主栈 `{ defineDomain, domainTable, z }`，
 *   跳过 profile 解析。给离线用例与别的嵌入方用（`profileContext` 依旧要提供：
 *   它由宿主启动时注入，只是这条路不再读它）。
 * - `config.domain`：换成别的域规格（例如测试里想要独立介质）。默认本包的 `lectures` 域。
 * @returns disposer：封住服务入口 → 释放域 → 摘掉服务。
 */
export async function apply(ctx, config = {}) {
  const facility = ctx.storageDomain;
  if (facility === null || facility === undefined || typeof facility.open !== 'function') {
    throw new KnowledgeError('CONFIG', '缺少 ctx.storageDomain：知识库的持久化只走宿主域存储'
      + '（profile 需要挂载 @deepseek-ai/dsh-storage-domain），本包不自建落盘');
  }

  // 宿主栈：优先用显式注入的（离线用例/别的宿主），否则从 profile 目录解析。
  // 解析只做一次，spec 也只声明一次 —— 域按名字单开，重复 open 由宿主如实拒绝。
  const host = config.storage === undefined
    ? await loadHostStorage(ctx.profileContext?.dir)
    : assertHostStorage(config.storage, 'config.storage');
  const spec = config.domain ?? createLectureSpec(host);

  // 宿主 open 会：解析后端路由 → 要求 kv facet → 读介质 → **按 schema 校验每一条存量记录**。
  // 存量里有坏记录时它会以 `invalid-record` 带表名与键抛出来；本包**不吞**这个错：
  // 静默把坏记录当"没有这条"正是本任务明令禁止的。
  const domain = await facility.open(spec);

  let service;
  try {
    service = createKnowledgeService({ domain, spec });
  } catch (error) {
    await domain.close();   // 服务建不起来就别把域晾在那儿
    throw error;
  }

  // `provide` 本身也可能失败（同名服务已被占）。那种情况下域已经开了，
  // 必须在这里就放掉 —— 否则一次失败的挂载会永久占住域名，之后再也 open 不上。
  let removeService;
  try {
    removeService = ctx.provide('zhiyunKnowledge', service);
  } catch (error) {
    await service.close();
    await domain.close();
    throw error;
  }

  let disposed;
  return async () => {
    // 幂等：Cordis 可能只调一次，但手工 dispose 与 fiber 卸载叠加时不该重复收尾。
    disposed ??= (async () => {
      // 先封入口（此后调用得到 DISPOSED，而不是宿主的 closed），再释放域；
      // 用 finally 保住摘服务这一步：域释放失败也不该让一个已死的服务留在 ctx 上。
      try {
        await service.close();
        await domain.close();
      } finally {
        if (typeof removeService === 'function') removeService();
      }
    })();
    return disposed;
  };
}

/** 供集成层核对：本包声明的域名与表名（接线方不必去猜字符串）。 */
export { DOMAIN_NAME, LECTURES_TABLE, keyOf } from './domain.js';
