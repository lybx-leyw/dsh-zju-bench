/**
 * 节笔记的离线用例。
 *
 * # golden 是怎么来的（这一点决定这些断言可不可信）
 *
 * `fixtures/dart-golden-pure.json` 与 `fixtures/dart-golden-edges.json`
 * **不是手抄的**：生成脚本把 Flutter 仓库 `lib/data/section_note_store.dart`
 * 的第 18–83 行（常量 + 全部纯函数）**逐字抽出来**，配一段打印所有边界值的
 * `main()`，用 `dart run` 真实执行、把 stdout 原样存成 JSON。
 *
 * 手抄 Dart 语义最容易错的恰好就是这些边界：负秒、`0x` 十六进制查询串、
 * 重复 query 键取第几个、host 大小写、坏百分号转义。所以这里不靠"读代码推断"，
 * 而是"跑一遍再钉住"。文件里另有 [golden 与 Flutter 源码对得上] 一条用例，
 * 直接回读 Dart 源码核对锚点，防止两边悄悄漂开。
 *
 * # 一条**有意**的不一致（不藏在"逐字一致"里）
 *
 * Dart 的 `int.tryParse` 在 64 位上认到 `±2^63`；JS 的 `Number` 只有 53 位
 * 安全整数，`9223372036854775807` 在这里会**失真**成 `9223372036854775808`。
 * 失真比拒绝更糟 —— 时间链接会悄悄指向一个错的秒数，所以本移植对超出安全
 * 整数的值一律当非法。这条差异有单独用例钉住，并且 golden 里那几个值被显式跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Context } from '@deepseek-ai/cordis';

import {
  assetLink,
  emptyNote,
  hasContent,
  isUsableId,
  kSectionNotesSchema,
  mmss,
  normalizeNote,
  noteKey,
  noteRoute,
  noteToJson,
  pageLink,
  parseInlineLinks,
  parseIntOrNull,
  parseZySectionUri,
  playerRouteOfZy,
  rewriteForExport,
  timeLink,
} from '../packages/dsh-zhiyun-notes/src/note.js';
import {
  createMemorySectionNoteStore,
  createSectionNoteService,
  createTableSectionNoteStore,
  exportFileName,
} from '../packages/dsh-zhiyun-notes/src/store.js';
import * as plugin from '../packages/dsh-zhiyun-notes/src/index.js';
import { NoteError } from '../packages/dsh-zhiyun-notes/src/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(HERE, '..', 'packages', 'dsh-zhiyun-notes');
/**
 * 与 Flutter 仓库的对照是可选增强：默认取与本仓库同级的 `zhiyun-pro`，
 * 也可用 `ZHIYUN_FLUTTER_ROOT` 指向其它位置；找不到时该用例自行跳过。
 */
const FLUTTER_ROOT = process.env.ZHIYUN_FLUTTER_ROOT
  ? path.resolve(process.env.ZHIYUN_FLUTTER_ROOT)
  : path.resolve(HERE, '..', '..', 'zhiyun-pro');
const FLUTTER_DART = path.join(FLUTTER_ROOT, 'lib', 'data', 'section_note_store.dart');

const readJson = (name) => JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'fixtures', name), 'utf8'));
const DART = readJson('dart-golden-pure.json');
const DART_EDGES = readJson('dart-golden-edges.json');

// ---------------------------------------------------------------------------
// ① 与 Dart 逐字一致（含 0 秒 / ≥1 小时 / 负数 / 非法值）
// ---------------------------------------------------------------------------

test('noteKey / noteRoute 与 Dart 逐字一致（含空串与特殊字符）', () => {
  assert.equal(noteKey('1', '2'), DART.key_1_2);
  assert.equal(noteKey('', ''), DART.key_empty);
  assert.equal(noteKey('a/b', 'c'), DART.key_slash);
  assert.equal(noteRoute({ courseId: '1', sectionId: '2' }), DART.route_1_2);
  // Dart 原样拼接，**不**做 URL 编码 —— 空格与 & 直接出现在路由里。
  assert.equal(noteRoute({ courseId: 'a b', sectionId: 'c&d' }), DART.route_enc);
  assert.equal(noteRoute({ courseId: '', sectionId: '' }), DART_EDGES.routeWeird);
});

test('mmss / timeLink 与 Dart 逐字一致：0 秒、59/60 边界、≥1 小时不进位、负数夹 0', () => {
  for (const [sec, expected] of Object.entries(DART.mmss)) {
    assert.equal(mmss(Number(sec)), expected, `mmss(${sec})`);
  }
  for (const [sec, expected] of Object.entries(DART.time)) {
    assert.equal(timeLink({ courseId: '1', sectionId: '2', atSec: Number(sec) }), expected, `timeLink(${sec})`);
  }
  // 三条边界单独指名，失败时一眼看得出是哪条口径崩了。
  assert.equal(mmss(0), '00:00', '0 秒');
  assert.equal(mmss(59), '00:59', '59 秒不满一分钟');
  assert.equal(mmss(60), '01:00', '60 秒进一分钟');
  assert.equal(mmss(3600), '60:00', '1 小时不进位到小时（Dart 就是这么写的）');
  assert.equal(mmss(-1), '00:00', '负数夹 0');
  // 负数只影响标签，`t=-1` 原样留在链接里（见 note.js 文件头第 2 条）。
  assert.equal(timeLink({ courseId: '1', sectionId: '2', atSec: -1 }), '[00:00](zy://section/1/2?t=-1)');
  assert.equal(timeLink({ courseId: '', sectionId: '', atSec: 5 }), DART_EDGES.timeWeird);
});

test('mmss 对非法值抛出有名字的失败，不静默给 00:00', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '10', {}]) {
    assert.throws(
      () => mmss(bad),
      (error) => error instanceof NoteError && error.code === 'INPUT',
      `mmss(${String(bad)}) 应当抛 INPUT`,
    );
  }
  assert.throws(() => timeLink({ courseId: '1', sectionId: '2', atSec: Number.NaN }), { code: 'INPUT' });
});

