import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { templates, faithful, buildCleanSentences, parseBlockDrafts, coverage, anchor, pageGate, glossary, parseTags, sanitizeOutline } from '../packages/dsh-zhiyun-parser/src/core.js';
import { faithfulRequest, mixRequest, chunkBlocks, tagRequest, outlineRequest } from '../packages/dsh-zhiyun-parser/src/prompts.js';
import { LectureParser, HarnessLlm, ParserCache } from '../packages/dsh-zhiyun-parser/src/parser.js';
import { Limiter } from '../packages/dsh-zhiyun-parser/src/cache.js';
import { apply } from '../packages/dsh-zhiyun-parser/src/index.js';
import { seedVocabulary, normalizeVocabulary, createVocabularyStore, createMemoryVocabularyStore, createJsonFileVocabularyStore } from '../packages/dsh-zhiyun-parser/src/vocabulary.js';
import { normalizeAccel, escalatedBudget } from '../packages/dsh-zhiyun-parser/src/accel.js';
import { correctionPrompt } from '../packages/dsh-zhiyun-parser/src/correction-policy.js';
import { lock } from '../scripts/profile.mjs';
import { mountHost, lesson, answer, png } from './fixtures/parser/host.mjs';
const reference = JSON.parse(await readFile(new URL('./fixtures/parser/dart-reference.json', import.meta.url)));

