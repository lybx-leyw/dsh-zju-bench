/**
 * 知识入库与检索：**跑真实的宿主存储栈**（storage + storage-json + storage-domain）。
 *
 * # 为什么这些用例不满足于"假装有个 storage"
 *
 * 本任务要拆掉的正是"自己写文件"那套。若用例里塞一个假的 storage，那么
 * 「记录真的按宿主 schema 存进了宿主看管的介质」「坏记录在读取边界如实被拒」
 * 「卸载后域真的被释放」这三条**全都验不到** —— 它们恰恰是宿主的行为。
 * 所以这里从 `.runtime/dsh-<版本>/node_modules` 加载真实的 cordis / dsh-storage /
 * dsh-storage-json / dsh-storage-domain，与 `tests/final-pass.test.mjs`、
 * `tests/classroom-cordis.test.mjs` 同一套做法。
 *
 * 测试里直接读写介质文件**只为**制造坏数据与核对落盘证据（产品代码一行文件 IO
 * 都没有，见 ⑦）：宿主没有"往介质里塞坏记录"的接口，要验读取端的校验只能在用例里种。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root, lock } from '../scripts/profile.mjs';
import * as plugin from '../packages/dsh-zhiyun-knowledge/src/index.js';
import { KnowledgeError } from '../packages/dsh-zhiyun-knowledge/src/errors.js';
import { DOMAIN_NAME, LECTURES_TABLE, keyOf, identityPart, createLectureSpec } from '../packages/dsh-zhiyun-knowledge/src/domain.js';
import { MATCH_FIELDS } from '../packages/dsh-zhiyun-knowledge/src/service.js';

/** 首选宿主（清单里验证过的那条线），与仓库其它宿主用例同源。 */
const HOST_VERSION = lock.preferredHostVersion ?? lock.hostVersions[0];

/** 某个宿主版本安装目录下的 `@deepseek-ai` 目录。 */
const hostModulesOf = (version) => path.join(root, '.runtime', `dsh-${version}`, 'node_modules', '@deepseek-ai');

/** 该宿主是否装了存储栈（没装就跳过，仓库既有惯例）。 */
async function hostAvailable(version = HOST_VERSION) {
  try { await access(path.join(hostModulesOf(version), 'dsh-storage-domain')); return true; } catch { return false; }
}

/**
 * 从宿主安装目录解析并加载存储栈。
 *
 * zod 从**域层的入口**解析：必须与域层校验用的是同一份 zod（见 src/host.js）。
 */
async function loadHostStack(version = HOST_VERSION) {
  const anchor = path.join(root, '.runtime', `dsh-${version}`);
  const require = createRequire(path.join(anchor, 'package.json'));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const domainEntry = require.resolve('@deepseek-ai/dsh-storage-domain');
  const zodEntry = createRequire(domainEntry).resolve('zod');
  const [cordis, storageModule, storageJson, storageDomain, zodModule] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-storage'),
    load('@deepseek-ai/dsh-storage-json'),
    load('@deepseek-ai/dsh-storage-domain'),
    import(pathToFileURL(zodEntry).href),
  ]);
  const z = zodModule.z ?? zodModule.default?.z ?? zodModule.default ?? zodModule;
  // 这套 `{ defineDomain, domainTable, z }` 正是插件从 profile 解析出来的同一份东西。
  const storage = { defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable, z };
  return { anchor, cordis, Storage: storageModule.default, storageJson, storageDomain, storage, z };
}

/**
 * 挂一个**真实宿主**：hub → json 后端 → 域层，再挂本插件。
 *
 * 不注入 `config.storage`：走的就是插件在真实宿主里的那条路 ——
 * 以 `profileContext.dir`（这里指向 `.runtime/dsh-<版本>`）为锚解析宿主栈。
 */
async function mountHost({ storageRoot, version = HOST_VERSION, config = {} } = {}) {
  const stack = await loadHostStack(version);
  const ctx = new stack.cordis.Context();
  try {
    await ctx.plugin(stack.Storage);
    await ctx.plugin(stack.storageJson, { root: storageRoot });
    await ctx.plugin(stack.storageDomain, { backend: 'json' });
    ctx.provide('profileContext', { dir: stack.anchor });
    const fiber = await ctx.plugin(plugin, config);
    return { ctx, fiber, service: ctx.get('zhiyunKnowledge'), stack };
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {});
    throw error;
  }
}

/**
 * 一份**与解析器真实产物同形**的记录：句子层 / 未落页 / 块层都要有真内容。
 *
 * `body` 可以换掉正文（账号隔离那类用例需要两份**正文不同**的记录：
 * 若两边正文一样，"搜不到对方的"就证明不了隔离，只能证明搜索坏了）。
 * `summaries` 同理，用来单独验"概述"这一档检索面。
 */