test('pageLink / assetLink / playerRouteOfZy 与 Dart 逐字一致', () => {
  assert.equal(pageLink({ courseId: '1', sectionId: '2', page: 14 }), DART.page_14);
  // 生成链接时 page=0 照样写进去；丢掉 0 是**跳转**那一刻的事（见下一条）。
  assert.equal(pageLink({ courseId: '1', sectionId: '2', page: 0 }), DART.page_0);
  assert.equal(assetLink({ id: 'img1' }), DART.asset);
  assert.equal(assetLink({ id: 'img1', alt: '第 14 页' }), DART.asset_alt);
  // `alt: ''` 是有意义的空 alt，不许回退成"插图"。
  assert.equal(assetLink({ id: 'img1', alt: '' }), DART.asset_alt_empty);

  for (const [key, expected] of Object.entries(DART.player)) {
    const [, courseId, sectionId, page, atSec] = /^(.*?)\/(.*?)\?p=(.*?)&t=(.*)$/.exec(key);
    const num = (value) => (value === 'null' ? undefined : Number(value));
    assert.equal(
      playerRouteOfZy({ courseId, sectionId, page: num(page), atSec: num(atSec) }),
      expected,
      `playerRouteOfZy(${key})`,
    );
  }
});

test('parseZySectionUri 与 Dart 逐字一致（坏串给 null 而不是崩）', () => {
  for (const [uri, expected] of Object.entries(DART.parse)) {
    assert.deepEqual(parseZySectionUri(uri), expected, `parseZySectionUri(${JSON.stringify(uri)})`);
  }
  for (const [uri, expected] of Object.entries(DART_EDGES.segments)) {
    assert.deepEqual(parseZySectionUri(uri), expected, `parseZySectionUri(${JSON.stringify(uri)})`);
  }
  // 几处最容易移植错的，单独指名。
  assert.deepEqual(parseZySectionUri('zy://SECTION/1/2'), { courseId: '1', sectionId: '2', page: null, atSec: null }, 'Dart 的 Uri.host 归一小写');
  assert.equal(parseZySectionUri('zy://section/1/2?t=1&t=2').atSec, 2, 'Dart 的 queryParameters 取最后一个');
  assert.equal(parseZySectionUri('zy://section/1/2?t=0x10').atSec, 16, 'Dart 的 int.tryParse 认 0x');
  assert.equal(parseZySectionUri('zy://section/1/2?t=%20').atSec, null, '解出来是空格 → 非法');
  assert.equal(parseZySectionUri('zy://section/a%2Fb/2').courseId, 'a/b');
  // 坏百分号转义：Dart 在特殊字符路径上会抛 FormatException，这里一律不崩。
  for (const bad of ['zy://section/1/2?t=%', 'zy://section/1/2?t=%zz', 'zy://section/%/2', 'zy://section/1/2?t=%E4']) {
    assert.doesNotThrow(() => parseZySectionUri(bad), `${bad} 不许崩`);
  }
  for (const other of ['zy-asset://img1', 'zy://asset/1/2', 'https://example.com/1/2', '/courses/1/section/2', '', 'zy://section/1']) {
    assert.equal(parseZySectionUri(other), null, `${JSON.stringify(other)} 应当 null`);
  }
});

test('parseIntOrNull 与 Dart 的 int.tryParse 同表；超出安全整数**有意**拒绝', () => {
  for (const [text, expected] of Object.entries(DART_EDGES.intTryParse)) {
    // Dart 的 64 位边界在 JS 里无法精确表示，下一段单独钉（见文件头）。
    if (Math.abs(Number(text)) > Number.MAX_SAFE_INTEGER) continue;
    assert.equal(parseIntOrNull(text) ?? null, expected, `parseIntOrNull(${JSON.stringify(text)})`);
  }
  for (const bad of ['abc', '1.5', '1e3', '1,5', '', ' ', '--1', '+-1', '٣']) {
    assert.equal(parseIntOrNull(bad), undefined, `${JSON.stringify(bad)} 应当非法`);
  }
  // 有意的不一致：JS 只有 53 位安全整数，失真的值宁可当非法。
  assert.equal(parseIntOrNull('9223372036854775807'), undefined, '2^63-1 在 JS 里失真 → 拒绝，而不是给出错的秒数');
  assert.equal(parseIntOrNull('9223372036854775808'), undefined);
  assert.equal(parseIntOrNull('-9223372036854775808'), undefined);
  assert.equal(parseIntOrNull('9007199254740991'), Number.MAX_SAFE_INTEGER, '安全整数边界内照样认');
});

// ---------------------------------------------------------------------------
// ② 同一节重复写入是替换、不丢其他节
// ---------------------------------------------------------------------------

test('同一节重复写入是替换而不是追加，且不丢其他节的笔记', async () => {
  const store = createMemorySectionNoteStore();
  const service = createSectionNoteService({ store });

  await service.put({ courseId: '1', sectionId: '2', markdown: '第一笔', title: '节二' });
  await service.put({ courseId: '9', sectionId: '8', markdown: '别人的笔记' });
  await service.put({ courseId: '1', sectionId: '2', markdown: '第二笔' });

  const all = await service.list();
  assert.equal(all.length, 2, '同一节只能有一条');
  const own = await service.get('1', '2');
  assert.equal(own.markdown, '第二笔', '是替换而不是追加');
  assert.equal(own.title, '节二', 'title 没给就保留原来的（Dart 的 `title ?? all[i].title`）');
  assert.equal(await service.hasContent('1', '2'), true);
  assert.equal((await service.get('9', '8')).markdown, '别人的笔记', '别的节不许被覆盖掉');
  assert.ok(store.writes >= 3, '每次 put 都真的落了一次盘');
});

test('并发写入不丢：同一节的两次 put 串行，最后一次赢', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  // 不加串行化的话，两次"读-改-写"会互相盖掉（App 里就是"快速打字丢字"）。
  await Promise.all([
    service.put({ courseId: '1', sectionId: '2', markdown: 'A' }),
    service.put({ courseId: '1', sectionId: '2', markdown: 'B' }),
  ]);
  const all = await service.list();
  assert.equal(all.length, 1, '两次写同一节只留一条');
  assert.ok(['A', 'B'].includes(all[0].markdown));
  assert.equal((await service.get('1', '2')).markdown, all[0].markdown, '读回来的与最后落下的一致');
});