test('Dart baseline remains intact; JS applies its explicitly relaxed correction prompt', () => {
  assert.deepEqual(templates, reference.prompts);
  assert.deepEqual(faithful(reference.faithful.raw), reference.faithful);
  const lines = lesson().subtitles.map(l => ({ ...l, page: 1 }));
  for (const c of reference.cases) {
    const clean = buildCleanSentences(lines, c.response), drafts = parseBlockDrafts(c.response, lines.length, clean.bridges);
    assert.deepEqual(clean.sentences, c.sentences); assert.deepEqual(clean.bridges, c.bridges);
    assert.deepEqual(clean.rejected.map(r => r.index), c.rejected); assert.deepEqual(drafts, c.drafts);
    assert.equal(coverage(drafts, lines.length).ok, c.coverageOk);
  }
  assert.deepEqual(mixRequest({ page: 2, lines, fromMs: 1000, toMs: 3000, faithfulText: reference.faithful.raw, terms: ['概率密度函数'] }), { ...reference.mix, constant: correctionPrompt(reference.mix.constant) });
  assert.equal(faithfulRequest('context', 2).variable, reference.faithfulRequest);
  assert.deepEqual(tagRequest([{index:1,page:2,startMs:1000,endMs:3000,bridge:'接着上文',sentences:[{text:'旧四史'},{text:'概率密度函数'}]}],templates.vocabulary,'context',1),reference.chunk);
  assert.deepEqual(outlineRequest([{index:1,tag:{summary:'概率密度函数'}},{index:2,tag:{summary:''}}],'context'),reference.outline);
});
test('missing and duplicate time anchors never discard or duplicate subtitle provenance', () => {
  const subtitles = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 800, text: `line${i}` }));
  for (const anchors of [[], [0,0,0], [1,1,3,0], [0,3,0,7], [4,2,1]]) {
    const a = anchor(anchors.map((createdSec,i) => ({ page: i + 1, createdSec })), subtitles);
    const indices = [...a.windows.flatMap(w => w.lines), ...a.unassigned].map(l => l.sourceIndex).sort((a,b) => a-b);
    assert.deepEqual(indices, subtitles.map((_,i) => i));
  }
});
test('page gate, glossary and taxonomy retain explicit unsupported results', () => {
  assert.equal(pageGate(faithful('## 页面画面\n桌面图标与任务栏')).filtered, true);
  assert.equal(pageGate(faithful(`## 页面文字\n${'字'.repeat(200)}\n## 页面画面\n任务栏`)).filtered, false);
  assert.deepEqual(glossary([1,2].map(page => ({ page, pageText: '', listedTerms: '- 概率密度函数\n无' }))).terms, [{ text: '概率密度函数', count: 2, pages: [1,2] }]);
  const parsed = parseTags(JSON.stringify({ tags: [{ index: 1, role: 'main', facets: ['不存在'], summary: '摘要' }, { index: 2, role: '支线', facets: ['新增:证明@推理'] }] }));
  assert.equal(parsed.tags[0].facets, null); assert.deepEqual(parsed.tags[1].facets, ['证明@推理']);
});
test('tag chunk count and character budgets are independent', () => {
  const blocks = Array.from({ length: 50 }, (_,i) => ({ index:i+1, bridge:'', page:null, startMs:null, sentences:[{text:'字'.repeat(100)}] }));
  assert.deepEqual(chunkBlocks(blocks).map(c=>c.length), [24,24,2]);
  assert.ok(chunkBlocks(blocks, 24, 250).every(c => c.length <= 2));
});
test('outline sanitizing drops only the untrusted spans and keeps the rest', () => {
  const cleaned = sanitizeOutline([
    { title:'a', from:1, to:3 }, { title:'b', from:3, to:4 }, { title:'c', from:2, to:2 },
    { title:'d', from:9, to:9 }, { title:'e', from:5, to:2 },
  ], 4);
  assert.deepEqual(cleaned.outline, [{ title:'a', from:1, to:3 }], '重叠 / 越界 / 反向的区间逐条剔除，其余照常给');
  assert.equal(cleaned.warnings.length, 4, '剔掉的每一条都要如实报出原因');
  assert.deepEqual(sanitizeOutline([], 4), { outline:[], warnings:[] });
  assert.deepEqual(sanitizeOutline([{ title:'x', from:1, to:1 }], 0), { outline:[], warnings:[] }, '没有块就不该有主线区间');
});
test('disk cache binds inputs and tolerates interrupted or old records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-cache-'));
  try {
    const cache = new ParserCache(dir), key = cache.key('mix', ['model', 'time', 'text']);
    await cache.put(key, 'answer'); assert.equal((await new ParserCache(dir).get(key)).raw, 'answer');
    assert.equal(await cache.get(cache.key('mix', ['model2', 'time', 'text'])), null);
    await writeFile(path.join(dir, `${key}.json`), '{broken'); assert.equal(await cache.get(key), null);
  } finally { await rm(dir, { recursive:true, force:true }); }
});
test('concurrency limiter cancels queued tasks and releases capacity', async () => {
  const limit = new Limiter(1), abort = new AbortController(); let release;
  const first = limit.run(() => new Promise(r => release = r));
  const queued = limit.run(() => assert.fail('cancelled queue must not run'), abort.signal);
  abort.abort(); await assert.rejects(queued); release(); await first;
  assert.equal(await limit.run(() => 42), 42); assert.equal(limit.active, 0);
});
for (const version of lock.hostVersions) test(`DSH ${version}: real LLM, attachments, plugin lifecycle and cache run the three-stage parser`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-host-')); let host;
  try {
    host = await mountHost(version, dir);
    assert.ok(host.parser, 'Cordis must activate the parser');
    const output = await host.parser.parse(lesson());
    assert.equal(output.status, 'ready'); assert.deepEqual(output.sentences.map(s=>s.text), ['旧四史','概率密度函数']);
    assert.deepEqual(output.sentences.map(s=>s.startMs), [1234,2200]); assert.equal(output.blocks.length, 1); assert.ok(output.spine);
    assert.equal(host.requests.length, 4);
    const image = host.requests[0].messages[0].content.find(b=>b.type==='image');
    assert.ok(image?.attachment.attachmentId); assert.equal(image.attachment.width, 1);
    for (const request of host.requests.slice(1)) assert.ok(request.messages[0].content.every(b=>b.type==='text'));
    assert.ok(host.requests.every(r => r.reasoningEffort !== 'high'));
    const cached = await host.parser.parse(lesson()); assert.equal(host.requests.length, 4); assert.ok(cached.calls.every(c=>c.cached)); assert.equal(cached.version, output.version);
    const changed = lesson(); changed.subtitles[0].startMs++;
    await host.parser.parse(changed); assert.ok(host.requests.length > 4, 'time anchor change invalidates dependent cache');
    const service = host.parser; await host.fiber.dispose(); assert.equal(service.closed, true); assert.equal(host.ctx.get('zhiyunParser'), undefined);
  } finally { await host?.dispose(); await rm(dir, { recursive:true, force:true }); }
});
test('host text-only model fails preflight without submitting images or consuming tokens', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-vision-')); let host;
  try { host = await mountHost(lock.hostVersions[0], dir, answer, { modalities:['text'] }); await assert.rejects(host.parser.parse(lesson()), {code:'VISION_MODEL'}); assert.equal(host.requests.length,0); }
  finally { await host?.dispose(); await rm(dir, {recursive:true,force:true}); }
});
test('truncated host stream is rejected instead of accepting partial text', async () => {
  const llm = new HarnessLlm({ selection:()=>({}), attachments:{saveImage(){}}, llm:{prepareCall:async()=>({ config:{}, stream:async function*(){yield {type:'text-delta',index:0,text:'partial'};yield {type:'finish',reason:{kind:'max-tokens'}};} })} });
  await assert.rejects(llm.call({route:{},constant:'',variable:'',stage:'mix'}), {code:'TRUNCATED'});
});
test('subtitle-only input remains intact without requesting any model', async () => {
  const parser = new LectureParser({ llm:{ resolve:()=>assert.fail(), call(){}, image(){} } });
  const output = await parser.parse({slides:[],subtitles:lesson().subtitles});
  // 没有课件帧 → 字幕**单列**保留：它们没有页，所以既不进块层、也不去标注
  // （与 App 的 `unassignedSentences` 同口径），但仍然一句不丢。
  assert.equal(output.sentences.length,0); assert.equal(output.unassignedSentences.length,2);
  assert.deepEqual(output.unassignedSentences.map(s=>s.text),lesson().subtitles.map(s=>s.text));
  assert.equal(output.blocks.length,0); assert.equal(output.status,'partial'); assert.equal(output.calls.length,0);
});
test('tag chunks are sent together and only the failed chunk is re-sent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-chunks-')); let host;
  const parts = [];
  try {
    const respond = options => {
      const [constantBlock, variableBlock] = options.messages[0].content;
      const constant = constantBlock.text, variable = variableBlock.text;
      if (constant.includes('完整转述')) return '## 页面文字\n字\n## 页面画面\n一张曲线图\n## 术语\n无';
      // 每句一块 → 25 块正好切成 24 + 1 两卷。
      if (constant.includes('逐块语音稿清洗器')) return ['## 逐块标注', ...Array.from({ length: 25 }, (_, i) => `块 ${i + 1}-${i + 1}`)].join('\n');
      if (constant.includes('维度标注')) {
        const indices = [...variable.matchAll(/^### 块 (\d+)/gm)].map(m => +m[1]);
        parts.push(indices.join(','));
        // 第二卷**首次**故意漏块（答题卡不完整）→ 只该补发这一卷。
        if (indices.includes(25) && parts.filter(p => p.includes('25')).length === 1) return JSON.stringify({ tags: [] });
        return JSON.stringify({ tags: indices.map(index => ({ index, role: '主线', facets: ['概念'], summary: `概述${index}` })) });
      }
      const count = +variable.match(/共 (\d+) 块/)?.[1];
      return JSON.stringify({ spine: '主线', outline: [{ title: '一段', from: 1, to: count }] });
    };
    host = await mountHost(lock.hostVersions[0], dir, respond);
    const output = await host.parser.parse({
      sourceId: 'fixture:chunks', context: 'context',
      slides: [{ page: 1, createdSec: 1, imageBytes: png, mediaType: 'image/png' }],
      subtitles: Array.from({ length: 25 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `第${i + 1}句` })),
    });
    assert.equal(output.blocks.length, 25);
    assert.deepEqual(output.tagFailures, []);
    assert.equal(output.status, 'ready');
    assert.equal(parts.length, 3, '两卷各发一次 + 只补发失败的第二卷');
    assert.deepEqual(parts.filter(p => !p.includes('25')), ['1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24'], '没失败的那一卷不该重发');
    assert.ok(output.blocks.every(b => b.tag.role === '主线' && b.tag.summary), '补发成功后每一块都要有标注');
  } finally { await host?.dispose(); await rm(dir,{recursive:true,force:true}); }
});
test('disposal aborts source fetch and explicit partial-source opt-in is required', async () => {
  const pending = new LectureParser({llm:{resolve(){},call(){},image(){}}, classroom:{getLessonContent:async(_c,_s,{signal}) => new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}});
  const job = pending.parseClassroom('1','2'); pending.dispose(); await assert.rejects(job,{code:'CANCELLED'});
  const partial = new LectureParser({llm:{resolve(){},call(){},image(){}},classroom:{getLessonContent:async()=>({slides:{meta:{complete:true},items:[]},subtitles:{meta:{complete:false},items:[]}})}});
  await assert.rejects(partial.parseClassroom('1','2'),{code:'PARTIAL_SOURCE'});
});
test('repeated invalid corrections stop retrying, preserve ASR, and stay out of the success cache', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-retry-')); let host;
  try {
    host = await mountHost(lock.hostVersions[0], dir, options => options.messages[0].content[0].text.includes('逐块语音稿清洗器') ? '1. 正文：完全重写原文为不相关的一段话\n块 2-2' : answer(options));
    const output = await host.parser.parse(lesson());
    assert.equal(output.status,'partial'); assert.deepEqual(output.sentences.map(s=>s.text),lesson().subtitles.map(s=>s.text));
    assert.deepEqual(output.failedPages,[1]); assert.equal(output.blocks.length,1); assert.equal(output.calls.filter(c=>c.stage==='mix').length,2);
    const count = host.requests.length; await host.parser.parse(lesson()); assert.equal(host.requests.length,count+2,'invalid mixes must be retried on the next run');
  } finally {await host?.dispose();await rm(dir,{recursive:true,force:true});}
});
test('one bad page retains all subtitles while successful neighboring pages remain usable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-partial-')); let host;
  try {
    host = await mountHost(lock.hostVersions[0], dir, answer);
    const input = lesson(); input.slides.push({page:2,createdSec:3,imageBytes:Buffer.from('bad'),mediaType:'image/png'});
    input.subtitles.push({startMs:3500,endMs:4000,text:'另一页原文'});
    const output = await host.parser.parse(input); assert.equal(output.status,'partial'); assert.equal(output.sentences.length,3);
    assert.equal(output.sentences[0].text,'旧四史'); assert.equal(output.sentences[2].text,'另一页原文'); assert.deepEqual(output.failedPages,[2]);
  } finally {await host?.dispose();await rm(dir,{recursive:true,force:true});}
});
test('Cordis plugin disposal cancels an active host LLM stream', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-cancel-')); let host;
  let started; const entered = new Promise(r=>started=r);
  try {
    host = await mountHost(lock.hostVersions[0], dir, async options => {started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));});
    const job = host.parser.parse(lesson()); const rejected = assert.rejects(job,{code:'CANCELLED'});
    await entered; await host.fiber.dispose(); await rejected;
  } finally {await host?.dispose();await rm(dir,{recursive:true,force:true});}
});
// ── 加速档位与截断升档 ──────────────────────────────────────────────────
/** 直连 LectureParser 的确定性模型：按阶段回包，并记录配置与请求。
 *
 * `calls` 是**阶段调用**的 prepareCall 配置（`resolve()` 会先为视觉/文本两条路由
 * 各准备一次，那两次在最前面，这里替调用方剥掉）；`requests` 是 stream 的入参，
 * 里面才有 messages。 */