function lectureRecord({
  accountId = '1', courseId = '10', subId = '20', status = 'ready', fetchedAt = '2026-10-07T00:00:00.000Z',
  body = ['旧事史', '概率密度函数'], summaries = ['概率密度的定义', '密度函数的性质'],
  bridges = ['接着看下一页', ''], unassignedText = '这一句没落到任何一页',
} = {}) {
  const sentence = (startMs, endMs, page, text, correctionDistance = 0) => ({ startMs, endMs, page, text, correctionDistance });
  const sentences = [sentence(1234, 2000, 1, body[0], 2), sentence(2200, 3100, 1, body[1])];
  return {
    // 身份三元组（键就是这三段拼的）
    accountId, courseId, subId,
    // 解析器产物
    schema: 1,
    sourceId: `zhiyun:112:${courseId}:${subId}`,
    status,
    fetchedAt,
    pages: [{ page: 1, transcription: { pageText: '概率密度函数', pageVisual: '一张曲线图' } }],
    sentences,
    unassignedSentences: [sentence(9000, 9500, null, unassignedText)],
    blocks: [
      { index: 1, sentenceFrom: 1, sentenceTo: 1, page: 1, startMs: 1234, endMs: 2000, bridge: bridges[0],
        sentences: [sentences[0]], tag: { role: '主线', facets: ['概念'], summary: summaries[0] } },
      { index: 2, sentenceFrom: 2, sentenceTo: 2, page: 1, startMs: 2200, endMs: 3100, bridge: bridges[1],
        sentences: [sentences[1]], tag: { role: null, facets: null, summary: summaries[1] } },
    ],
    spine: '从旧事史到概率密度函数',
    outline: [{ title: '概念', from: 1, to: 2 }],
    glossary: { minCount: 2, extracted: [], terms: [] },
    vocabulary: [{ name: '概念', aliases: [] }, { name: '概率密度函数', aliases: [] }],
    failedPages: [], failures: [], tagFailures: [], outlineFailure: null,
    warnings: ['1 句字幕未分配，已保留'], calls: [], version: 'hash-fixture',
    lecture: null,
  };
}

/** 介质文件：单文档布局下就是 `<root>/<域名>.json`（宿主 json 后端自己的约定）。 */
const mediumFile = (storageRoot) => path.join(storageRoot, `${DOMAIN_NAME}.json`);

/** 读介质并原样改一处再写回 —— **只在用例里**用来种坏数据 / 核对落盘。 */
async function rewriteMedium(storageRoot, mutate) {
  const file = mediumFile(storageRoot);
  const document = JSON.parse(await readFile(file, 'utf8'));
  mutate(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}

/** 每个用例一份独立介质；挂过的宿主都在收尾时卸载（dispose 幂等）。 */
async function withMedia(run) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'zhiyun-knowledge-'));
  const mounted = [];
  try {
    return await run({ storageRoot, mount: (options) => { const host = mountHost({ storageRoot, ...options }); mounted.push(host); return host; } });
  } finally {
    for (const pending of mounted.reverse()) await (await pending.catch(() => null))?.ctx.fiber.dispose().catch(() => {});
    await rm(storageRoot, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════
// ⓪ 纯离线部分：键与身份、插件形状（不需要宿主）
// ═══════════════════════════════════════════════════════════════

test('键由身份拼出且分隔符不可伪造：段里含冒号会让两个不同身份撞成同一把键', () => {
  assert.equal(keyOf('1', '10', '20'), '1:10:20');
  // 冒号是键的分隔符：段里再出现冒号就会让 ('1:2','3') 与 ('1','2:3') 撞键 —— 必须拒。
  for (const bad of ['1:2', '', '  ', 'a b', 1, null, undefined]) {
    assert.throws(() => identityPart(bad, 'accountId'), (error) => error instanceof KnowledgeError && error.code === 'INPUT',
      `身份段 ${JSON.stringify(bad)} 必须被拒`);
  }
  assert.throws(() => keyOf('1', '2:3', '4'), { code: 'INPUT' });
  // 空白被归一，不会把 `' 1'` 与 `'1'` 落成两条。
  assert.equal(keyOf(' 1 ', ' 10 ', ' 20 '), '1:10:20');
  assert.throws(() => keyOf('1', '10', 'x'.repeat(201)), { code: 'INPUT' });
});

test('插件声明了宿主依赖：没有 storageDomain 就没有持久化，绝不静默自建落盘', () => {
  assert.equal(plugin.name, 'zhiyun-knowledge');
  assert.ok(plugin.inject.includes('storageDomain'), 'inject 要写明 storageDomain');
  assert.ok(plugin.inject.includes('profileContext'), 'inject 要写明 profileContext（解析锚点）');
  assert.equal(typeof plugin.apply, 'function');
});

test('没有 ctx.storageDomain 时如实报配置错，而不是退化成自己写文件', async () => {
  const ctx = { profileContext: { dir: path.join(root, '.runtime', `dsh-${HOST_VERSION}`) }, provide: () => { throw new Error('不该走到 provide'); } };
  await assert.rejects(plugin.apply(ctx, {}), (error) => error.code === 'CONFIG' && /storageDomain/.test(error.message));
});

test('配置错了就报配置错：profile 目录里解析不到域层时如实失败', async () => {
  const emptyDir = await mkdtemp(path.join(tmpdir(), 'zhiyun-knowledge-empty-'));
  try {
    const storageDomain = { open: async () => { throw new Error('不该走到 open'); } };
    await assert.rejects(plugin.apply({ storageDomain, profileContext: { dir: emptyDir }, provide: () => {} }, {}),
      (error) => error.code === 'CONFIG' && /dsh-storage-domain/.test(error.message));
    // 缺锚点（没有 profileContext.dir）同样是配置错，不是"默默不用存储"。
    await assert.rejects(plugin.apply({ storageDomain, profileContext: {}, provide: () => {} }, {}),
      (error) => error.code === 'CONFIG' && /profileContext/.test(error.message));
  } finally { await rm(emptyDir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════
// 宿主相关用例
// ═══════════════════════════════════════════════════════════════

test('① 写入-读回逐字段一致，且真的落在宿主 json 后端的介质上', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot, mount }) => {
    const { service } = await mount();
    const input = lectureRecord();
    const { key, replaced } = await service.put(input);
    assert.equal(key, '1:10:20');
    assert.equal(replaced, false, '第一次写入不是覆盖');

    // 逐字段一致：未落页字幕与 blocks 都在（这两处最容易在"换个存储"时被丢）。
    const readBack = service.get({ accountId: '1', courseId: '10', subId: '20' });
    assert.deepEqual(readBack, JSON.parse(JSON.stringify(input)));
    assert.deepEqual(readBack.unassignedSentences.map((s) => s.text), ['这一句没落到任何一页']);
    assert.deepEqual(readBack.blocks.map((b) => [b.index, b.bridge, b.tag.summary]),
      [[1, '接着看下一页', '概率密度的定义'], [2, '', '密度函数的性质']]);
    assert.equal(readBack.lecture, null, '讲义暂未生成时字段在且为 null');
    // 解析器的额外字段（pages / glossary / version…）原样带过，不被 schema 削掉。
    assert.equal(readBack.pages[0].transcription.pageText, '概率密度函数');
    assert.equal(readBack.version, 'hash-fixture');

    // 落盘证据：宿主 json 后端自己的单文档布局 + unit 头。
    assert.deepEqual(await readdir(storageRoot), [`${DOMAIN_NAME}.json`]);
    const document = JSON.parse(await readFile(mediumFile(storageRoot), 'utf8'));
    assert.equal(document.unit.name, DOMAIN_NAME);
    assert.equal(document.unit.version, 1);
    assert.deepEqual(document.tables[LECTURES_TABLE][key], JSON.parse(JSON.stringify(input)));
  });
});

test('①续 关掉宿主再开一份：记录从介质里回来（真的持久化，不是内存缓存）', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot, mount }) => {
    const first = await mount();
    const input = lectureRecord();
    await first.service.put(input);
    assert.equal(first.service.size, 1);
    await first.ctx.fiber.dispose();   // 整个宿主退出

    const second = await mount();
    assert.equal(second.service.size, 1, '新宿主应当从介质里读回一条');
    assert.deepEqual(second.service.get({ accountId: '1', courseId: '10', subId: '20' }), JSON.parse(JSON.stringify(input)));
  });
});