test('写失败**不**改内存：内存里不许留一条磁盘上没有的笔记', async () => {
  const failing = {
    read: async () => ({ schema: kSectionNotesSchema, notes: [] }),
    write: async () => { throw new Error('disk full'); },
  };
  const service = createSectionNoteService({ store: failing });
  await assert.rejects(
    service.put({ courseId: '1', sectionId: '2', markdown: '写不进去的' }),
    (error) => error instanceof NoteError && error.code === 'PERSIST',
  );
  assert.deepEqual(await service.list(), [], '写失败后列表必须还是空的');
  assert.equal(await service.get('1', '2'), null, '不许出现"界面显示已保存、重启就没了"');
});

test('读失败**抛**出来，不假装"没有笔记"', async () => {
  const broken = { read: async () => { throw new Error('EIO'); }, write: async () => {} };
  const service = createSectionNoteService({ store: broken });
  await assert.rejects(service.list(), (error) => error instanceof NoteError && error.code === 'LOAD');
  // 介质里是别的东西（不是数组也不是 {notes}）同样算坏，不当空表。
  const weird = createSectionNoteService({ store: { read: async () => 42, write: async () => {} } });
  await assert.rejects(weird.list(), { code: 'LOAD' });
});

test('介质里认不出的记录被丢弃，但**数得出来**（droppedOnLoad）', async () => {
  const store = createMemorySectionNoteStore();
  await store.write([
    { courseId: '1', sectionId: '2', title: '', markdown: '好的一条', updatedAt: new Date(0).toISOString() },
    { courseId: '', sectionId: '2', title: '', markdown: '缺 courseId', updatedAt: new Date(0).toISOString() },
    { courseId: '3', sectionId: '', title: '', markdown: '缺 sectionId', updatedAt: new Date(0).toISOString() },
  ]);
  const service = createSectionNoteService({ store });
  assert.equal((await service.list()).length, 1);
  assert.equal(service.droppedOnLoad, 2, '丢弃的两条要能数出来，不能静默缩小列表');
});

test('getOrEmpty 不落盘，且给的是"从没写过"的语义（updatedAt = 纪元 0）', async () => {
  const store = createMemorySectionNoteStore();
  const service = createSectionNoteService({ store });
  const empty = await service.getOrEmpty({ courseId: '1', sectionId: '2', title: '标题' });
  assert.equal(empty.markdown, '');
  assert.equal(empty.title, '标题');
  assert.equal(empty.updatedAt, new Date(0).toISOString());
  assert.equal(hasContent(empty), false);
  assert.equal(hasContent({ markdown: '  \n\t ' }), false, '只有空白不算有内容');
  assert.equal(hasContent({ markdown: '有东西' }), true);
  assert.equal(store.writes, 0, 'getOrEmpty 不许落盘');
  assert.equal(await service.get('1', '2'), null, '没写过就是 null，不是空笔记');
});

test('remove 删一节，其它节与附件记录都还在', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  await service.put({ courseId: '1', sectionId: '2', markdown: 'A' });
  await service.put({ courseId: '1', sectionId: '3', markdown: 'B' });
  await service.putAsset({ courseId: '1', sectionId: '3', id: 'img1', file: 'note_assets/img1.png' });

  assert.equal(await service.remove('1', '2'), true);
  assert.equal(await service.remove('1', '2'), false, '本来就没有 → false，不谎报成功');
  assert.equal(await service.get('1', '2'), null);
  assert.equal((await service.get('1', '3')).markdown, 'B');
  assert.equal((await service.getAsset('img1')).courseId, '1', '删别的节不影响这节的附件记录');
});

test('courseId / sectionId 非法时拒绝，不许拼出会跳错节的内链', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  for (const [courseId, sectionId] of [['1/2', '3'], ['1', 'a b'], ['1', ''], ['', '2'], ['1', 'a?t=9'], [null, '2']]) {
    await assert.rejects(
      service.put({ courseId, sectionId, markdown: 'x' }),
      (error) => error instanceof NoteError && error.code === 'INPUT',
      `(${String(courseId)}, ${String(sectionId)}) 应当被拒`,
    );
  }
  assert.equal(isUsableId('1'), true);
  assert.equal(isUsableId('a-b_c.d'), true);
  assert.equal(isUsableId(''), false);
  assert.equal(isUsableId('a/b'), false);
});

// ---------------------------------------------------------------------------
// ③ 内链解析：两种 scheme 都认，坏串不崩且如实跳过
// ---------------------------------------------------------------------------

