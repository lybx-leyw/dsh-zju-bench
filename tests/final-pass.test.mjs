/**
 * 无曰终审的离线用例。
 *
 * # 怎么做到「离线但仍是真的」
 *
 * 不联网，也不假装 agent 不存在：**用真的 Cordis**（宿主 `.runtime/dsh-<版本>` 里
 * 那一份）加载本插件，把宿主那四个服务（`agents` / `subagents` / `fs` /
 * `profileContext`）换成**记录调用的假实现**。于是这些用例验证的是真问题：
 *
 * - 插件的 `inject` 声明对不对、激活与卸载是否干净（真 fiber 生命周期）；
 * - 终审**确实经由 `ctx.agents` 建 agent、经 `ctx.subagents` 委派子 agent**，
 *   而不是自己发一次 LLM 请求；
 * - 子 agent 失败 / 超时 / 取消时，如实返回失败与原因，**绝不**把没改过的稿子
 *   当成已终审。
 *
 * 关于「不是 llm.call」这一条，这里用**投毒**断言：给上下文提供一个 `llm` 服务，
 * 任何属性访问都抛错。终审若绕开 agent 去直接调 llm，用例立刻炸 —— 比断言
 * 「没调用某函数」更硬。
 *
 * @module tests/final-pass
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { root, lock } from '../scripts/profile.mjs';
import * as plugin from '../packages/dsh-zhiyun-final-pass/src/index.js';
import { WUYUE_SYSTEM_PROMPT, wuyueTaskText } from '../packages/dsh-zhiyun-final-pass/src/prompts.js';
import { FinalPassError, countShape } from '../packages/dsh-zhiyun-final-pass/src/index.js';

// ═══════════════════════════════════════════════════════════════
// 假宿主：只实现本插件真正用到的那几个方法，其余一律记录
// ═══════════════════════════════════════════════════════════════

/** 一个可等待的闸门，用来让用例精确地停在「子 agent 已发布」那一刻。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 把 abort 变成一个 typed 失败（模拟宿主服务在取消时的行为）。 */
function abortedError(reason) {
  return Object.assign(new Error('aborted'), { code: 'ABORTED', reason });
}

/** 记录一切的假 `ctx.agents`（宿主 `AgentRegistry`）。 */
class FakeAgents {
  constructor() {
    this.created = [];
    this.disposed = [];
  }

  async create(options) {
    this.created.push(options);
    const agent = {
      id: options.sessionId,
      options: options.agentOptions ?? {},
      session: { id: options.sessionId, seq: 0, header: { id: options.sessionId } },
      ctx: { get: () => undefined },
    };
    // 与真工厂同序：setup 在发布之前跑（这里直接给已发布的 agent）。
    if (typeof options.setup === 'function') await options.setup(agent.ctx, agent);
    let done = false;
    return {
      agent,
      dispose: async () => { if (!done) { done = true; this.disposed.push(agent.id); } },
    };
  }
}

/** 记录一切的假 `ctx.subagents`（宿主 `SubagentRuntime` 的调用面）。 */
class FakeSubagents {
  constructor() {
    this.providers = new Map();
    this.starts = [];
    /** @type {(request: object, gate: object) => Promise<object>} */
    this.behavior = undefined;
  }

  register(name, capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }) {
    this.providers.set(name, { name, capabilities, inheritsParentContext: false });
  }

  list() { return [...this.providers.keys()]; }

  getProvider(name) { return this.providers.get(name); }

  async start(name, request) {
    const record = { name, request };
    this.starts.push(record);
    if (this.behavior === undefined) throw new Error('用例没有设置 subagents.behavior');
    return this.behavior(request, record);
  }
}

/** 记录一切的假 `ctx.fs`：内存文件，够本插件用（resolve / readText / writeText）。 */
class FakeFs {
  constructor() {
    this.files = new Map();
    this.writes = [];
    this.reads = [];
  }

  async resolve(p, opts) {
    const base = opts?.cwd ?? process.cwd();
    const full = path.isAbsolute(p) ? p : path.resolve(base, p);
    if (full.split(/[\\/]/).includes('..')) throw Object.assign(new Error('path escapes'), { code: 'FS_SANDBOX_DENIED' });
    return { targetKey: full, displayPath: full };
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    if (signal?.aborted) throw abortedError(signal.reason);
    this.writes.push({ path: target.displayPath, content, sandboxPolicy });
    this.files.set(target.targetKey, content);
    return { operation: 'create', version: 'v1' };
  }