test('② 账号隔离：不同账号的同名课程节次互不可见', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ mount }) => {
    const { service } = await mount();
    // ⚠️ 两个账号的正文必须**不同**：正文一样的话，"搜不到对方的"证明不了隔离，
    //    只能证明搜索坏了（同一条搜到两次也说得通）。
    await service.put(lectureRecord({ accountId: '1', body: ['甲账号独有的一句', '甲账号的第二句'], summaries: ['甲账号的概述', '甲账号的第二段概述'] }));
    await service.put(lectureRecord({ accountId: '2', subId: '21', body: ['乙账号独有的一句', '乙账号的第二句'], summaries: ['乙账号的概述', '乙账号的第二段概述'] }));

    // 读：两个账号的键互不可见。
    assert.equal(service.get({ accountId: '2', courseId: '10', subId: '21' }).accountId, '2');
    assert.equal(service.get({ accountId: '1', courseId: '10', subId: '21' }), undefined);
    assert.equal(service.get({ accountId: '2', courseId: '10', subId: '20' }), undefined);
    // 列：账号 2 的"同一门课"只有它自己那一条。
    assert.deepEqual(service.listByCourse({ accountId: '2', courseId: '10' }).map((r) => r.subId), ['21']);
    assert.deepEqual(service.listByCourse({ accountId: '1', courseId: '10' }).map((r) => r.subId), ['20']);
    // 检索也不许跨账号：甲搜"乙的正文"零命中，反过来也一样。
    assert.deepEqual(service.search({ accountId: '1', query: '乙账号独有' }), []);
    assert.deepEqual(service.search({ accountId: '2', query: '甲账号独有' }), []);
    assert.deepEqual(service.search({ accountId: '1', query: '甲账号独有' }).map((h) => h.key), ['1:10:20']);
    assert.deepEqual(service.search({ accountId: '2', query: '乙账号独有' }).map((h) => h.key), ['2:10:21']);
    // 删：删账号 2 的节次不影响账号 1 的。
    assert.equal(await service.remove({ accountId: '2', courseId: '10', subId: '21' }), true);
    assert.ok(service.get({ accountId: '1', courseId: '10', subId: '20' }));
    assert.equal(service.get({ accountId: '2', courseId: '10', subId: '21' }), undefined);
    // 删不存在的返回 false（不是报错，也不是"删掉了"）。
    assert.equal(await service.remove({ accountId: '2', courseId: '10', subId: '21' }), false);
  });
});