test('parseInlineLinks 认两种 scheme，并给出可用的字段', () => {
  const markdown = '见 [03:21](zy://section/1/2?t=201) 与 [第 14 页](zy://section/1/2?page=14)，图 ![插图](zy-asset://img1)。';
  const links = parseInlineLinks(markdown);
  assert.equal(links.length, 3);

  const [time, page, image] = links;
  assert.deepEqual(
    { type: time.type, courseId: time.courseId, sectionId: time.sectionId, atSec: time.atSec, label: time.label },
    { type: 'section', courseId: '1', sectionId: '2', atSec: 201, label: '03:21' },
  );
  assert.equal(page.type, 'section');
  assert.equal(page.page, 14);
  assert.deepEqual(
    { type: image.type, assetId: image.assetId, label: image.label },
    { type: 'asset', assetId: 'img1', label: '插图' },
  );
  // 位置信息要能直接用来做原地替换。
  assert.equal(markdown.slice(time.start, time.end), time.raw);
  assert.equal(markdown.slice(image.start, image.end), image.raw);
  // 顺序按出现位置。
  const starts = links.map((link) => link.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('parseInlineLinks 对坏串如实跳过：不崩，也不当成正常链接', () => {
  const markdown = [
    '[x](zy://section/1)',          // 只有一段 → 认不出
    '[y](zy://section//2)',         // 空段
    '[z](zy://section/1/2?t=abc)',  // 形状合法、秒数非法
    '![空](zy-asset://)',           // 没有附件 id
  ].join('\n');
  // 注意：`assert.doesNotThrow` **不返回**回调的返回值，所以先断言不抛、再单独取结果。
  assert.doesNotThrow(() => parseInlineLinks(markdown));
  const links = parseInlineLinks(markdown);
  assert.equal(links.length, 4);

  const bad = links.filter((link) => link.code !== undefined);
  assert.deepEqual(bad.map((link) => link.code), ['BAD_SECTION_LINK', 'BAD_SECTION_LINK', 'BAD_ASSET_LINK']);
  for (const link of bad) assert.ok(typeof link.reason === 'string' && link.reason !== '', '坏串必须带 reason');

  // 形状合法、只是秒数解不出来的那条：如实给 atSec=null，不算坏串。
  const typed = links.find((link) => link.raw === '[z](zy://section/1/2?t=abc)');
  assert.equal(typed.type, 'section');
  assert.equal(typed.atSec, null);
  assert.equal(typed.code, undefined);
});

test('parseInlineLinks 如实交代"认不了的行内内容"，不静默当没有', () => {
  const markdown = '[外链](https://example.com/a) [本地](/courses/1/section/2) [别的自家 scheme](zy://asset/1/2) ![](x.png)';
  const links = parseInlineLinks(markdown);
  assert.equal(links.length, 4);
  assert.deepEqual(links.map((link) => link.type), ['unknown-inline', 'unknown-inline', 'unknown-inline', 'unknown-inline']);
  assert.deepEqual(
    links.map((link) => link.code),
    ['UNSUPPORTED_SCHEME', 'UNSUPPORTED_SCHEME', 'BAD_SCHEME_SHAPE', 'UNSUPPORTED_SCHEME'],
  );
  assert.equal(parseInlineLinks('[空]()')[0].code, 'EMPTY_TARGET');
});

test('parseInlineLinks 对空/非字符串输入给空数组，不崩', () => {
  for (const input of ['', undefined, null, 42, {}, []]) {
    assert.deepEqual(parseInlineLinks(input), [], `${String(input)} 应当空数组`);
  }
});

test('裸 zy:// 串也能被摘出来（Dart 的 exportMarkdown 是按裸前缀 replaceAll 的）', () => {
  const links = parseInlineLinks('没有写成链接的内链 zy://section/1/2?t=7 和 zy-asset://img9');
  assert.equal(links.length, 2);
  assert.equal(links[0].bare, true);
  assert.equal(links[0].atSec, 7);
  assert.equal(links[1].assetId, 'img9');
});

test('导出改写与 Dart exportMarkdown 同判据', () => {
  assert.equal(
    rewriteForExport('看图 ![插图](zy-asset://img1) 与 [03:21](zy://section/1/2?t=201)。', { img1: 'img1.png' }),
    '看图 ![插图](img1.png) 与 03:21。',
    'asset 换文件名，section 链接降级成纯文本',
  );
  // 附件没落盘时保留原样的内链（Dart 也是 continue 掉了）—— 不许静默删用户正文。
  assert.equal(rewriteForExport('![插图](zy-asset://ghost)', {}), '![插图](zy-asset://ghost)');
  assert.equal(rewriteForExport('', {}), '');
  assert.equal(exportFileName('note_assets/img1.png'), 'img1.png');
  assert.equal(exportFileName('note_assets\\img1.png'), 'img1.png', 'Windows 分隔符也当分隔符');
});

// ---------------------------------------------------------------------------
// ④ 附件与笔记分开放；删笔记时附件行为按 Dart 语义
// ---------------------------------------------------------------------------

test('附件记录挂在笔记上，字节不归本包；同一张图挂两次不去重', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  const after = await service.putAsset({
    courseId: '1', sectionId: '2', id: 'img1', file: 'note_assets/img1.png', alt: '第 14 页', page: 14,
  });
  assert.deepEqual(after.assets, [{ id: 'img1', file: 'note_assets/img1.png', alt: '第 14 页', page: 14 }]);
  // 追加而不是替换：正文里同一张图可能出现两次，去重反而对不上正文。
  await service.putAsset({ courseId: '1', sectionId: '2', id: 'img1', file: 'note_assets/img1.png' });
  assert.equal((await service.get('1', '2')).assets.length, 2);
  // 挂附件不动正文（Dart 的 addAsset / attachSketch 都不碰 markdown）。
  assert.equal((await service.get('1', '2')).markdown, '');
});

test('putAsset 需要 file；id 缺省时自动生成且同一毫秒不重号', async () => {
  const fixed = new Date('2026-10-07T11:12:13.456Z');
  const service = createSectionNoteService({ store: createMemorySectionNoteStore(), now: () => fixed });
  await assert.rejects(
    service.putAsset({ courseId: '1', sectionId: '2', id: 'a' }),
    (error) => error instanceof NoteError && error.code === 'INPUT',
    '本包不碰字节，就得让调用方说清文件在哪',
  );
  const first = await service.putAsset({ courseId: '1', sectionId: '2', file: 'note_assets/a.png' });
  const second = await service.putAsset({ courseId: '1', sectionId: '2', file: 'note_assets/b.png' });
  assert.notEqual(first.assets[0].id, second.assets[1].id, '同一毫秒的两张图不许撞 id（撞了会取错图）');
});

test('生成一个附件 id 只读**一次**时钟（读两次会让"同一毫秒"的比较与命名对不上）', async () => {
  // 这一条是回归钉。早期实现是
  //   `const at = now() instanceof Date ? now().getTime() : new Date(now()).getTime();`
  // —— 读了两次时钟：**比较用的时刻与拿来命名的时刻不是同一个**。
  // 冻结时钟下它看起来完全正常（这正是它躲过第一轮用例的原因），
  // 所以这里不靠"制造碰撞"（那还要看运气：两次读跨越毫秒边界时反而会得到不同 id），
  // 而是直接钉住真正的不变式：**生成一个 id 只许读一次 now()**。
  let reads = 0;
  const counting = () => { reads += 1; return new Date(1_700_000_000_000); };
  const service = createSectionNoteService({ store: createMemorySectionNoteStore(), now: counting });

  reads = 0;
  await service.putAsset({ courseId: '1', sectionId: '2', file: 'note_assets/a.png' });
  // putAsset 里合法的读数是 2 次：1 次给附件 id、1 次给 updatedAt（stamp()）。
  assert.equal(reads, 2, `一次 putAsset 只该读 2 次时钟（id + updatedAt），实际 ${reads} 次`);

  // 附带确认唯一性：同一毫秒靠自增尾号区分。
  const a = await service.putAsset({ courseId: '1', sectionId: '2', file: 'note_assets/b.png' });
  const ids = (await service.get('1', '2')).assets.map((asset) => asset.id);
  assert.deepEqual(ids, ['img1700000000000', 'img1700000000000-1']);
  assert.equal(a.assets[1].id, 'img1700000000000-1', '同一毫秒的第二张图带自增尾号');
});

test('删笔记**不**级联删附件字节（Dart 语义：只重写索引，note_assets/ 从不动）', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  await service.putAsset({ courseId: '1', sectionId: '2', id: 'img1', file: 'note_assets/img1.png' });
  assert.equal(await service.remove('1', '2'), true);
  assert.equal(await service.get('1', '2'), null, '笔记记录没了');
  // 这是本包**选择**的语义，注释与用例里都写清楚：
  // 附件记录挂在笔记上，所以跟着走了；而字节（存在宿主存储里）本包从不删，
  // 与 Dart 的 `note_assets/` 行为一致 —— 附件成孤儿但不丢，导出时还找得回来。
  assert.equal(await service.getAsset('img1'), null, '记录随笔记消失');
});

test('removeAsset 只摘引用，不动别的附件、不动正文', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  await service.put({ courseId: '1', sectionId: '2', markdown: '正文 ![插图](zy-asset://img1)' });
  await service.putAsset({ courseId: '1', sectionId: '2', id: 'img1', file: 'note_assets/img1.png' });
  await service.putAsset({ courseId: '1', sectionId: '2', id: 'img2', file: 'note_assets/img2.png' });

  assert.equal(await service.removeAsset('img1'), true);
  assert.equal(await service.removeAsset('img1'), false, '已经摘过了 → false');
  const note = await service.get('1', '2');
  assert.deepEqual(note.assets.map((asset) => asset.id), ['img2']);
  assert.equal(note.markdown, '正文 ![插图](zy-asset://img1)', '正文一个字都不许改');
});

