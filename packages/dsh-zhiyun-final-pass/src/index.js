/**
 * 无曰终审：把一节讲义交给**宿主原生的 agent 运行时**自由整理。
 *
 * # 为什么是 agent，不是「再发一次 llm.call」
 *
 * App 的 `lib/fusion/lecture_final_pass.dart` 写得很清楚：「整齐规范」
 * **说不成一句能塞进 JSON 的指令**，上一版正是死在这里。所以这一层要的是一个能
 * **自己分段读、自己判断、反复多轮改、改完再读一遍**的执行者 —— 那是 agent 的活。
 *
 * 本包**不自己实现任何 agent 机制**，而是接在宿主现成的 agent 架构上：
 *
 * | 用到的宿主服务 | 包 | 干什么 |
 * |---|---|---|
 * | `ctx.agents`（`AgentRegistry`） | `@deepseek-ai/dsh-agent` | 建立并持有一个「终审」根 agent（定 cwd / 预设 / 模型） |
 * | `ctx.subagents`（`SubagentRuntime`） | `@deepseek-ai/dsh-subagent` | 每一节**委派一个一次性子 agent**，由它真正读写文件、多轮改稿 |
 * | `ctx.fs`（`FileSystem`） | `@deepseek-ai/dsh-fs` | 写出待整理的讲义、读回改完的讲义（不另开 node:fs 旁路） |
 * | `ctx.profileContext` | 宿主启动器 | 默认工作目录挂在 profile 数据目录下 |
 *
 * 「agent 要能自己读写文件」这件事**照样是复用**：文件工具（`read` / `write` /
 * `edit` / `pwsh`）来自宿主既有的 agent 预设（`ctx.agentPresets` 的 `mount()`），
 * 子 agent 通过宿主自己的 `applyChildComposition()` 继承父 agent 的预设。
 * 本包**不注册任何工具** —— 自己再注册一套 `read`/`write` 就是造轮子。
 *
 * # 真实签名（读自宿主 `lib/types/*.d.ts` 与 `.ref/packages/` 参考实现）
 *
 * - `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`
 *   `CreateAgentOptions = { sessionId, parentAgent?, meta?: {cwd?, parentSession?,
 *   isSeeded?, origin?, delegationDepth?, agentPreset?}, seed?, agentOptions?,
 *   signal?, setup?: (agentCtx, agent) => … }`；返回的 handle 是**唯一**拥有
 *   该 agent 拆卸权的凭据（`handle.dispose()`）。
 * - `ctx.subagents.start(name, request: SubagentStartRequest): Promise<SubagentRun>`
 *   `SubagentStartRequest = { label?, prompt: ContentBlock[], parent: Agent,
 *   signal: AbortSignal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`。
 *   `SubagentRun = { id, localAgent, result: Promise<SubagentResult>, dispose() }`，
 *   而 `SubagentResult = { output, structured?, diagnostic?, stopReason }`，
 *   `stopReason ∈ { completed, aborted, error, 'max-tokens', refusal }`。
 *   `result` **不会**因「子 agent 层面失败」而 reject —— 它如实给出 `stopReason`，
 *   这正是本包判定「跑没跑成」的依据（而不是靠猜）。
 *   `persona` 与 `toolFilter` 由宿主在子 agent 的 creation window 里落点
 *   （`deployment:persona-prefix` 段 / `tools.restrict()`），前提是所选 provider
 *   声明了对应 capability（`spawn` 全部支持）。
 * - `ctx.fs.resolve(path, {cwd}) → FsTarget`；
 *   `writeText(target, content, expected?, signal?, sandboxPolicy?)`；
 *   `readText(target, signal?)`。写文件要自己带 `sandboxPolicy`
 *   （`ctx.sandboxPolicy.resolve({session})`），否则 plugin 的写入按「无 session」
 *   解析成部署默认根，落在 agent 的 cwd 之外会被沙箱拒绝。
 *
 * # 与 App 的分工（刻意保留的缝）
 *
 * App 的 `WuyueRunner` 端口签名是 `run({lecture, sectionId, workDir})`，返回
 * **合回结构**的 `Lecture`。JS 这边的讲义模型（导出/合回）属于讲义装配那个包，
 * 不在本包写作范围内 —— 所以本包暴露的是它下面那一层：**给定「喂给 agent 的文本」
 * 与节 id，跑完一次终审，把改完的文本交回来**。导出与合回由调用方按自己的模型做，
 * 这与 App 把 `runWuyueSecondPass` 与 `mergeAgentLectureText` 分成两层是同一个形状。
 *
 * # 失败语义（App 端口注释里的硬要求）
 *
 * 「拿不到结果时必须抛错，不要返回『原讲义 + 空 report』冒充跑过了」——
 * 「跑过但没改」与「根本没跑」在用户眼里是两件事。所以：
 * 子 agent 的 `stopReason !== 'completed'`、超时、取消、文件读不回、
 * 标记行被改坏，**一律抛 [FinalPassError]**，绝不返回成功。
 * 只有真的跑完（且文件读得回来）才返回 report；此时 `unchanged` 会如实标出
 * 「文件没变」这个事实 —— 它是事实，不是失败。
 *
 * @module dsh-zhiyun-final-pass
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { WUYUE_SYSTEM_PROMPT, wuyueTaskText } from './prompts.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'zhiyun-final-pass';

/**
 * 真正依赖的宿主服务名 —— 不多不少：
 * `agents`（建立终审 agent）、`subagents`（逐节委派）、`fs`（读写讲义文件）、
 * `profileContext`（默认工作目录）。
 *
 * 刻意**不**列 `agentPresets` / `sandboxPolicy` / `permissionPresets` /
 * `agentDefaultModel`：它们都是「有就用、没有就退到宿主既有行为」的可选能力，
 * 写成硬依赖会让本插件在没有它们的最小组合里静默不激活
 * （宿主自己的 `applyChildComposition()` 读预设也是这个 `ctx.get` 口径）。
 */