function stubLlm(respond, { accel = undefined, cache = undefined } = {}) {
  const prepared = [], requests = [];
  const parser = new LectureParser({ llm: new HarnessLlm({
    selection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
    attachments: { saveImage: () => ({ attachmentId: 'fixture-image' }) },
    accel,
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
      prepareCall: async config => {
        prepared.push(config);
        return { config, inputModalities: ['text', 'image'], stream: async function* (options) {
          requests.push(options);
          const result = await respond(options);
          yield { type: 'text-delta', index: 0, text: result };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      },
    },
  }), ...(cache ? { cache } : {}) });
  return { parser, prepared, requests, calls: () => prepared.slice(2) };
}
/** 三阶段确定性回包；`facet` 决定标注阶段每块要报的标签原文。 */
function taggingAnswer(facet, faithfulText = '## 页面文字\n旧四史，概率密度函数\n## 页面画面\n一张曲线图\n## 术语\n旧四史\n概率密度函数') {
  return config => {
    const constant = config.messages[0].content[0].text;
    const variable = config.messages[0].content[1].text;
    if (constant.includes('完整转述')) return faithfulText;
    if (constant.includes('逐块语音稿清洗器')) return '## 逐块标注\n1. 正文：旧四史\n块 1-2';
    // 分卷标注的常量段开头是「你在给一节大学课做**维度标注**（分卷进行）」——
    // 整节主线的常量段里也有「维度标注」四个字（它要引用这一阶段的产物），
    // 所以只能按**开头**判，按 include 判会把两种请求混成一种。
    if (constant.startsWith('你在给一节大学课做**维度标注**（分卷进行）')) {
      const indices = [...variable.matchAll(/^### 块 (\d+)/gm)].map(m => +m[1]);
      return JSON.stringify({ tags: indices.map(index => ({ index, role: '主线', facets: [facet], summary: '概率密度函数' })) });
    }
    const count = +variable.match(/共 (\d+) 块/)?.[1];
    return JSON.stringify({ spine: '主线', outline: [{ title: '概念', from: 1, to: count }] });
  };
}
/** 只看**分卷标注**那一次调用（主线请求的常量段里也会提到「维度标注」）。 */
const tagOnly = requests => requests.filter(r => r.messages[0].content[0].text.startsWith('你在给一节大学课做**维度标注**（分卷进行）'));
/** 分卷提示里真正**注入的清单**（`【已有标签（**优先用它们**）】` 之后那一段）。 */
function injectedVocabulary(constant) {
  const marker = '【已有标签（**优先用它们**）】';
  const start = constant.indexOf(marker);
  if (start < 0) return null;
  return constant.slice(start + marker.length).split('\n')[0].trim();
}
test('★ unconfigured accel sends the byte-identical request shape', async () => {
  // ① 不配 accel（`{}` 与不传等价）：四次调用的配置**逐字段**与改动前相同 ——
  //    路由上只有 provider/model，一个新增字段都没有。
  for (const accel of [undefined, {}, null]) {
    const { parser, calls } = stubLlm(taggingAnswer('概念'), { accel });
    const output = await parser.parse(lesson());
    assert.equal(output.status, 'ready');
    assert.equal(calls().length, 4, `${JSON.stringify(accel)}：看图 / 混合 / 标注 / 主线各一次`);
    assert.deepEqual(calls().map(c => Object.keys(c).sort()), Array(4).fill(['model', 'provider']),
      `${JSON.stringify(accel)}：请求配置里除了路由没有任何新字段`);
    assert.deepEqual(calls().map(c => [c.provider, c.model]), Array(4).fill(['fixture-provider', 'fixture-model']));
    parser.dispose();
  }
  // ② 配了档位：只有给了的字段进调用配置，没配的阶段一个字段都不加。
  const { parser, calls } = stubLlm(taggingAnswer('概念'),
    { accel: { tags: { maxTokens: 4096, reasoningEffort: 'low' }, outline: {}, escalation: { maxTokens: 60000 } } });
  const output = await parser.parse(lesson());
  assert.equal(output.status, 'ready');
  assert.deepEqual(calls().map(c => c.maxTokens), [undefined, undefined, 4096, undefined], '只有标注阶段带上了预算');
  assert.deepEqual(calls().map(c => c.reasoningEffort), [undefined, undefined, 'low', undefined], '只有标注阶段带上了档位');
  parser.dispose();
  // ②b 适配器不认 accel：不能静默忽略 —— 那样用户以为降本生效了，而钱一分没少。
  const bare = new LectureParser({ llm: { resolve() {}, call() {}, image() {} }, accel: { tags: { maxTokens: 4096 } } });
  assert.equal(bare.accelIssues.length, 1);
  assert.ok(bare.accelIssues[0].includes('没有落点'));
  assert.deepEqual(new LectureParser({ llm: { resolve() {}, call() {}, image() {} } }).accelIssues, [], '不配档位就不该有告警');
  const bareEscalation = new LectureParser({ llm: { resolve() {}, call() {}, image() {} }, accel: { escalation: { maxTokens: 4096 } } });
  assert.equal(bareEscalation.accelIssues.length, 1, '只配了升档也算「配了档位」，同样要如实告警');
  bare.dispose(); bareEscalation.dispose();
  // ③ 归一：`{}`、阶段给 null、只给 0 都不产生字段；写错的配置**报错**而不是静默丢弃。
  assert.deepEqual(normalizeAccel({}), { stages: {}, escalation: null, issues: [] });
  assert.deepEqual(normalizeAccel({ faithful: null, tags: { maxTokens: 0, reasoningEffort: undefined } }), { stages: {}, escalation: null, issues: [] });
  assert.throws(() => normalizeAccel({ tags: { maxTokens: '8192' } }), { code: 'CONFIG' });
  assert.throws(() => normalizeAccel({ tags: { reasoningEffort: '' } }), { code: 'CONFIG' });
  assert.throws(() => normalizeAccel({ tags: { temperature: 0.2 } }), { code: 'CONFIG' });
  assert.throws(() => normalizeAccel({ escalation: { factor: 0.5, maxTokens: 60000 } }), { code: 'CONFIG' });
  assert.throws(() => normalizeAccel({ escalation: { maxTokens: 60000, ceiling: 0 } }), { code: 'CONFIG' });
  assert.equal(normalizeAccel({ nonsense: {} }).issues.length, 1, '不认识的键要如实报出');
  assert.equal(normalizeAccel({ escalation: {} }).issues.length, 1, '升档没有落点要如实报出');
  // ④ 硬顶与倍数（纯函数）：抬不过硬顶；非法倍数不抬（抬小比不抬更糟）。
  assert.equal(escalatedBudget({ current: 30000, factor: 2, ceiling: 50000 }), 50000);
  assert.equal(escalatedBudget({ current: 30000, factor: 2, ceiling: 131072 }), 60000);
  assert.equal(escalatedBudget({ current: 40000, factor: 0.5, ceiling: 50000 }), 40000);
  assert.equal(escalatedBudget({ current: 0, factor: 2 }), 0, '0 = 不传预算，不抬');
});
test('★ truncation escalates at most once and otherwise keeps the TRUNCATED failure', async () => {
  const make = accel => {
    const calls = [];
    const llm = new HarnessLlm({ selection:()=>({}), attachments:{ saveImage(){} }, accel, llm: { prepareCall: async config => {
      calls.push(config);
      return { config, stream: async function* () { yield { type: 'text-delta', index: 0, text: 'partial' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; } };
    } } });
    return { llm, calls };
  };
  // 配了升档预算：截断 → 按升档预算重发**恰好一次**；仍截断 → 走现有 TRUNCATED 失败路径。
  const escalated = make({ escalation: { maxTokens: 60000 } });
  await assert.rejects(escalated.llm.call({ route: { maxTokens: 30000 }, constant: '', variable: '', stage: 'mix' }), { code: 'TRUNCATED' });
  assert.deepEqual(escalated.calls.map(c => c.maxTokens), [30000, 60000], '先按原预算发一次，再按升档预算恰好发一次 —— 不许有第三次');
  // 没配升档：**一次都不重试**（同预算重发注定还是截断，只会白花钱）。
  const failed = make({ faithful: { maxTokens: 8192 } });
  await assert.rejects(failed.llm.call({ route: { maxTokens: 8192 }, constant: '', variable: '', stage: 'faithful' }), { code: 'TRUNCATED' });
  assert.deepEqual(failed.calls.map(c => c.maxTokens), [8192], '没有升档预算就没有第二次调用');
  const fallback = make({ escalation: { maxTokens: 4096 } });
  await assert.rejects(fallback.llm.call({ route: {}, constant: '', variable: '', stage: 'tags' }), { code: 'TRUNCATED' });
  assert.deepEqual(fallback.calls.map(c => c.maxTokens), [undefined, 4096]);
  // 升档**抬不动**时不许重试：请求不变的重发必然还是截断，只是白花一次调用。
  const ceiling = make({ escalation: { maxTokens: 30000, ceiling: 30000 } });
  await assert.rejects(ceiling.llm.call({ route: { maxTokens: 30000 }, constant: '', variable: '', stage: 'mix' }), { code: 'TRUNCATED' });
  assert.deepEqual(ceiling.calls.map(c => c.maxTokens), [30000], '硬顶已到 → 抬不动 → 不重试');
  // 硬顶与升档预算自相矛盾（硬顶更小）→ 开跑前报错，不悄悄纠正。
  assert.throws(() => normalizeAccel({ escalation: { maxTokens: 60000, ceiling: 30000 } }), { code: 'CONFIG' });
  const sameEffort = make({ tags: { reasoningEffort: 'low' }, escalation: { reasoningEffort: 'low' } });
  await assert.rejects(sameEffort.llm.call({ route: { reasoningEffort: 'low' }, constant: '', variable: '', stage: 'tags' }), { code: 'TRUNCATED' });
  assert.equal(sameEffort.calls.length, 1, '档位与现值相同 → 请求没变 → 不重试');
  // 升档后成功：如实报告抬过几次；不配 accel 时成功路径不报告升档。
  const ok = new HarnessLlm({ selection:()=>({}), attachments:{ saveImage(){} }, accel: { escalation: { maxTokens: 60000 } }, llm: { prepareCall: async config => ({ config, stream: async function* () {
    if (config.maxTokens === 60000) { yield { type: 'text-delta', index: 0, text: '完整回包' }; yield { type: 'finish', reason: { kind: 'stop' } }; yield { type: 'usage', usage: { outputTokens: 3 } }; return; }
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } }) } });
  const result = await ok.call({ route: { maxTokens: 30000 }, constant: '', variable: '', stage: 'mix' });
  assert.equal(result.text, '完整回包'); assert.equal(result.escalated, 1); assert.deepEqual(result.usage, { outputTokens: 3 });
  const noAccel = new HarnessLlm({ selection:()=>({}), attachments:{ saveImage(){} }, llm: { prepareCall: async config => ({ config, stream: async function* () { yield { type: 'text-delta', index: 0, text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) } });
  assert.equal((await noAccel.call({ route: {}, constant: '', variable: '', stage: 'mix' })).escalated, 0, '没配升档时成功路径不报告升档');
});
test('★ injected vocabulary store saves new tags once and seeds the next parse', async () => {
  const store = createMemoryVocabularyStore();
  const { parser, calls, requests } = stubLlm(taggingAnswer('新增:休息'));
  parser.vocabularyStore = store;
  const first = await parser.parse(lesson());
  assert.ok(first.vocabulary.some(t => t.name === '休息'), '新增标签要进本节的词表');
  assert.equal(store.saves, 1, '只在真的有新增时写一次');
  assert.ok(store.vocabulary.some(t => t.name === '休息'), '写回的是带新项的词表');
  const tagConstants = () => tagOnly(requests).map(r => r.messages[0].content[0].text);
  const injected = () => injectedVocabulary(tagConstants()[0]);
  assert.equal(tagConstants().length, 1, '只有分卷标注那一次请求带这份清单');
  assert.deepEqual(injected().split('、'), seedVocabulary().map(t => t.name), '注入的清单就是词表本身，不含「新增:」前缀');
  assert.ok(!injected().includes('休息'), '第一次解析时它还不是词表里的项');
  assert.equal(calls().length, 4);
  // 第二次解析：上一节的新项作为**种子**加载 → 它已是已有项，不再算新增、也就不用再写盘。
  const before = requests.length;
  const second = await parser.parse(lesson());
  assert.ok(second.vocabulary.some(t => t.name === '休息'), '第二次解析要从 store 里加载到它');
  assert.equal(store.saves, 1, '已存在的标签不算新增，不该再写一次');
  assert.deepEqual(injectedVocabulary(tagConstants().at(-1)).split('、'), [...seedVocabulary().map(t => t.name), '休息'],
    '第二次请求注入的清单要包含上一节新增的标签');
  assert.deepEqual(second.tagFailures, [], '它已经是词表里的项，不该被判成未知标签');
  assert.ok(requests.length > before, '词表变了 → 标注缓存键随之变化（不会被旧标注顶掉）');
  parser.dispose();
});
test('★ broken vocabulary load falls back to the seed with a named warning instead of failing', async () => {
  // ① store.load 抛错（磁盘 / 权限 / 宿主存储故障）：解析照常跑完。
  const boom = createVocabularyStore({ load: async () => { throw Object.assign(new Error('磁盘炸了'), { code: 'EACCES' }); }, save: async () => {} });
  const { parser } = stubLlm(taggingAnswer('概念'));
  parser.vocabularyStore = boom;
  const output = await parser.parse(lesson());
  assert.equal(output.status, 'ready', '词表加载失败不许让解析失败');
  assert.deepEqual(output.vocabulary.map(t => t.name), seedVocabulary().map(t => t.name), '回退到种子词表');
  assert.ok(output.warnings.some(w => w.includes('词表加载失败') && w.includes('EACCES')), '原因要进 warnings，不许静默当成「没有新增词」');
  assert.ok(parser.loadIssues.some(w => w.includes('EACCES')), '原因也要留在 loadIssues 上');
  parser.dispose();
  // ② 坏数据（不是 JSON / 项缺 name / 没有 terms 列表）：同样回退，逐条报出。
  const notJson = normalizeVocabulary('{oops');
  assert.deepEqual(notJson.vocabulary, seedVocabulary());
  assert.equal(notJson.issues.length, 1);
  const broken = normalizeVocabulary({ terms: [{ name: '睡眠', aliases: ['休息'] }, { aliases: ['x'] }, 'not-an-object'] });
  assert.deepEqual(broken.vocabulary.slice(0, 11).map(t => t.name), seedVocabulary().map(t => t.name), '种子项永远在，且排在最前');
  assert.ok(broken.vocabulary.some(t => t.name === '睡眠' && t.aliases[0] === '休息'), '好项照常留下');
  assert.equal(broken.issues.length, 3, '坏项逐条报出（缺 name、非对象），种子也不是悄悄补的');
  const noTerms = normalizeVocabulary({ v: 1 });
  assert.deepEqual(noTerms.vocabulary, seedVocabulary());
  assert.equal(noTerms.issues.length, 1);
  // ③ 写回失败也不算解析失败 —— 但要如实报出来（否则下次词表又回到旧样子而没人知道）。
  const failingSave = createVocabularyStore({ load: async () => null, save: async () => { throw Object.assign(new Error('只读'), { code: 'EROFS' }); } });
  const second = stubLlm(taggingAnswer('新增:休息'));
  second.parser.vocabularyStore = failingSave;
  const saved = await second.parser.parse(lesson());
  assert.equal(saved.status, 'ready');
  assert.ok(saved.warnings.some(w => w.includes('词表写入失败') && w.includes('EROFS')), '写盘失败要有名字');
  assert.ok(saved.vocabulary.some(t => t.name === '休息'), '这一节的标签照常打在块上');
  second.parser.dispose();
  // ④ 解析**失败**时已经长出来的标签仍要留住（用户重跑往往正是为了补那几卷）；
  //    但**取消不算失败**：用户按了停，就不该在磁盘上留下他没收下的东西。
  const failing = createMemoryVocabularyStore();
  // 让主线阶段炸掉：那是**标注之后**才走的最后一步，正好用来钉住失败路径的写回。
  const brokenCache = new ParserCache();
  const cache = { key: (stage, inputs) => { if (stage === 'outline') throw new Error('缓存键计算失败'); return brokenCache.key(stage, inputs); },
    get: key => brokenCache.get(key), put: (key, raw) => brokenCache.put(key, raw) };
  const third = stubLlm(taggingAnswer('新增:休息'), { cache });
  third.parser.vocabularyStore = failing;
  await assert.rejects(third.parser.parse(lesson()), { message: '缓存键计算失败' });
  assert.equal(failing.saves, 1, '失败路径上已提名的新标签要留住');
  assert.ok(failing.vocabulary.some(t => t.name === '休息'));
  const cancelledStore = createMemoryVocabularyStore();
  // 真正的窗口是「标注已经收下新标签、主线还在飞」时用户按停 —— 只有到这一步，
  // 取消与失败才分得开（早于标注的取消根本还没有新标签，钉不住这条护栏）。
  let outlineStarted; const outlineInFlight = new Promise(resolve => { outlineStarted = resolve; });
  const gated = stubLlm(options => {
    const constant = options.messages[0].content[0].text;
    if (!constant.startsWith('你在给一节大学课写**整节主线**')) return taggingAnswer('新增:休息')(options);
    outlineStarted();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, {});
  gated.parser.vocabularyStore = cancelledStore;
  const job = gated.parser.parse(lesson());
  await outlineInFlight;
  gated.parser.dispose();
  await assert.rejects(job, { code: 'CANCELLED' });
  assert.equal(cancelledStore.saves, 0, '取消不写盘（即使此刻已经有新标签在手上）');
});
test('★ vocabulary snapshot is the loaded one, so a changed vocabulary invalidates old annotations', async () => {
  // 词表变了，旧标注不许命中 —— 否则 filter 的稳定键会指向一份已经不存在的清单。
  const store = createMemoryVocabularyStore();
  const { parser, requests } = stubLlm(taggingAnswer('概念'));
  parser.vocabularyStore = store;
  const tagCalls = () => tagOnly(requests).length;
  const first = await parser.parse(lesson());
  assert.equal(tagCalls(), 1);
  await parser.parse(lesson());
  assert.equal(tagCalls(), 1, '词表没变 → 标注命中缓存');
  await store.save([...seedVocabulary(), { name: '休息', aliases: [] }]);
  const third = await parser.parse(lesson());
  assert.equal(tagCalls(), 2, '词表变了，标注快照随之变化，旧缓存不许命中');
  assert.ok(third.vocabulary.some(t => t.name === '休息'), '产物里的词表来自**加载后**的种子');
  assert.ok(!first.vocabulary.some(t => t.name === '休息'), '第一次解析时 store 里还没有它');
  parser.dispose();
});
test('★ json file vocabulary store writes through the host atomic writer', async () => {
  const writes = [];
  const store = createJsonFileVocabularyStore({ file: 'vocabulary.json',
    readFile: async () => JSON.stringify({ terms: [{ name: '睡眠', aliases: ['休息'] }] }),
    writeFile: async (file, text) => { writes.push([file, text]); } });
  const loaded = await store.load();
  assert.deepEqual(loaded.slice(0, 11).map(t => t.name), seedVocabulary().map(t => t.name));
  assert.ok(loaded.some(t => t.name === '睡眠' && t.aliases[0] === '休息'));
  await store.save([{ name: '睡眠', aliases: [] }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'vocabulary.json');
  assert.deepEqual(JSON.parse(writes[0][1]), { v: 1, kind: 'tag_vocabulary', terms: [{ name: '睡眠', aliases: [] }] });
  // 真落盘路径也要能读回来（宿主的原子写会自己建父目录）。
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-vocab-file-'));
  try {
    const real = createJsonFileVocabularyStore({ file: path.join(dir, 'nested/vocabulary.json') });
    assert.deepEqual((await real.load()).map(t => t.name), seedVocabulary().map(t => t.name), '没有文件 = 种子词表，不是错误');
    const terms = [...seedVocabulary(), { name: '睡眠', aliases: [] }];
    await real.save(terms);
    assert.deepEqual(await real.load(), terms);
    assert.ok((await readFile(path.join(dir, 'nested/vocabulary.json'), 'utf8')).includes('tag_vocabulary'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('★ real host: no accel adds no request fields; the vocabulary file reaches the host prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-vocab-host-')); let host;
  try {
    // 宿主侧的默认词表文件（`<profile>/data/zhiyun-parser/vocabulary.json`）先放一个
    // 别的节长出来的标签：插件必须**从它加载**，而不是每次从种子起步。
    const file = path.join(dir, 'data/zhiyun-parser/vocabulary.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ v: 1, kind: 'tag_vocabulary', terms: [...seedVocabulary(), { name: '休息', aliases: [] }] }));
    host = await mountHost(lock.hostVersions[0], dir, taggingAnswer('休息'));
    const output = await host.parser.parse(lesson());
    assert.equal(output.status, 'ready');
    assert.deepEqual(output.vocabulary.map(t => t.name), [...seedVocabulary().map(t => t.name), '休息'], '产物词表来自磁盘上的词表');
    const tagged = tagOnly(host.requests);
    assert.equal(tagged.length, 1);
    assert.deepEqual(injectedVocabulary(tagged[0].messages[0].content[0].text).split('、'), output.vocabulary.map(t => t.name));
    // 未配 accel → 请求上除了 provider/model 没有任何新字段（与上面直连那条同口径）。
    for (const request of host.requests) {
      assert.deepEqual(Object.keys(request).filter(key => key !== 'messages' && key !== 'signal').sort(), ['model', 'provider']);
    }
  } finally { await host?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
test('★ plugin config is the second accel entry point and reaches every stage', async () => {
  // `index.js` 的 config → HarnessLlm 接线：直接调插件的 apply（fixture 的挂载
  // 不接收插件 config，而这是**集成层**真正会走的那条路）。
  const requests = [], prepared = [];
  const inner = {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    prepareCall: async config => { prepared.push(config); return { config, inputModalities: ['text', 'image'], stream: async function* (options) {
      requests.push(options);
      const text = taggingAnswer('概念')(options);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }; },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-plugin-config-'));
  try {
    const provided = new Map();
    const ctx = {
      llm: inner, attachments: { saveImage: () => ({ attachmentId: 'fixture-image' }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) },
      profileContext: { dir }, zhiyunClassroom: {},
      provide: (name, value) => provided.set(name, value),
    };
    const teardown = await apply(ctx, { concurrency: 2, visionBatchSize: 2, accel: { tags: { maxTokens: 4096, reasoningEffort: 'low' } } });
    const parser = provided.get('zhiyunParser');
    assert.ok(parser, '插件要提供 zhiyunParser');
    assert.equal(parser.visionBatchSize, 2, '插件配置实际传给课件分组入口');
    const output = await parser.parse(lesson());
    assert.equal(output.status, 'ready');
    const tagged = tagOnly(requests);
    assert.ok(tagged.length);
    for (const request of tagged) { assert.equal(request.maxTokens, 4096); assert.equal(request.reasoningEffort, 'low'); }
    for (const request of requests.filter(r => !tagOnly([r]).length)) {
      assert.equal(request.maxTokens, undefined, '没配档位的阶段一个字段都不加');
      assert.equal(request.reasoningEffort, undefined);
    }
    // dispose 触发插件卸载；之后再解析要抛已关闭。
    await teardown();
    assert.equal(parser.closed, true);
    await assert.rejects(parser.parse(lesson()), { code: 'DISPOSED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('unrecognized model block syntax retries and cannot become cached ready through the whole-page fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-missing-blocks-')); let host;
  try {
    host = await mountHost(lock.hostVersions[0], dir, options => {
      const prompt=options.messages[0].content[0].text;
      if (prompt.includes('逐块语音稿清洗器')) return '## 逐块标注\n1-2 衔接：格式缺少块字';
      return answer(options);
    });
    const result = await host.parser.parse(lesson());
    assert.equal(result.status, 'partial'); assert.equal(result.sentences.length, 2);
    assert.equal(result.blocks.length, 1); assert.ok(result.failures.some(f=>f.code==='BLOCK_COVERAGE'));
    assert.ok(result.warnings.some(w=>w.includes('回退为整页一块')));
    assert.ok(host.requests.some(r=>r.messages[0].content.some(b=>b.text?.includes('不要省略「块」字'))));
    const calls = host.requests.length; await host.parser.parse(lesson());
    assert.ok(host.requests.length > calls, 'failed fallback must never be cached as converged');
  } finally { await host?.dispose(); await rm(dir, {recursive:true,force:true}); }
});