test('getAsset 找得到是哪一节、文件在哪；找不到给 null', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  await service.putAsset({ courseId: '7', sectionId: '8', id: 'img7', file: 'note_assets/img7.png' });
  const found = await service.getAsset('img7');
  assert.equal(found.courseId, '7');
  assert.equal(found.sectionId, '8');
  assert.deepEqual(found.asset, { id: 'img7', file: 'note_assets/img7.png' });
  // 「字节在不在」本包看不到文件系统，所以不许假装能判 —— 如实留一个 owned:false。
  assert.equal(found.owned, false);
  assert.equal(await service.getAsset('不存在'), null);
});

test('exportMarkdown 把改写后的正文与附件清单一并交回（字节由调用方读）', async () => {
  const service = createSectionNoteService({ store: createMemorySectionNoteStore() });
  await service.putAsset({ courseId: '1', sectionId: '2', id: 'img1', file: 'note_assets/img1.png' });
  await service.put({
    courseId: '1',
    sectionId: '2',
    markdown: '看图 ![插图](zy-asset://img1)，见 [03:21](zy://section/1/2?t=201)。',
  });
  const pack = await service.exportMarkdown({ courseId: '1', sectionId: '2' });
  assert.equal(pack.markdown, '看图 ![插图](img1.png)，见 03:21。');
  assert.deepEqual(pack.files, { img1: 'note_assets/img1.png' });
});

test('noteToJson 只写非空字段（对齐 Dart 的 if (isNotEmpty)）', () => {
  const bare = noteToJson(emptyNote({ courseId: '1', sectionId: '2' }));
  assert.equal('assets' in bare, false);
  assert.equal('sketches' in bare, false);
  const full = noteToJson({
    ...emptyNote({ courseId: '1', sectionId: '2' }),
    assets: [{ id: 'a', file: 'f', alt: '', page: 3 }],
    sketchIds: ['s1'],
  });
  assert.equal('alt' in full.assets[0], false, '空 alt 不写出去');
  assert.equal(full.assets[0].page, 3);
  assert.deepEqual(full.sketches, ['s1'], 'Dart 的字段名是 sketches');
});

test('normalizeNote 丢掉坏记录与坏附件，但保住整条笔记', () => {
  assert.equal(normalizeNote(null), null);
  assert.equal(normalizeNote('garbage'), null);
  assert.equal(normalizeNote({ courseId: '', sectionId: '2' }), null);
  assert.equal(normalizeNote({ courseId: '1', sectionId: '' }), null);
  const note = normalizeNote({
    courseId: '1',
    sectionId: '2',
    title: 'T',
    markdown: 'M',
    updatedAt: '不是时间',
    assets: [{ id: 'a', file: 'f' }, { id: '', file: 'f' }, { file: 'f' }, 'garbage'],
    sketches: ['s1', '', 42],
  });
  assert.equal(note.updatedAt, new Date(0).toISOString(), '解不出的时间落纪元 0，不是"现在"');
  assert.deepEqual(note.assets.map((asset) => asset.id), ['a'], '坏附件逐条丢，不拖垮整条');
  assert.deepEqual(note.sketchIds, ['s1'], '空串与非字符串丢弃');
  assert.deepEqual(normalizeNote({ courseId: '1', sectionId: '2', sketches: ['x'] }).sketchIds, ['x']);
});

// ---------------------------------------------------------------------------
// ⑤ 插件：装载 / 卸载 / store 形状
// ---------------------------------------------------------------------------

test('真实 Cordis：装载后 ctx.zhiyunNotes 可用；卸载后服务消失、写确实落到了 store', async () => {
  const ctx = new Context();
  // 插件声明了 `inject: ['storageDomain']`（真机验收定的），所以装载前必须有这个服务；
  // 这条用例走的是 config.store 注入，域服务只是让插件能激活的空壳。
  ctx.provide('storageDomain', { open: async () => { throw new Error('不应走到宿主域'); } });
  const store = createMemorySectionNoteStore();
  const dispose = await ctx.plugin(plugin, { store });
  try {
    const service = ctx.get('zhiyunNotes');
    assert.ok(service, '装载后服务必须在 ctx 上');
    await service.put({ courseId: '1', sectionId: '2', markdown: '装起来就能用' });
    assert.equal((await service.get('1', '2')).markdown, '装起来就能用');
  } finally {
    await dispose.dispose();
  }
  assert.equal(ctx.get('zhiyunNotes'), undefined, '卸载后服务必须消失');
  assert.ok(store.writes > 0, '写确实落到了注入的 store');
  assert.equal(store.records.length, 1, '注销后注入的 store 仍归调用方所有（本包不替它清空）');
});