export const inject = ['agents', 'subagents', 'fs', 'profileContext'];

/** 节 id 允许的字符：它要拼进文件名，所以这里收紧而不是靠沙箱兜底。 */
const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 讲义文本里的三个标记（与 App `lecture_final_pass.dart` 同一套）。 */
const SECTION_MARK = /^#!section /m;
const TOPIC_MARK = /^##!topic /gm;
const BLOCK_MARK = /^>>> BLOCK /gm;

/** 默认超时：一节讲义的整理给 30 分钟，够几十轮工具往返。 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 终审失败。**带着稳定 code 与原因**，调用方据此决定降级还是重试 ——
 * 绝不吞掉原因返回一个「看起来跑过了」的结果。
 *
 * `code` 取值：
 * - `INPUT` 入参不合法（文本为空、节 id 含路径字符）
 * - `DISPOSED` 服务已卸载
 * - `BUSY` 已有一节在跑（串行，与 App 一节一份任务的形状一致）
 * - `NO_PROVIDER` 宿主的 `ctx.subagents` 上没有配置的那个 provider
 * - `PROVIDER_UNSUPPORTED` provider 不支持 `persona`（没有 persona 就不是终审）
 * - `TIMEOUT` 超时
 * - `ABORTED` 被调用方的取消信号中止
 * - `AGENT_START_FAILED` 委派在子 agent 发布前就失败（基础设施故障）
 * - `AGENT_FAILED` 子 agent 跑完但它自己失败了（`stopReason` 如实带出）
 * - `FORMAT` 改完的文本读不回 / 标记行被改坏
 */
export class FinalPassError extends Error {
  /**
   * @param {string} code - 稳定错误码，见类文档。
   * @param {string} message - 给人看的原因。
   * @param {{cause?: unknown, stopReason?: string, diagnostic?: string}} [details] - 结构化细节。
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'FinalPassError';
    this.code = code;
    /** 子 agent 的终止原因（`SubagentResult.stopReason`），能拿到时带上。 */
    this.stopReason = details.stopReason;
    /** provider 自述的失败细节（`SubagentResult.diagnostic`）。 */
    this.diagnostic = details.diagnostic;
  }
}

/**
 * 数一份讲义文本的形状（知识点数 / 块数）。
 *
 * **只数标记行，不做质量判断** —— 与 App `parseAgentLectureText` 的注释同一条原则：
 * 块名合不合规、字数对不对，那是 agent 的判断范围，不是这里的事。
 * 这里够用的只有一件事：报出「形状有没有变」这个事实，供调用方与日志看。
 *
 * @param {string} text - 讲义文本。
 * @returns {{topics: number, blocks: number}} 知识点数与块数。
 */
export function countShape(text) {
  return {
    topics: (text.match(TOPIC_MARK) ?? []).length,
    blocks: (text.match(BLOCK_MARK) ?? []).length,
  };
}