test('②续 账号 "1" 与 "10" 不会因为前缀相同而串数据（分隔符是键的一部分）', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ mount }) => {
    const { service } = await mount();
    await service.put(lectureRecord({ accountId: '1', body: ['一号账号的正文', '第二句'], summaries: ['一号概述', '第二段概述'] }));
    await service.put(lectureRecord({ accountId: '10', body: ['十号账号的正文', '第二句'], summaries: ['十号概述', '第二段概述'] }));
    // 键前缀 `1:` 不能匹配 `10:10:20`。
    assert.deepEqual(service.listByCourse({ accountId: '1', courseId: '10' }).map((r) => r.key), ['1:10:20']);
    assert.deepEqual(service.listByCourse({ accountId: '10', courseId: '10' }).map((r) => r.key), ['10:10:20']);
    assert.deepEqual(service.search({ accountId: '1', query: '正文' }).map((h) => h.accountId), ['1']);
    assert.deepEqual(service.search({ accountId: '10', query: '正文' }).map((h) => h.accountId), ['10']);
    assert.deepEqual(service.search({ accountId: '1', query: '十号账号' }), []);
  });
});

test('③ 同一把键再写一次是替换而不是追加（块数与句数一起换掉）', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot, mount }) => {
    const { service } = await mount();
    await service.put(lectureRecord());
    assert.equal(service.size, 1);

    const replacement = lectureRecord({ status: 'partial', fetchedAt: '2026-10-08T12:00:00.000Z' });
    replacement.blocks = [];                                     // 覆盖后不许还留着上一次的块
    replacement.sentences = replacement.sentences.slice(0, 1);   // 也不许把句数拼起来
    replacement.unassignedSentences = [];
    const second = await service.put(replacement);
    assert.equal(second.replaced, true, '第二次写入应当报"覆盖"');

    assert.equal(service.size, 1, '同一把键在表里只占一条');
    const readBack = service.get({ accountId: '1', courseId: '10', subId: '20' });
    assert.deepEqual(readBack, JSON.parse(JSON.stringify(replacement)));
    assert.equal(readBack.status, 'partial');
    assert.equal(readBack.blocks.length, 0);
    assert.equal(readBack.sentences.length, 1);
    assert.equal(service.listByCourse({ accountId: '1', courseId: '10' }).length, 1);
    // 介质里也只有一条（不是"追加了两条"）。
    const document = JSON.parse(await readFile(mediumFile(storageRoot), 'utf8'));
    assert.deepEqual(Object.keys(document.tables[LECTURES_TABLE]), ['1:10:20']);
  });
});

test('④ 坏字段：写入端有名字地拒；介质里已有的坏记录让 open 如实失败，不当成"没有这条"', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot, mount }) => {
    // 写入口径：坏记录不许落盘（否则它会在下次 open 时把整个域卡住）。
    const { service } = await mount();
    // ⚠️ 两种失败要分得清：身份坏是 INPUT（键都拼不出来），记录坏是 INVALID_RECORD。
    for (const [label, patch] of [
      ['status 不在词表里', { status: 'done' }],
      ['句子正文不是字符串', { sentences: [{ startMs: 1, endMs: 2, text: 3 }] }],
      ['块不是数组', { blocks: 'nope' }],
      ['警告里混了非字符串', { warnings: [1] }],
      ['schema 不是正整数', { schema: 0 }],
      ['概述不是字符串', { blocks: [{ index: 1, sentenceFrom: 1, sentenceTo: 1, bridge: '', sentences: [], tag: { summary: 42 } }] }],
    ]) {
      await assert.rejects(service.put({ ...lectureRecord(), ...patch }), (error) => {
        assert.equal(error.name, 'KnowledgeError', label);
        assert.equal(error.code, 'INVALID_RECORD', `${label} 应当以 INVALID_RECORD 失败`);
        return true;
      }, label);
    }
    // 身份坏在 schema 之前就被拦住（键是身份的函数）。
    await assert.rejects(service.put({ ...lectureRecord(), accountId: undefined }), { name: 'KnowledgeError', code: 'INPUT' });
    await assert.rejects(service.put({ ...lectureRecord(), courseId: '1:0' }), { name: 'KnowledgeError', code: 'INPUT' });
    await assert.rejects(service.put(null), { name: 'KnowledgeError', code: 'INPUT' });
    assert.equal(service.size, 0, '坏记录一条都不许落盘');
    // 好记录照常能写：拒的是那条坏的，不是整个服务。
    await service.put(lectureRecord());
    assert.equal(service.size, 1);
  });

  // 读取端：往介质里种一条坏记录。
  await withMedia(async ({ storageRoot, mount }) => {
    const first = await mount();
    await first.service.put(lectureRecord());
    await first.ctx.fiber.dispose();          // 关掉，放开域与介质句柄

    await rewriteMedium(storageRoot, (document) => {
      document.tables[LECTURES_TABLE]['1:10:99'] = { accountId: '1', courseId: '10', subId: '99' }; // 缺 status / blocks …
    });

    // ① 插件挂载（= 打开域）必须失败，且错误要指出是哪张表的哪个键。
    await assert.rejects(mount(), (error) => {
      assert.equal(error.name, 'DomainError');
      assert.equal(error.code, 'invalid-record', '坏记录必须让 open 如实失败');
      assert.equal(error.detail.table, LECTURES_TABLE);
      assert.equal(error.detail.key, '1:10:99');
      return true;
    }, '坏记录不许被静默跳过');

    // ② 反面：摘掉坏记录后同一个域能正常打开 —— 证明前面拒的确实是那条坏记录。
    await rewriteMedium(storageRoot, (document) => { delete document.tables[LECTURES_TABLE]['1:10:99']; });
    const recovered = await mount();
    assert.equal(recovered.service.size, 1);
    assert.equal(recovered.service.get({ accountId: '1', courseId: '10', subId: '20' }).spine, '从旧事史到概率密度函数');
    // 而"这条确实不存在"仍然是 undefined —— 与"坏掉"是两种不同的结果。
    assert.equal(recovered.service.get({ accountId: '1', courseId: '10', subId: '99' }), undefined);
  });
});