  async readText(target, signal) {
    if (signal?.aborted) throw abortedError(signal.reason);
    this.reads.push(target.displayPath);
    if (!this.files.has(target.targetKey)) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
    return this.files.get(target.targetKey);
  }
}

/** 造一个真实的 Cordis 上下文，只把宿主服务换成假的。 */
async function makeContext(cordisPath, { timeoutMs, behavior } = {}) {
  const { Context } = await import(pathToFileURL(cordisPath).href);
  const ctx = new Context();
  const agents = new FakeAgents();
  const subagents = new FakeSubagents();
  const fs = new FakeFs();
  subagents.register('spawn');
  if (behavior !== undefined) subagents.behavior = behavior;

  ctx.provide('agents', agents);
  ctx.provide('subagents', subagents);
  ctx.provide('fs', fs);
  ctx.provide('profileContext', { dir: path.join(process.cwd(), '.tmp-final-pass-tests') });
  // 投毒：终审若直接调 llm，任何访问都会抛错。本插件不该碰它。
  ctx.provide('llm', new Proxy({}, {
    get(_t, key) { throw new Error(`终审不许直接调 llm（访问了 llm.${String(key)}）`); },
  }));

  const fiber = await ctx.plugin(plugin, timeoutMs === undefined ? {} : { timeoutMs });
  const service = ctx.get('zhiyunFinalPass');
  return { ctx, fiber, service, agents, subagents, fs };
}

/** 一份与 App 导出格式同形的讲义文本。 */
const LECTURE = [
  '#!section s1 树与索引',
  '#! 与 ##! 开头的行一个字都不许改。',
  '',
  '##!topic 1 1 | 随机寻址 | P1-3 | src=1,2 | 章=存储',
  '>>> BLOCK 讲解',
  '内存充足时采用随机寻址。内存不足时需用外存。',
  '',
  '##!topic 1 2 | 树高 | P4-6 | src=3 | 章=存储',
  '>>> BLOCK 讲解 | 树高与访问次数',
  '为减少外存访问，希望树的高度尽量低。',
  '',
].join('\n');

/** 子 agent 「改完」的版本：把一块拆成两块，并给小标题。 */
const REFINED = [
  '#!section s1 树与索引',
  '#! 与 ##! 开头的行一个字都不许改。',
  '',
  '##!topic 1 1 | 随机寻址 | P1-3 | src=1,2 | 章=存储',
  '>>> BLOCK 讲解 | 随机寻址',
  '内存充足时采用随机寻址。',
  '',
  '>>> BLOCK 讲解 | 内存不足与外存',
  '内存不足时需用外存。',
  '',
  '##!topic 1 2 | 树高 | P4-6 | src=3 | 章=存储',
  '>>> BLOCK 讲解 | 树高与访问次数',
  '为减少外存访问，希望树的高度尽量低。',
  '',
].join('\n');

/** 每次都真的改稿的假子 agent：写出 REFINED 再如实交回。 */
function refiningBehavior(fs, { stopReason = 'completed', diagnostic } = {}) {
  return async request => {
    // 这个假 agent「干活」：直接改目标文件（它从任务文本里拿到路径）。
    const filePath = /```\r?\n(.+?)\r?\n```/s.exec(request.prompt[0].text)?.[1];
    assert.ok(filePath, '任务文本里应当给出讲义文件路径');
    fs.files.set(filePath, REFINED);
    return {
      id: 'child-1',
      localAgent: { session: { seq: 12 } },
      result: Promise.resolve({
        output: [{ type: 'text', text: '把随机的讲解拆成两块，并各自加了小标题。' }],
        stopReason,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }),
      dispose: async () => {},
    };
  };
}

// ═══════════════════════════════════════════════════════════════
// 用例
// ═══════════════════════════════════════════════════════════════