/** 合并 `AbortSignal`：任一中止即中止；返回 `{signal, cleanup}`。 */
function fuseSignals(signals) {
  const controller = new AbortController();
  const listeners = [];
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, abort: reason => controller.abort(reason), cleanup: () => { for (const off of listeners) off(); } };
}

/** 从 `SubagentResult.output`（`ContentBlock[]`）里取人看的文本。 */
function outputText(output) {
  if (!Array.isArray(output)) return '';
  return output
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/**
 * 无曰终审服务（`ctx.zhiyunFinalPass`）。
 *
 * 持有**一个**宿主根 agent 作为委派起点（定 cwd / 预设 / 模型），每节委派一个
 * 一次性子 agent 真正干活 —— 与 App「一个 ZhiyunAgent 跑一节」不同的一处：
 * 这里把「编辑器」放在子 agent 里、父 agent 只做委派起点，好处是 persona、
 * 工具可见性、递归预算、取消与拆卸**全部由宿主既有的委派机制负责**
 * （`SubagentRun.result.stopReason` 就是现成的失败语义）。
 */
export class ZhiyunFinalPass {
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx;

  /** @type {import('@deepseek-ai/dsh-agent').AgentHandle | undefined} */
  #handle;

  /** @type {import('@deepseek-ai/dsh-subagent').SubagentRun | undefined} */
  #run;

  /** 正在跑的那一节（串行）。 */
  #active;

  #disposed = false;

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {object} [config] - 插件配置。
   * @param {string} [config.cwd] - 终审 agent 的工作目录（也是讲义文件目录、沙箱 workspace-write 边界）。默认 `<profileContext.dir>/data/zhiyun-final-pass`。
   * @param {string} [config.provider] - `ctx.subagents` 上的 provider 名，默认 `spawn`。
   * @param {string} [config.agentPreset] - 挂在终审 agent 上的 agent 预设 id；省略则用宿主预设注册表的默认预设（文件工具由此而来）。
   * @param {string} [config.permissionPreset] - 显式写进终审 session 的权限预设；省略则沿用宿主给新 session 的默认（最小权限）。
   * @param {number} [config.timeoutMs] - 单节超时，默认 30 分钟。
   * @param {number} [config.maxDepth] - 委派深度上限，透传给 `ctx.subagents.start`。
   * @param {{allow?: string[], deny?: string[]}} [config.toolFilter] - 子 agent 的工具范围，透传给宿主。
   * @param {{provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number}} [config.agentOptions] - 显式模型路由；省略则读 `ctx.agentDefaultModel`。
   */
  constructor(ctx, config = {}) {
    this.#ctx = ctx;
    const fallback = path.join(ctx.profileContext.dir, 'data', 'zhiyun-final-pass');
    this.cwd = path.resolve(typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : fallback);
    this.provider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn';
    this.agentPreset = typeof config.agentPreset === 'string' && config.agentPreset.length > 0 ? config.agentPreset : undefined;
    this.permissionPreset = typeof config.permissionPreset === 'string' && config.permissionPreset.length > 0 ? config.permissionPreset : undefined;
    this.timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxDepth = config.maxDepth;
    this.toolFilter = config.toolFilter;
    this.agentOptions = config.agentOptions;
  }

  /** 当前的终审根 agent（尚未建立时为 `undefined`）。 */
  get agent() {
    return this.#handle?.agent;
  }

  /** 给日志与界面看的自述。 */
  describe() {
    const selection = this.#resolveAgentOptions({});
    return {
      cwd: this.cwd,
      provider: this.provider,
      agentPreset: this.agentPreset ?? '(宿主默认预设)',
      permissionPreset: this.permissionPreset ?? '(继承宿主默认)',
      timeoutMs: this.timeoutMs,
      agentId: this.#handle?.agent?.id,
      running: this.#active !== undefined,
      disposed: this.#disposed,
      model: selection,
    };
  }

  /** 模型路由：显式配置优先，其次宿主的默认模型选择（与宿主入口点同一口径）。 */
  #resolveAgentOptions(extra) {
    const selection = this.#ctx.get('agentDefaultModel')?.currentSelection();
    return {
      ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
      ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      ...this.agentOptions,
      ...extra,
    };
  }

  /**
   * 建立（或取回）终审根 agent。
   *
   * **懒建立**：不在 `apply()` 里建 —— 那会在宿主启动时就凭空多出一个空 session，
   * 而 agent 工厂（`ctx.agentLoop` 注册到 `ctx.agents` 的 factory）也可能晚于本插件激活。
   * 权限与预设都走宿主：预设 `mount()` 进 agent 的 creation window，
   * 于是文件工具与 persona 落点都是宿主既有的机制，不是本包自己装的。
   *
   * @param {AbortSignal} signal - 创建期取消。
   * @returns {Promise<import('@deepseek-ai/dsh-agent').Agent>} 已发布的根 agent。
   */
  async #ensureAgent(signal) {
    if (this.#handle !== undefined) return this.#handle.agent;
    const presets = this.#ctx.get('agentPresets');
    const agentOptions = this.#resolveAgentOptions({});
    let handle;
    try {
      handle = await this.#ctx.agents.create({
        sessionId: `zhiyun-final-pass-${randomUUID()}`,
        meta: { cwd: this.cwd },
        ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
        signal,
        // setup 只做「组装」：把宿主预设挂到这个 agent 自己的 scope 上。
        // 子 agent 由此继承文件工具与部署口径（宿主的 applyChildComposition 读父预设）。
        setup: async agentCtx => {
          if (presets === undefined) return;
          await presets.mount(agentCtx, this.agentPreset);
        },
      });
    } catch (error) {
      // 建立失败也要如实带原因、能被 code 分支：
      // 没有 agent 工厂、模型路由没配、预设不存在，都会在这里现形。
      throw new FinalPassError('AGENT_START_FAILED', `建立终审 agent 失败：${error?.message ?? String(error)}`, { cause: error });
    }
    if (this.#disposed) {
      // 卸载与建立赛跑：谁后到谁收拾，绝不留下没人拥有的 agent。
      await handle.dispose();
      throw new FinalPassError('DISPOSED', '终审服务在建立 agent 期间被卸载。');
    }
    this.#handle = handle;
    if (this.permissionPreset !== undefined) {
      this.#ctx.get('permissionPresets')?.set(handle.agent.session, this.permissionPreset);
    }
    return handle.agent;
  }

  /** 解析一次读的沙箱策略：以终审 session 的 cwd 为 workspace-write 边界。 */
  #writePolicy() {
    const session = this.#handle?.agent?.session;
    return this.#ctx.get('sandboxPolicy')?.resolve(session === undefined ? undefined : { session });
  }

  /**
   * 取消检查：**抛本包的错误类型**，不把 `AbortError` 漏给调用方。
   * 调用方拿到的每一个失败都应当能按 `code` 分支，取消也不例外。
   *
   * 超时也是经由同一个信号中止的，所以这里必须**先认超时**，
   * 否则「超时」会被报成「调用方取消」——那是把原因说错了。
   */
  #throwIfAborted(signal, sectionId, timedOut = () => false) {
    if (timedOut()) {
      throw new FinalPassError('TIMEOUT', `终审超时（${this.timeoutMs}ms）：${sectionId}`, { cause: signal.reason });
    }
    if (signal.aborted) throw new FinalPassError('ABORTED', `终审被取消：${sectionId}`, { cause: signal.reason });
  }

  /** 读回文件；读不回就抛，不返回空串假装成功。 */
  async #readText(target) {
    try {
      return await this.#ctx.fs.readText(target);
    } catch (error) {
      throw new FinalPassError('FORMAT', `读不回终审改完的文件：${target.displayPath}${error?.code === undefined ? '' : `（${error.code}）`}`, { cause: error });
    }
  }

  /**
   * 跑一节的终审。
   *
   * 流程与 App `runWuyueSecondPass` 同形：写出讲义 → 交给 agent 自己改 →
   * 读回改完的文本 → 交回调用方（导出与合回由调用方按自己的模型做）。
   *
   * @param {object} request - 本次任务。
   * @param {string} request.text - 喂给 agent 的讲义全文（调用方从自己的讲义模型导出）。
   * @param {string} request.sectionId - 节 id，同时是文件名（只允许 `[A-Za-z0-9._-]`）。
   * @param {AbortSignal} [request.signal] - 调用方取消信号。
   * @returns {Promise<object>} 终审报告（含改完的 `text`）。
   * @throws {FinalPassError} 任何没跑成的情况，见 [FinalPassError] 的 code 表。
   */
  async run({ text, sectionId, signal } = {}) {
    if (this.#disposed) throw new FinalPassError('DISPOSED', '终审服务已卸载，请重新加载插件。');
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new FinalPassError('INPUT', '终审需要一份非空的讲义文本。');
    }
    if (typeof sectionId !== 'string' || !SECTION_ID.test(sectionId) || sectionId.includes('..')) {
      throw new FinalPassError('INPUT', `节 id 不合法（只允许字母数字与 . _ -，且不含 ..）：${String(sectionId)}`);
    }
    if (this.#active !== undefined) {
      throw new FinalPassError('BUSY', '已有一节在做终审；终审串行，请等它跑完或先取消。');
    }
    if (signal?.aborted) {
      throw new FinalPassError('ABORTED', `终审在开始前就被取消：${sectionId}`, { cause: signal.reason });
    }

    const fused = fuseSignals([signal]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fused.abort(new FinalPassError('TIMEOUT', `终审超时（${this.timeoutMs}ms）：${sectionId}`));
    }, this.timeoutMs);

    const work = this.#runSection({ text, sectionId, signal: fused.signal, timedOut: () => timedOut });
    this.#active = work;
    try {
      return await work;
    } finally {
      clearTimeout(timer);
      fused.cleanup();
      if (this.#active === work) this.#active = undefined;
    }
  }

  /** 一次终审的实际流程（`run` 负责串行、超时与信号的生命周期）。 */
  async #runSection({ text, sectionId, signal, timedOut }) {
    const before = countShape(text);
    const agent = await this.#ensureAgent(signal);
    this.#throwIfAborted(signal, sectionId, timedOut);

    const filePath = path.join(this.cwd, `${sectionId}.md`);
    const target = await this.#ctx.fs.resolve(filePath, { cwd: this.cwd });
    await this.#ctx.fs.writeText(target, text, undefined, signal, this.#writePolicy());

    const registered = this.#ctx.subagents.list();
    const provider = this.#ctx.subagents.getProvider(this.provider);
    if (provider === undefined) {
      throw new FinalPassError('NO_PROVIDER', `宿主 ctx.subagents 上没有 provider「${this.provider}」；已注册：${registered.length === 0 ? '（无）' : registered.join('、')}`);
    }
    if (provider.capabilities?.persona === false) {
      throw new FinalPassError('PROVIDER_UNSUPPORTED', `provider「${this.provider}」不支持 persona：无曰的提示词是子 agent 的 persona，没有它就不是终审。`);
    }

    let run;
    try {
      run = await this.#ctx.subagents.start(this.provider, {
        label: `无曰终审 ${sectionId}`,
        prompt: [{
          type: 'text',
          text: wuyueTaskText({
            filePath,
            sectionTitle: sectionId,
            chapterCount: 0,
            topicCount: before.topics,
            blockCount: before.blocks,
          }),
        }],
        parent: agent,
        signal,
        persona: WUYUE_SYSTEM_PROMPT,
        ...(this.maxDepth === undefined ? {} : { maxDepth: this.maxDepth }),
        ...(this.toolFilter === undefined ? {} : { toolFilter: this.toolFilter }),
      });
    } catch (error) {
      if (timedOut()) throw new FinalPassError('TIMEOUT', `终审在子 agent 发布前超时：${sectionId}`, { cause: error });
      if (signal.aborted) throw new FinalPassError('ABORTED', `终审在子 agent 发布前被取消：${sectionId}`, { cause: error });
      throw new FinalPassError('AGENT_START_FAILED', `委派终审子 agent 失败：${error?.message ?? String(error)}`, { cause: error });
    }

    this.#run = run;
    let result;
    // 会话状态必须在拆卸**之前**读：`handle.dispose()` 会把这个 session 从
    // 宿主 store 里摘掉，之后再读是悬空引用。
    let childEvents;
    try {
      result = await run.result;
      childEvents = run.localAgent?.session?.seq;
    } finally {
      // 一次性的 run 必须由持有者拆卸，才算到达静默
      // （宿主 SubagentRun 契约：consumers must always dispose）。
      // 拆卸本身的失败不该盖掉结果通道交代的原因。
      this.#run = undefined;
      try {
        await run.dispose();
      } catch {
        // 结果通道拥有 run 的故障；这里只负责释放。
      }
    }
    this.#throwIfAborted(signal, sectionId, timedOut);

    if (result.stopReason !== 'completed') {
      throw this.#failure(sectionId, result, timedOut(), signal.aborted);
    }

    const after = await this.#readText(target);
    if (!SECTION_MARK.test(after)) {
      throw new FinalPassError('FORMAT', `终审改完的文本里 \`#!section\` 标记行没了，拒绝当成结果：${filePath}`);
    }
    const shape = countShape(after);
    return {
      ok: true,
      sectionId,
      filePath,
      provider: this.provider,
      agentPreset: this.agentPreset,
      stopReason: result.stopReason,
      /** agent 最后的交代（它自己说改了哪几件，可能为空）。 */
      output: outputText(result.output),
      /** 改完的讲义全文，调用方按自己的模型合回。 */
      text: after,
      topicsBefore: before.topics,
      topicsAfter: shape.topics,
      blocksBefore: before.blocks,
      blocksAfter: shape.blocks,
      /** 形状（知识点/块数）变了 —— 变了不一定是错，合并两块也合理，只报事实。 */
      shapeChanged: before.topics !== shape.topics || before.blocks !== shape.blocks,
      /** 文件一个字没动。这是事实，不是失败。 */
      unchanged: after === text,
      /** 子 agent 的会话日志长度，作为「它真的动过几轮」的代理量（拿不到 localAgent 时为 undefined）。 */
      childEvents,
    };
  }

  /** 把一次非 `completed` 的终止翻译成如实带原因的失败。 */
  #failure(sectionId, result, timedOut, aborted) {
    const detail = result.diagnostic === undefined ? '' : `：${result.diagnostic}`;
    if (timedOut) {
      return new FinalPassError('TIMEOUT', `终审超时（${this.timeoutMs}ms），子 agent 未被当成跑完：${sectionId}`, { stopReason: result.stopReason, diagnostic: result.diagnostic });
    }
    if (aborted || result.stopReason === 'aborted') {
      return new FinalPassError('ABORTED', `终审被取消，改到一半的稿子不算已终审：${sectionId}`, { stopReason: result.stopReason, diagnostic: result.diagnostic });
    }
    return new FinalPassError('AGENT_FAILED', `终审子 agent 未跑完（stopReason=${result.stopReason}）${detail}`, { stopReason: result.stopReason, diagnostic: result.diagnostic });
  }

  /**
   * 卸载：先中止在跑的那一节，等它真的静下来，再拆掉终审 agent。
   *
   * 顺序是有意的：**子 run 的拆卸会取消子 agent 的当前轮**，在跑的 `run()` 因此
   * 以 `ABORTED` 如实失败（而不是卸载后还挂着一个没人拥有的 agent 在改文件）。
   * 幂等；卸载后 `run()` 一律抛 `DISPOSED`。
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#active;
    const run = this.#run;
    if (run !== undefined) {
      try {
        await run.dispose();
      } catch {
        // run 的故障由它自己的 result 通道交代；拆卸失败不该再掀一次。
      }
    }
    // 等在跑的那一节真正收敛：卸载的契约是「到静默」，不是「发出取消就返回」。
    if (active !== undefined) {
      try {
        await active;
      } catch {
        // 被卸载打断的那一节以 ABORTED 失败，原因已经沿着 run() 的 Promise 交代过了。
      }
    }
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle !== undefined) await handle.dispose();
  }
}

/**
 * Cordis 插件入口：建立终审服务并挂到 `ctx.zhiyunFinalPass`。
 *
 * # 为什么这个 `apply` 是 `async` 的
 *
 * 实测（Cordis 4.0.4 / 4.0.5-alpha.1 都一样）：**同步 `apply` 返回的 disposer
 * 会被静默丢掉** —— 框架只把「可迭代的 disposer 列表」当返回值处理；
 * 一个函数不是可迭代对象，于是它被忽略，插件卸载时不会调用 `dispose()`，
 * agent 与在跑的 run 一起泄漏。异步 `apply` 的返回值才会被当成 disposer。
 * （另一种同样有效的写法是 `ctx.effect(...)`。）
 *
 * 所以本插件**必须是 async**，并照常返回 disposer：这既符合调用方对
 * 「apply 返回 disposer」的期待，也真的会在卸载时跑。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（已注入 `agents`/`subagents`/`fs`/`profileContext`）。
 * @param {object} [config] - 见 [ZhiyunFinalPass] 构造参数。
 * @returns {Promise<() => Promise<void>>} disposer：卸载时中止在跑的那一节并释放 agent。
 */
export async function apply(ctx, config = {}) {
  const service = new ZhiyunFinalPass(ctx, config);
  ctx.provide('zhiyunFinalPass', service);
  return () => service.dispose();
}