test('卸载之后的调用给出有名字的 CLOSED，而不是没法解释的错', async () => {
  const ctx = new Context();
  ctx.provide('storageDomain', { open: async () => { throw new Error('不应走到宿主域'); } });
  const dispose = await ctx.plugin(plugin, { store: createMemorySectionNoteStore() });
  const service = ctx.get('zhiyunNotes');
  await dispose.dispose();
  await assert.rejects(service.list(), (error) => error instanceof NoteError && error.code === 'CLOSED');
});

test('没有注入 store 且宿主没有 storageDomain 时，插件**等待依赖**而不是静默退化成内存', async () => {
  // ⚠️ 契约在真机验收时改过：`storageDomain` 现在写进了 `inject`。
  //    Cordis 的语义是「依赖未就绪 → 插件 pending」，所以这里**不会**抛错，
  //    也**不会**留下一个假装能用的内存服务 —— 服务在依赖到位前根本不存在。
  //    这正是我们要的：如实"还没好"，而不是"看起来好了、重启就没"。
  const ctx = new Context();
  await ctx.plugin(plugin, {});
  assert.equal(ctx.get('zhiyunNotes'), undefined, '依赖缺失时不许挂上半吊子服务');

  // 依赖到位后同一个 ctx 就会激活 —— 证明上面不是"永久失败"。
  ctx.provide('storageDomain', { open: async () => { throw new Error('不应走到宿主域'); } });
  const ctx2 = new Context();
  ctx2.provide('storageDomain', { open: async () => { throw new Error('不应走到宿主域'); } });
  await ctx2.plugin(plugin, { store: createMemorySectionNoteStore() });
  assert.ok(ctx2.get('zhiyunNotes'), '依赖就绪后必须激活');
});

test('config.domain=false 时也只认注入的 store', async () => {
  const ctx = new Context();
  // `inject: ['storageDomain']` 是激活前提；本用例要验的是"即便域就绪也不去开它"。
  let opened = 0;
  ctx.provide('storageDomain', { open: async () => { opened += 1; throw new Error('config.domain=false 时不该开域'); } });
  const dispose = await ctx.plugin(plugin, { store: createMemorySectionNoteStore(), domain: false });
  assert.ok(ctx.get('zhiyunNotes'));
  assert.equal(opened, 0, 'config.domain=false 时不许碰宿主域');
  await dispose.dispose();
});

test('宿主存储路径：用 ctx.storageDomain 打开域、读写走 KvTable、卸载时关掉域', async () => {
  // ⚠️ 这里用**假的** storageDomain + 假的 ctx：真宿主包在仓库根 node_modules 里没有
  // （只有 profile 的 junction 里能解析），所以离线跑不了真 domain。
  // 本用例钉的是**我们与宿主的约定**：调用签名、读写形状、以及"域的句柄由本插件关闭"。
  // 真 domain 的内部行为属于宿主自己的测试面，不在这里冒充已验。
  const records = new Map();
  const calls = { opened: 0, closed: 0, spec: null, puts: 0, deletes: 0 };
  const provided = new Map();
  const facade = {
    async open(spec) {
      calls.opened += 1;
      calls.spec = spec;
      return {
        table: (tableName) => {
          assert.equal(tableName, plugin.kNotesTableName);
          return {
            keys: () => records.keys(),
            get: (key) => records.get(key),
            put: async (key, value) => { calls.puts += 1; records.set(key, value); },
            delete: async (key) => { calls.deletes += 1; return records.delete(key); },
          };
        },
        close: async () => { calls.closed += 1; },
      };
    },
  };
  const fakeCtx = {
    // 插件声明了 `inject: ['storageDomain']`，所以真宿主里 Cordis 会保证它已就绪；
    // 假 ctx 只需照同一形状把服务放在属性上（详见文件末尾那条真机验收记录）。
    storageDomain: facade,
    provide: (serviceName, value) => {
      provided.set(serviceName, value);
      return () => provided.delete(serviceName);
    },
  };
  const dispose = await plugin.apply(fakeCtx, {
    loadDomainModule: async () => ({
      // 只做形状：真 zod 由宿主的 domain 校验，这里钉的是"我们把 schema 交给了它"。
      defineDomain: (spec) => spec,
      domainTable: (schema) => ({ valueSchema: schema }),
      z: {
        // 只做形状：真 zod 由宿主的 domain 在 open 时用来校验存量记录，
        // 这里钉的是"我们把 schema 交给了它、且用到的都是宿主 zod 真有的 API"。
        object: (shape) => ({ kind: 'object', shape, passthrough: () => ({ kind: 'loose-object', shape }) }),
        string: () => ({ kind: 'string', optional: () => ({ kind: 'optional-string' }) }),
        number: () => ({ kind: 'number', optional: () => ({ kind: 'optional-number' }) }),
        array: (item) => ({ kind: 'array', item, optional: () => ({ kind: 'optional-array' }) }),
      },
    }),
  });

  assert.ok(provided.get('zhiyunNotes'), '服务要挂上 ctx');
  assert.equal(calls.opened, 1);
  assert.equal(calls.spec.name, 'zhiyun_notes', '域名字要能过宿主的 UNIT_NAME_RE');
  assert.equal(calls.spec.version, 1);
  assert.ok(calls.spec.tables.notes, '表名字要能过宿主的 UNIT_NAME_RE');

  const service = provided.get('zhiyunNotes');
  await service.put({ courseId: '1', sectionId: '2', markdown: '走宿主域' });
  assert.equal(calls.puts, 1);
  assert.equal(records.get('1/2').markdown, '走宿主域');
  assert.equal(records.get('1/2').sections === undefined, true);

  await service.remove('1', '2');
  assert.equal(calls.deletes, 1, '删掉的键要从域里清掉');

  await dispose();
  assert.equal(calls.closed, 1, '域的句柄归本插件关闭（宿主文档：caller owns the handle）');
  assert.equal(provided.has('zhiyunNotes'), false, '卸载后服务要摘掉');
});