test('⑤ 检索：块正文/概述/衔接命中，不命中就是空；只在给定账号（与可选课程）里找', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ mount }) => {
    const { service } = await mount();
    assert.deepEqual(MATCH_FIELDS, ['sentence', 'summary', 'bridge'], '检索面就是这三处，不多不少');
    // 两门课的正文/概述/衔接取不同字面量，才能分清"命中"与"串课"。
    await service.put(lectureRecord({ courseId: '10', subId: '20' }));
    await service.put(lectureRecord({
      courseId: '11', subId: '30',
      body: ['另一门课的第一句', '另一门课的第二句'],
      // 第二块的概述**故意与课程 10 的概述共享字面量**：用来验"不限定课程时两门课都找得到"，
      // 而 '旧事史' / '另一门课' 这类只属于一门的字面量用来验限定确实生效。
      summaries: ['另一门课的概述', '密度函数的性质（另一门课版本）'],
      bridges: ['另一门课的衔接', ''],
      unassignedText: '另一门课没落页的一句',
    }));

    // 命中：块正文
    const bySentence = service.search({ accountId: '1', query: '旧事史' });
    assert.equal(bySentence.length, 1, '只有 10 那门课的块里含这三个字');
    assert.equal(bySentence[0].key, '1:10:20');
    assert.deepEqual(bySentence[0].matches, [{ field: 'sentence', blockIndex: 1, text: '旧事史' }]);
    // 命中：块概述（共享字面量 → 两门课各命中一次，且都指到第 2 块）
    assert.deepEqual(service.search({ accountId: '1', query: '密度函数的性质' }).map((h) => [h.courseId, h.matches[0].field, h.matches[0].blockIndex]),
      [['10', 'summary', 2], ['11', 'summary', 2]]);
    // 命中：块衔接
    assert.deepEqual(service.search({ accountId: '1', query: '接着看下一页' }).map((h) => [h.courseId, h.matches]),
      [['10', [{ field: 'bridge', blockIndex: 1, text: '接着看下一页' }]]]);
    // 命中多块时不会漏：'另一门课' 在两块的正文与概述/衔接里都出现。
    assert.ok(service.search({ accountId: '1', query: '另一门课' })[0].matches.length >= 2, '一条记录里的多处命中都要列出来');
    // 课程限定：只属于一门的字面量在另一门里搜不到，反之亦然。
    assert.deepEqual(service.search({ accountId: '1', query: '旧事史', courseId: '10' }).map((h) => h.courseId), ['10']);
    assert.deepEqual(service.search({ accountId: '1', query: '旧事史', courseId: '11' }), []);
    assert.deepEqual(service.search({ accountId: '1', query: '另一门课', courseId: '10' }), []);
    assert.deepEqual(service.search({ accountId: '1', query: '密度函数的性质', courseId: '11' }).map((h) => h.courseId), ['11']);
    // 不限定课程则两门课都在（仍限本账号）。
    assert.deepEqual(service.search({ accountId: '1', query: '密度函数的性质' }).map((h) => h.courseId), ['10', '11']);

    // 未命中：检索词根本不在任何块里 → 空数组（不是 undefined，也不是"返回全部"）。
    assert.deepEqual(service.search({ accountId: '1', query: '傅里叶变换' }), []);
    // 字面匹配的边界：**不是**向量/AI 检索 —— 不切词、不做同义、大小写敏感。
    // '旧事' 是 '旧事史' 的连续子串，**应当**命中（这正是"字面"的意思）；
    // 真正的反例是"字都在、但不连续"：切词或模糊匹配才会命中它。
    assert.deepEqual(service.search({ accountId: '1', query: '旧事' }).map((h) => h.matches[0].text), ['旧事史']);
    assert.deepEqual(service.search({ accountId: '1', query: '事史旧' }), [], '不做分词/不做乱序匹配：只匹配连续子串');
    assert.deepEqual(service.search({ accountId: '1', query: '概率函数' }), [], '不切词：把词拆开拼起来不算命中');
    assert.deepEqual(service.search({ accountId: '1', query: 'OLD' }), [], '大小写敏感（也不做任何同义改写）');
    // 未落页的字幕不属于任何块，因此不在被检索的表面上（见 service.js searchableFragments）。
    assert.deepEqual(service.search({ accountId: '1', query: '没落到任何一页' }), []);
    assert.deepEqual(service.search({ accountId: '1', query: '另一门课没落页' }), []);
    // 空检索词不许退化成"返回全部"。
    assert.throws(() => service.search({ accountId: '1', query: '   ' }), { code: 'INPUT' });
    assert.throws(() => service.search({ accountId: '1' }), { code: 'INPUT' });
    // 列出课程时给的是摘要而不是整份产物（几百 KB 的产物不该拖进列表）。
    const [summary] = service.listByCourse({ accountId: '1', courseId: '10' });
    assert.equal(summary.record, undefined);
    assert.deepEqual(summary.counts, { sentences: 2, unassignedSentences: 1, blocks: 2, outline: 1, vocabulary: 2, warnings: 1 });
    assert.equal(summary.hasLecture, false);
    assert.ok(service.listByCourse({ accountId: '1', courseId: '10', full: true })[0].record.blocks.length === 2);
  });
});