for (const version of lock.hostVersions) {
  const cordisPath = path.join(root, '.runtime', `dsh-${version}`, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');

  test(`Cordis ${version}：插件声明真依赖、激活后服务可用、卸载后消失且 agent 被释放`, async t => {
    try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

    // 依赖必须是真的：漏一个，插件在最小组合里会静默不激活。
    assert.deepEqual([...plugin.inject].sort(), ['agents', 'fs', 'profileContext', 'subagents']);
    assert.equal(plugin.name, 'zhiyun-final-pass');

    const { ctx, fiber, service, agents } = await makeContext(cordisPath, {
      behavior: async () => { throw new Error('本用例不跑终审'); },
    });
    assert.ok(service, '激活后 ctx.zhiyunFinalPass 应当可用');
    assert.equal(typeof service.run, 'function');
    assert.equal(typeof service.dispose, 'function');
    assert.equal(service.agent, undefined, '不跑就不该凭空建 agent');
    assert.deepEqual(service.describe().cwd, path.join(process.cwd(), '.tmp-final-pass-tests', 'data', 'zhiyun-final-pass'));

    await fiber.dispose();
    assert.equal(ctx.get('zhiyunFinalPass'), undefined, '卸载后服务应当消失');
    assert.equal(agents.created.length, 0);
    await ctx.fiber.dispose();
  });

  test(`Cordis ${version}：终审确实走 ctx.agents + ctx.subagents（记录调用的假实现），不是 llm.call`, async t => {
    try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

    // behavior 需要假 fs 才能「改文件」，所以先建上下文、再绑行为。
    const { ctx, fiber, service, agents, subagents, fs } = await makeContext(cordisPath, {
      behavior: async () => { throw new Error('behavior 尚未绑定'); },
    });
    subagents.behavior = async request => {
      // 断言 ② 的核心：委派请求的形状就是宿主 SubagentStartRequest。
      assert.equal(typeof request.parent?.id, 'string', 'parent 必须是 ctx.agents 建出来的那个 agent');
      assert.ok(Array.isArray(request.prompt) && request.prompt[0].type === 'text');
      assert.ok(request.signal instanceof AbortSignal, '必须把取消信号透传给宿主');
      return refiningBehavior(fs)(request);
    };

    const report = await service.run({ text: LECTURE, sectionId: 's1' });

    // ① 走了 ctx.agents：终审根 agent 由注入的注册表建立，且只建一次。
    assert.equal(agents.created.length, 1);
    assert.match(agents.created[0].sessionId, /^zhiyun-final-pass-/);
    assert.equal(agents.created[0].meta.cwd, path.join(process.cwd(), '.tmp-final-pass-tests', 'data', 'zhiyun-final-pass'));

    // ② 走了 ctx.subagents：provider 名、parent、persona、提示词。
    assert.equal(subagents.starts.length, 1);
    const { name, request } = subagents.starts[0];
    assert.equal(name, 'spawn');
    assert.equal(request.parent.id, agents.created[0].sessionId, 'parent 必须是那个终审 agent');
    assert.equal(request.persona, WUYUE_SYSTEM_PROMPT, '无曰的提示词经由宿主的 persona 能力落点');
    assert.match(request.prompt[0].text, /s1\.md/, '任务文本给出讲义文件路径');
    assert.match(request.prompt[0].text, /2 知识点 \/ 2 块/, '任务文本给出形状（知识点/块数）');

    // ③ 讲义是经 ctx.fs 读写的，不是旁路 node:fs。
    assert.equal(fs.writes.length, 1);
    assert.equal(fs.writes[0].content, LECTURE);
    assert.equal(fs.reads.length, 1);

    // ④ 结果如实：改完的文本 + 形状变化的事实。
    assert.equal(report.ok, true);
    assert.equal(report.stopReason, 'completed');
    assert.equal(report.text, REFINED);
    assert.equal(report.topicsBefore, 2);
    assert.equal(report.topicsAfter, 2);
    assert.equal(report.blocksBefore, 2);
    assert.equal(report.blocksAfter, 3);
    assert.equal(report.shapeChanged, true);
    assert.equal(report.unchanged, false);
    assert.match(report.output, /拆成两块/);
    assert.equal(report.childEvents, 12);
    assert.equal(report.filePath, fs.writes[0].path);

    await fiber.dispose();
    assert.equal(ctx.get('zhiyunFinalPass'), undefined);
    assert.deepEqual(agents.disposed, [agents.created[0].sessionId], '卸载必须把 agent 还回去');
    await ctx.fiber.dispose();
  });
}

// ═══════════════════════════════════════════════════════════════
// 失败语义（不依赖具体宿主版本，用已安装的那一份跑）
// ═══════════════════════════════════════════════════════════════

const cordisPath = path.join(root, '.runtime', `dsh-${lock.hostVersions[0]}`, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');

test('子 agent 失败 → 如实返回失败与原因，绝不把没改过的稿子当成已终审', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { ctx, fiber, service, fs } = await makeContext(cordisPath, {
    behavior: async () => ({
      id: 'child-x',
      localAgent: { session: { seq: 3 } },
      result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: '模型的锅' }),
      dispose: async () => {},
    }),
  });

  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(
    () => { throw new Error('失败必须抛出，不许返回成功'); },
    e => e,
  );
  assert.ok(error instanceof FinalPassError);
  assert.equal(error.code, 'AGENT_FAILED');
  assert.equal(error.stopReason, 'error');
  assert.match(error.message, /stopReason=error/);
  assert.match(error.message, /模型的锅/);

  // 稿子**没被改**，而且绝不能出现在任何「成功」结果里。
  assert.equal(fs.files.get(path.join(fs.writes[0].path)), LECTURE);
  assert.equal(error.text, undefined, '失败里不许夹带一份「已终审」的文本');

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('超时 → 明确报 TIMEOUT，不报成取消、也不报成成功', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  // 子 agent 永不交结果：只有超时能把它结束。
  const { ctx, fiber, service } = await makeContext(cordisPath, {
    timeoutMs: 40,
    behavior: async request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(abortedError(request.signal.reason)), { once: true });
    }),
  });

  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(
    () => { throw new Error('超时必须抛出'); },
    e => e,
  );
  assert.equal(error.code, 'TIMEOUT');
  assert.match(error.message, /超时/);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('取消信号能中止：子 agent 发布后取消 → ABORTED，改到一半不算已终审', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const gate = deferred();
  const { ctx, fiber, service, fs } = await makeContext(cordisPath, {
    behavior: async request => {
      const result = new Promise(resolve => {
        request.signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }), { once: true });
      });
      gate.resolve();
      return { id: 'child-c', localAgent: { session: { seq: 1 } }, result, dispose: async () => {} };
    },
  });

  const controller = new AbortController();
  const running = service.run({ text: LECTURE, sectionId: 's1', signal: controller.signal });
  await gate.promise;            // 停在「子 agent 已发布」那一刻
  controller.abort(new Error('用户按了取消'));

  const error = await running.then(
    () => { throw new Error('取消必须抛出'); },
    e => e,
  );
  assert.equal(error.code, 'ABORTED');
  assert.match(error.message, /取消/);
  // 文件里还是原稿：一半的修改不算终审结果。
  assert.equal(fs.files.get(path.join(fs.writes[0].path)), LECTURE);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('输入与状态校验：空文本、坏节 id 一律 INPUT；卸载后 DISPOSED', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { ctx, fiber, service } = await makeContext(cordisPath, {
    behavior: async () => { throw new Error('不该走到委派'); },
  });

  for (const [text, sectionId] of [['', 's1'], ['   ', 's1'], [LECTURE, '../escape'], [LECTURE, 'a/b'], [LECTURE, 42]]) {
    const error = await service.run({ text, sectionId }).then(() => null, e => e);
    assert.equal(error?.code, 'INPUT', `应当以 INPUT 拒绝：${JSON.stringify([text, sectionId])}`);
  }

  await fiber.dispose();
  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(() => null, e => e);
  assert.equal(error?.code, 'DISPOSED');
  await ctx.fiber.dispose();
});