test('真实 Cordis：本插件**声明** inject 后能拿到 storageDomain（新契约，真机验收定的）', async () => {
  // # 这条用例在真机验收时被改写，原因值得留在这里
  //
  // 原版钉的是「不声明 inject、用 ctx.get 探」——当时的前提是
  // 「storageDomain 是可选服务」。真机跑下来发现那个前提不成立：
  // 宿主 `dsh-storage-domain` 是在 `ctx.inject([...backends])` 的**子 fiber** 里
  // `domainCtx.provide('storageDomain', …)`，而 `ctx.get()` 只按**本插件的依赖图**
  // 解析 —— 不声明就永远探不到，于是生产 profile 里这个插件每次启动都报 CONFIG
  // 未激活（单测却是绿的，因为单测直接注入 config.store）。
  //
  // 所以契约改成 `inject: ['storageDomain']`，这条用例钉两件事：
  // ① 依赖就绪后 `ctx.storageDomain` 真的可读（不是抛、不是 undefined）；
  // ② 那个 Cordis 陷阱依然真实存在 —— 对**未声明**的服务读属性会抛，
  //    所以将来若要把某个服务做成可选，仍然必须用 `ctx.get`。
  const ctx = new Context({ name: 'probe-cordis-inject' });
  let observed;
  await ctx.plugin({
    name: 'probe-read',
    inject: [],
    apply(inner) {
      observed = {
        threwOnProperty: (() => { try { void inner.storageDomain; return false; } catch { return true; } })(),
        getIsUndefined: inner.get('storageDomain') === undefined,
      };
    },
  });
  assert.equal(observed.threwOnProperty, true, '未声明 inject 的服务读属性确实会抛');
  assert.equal(observed.getIsUndefined, true, 'ctx.get 才是"有没有都安全"的读法');

  // 本插件：声明了 inject，所以依赖就绪即可用；未就绪则**等待**（服务不出现）。
  assert.ok(plugin.inject.includes('storageDomain'), '契约要求：必须声明这个依赖，否则子 fiber 的服务永远探不到');
  const real = new Context();
  real.provide('storageDomain', { open: async () => { throw new Error('不应走到宿主域'); } });
  await real.plugin(plugin, { store: createMemorySectionNoteStore() });
  assert.ok(real.get('zhiyunNotes'), '依赖就绪后插件必须激活');
  await real.fiber.dispose();
});

test('真实 Cordis + 真实 storageDomain 形状：走宿主存储路径能装载、读写、卸载', async () => {
  // 这里把**真宿主服务**挂在真 Context 上，宿主 domain 用假的（真 domain 的内部行为
  // 属于宿主自己的测试面，本仓离线环境里也没有那个包）。
  const records = new Map();
  const calls = { opened: 0, closed: 0, puts: 0, deletes: 0 };
  const ctx = new Context();
  ctx.provide('storageDomain', {
    async open(spec) {
      calls.opened += 1;
      assert.equal(spec.name, plugin.kNotesDomainName);
      return {
        table: () => ({
          keys: () => records.keys(),
          get: (key) => records.get(key),
          put: async (key, value) => { calls.puts += 1; records.set(key, value); },
          delete: async (key) => { calls.deletes += 1; return records.delete(key); },
        }),
        close: async () => { calls.closed += 1; },
      };
    },
  });

  const fiber = await ctx.plugin(plugin, {
    loadDomainModule: async () => ({
      defineDomain: (spec) => spec,
      domainTable: (schema) => ({ valueSchema: schema }),
      z: {
        object: (shape) => ({ kind: 'object', shape, passthrough: () => ({ kind: 'loose-object', shape }) }),
        string: () => ({ kind: 'string', optional: () => ({ kind: 'optional-string' }) }),
        number: () => ({ kind: 'number', optional: () => ({ kind: 'optional-number' }) }),
        array: (item) => ({ kind: 'array', item, optional: () => ({ kind: 'optional-array' }) }),
      },
    }),
  });

  const service = ctx.get('zhiyunNotes');
  assert.ok(service, '走宿主存储路径也要挂上服务');
  assert.equal(calls.opened, 1);
  await service.put({ courseId: '1', sectionId: '2', markdown: '走真 cordis + 宿主域' });
  assert.equal(records.get('1/2').markdown, '走真 cordis + 宿主域');
  assert.equal(calls.puts, 1);

  await fiber.dispose();
  assert.equal(ctx.get('zhiyunNotes'), undefined);
  assert.equal(calls.closed, 1, '域的句柄归本插件关闭');
});

test('createTableSectionNoteStore：按记录的 KV 也能当 store 用', async () => {
  const records = new Map();
  const table = {
    keys: () => records.keys(),
    get: (key) => records.get(key),
    put: async (key, value) => { records.set(key, value); },
    delete: async (key) => { records.delete(key); },
  };
  const service = createSectionNoteService({ store: createTableSectionNoteStore(table) });
  await service.put({ courseId: '1', sectionId: '2', markdown: 'A' });
  await service.put({ courseId: '1', sectionId: '3', markdown: 'B' });
  assert.deepEqual([...records.keys()].sort(), ['1/2', '1/3']);
  await service.remove('1', '2');
  assert.deepEqual([...records.keys()], ['1/3'], '删掉的键要从 KV 里清掉');
  assert.throws(
    () => createTableSectionNoteStore(null),
    (error) => error instanceof NoteError && error.code === 'CONFIG',
  );
});

test('store 形状不认识时报 CONFIG，而不是装着能用', () => {
  assert.throws(
    () => createSectionNoteService({ store: { nope: 1 } }),
    (error) => error instanceof NoteError && error.code === 'CONFIG',
  );
  assert.throws(() => createSectionNoteService({}), { code: 'CONFIG' });
});

// ---------------------------------------------------------------------------
// ⑥ 源码不出现 node:fs / process.env（扫源码用例钉住）
// ---------------------------------------------------------------------------