test('⑥ 卸载后服务消失、域被释放，旧引用拿到的是 DISPOSED 而不是宿主的 closed', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ mount }) => {
    const host = await mount();
    const service = host.service;
    await service.put(lectureRecord());
    assert.ok(host.ctx.storageDomain.get(DOMAIN_NAME), '卸载前域是开着的');

    await host.fiber.dispose();   // 只卸载本插件

    assert.equal(host.ctx.get('zhiyunKnowledge'), undefined, '服务要从 ctx 上消失');
    assert.equal(host.ctx.storageDomain.get(DOMAIN_NAME), undefined, '宿主域要被释放（域名放开）');
    assert.equal(service.closed, true);
    assert.throws(() => service.get({ accountId: '1', courseId: '10', subId: '20' }), (error) => error.code === 'DISPOSED');
    assert.throws(() => service.listByCourse({ accountId: '1', courseId: '10' }), (error) => error.code === 'DISPOSED');
    assert.throws(() => service.search({ accountId: '1', query: '旧事史' }), (error) => error.code === 'DISPOSED');
    assert.throws(() => service.size, (error) => error.code === 'DISPOSED');
    await assert.rejects(service.put(lectureRecord()), (error) => error.code === 'DISPOSED');
    await assert.rejects(service.remove({ accountId: '1', courseId: '10', subId: '20' }), (error) => error.code === 'DISPOSED');

    // 域名放开后，同一个宿主里能重新打开并读到之前写下的东西。
    const spec = createLectureSpec(host.stack.storage);
    const reopened = await host.ctx.storageDomain.open(spec);
    try {
      assert.equal(reopened.table(LECTURES_TABLE).get('1:10:20').status, 'ready');
    } finally { await reopened.close(); }
  });
});

test('⑥续 名单里的每个宿主版本都能挂起来用（宿主 API 不押在某一个版本上）', async (t) => {
  const available = [];
  for (const version of lock.hostVersions) if (await hostAvailable(version)) available.push(version);
  if (!available.length) return t.skip('没有安装任何清单里的宿主');

  for (const version of available) {
    const storageRoot = await mkdtemp(path.join(tmpdir(), `zhiyun-knowledge-${version}-`));
    const stack = await loadHostStack(version);
    const ctx = new stack.cordis.Context();
    try {
      await ctx.plugin(stack.Storage);
      await ctx.plugin(stack.storageJson, { root: storageRoot });
      await ctx.plugin(stack.storageDomain, { backend: 'json' });
      // 这里**不**注入 config.storage：走真实的 profile 锚点解析路径。
      ctx.provide('profileContext', { dir: stack.anchor });
      const fiber = await ctx.plugin(plugin, {});
      const service = ctx.get('zhiyunKnowledge');
      assert.ok(service, `${version}: 服务要挂上`);
      await service.put(lectureRecord());
      assert.equal(service.get({ accountId: '1', courseId: '10', subId: '20' }).status, 'ready', `${version}: 写入-读回`);
      assert.equal(service.search({ accountId: '1', query: '旧事史' }).length, 1, `${version}: 检索`);
      await fiber.dispose();
      assert.equal(ctx.get('zhiyunKnowledge'), undefined, `${version}: 卸载后服务消失`);
      assert.equal(ctx.storageDomain.get(DOMAIN_NAME), undefined, `${version}: 卸载后域释放`);
    } finally {
      await ctx.fiber.dispose().catch(() => {});
      await rm(storageRoot, { recursive: true, force: true });
    }
  }
});