test('没有对应 provider → NO_PROVIDER（并列出已注册的），不静默降级', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { Context } = await import(pathToFileURL(cordisPath).href);
  const ctx = new Context();
  ctx.provide('agents', new FakeAgents());
  ctx.provide('subagents', new FakeSubagents());   // 一个 provider 都没注册
  ctx.provide('fs', new FakeFs());
  ctx.provide('profileContext', { dir: process.cwd() });
  const fiber = await ctx.plugin(plugin, { provider: 'spawn' });
  const service = ctx.get('zhiyunFinalPass');

  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(() => null, e => e);
  assert.equal(error?.code, 'NO_PROVIDER');
  assert.match(error.message, /spawn/);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('标记行被 agent 改坏 → FORMAT，拒绝把读不回的东西当成结果', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { ctx, fiber, service } = await makeContext(cordisPath, {
    behavior: async request => {
      // 这个假 agent「任性」：把结构标记全删了。
      const filePath = /```\r?\n(.+?)\r?\n```/s.exec(request.prompt[0].text)[1];
      ctx.get('fs').files.set(filePath, '讲义内容（标记行没了）\n');
      return {
        id: 'child-f',
        localAgent: { session: { seq: 5 } },
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  });

  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(
    () => { throw new Error('格式坏掉必须抛出'); },
    e => e,
  );
  assert.equal(error.code, 'FORMAT');
  assert.match(error.message, /#!section/);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('agent 一个字没改 → 仍然是成功，但如实标注 unchanged（跑过但没改 ≠ 没跑）', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { ctx, fiber, service } = await makeContext(cordisPath, {
    behavior: async () => ({
      id: 'child-u',
      localAgent: { session: { seq: 2 } },
      result: Promise.resolve({ output: [{ type: 'text', text: '这一节已经很整齐，我没改。' }], stopReason: 'completed' }),
      dispose: async () => {},
    }),
  });

  const report = await service.run({ text: LECTURE, sectionId: 's1' });
  assert.equal(report.ok, true);
  assert.equal(report.unchanged, true, '「文件没变」是事实，要报出来');
  assert.equal(report.shapeChanged, false);
  assert.equal(report.text, LECTURE, '没改就交回原样，不是半份结果');
  assert.match(report.output, /没改/);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('宿主的 agent 工厂缺席 / 建立失败 → AGENT_START_FAILED，如实带原因', async t => {
  try { await access(cordisPath); } catch { return t.skip('此宿主未安装'); }

  const { Context } = await import(pathToFileURL(cordisPath).href);
  const ctx = new Context();
  const broken = new FakeAgents();
  broken.create = async () => { throw new Error('no agent factory registered'); };
  ctx.provide('agents', broken);
  const subagents = new FakeSubagents();
  subagents.register('spawn');
  ctx.provide('subagents', subagents);
  ctx.provide('fs', new FakeFs());
  ctx.provide('profileContext', { dir: process.cwd() });
  const fiber = await ctx.plugin(plugin);
  const service = ctx.get('zhiyunFinalPass');

  const error = await service.run({ text: LECTURE, sectionId: 's1' }).then(() => null, e => e);
  assert.equal(error?.code, 'AGENT_START_FAILED');
  assert.match(error.message, /no agent factory registered/);
  assert.equal(subagents.starts.length, 0, 'agent 都没建起来，不该已经委派出去');

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test('提示词只给「什么叫好」：无硬阈值式禁令，且不许出现 persona 插值标记', () => {
  // persona 段按 {{变量}} 严格插值；本文件里出现 {{ 会让宿主渲染时炸掉。
  assert.equal(WUYUE_SYSTEM_PROMPT.includes('{{'), false);
  assert.equal(wuyueTaskText({ filePath: 'x.md' }).includes('{{'), false);

  // 「只给什么叫好」的可检验形态：描述的是判断标准，而不是可硬凑的阈值。
  assert.match(WUYUE_SYSTEM_PROMPT, /没有硬性阈值/);
  assert.match(WUYUE_SYSTEM_PROMPT, /靠你自己的判断/);
  assert.match(WUYUE_SYSTEM_PROMPT, /不许新增知识/);
  assert.match(WUYUE_SYSTEM_PROMPT, /不许丢知识/);

  // 工具名必须是宿主**真有**的那个（`read`，参数 file_path），不是 App 里的 read_file。
  assert.match(WUYUE_SYSTEM_PROMPT, /read\(file_path=/);
  assert.equal(WUYUE_SYSTEM_PROMPT.includes('read_file('), false);

  // 任务文本只给路径与形状。
  const task = wuyueTaskText({ filePath: 'C:\\w\\s1.md', sectionTitle: '树', chapterCount: 1, topicCount: 2, blockCount: 3 });
  assert.match(task, /C:\\w\\s1\.md/);
  assert.match(task, /1 章 \/ 2 知识点 \/ 3 块/);
  assert.equal(countShape(LECTURE).topics, 2);
  assert.equal(countShape(LECTURE).blocks, 2);
});