/** 递归收集包内所有 .js。 */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 去掉注释后的源码（**只**去注释，字符串原样留着）。
 *
 * 为什么必须去注释：文件头注释里**正大光明地写着**「本包不 import node:fs、
 * 不读环境变量」—— 直接扫原文会把这句自述当成违规（第一次跑就撞上了）。
 *
 * 为什么**不能**顺手把字符串也剥掉：那会留下一个更糟的洞 ——
 * `import('node:fs')` 和 `require('node:fs')` 的目标正是字符串字面量，
 * 剥掉之后这两句会变成 `import( )`，扫描反而全绿。
 * 宁可对"字符串里出现 node:fs"这种极罕见情况误报（改个措辞即可），
 * 也不能放过真正的违规 import。
 *
 * 逐字符走状态机，而不是用 `//` 正则硬砍：注释与字符串里出现的 `//`
 * （比如 URL、`']['`）会让正则把真正的代码一起砍掉，产生假阴性。
 * @param {string} text - 源文件。
 * @returns {string} 只剩代码的文本（字符串原样保留）。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

test('本包源码不 import node:fs / 不读环境变量 / 不自己写文件', () => {
  const files = sourceFiles(PACKAGE_DIR);
  assert.ok(files.length >= 3, `至少要扫到 3 个源文件，实际 ${files.length}`);

  // 先确认剥离器只吃注释、不吃代码：注释里的三句自述要被去掉，而代码要留得住。
  const selfTest = stripComments([
    '// 本包不 import node:fs、不读 process.env',
    '/* 也不 writeFile */',
    "import fs from 'node:fs';",
    "const s = 'process.env 只是字符串';",
  ].join('\n'));
  assert.equal(/\/\/ 本包不 import|也不 writeFile/.test(selfTest), false, '注释必须被剥掉');
  assert.match(selfTest, /import fs from 'node:fs';/, '字符串里的 node:fs 必须留下来 —— 那才是真违规要抓的地方');
  assert.match(selfTest, /'process\.env 只是字符串'/, '字符串原样保留');
  assert.match(selfTest, /'\/\/ 不是注释'|process\.env/, '字符串内不会被误当注释');

  const forbidden = [
    [/node:fs/, 'node:fs'],
    [/process\.env/, 'process.env'],
    // tmp+rename 自建原子写：本仓明令禁止（宿主有 dsh-atomic-write）。
    [/\.rename\(/, '自建 rename'],
    [/writeFile|readFile|createWriteStream|appendFile/, '直接文件读写 API'],
    // 落盘只能经注入的 store，不许自己拼路径。
    [/node:path/, 'node:path（本包不该拼路径）'],
    [/\brequire\(/, 'require（本包是 ESM）'],
    [/from\s+['"]node:/, '任何 node: 内建模块'],
  ];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, label] of forbidden) {
      assert.equal(pattern.test(code), false, `${path.relative(PACKAGE_DIR, file)} 的**代码**里不许出现 ${label}`);
    }
  }

  // 反向确认：剥离器不是在"删掉一切"（那样上面全是假绿）。
  const indexCode = stripComments(readFileSync(path.join(PACKAGE_DIR, 'src', 'index.js'), 'utf8'));
  assert.match(indexCode, /ctx\.provide\('zhiyunNotes'/, '剥离后仍要看得见真代码');
  // 契约：必须声明 storageDomain（理由见上面那条真实 Cordis 用例）。
  assert.match(indexCode, /inject\s*=\s*\[\s*'storageDomain'\s*\]/, '剥离后仍要看得见真代码');
});

test('纯函数层（note.js）不依赖宿主：只 import 自己的 errors', () => {
  const text = readFileSync(path.join(PACKAGE_DIR, 'src', 'note.js'), 'utf8');
  const imports = [...text.matchAll(/^import\s.+$/gm)].map((match) => match[0]);
  assert.equal(imports.length, 1, `note.js 只该有一个 import，实际 ${imports.length}`);
  assert.match(imports[0], /\.\/errors\.js/);
  assert.equal(/@deepseek-ai\//.test(text), false, 'note.js 不许依赖任何宿主包');
});

test('index.js 只在真正要走宿主存储时才加载宿主包（延迟 import，不吃顶层依赖）', () => {
  const text = readFileSync(path.join(PACKAGE_DIR, 'src', 'index.js'), 'utf8');
  assert.equal(
    /^import\s[^\n]*@deepseek-ai/m.test(text),
    false,
    '顶层 import 宿主包会让离线环境连 note.js 都用不了',
  );
  // 真机验收后这条改为：宿主存储的**解析**由 `dsh-zhiyun-knowledge/host` 那份
  // 跑通的实现负责（同一件事不留两份），但它同样只能在**动态 import** 里出现 ——
  // 否则离线环境连 note.js 都用不了，这正是本条要防的。
  assert.equal(
    /^import\s[^\n]*dsh-zhiyun-knowledge/m.test(text),
    false,
    '复用宿主解析器也不许放在顶层',
  );
  assert.match(text, /import\('dsh-zhiyun-knowledge\/host'\)/, '宿主存储路径要走动态 import');
});

// ---------------------------------------------------------------------------
// ⑦ golden 与 Flutter 源码对得上（防止两边悄悄漂开）
// ---------------------------------------------------------------------------

test('golden 覆盖的纯函数在 Flutter 源码里仍然逐字存在', (t) => {
  let source;
  try {
    source = readFileSync(FLUTTER_DART, 'utf8');
  } catch {
    return t.skip('Flutter 仓库不在本机，跳过与 Dart 源码的对照');
  }
  const compact = source.replace(/\s+/g, ' ');
  const anchors = [
    /String sectionNoteKey\(String courseId, String sectionId\) =>/,
    /String sectionNoteRoute\(\{ required String courseId, required String sectionId, \}\) =>/,
    /final s = sec < 0 \? 0 : sec;/,
    /return '\$m:\$n';/,
    /const String kZySectionScheme = 'zy:\/\/section\/';/,
    /const String kZyAssetScheme = 'zy-asset:\/\/';/,
    /if \(uri\.scheme != 'zy' \|\| uri\.host != 'section'\) return null;/,
    /if \(parts\.length < 2\) return null;/,
    /int\.tryParse\(uri\.queryParameters\['page'\] \?\? ''\)/,
    /int\.tryParse\(uri\.queryParameters\['t'\] \?\? ''\)/,
    /if \(page != null && page > 0\) 'page=\$page'/,
    /if \(atSec != null && atSec >= 0\) 't=\$atSec'/,
  ];
  for (const anchor of anchors) {
    assert.match(compact, anchor, `Flutter 源码里找不到锚点 ${anchor}（两边可能已经漂开，请重新生成 golden）`);
  }
});