test('⑥续 provide 撞名时挂载失败，但域不许被永久占住（否则之后再也开不上）', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot }) => {
    const stack = await loadHostStack();
    const ctx = new stack.cordis.Context();
    try {
      await ctx.plugin(stack.Storage);
      await ctx.plugin(stack.storageJson, { root: storageRoot });
      await ctx.plugin(stack.storageDomain, { backend: 'json' });
      ctx.provide('profileContext', { dir: stack.anchor });
      // 用一个**可卸载**的占位插件占住这个名字：`provide` 的所有权绑在 fiber 上，
      // 卸载它才会真正放开名字（`ctx.reflect.set` 只是改值，不释放注册）。
      const placeholder = await ctx.plugin({ apply(c) { c.provide('zhiyunKnowledge', { 占位: true }); } });
      await assert.rejects(async () => { await ctx.plugin(plugin, {}); }, /zhiyunKnowledge|already/i);

      // 关键：失败的挂载**不许**把域留在 facility 里（留着就等于域名被 reserved，
      // 之后任何一次 open 都会以 already-open 失败 —— 插件再也起不来）。
      assert.equal(ctx.storageDomain.get(DOMAIN_NAME), undefined, '挂载失败后域必须被释放');

      // 放开占位服务后，同一个宿主里能重新挂上并正常用。
      await placeholder.dispose();
      const fiber = await ctx.plugin(plugin, {});
      const service = ctx.get('zhiyunKnowledge');
      assert.ok(service?.put, '重新挂载后服务要可用');
      await service.put(lectureRecord());
      assert.equal(service.size, 1);
      await fiber.dispose();
      assert.equal(ctx.storageDomain.get(DOMAIN_NAME), undefined);
    } finally { await ctx.fiber.dispose(); }
  });
});

