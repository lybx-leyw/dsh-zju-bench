import { randomUUID } from 'node:crypto';
import { ParserError } from './errors.js';
import { normalizeAccel, applyAccel, escalatedBudget } from './accel.js';
export { ParserError } from './errors.js';

/**
 * 宿主 LLM 适配器。
 *
 * 这里同时是**加速档位唯一的落点**：`accel` 只在这一层并进请求配置。
 * 理由有三条：
 * ① 未配 accel 时 `resolve()` 的输出与改动前**逐字段相同** ——
 *    缓存键、视觉预检、路由都建立在它上面，档位若也去改它，
 *    "不配 accel 就等于没改过"这句话就不再成立；
 * ② 升档重试必须能在同一处改预算重发，否则"恰好一次"这个上界会散在调用方；
 * ③ 档位是**请求形状**的一部分，与消息构造同源才好审。
 */
export class HarnessLlm {
  constructor({ llm, attachments, selection, routes = {}, timeoutMs = 900000, accel = null }) {
    if (!llm?.prepareCall || !attachments?.saveImage) throw new ParserError('CONFIG', '解析器需要 DSH 的 llm 和 attachments 服务');
    this.llm = llm; this.attachments = attachments; this.selection = selection; this.routes = routes; this.timeoutMs = timeoutMs;
    const normalized = normalizeAccel(accel);
    this.accel = normalized.stages; this.escalation = normalized.escalation; this.accelIssues = normalized.issues;
    // 显式声明「档位在我这里落点」：调用方据此判断要不要如实告警。用标记而不是
    // 猜 `accel` 是否为空 —— 猜会把「只配了升档、没配阶段档位」误判成没有落点。
    this.acceptsAccel = true;
  }
  async resolve(signal) {
    const selected = this.selection(); const routes = {};
    for (const stage of ['vision', 'text']) {
      const custom = this.routes[stage] ?? {};
      // Parsing does not inherit the chat's reasoning effort. Prefer a declared
      // disabled level; otherwise leave effort resolution to the host adapter.
      let config = { provider: custom.provider ?? selected.provider, model: custom.model ?? selected.model };
      if (!config.provider || !config.model) throw new ParserError('CONFIG', '请在宿主配置解析模型');
      try {
        const info = await this.llm.resolveModelInfo(config.provider, config.model, signal);
        const disabled = info.reasoning?.efforts?.find(e => ['none', 'off', 'disabled'].includes(e.id));
        if (custom.reasoningEffort !== undefined) config.reasoningEffort = custom.reasoningEffort;
        else if (disabled) config.reasoningEffort = disabled.id;
        if (custom.maxTokens !== undefined) config.maxTokens = custom.maxTokens;
        const prepared = await this.llm.prepareCall(config, signal);
        if (stage === 'vision' && !prepared.inputModalities?.includes('image')) throw new ParserError('VISION_MODEL', '视觉阶段需要宿主明确声明支持图片的模型');
        routes[stage] = { ...prepared.config };
      } catch (error) {
        if (signal?.aborted) throw new ParserError('CANCELLED', '解析已取消');
        if (error instanceof ParserError) throw error;
        throw new ParserError('CONFIG', '宿主解析模型未配置或不可用', { stage, causeCode: error.code ?? 'LLM' });
      }
    }
    return routes;
  }
  async image(bytes, mediaType, name) { return this.attachments.saveImage({ data: bytes, mediaType, name }); }
  /**
   * 某阶段撞上输出上限时的升档落点；`null` = 不升档（没配、或抬不动）。
   *
   * 「抬不动就不重试」是硬要求：同预算重发注定还是截断，只会白花一次调用
   * 并把升档的机会挤掉（Dart `openai_client.dart` 的抬预算分支同理）。
   */
  escalationBump(current) {
    const policy = this.escalation;
    if (!policy) return null;
    const next = {};
    const hasBudget = Number.isFinite(current.maxTokens) && current.maxTokens > 0;
    if (policy.promote.maxTokens !== undefined) {
      const escalated = hasBudget
        ? escalatedBudget({ current: current.maxTokens, factor: policy.factor, ceiling: policy.ceiling })
        : policy.promote.maxTokens;
      // 升档预算是**下限**（路由自己的预算若已更高就按倍数抬，绝不下调），
      // 硬顶是**上限**（`normalizeEscalation` 已保证硬顶不低于升档预算，两者不会打架）。
      const target = Math.min(Math.max(escalated, policy.promote.maxTokens), policy.ceiling);
      if (!hasBudget || target > current.maxTokens) next.maxTokens = target;
    }
    if (policy.promote.reasoningEffort !== undefined && policy.promote.reasoningEffort !== current.reasoningEffort) {
      next.reasoningEffort = policy.promote.reasoningEffort;
    }
    return Object.keys(next).length ? next : null;
  }
  async call({ route, constant, variable, image, signal, stage }) {
    const timed = AbortSignal.any([AbortSignal.timeout(stage === 'faithful' ? Math.min(this.timeoutMs, 120000) : this.timeoutMs), ...(signal ? [signal] : [])]);
    const content = [{ type: 'text', text: constant }, { type: 'text', text: variable }];
    if (image) content.push({ type: 'image', attachment: image });
    const message = Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'zhiyun-parser' }),
      content: Object.freeze(content.map(block => Object.freeze(block))) });
    // 档位与路由在这里合成；未配 accel 时 `current` 就是 `route` 本身（同一个对象，
    // 不是等价的副本）—— 「不配就等于没改过」由构造保证，而不是靠逐字段比对。
    let current = applyAccel(route, this.accel[stage] ?? null);
    let escalations = 0;
    for (;;) {
      let usage = null, finish = null; const blocks = new Map();
      try {
        const prepared = await this.llm.prepareCall(current, timed);
        if (image && !prepared.inputModalities?.includes('image')) throw new ParserError('VISION_MODEL', '视觉模型已变更，不再支持图片');
        for await (const chunk of prepared.stream({ ...prepared.config, messages: [message], signal: timed })) {
          timed.throwIfAborted();
          if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
          if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
          if (chunk.type === 'tool-call-delta') throw new ParserError('PROTOCOL', '解析阶段不执行模型返回的工具调用');
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        if (!finish || finish.kind !== 'stop') {
          const truncated = finish?.kind === 'max-tokens';
          // 截断升档：**恰好一次**。仍截断就落到下面那条 TRUNCATED 失败路径上 ——
          // 拿一份被截断的回包当成功，等于把「模型没说完」伪装成「讲完了」。
          const bump = truncated && escalations < 1 ? this.escalationBump(current) : null;
          if (bump) { escalations++; current = applyAccel(current, bump); continue; }
          throw new ParserError(truncated ? 'TRUNCATED' : 'LLM_FAILED', '宿主模型未完整完成解析',
            { stage, causeCode: finish?.failure?.code ?? finish?.kind ?? 'NO_FINISH', escalated: escalations });
        }
        const text = [...blocks.entries()].sort((a,b) => a[0]-b[0]).map(([,v]) => v).join('');
        if (!text.trim()) throw new ParserError('EMPTY_RESPONSE', '宿主模型返回空内容', { stage });
        return { text, usage, route: prepared.config, escalated: escalations };
      } catch (error) {
        if (timed.aborted) throw new ParserError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT', '解析已取消或超时', { stage });
        if (error instanceof ParserError) throw error;
        throw new ParserError('LLM_FAILED', '宿主模型调用失败', { stage, causeCode: error.code ?? 'LLM' });
      }
    }
  }
}