test('⑦ 产品代码零文件 IO：持久化只走 ctx.storageDomain（这条约束用自检钉住）', async () => {
  const dir = new URL('../packages/dsh-zhiyun-knowledge/src/', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.js'));
  assert.ok(files.length >= 5, 'errors / host / domain / service / index');
  // 先剥注释再扫：说明文字里就写着「本包不碰 node:fs」，不剥注释会把自己的注释判红。
  const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of files) {
    const code = stripComments(await readFile(new URL(file, dir), 'utf8'));
    for (const [what, pattern] of [
      ['文件读写', /node:fs|writeFileAtomic|readFileSync|writeFileSync/],
      ['临时文件 + rename', /\brenameSync|\brename\s*\(|\.tmp\b|tmpdir\s*\(/],
      ['自建 JSON 落盘', /writeFile\s*\(|readFile\s*\(/],
    ]) {
      assert.ok(!pattern.test(code), `${file} 不许${what}：持久化是宿主存储栈的职责`);
    }
  }
  // 域规格用的 zod 必须来自宿主（不能自己 import 一个 zod 副本）。
  const domainSource = stripComments(await readFile(new URL('domain.js', dir), 'utf8'));
  assert.ok(!/from\s+['"]zod['"]|require\(['"]zod['"]\)/.test(domainSource),
    'domain.js 不许自己 import zod，schema 要由宿主的 zod 构造');
  // 打开域这件事只出现在 index.js（别的文件不该绕过插件自己开域）。
  for (const file of files) {
    if (file === 'index.js') continue;
    const code = stripComments(await readFile(new URL(file, dir), 'utf8'));
    assert.ok(!/storageDomain\s*\.\s*open|\.open\(\s*spec/.test(code), `${file} 不该自己打开域`);
  }
});

test('⑦续 config.storage 可注入宿主栈：不依赖 profile 解析，也能挂起来用', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot }) => {
    const stack = await loadHostStack();
    const ctx = new stack.cordis.Context();
    try {
      await ctx.plugin(stack.Storage);
      await ctx.plugin(stack.storageJson, { root: storageRoot });
      await ctx.plugin(stack.storageDomain, { backend: 'json' });
      // profileContext 依旧要给（inject 里是硬依赖，见 index.js 的说明），
      // 但这里**故意把它指到一个没有宿主包的目录**：证明这条路真的只靠注入的栈，
      // 没有偷偷回落到 profile 解析。
      const emptyDir = await mkdtemp(path.join(tmpdir(), 'zhiyun-knowledge-noanchor-'));
      ctx.provide('profileContext', { dir: emptyDir });
      const fiber = await ctx.plugin(plugin, { storage: stack.storage });
      const service = ctx.get('zhiyunKnowledge');
      assert.ok(service, '注入宿主栈后服务要能用（不经过 profile 解析）');
      await service.put(lectureRecord());
      assert.equal(service.get({ accountId: '1', courseId: '10', subId: '20' }).status, 'ready');
      await fiber.dispose();
      await rm(emptyDir, { recursive: true, force: true });

      // 注入的栈形状不对要有名字地拒（不许静默退化）。
      // ⚠️ `ctx.plugin()` 返回的是 Fiber（thenable），不是 Promise 实例 ——
      //    `assert.rejects` 只收函数或 Promise，所以这里包一层 async 函数。
      for (const broken of [{ defineDomain: 1 }, { defineDomain: () => {}, domainTable: () => {}, z: {} }, null]) {
        const other = new stack.cordis.Context();
        await other.plugin(stack.Storage);
        await other.plugin(stack.storageJson, { root: path.join(storageRoot, 'other') });
        await other.plugin(stack.storageDomain, { backend: 'json' });
        other.provide('profileContext', { dir: stack.anchor });
        await assert.rejects(async () => { await other.plugin(plugin, { storage: broken }); }, { code: 'CONFIG' },
          `形状不对的注入栈 ${JSON.stringify(broken)} 必须报配置错`);
        await other.fiber.dispose();
      }
    } finally { await ctx.fiber.dispose(); }
  });
});

test('⑦续 从真实 profile 目录解析宿主栈（生产里 profileContext.dir 就是它）', async (t) => {
  // 生产里 `profileContext.dir` 是 `.runtime/home/profiles/<profile>`，宿主包在那里
  // 是**链接**（junction），不是实体目录。这条路径与 `.runtime/dsh-<版本>` 不同，
  // 而它才是插件真正会拿到的那一个 —— 必须单独验。
  const profileDir = path.join(root, '.runtime', 'home', 'profiles', lock.profile);
  try { await access(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-storage-domain')); }
  catch { return t.skip('本机还没初始化 profile（npm run profile:init）'); }

  const storageRoot = await mkdtemp(path.join(tmpdir(), 'zhiyun-knowledge-profile-'));
  const stack = await loadHostStack();
  const ctx = new stack.cordis.Context();
  try {
    await ctx.plugin(stack.Storage);
    await ctx.plugin(stack.storageJson, { root: storageRoot });
    await ctx.plugin(stack.storageDomain, { backend: 'json' });
    ctx.provide('profileContext', { dir: profileDir });
    // 不注入 config.storage：真的走 profile 解析。
    const fiber = await ctx.plugin(plugin, {});
    const service = ctx.get('zhiyunKnowledge');
    assert.ok(service, '从真实 profile 目录解析出宿主栈并挂上服务');
    await service.put(lectureRecord());
    assert.equal(service.get({ accountId: '1', courseId: '10', subId: '20' }).status, 'ready');
    assert.equal(service.search({ accountId: '1', query: '旧事史' }).length, 1);
    await fiber.dispose();
    assert.equal(ctx.get('zhiyunKnowledge'), undefined);
  } finally {
    await ctx.fiber.dispose().catch(() => {});
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('⑦续 键与记录身份不一致时如实报错（不静默当成"没有这条"）', async (t) => {
  if (!await hostAvailable()) return t.skip('此宿主未安装 storage-domain');
  await withMedia(async ({ storageRoot, mount }) => {
    // 种一条**过得了 schema、但身份与键不符**的记录：schema 层面它是合法的，
    // 唯一能看出问题的地方是与键的一致性 —— 若那条检查被省掉，listByCourse 的
    // 前缀就会把别的账号的数据带出来（正是隔离的反例）。
    const first = await mount();
    await first.service.put(lectureRecord({ accountId: '1' }));
    await first.ctx.fiber.dispose();

    await rewriteMedium(storageRoot, (document) => {
      const table = document.tables[LECTURES_TABLE];
      // 键声称是账号 1 的，记录里写的却是账号 2 —— 前缀取到了它，身份核对必须拦住。
      table['1:10:20'] = { ...table['1:10:20'], accountId: '2' };
    });

    const second = await mount();
    assert.throws(() => second.service.listByCourse({ accountId: '1', courseId: '10' }),
      (error) => error.code === 'CORRUPT', '身份与键不一致必须如实报错');
    assert.throws(() => second.service.get({ accountId: '1', courseId: '10', subId: '20' }),
      (error) => error.code === 'CORRUPT');
    assert.throws(() => second.service.search({ accountId: '1', query: '旧事史' }),
      (error) => error.code === 'CORRUPT');
    // 但账号 2 那边取不到它（键不匹配它的前缀）：不会因为记录里写着 2 就露出来。
    assert.deepEqual(second.service.listByCourse({ accountId: '2', courseId: '10' }), []);
  });

  // 第二种坏法：记录里的身份**本身就不成形**（含冒号）。它也必须是 CORRUPT
  // （"存储里的数据坏了"），而不是 INPUT（"你传的参数不对"）—— 两者该去修的东西不同。
  await withMedia(async ({ storageRoot, mount }) => {
    const first = await mount();
    await first.service.put(lectureRecord({ accountId: '1' }));
    await first.ctx.fiber.dispose();

    await rewriteMedium(storageRoot, (document) => {
      // 键仍是合法键，但记录里的 accountId 含冒号 —— 重算键会抛 INPUT。
      document.tables[LECTURES_TABLE]['1:10:20'] = { ...document.tables[LECTURES_TABLE]['1:10:20'], accountId: '9:9' };
    });

    const second = await mount();
    assert.throws(() => second.service.get({ accountId: '1', courseId: '10', subId: '20' }),
      (error) => error.code === 'CORRUPT', '身份不成形也要归成 CORRUPT（数据坏了，不是参数坏了）');
  });
});
