/**
 * **讲义装配**的契约测试 —— 全部离线（假 llm，不联网）。
 *
 * # 规格来源
 *
 * 被测层是 App 的 `fusion/lecture_tree.dart` + `fusion/lecture_register.dart` +
 * `fusion/lecture_polish.dart` 三件的移植，所以下面每条断言都对应 App 侧
 * 一条**真机踩过的坑**（Dart 测试里那条注释就是它的现场记录）。
 *
 * # 为什么样本一律 8 页起
 *
 * 页眉判据是「出现在 **≥ 3 页** 且 **≥ 40% 的页** 上」，而**一个知识点跨 2–3 页
 * 是常态**。4 页样本里「跨 3 页的真标题」会被当成页眉剔掉 → 知识点丢名字。
 * 所以测试样本不能图省事写 2–3 页：那样测的不是生产行为。
 *
 * # 为什么每条都要「同时断言反例」
 *
 * 只断言「成功路径对了」的测试**抓不到退化**：实现改成"永远返回固定伪造值"
 * 时，正向断言照样绿。所以多数用例都配一句"不该出现的东西"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLectureTree, looksLikeSectionDivider, detectSlideTemplate, cleanLine,
  tidySlideHeading, SLIDE_TEMPLATE,
} from '../packages/dsh-zhiyun-lecture/src/tree.js';
import {
  judgeWritten, normalizeLectureText, kClassroomMarks, REGISTER,
} from '../packages/dsh-zhiyun-lecture/src/register.js';
import {
  createLectureAssembler, parseLecturePolishResponse, chunkLectureForPolish,
  buildLecturePolishBody, lectureGlossary, contentChars, checkPolishLength,
  checkPolishFiller, checkPolishShrink, isBrokenOutput, tidyWrittenText,
  kLectureWrittenSystemPrompt, kLectureFillerWords, kStage, kStageName,
} from '../packages/dsh-zhiyun-lecture/src/polish.js';
import { LectureError } from '../packages/dsh-zhiyun-lecture/src/errors.js';

// ═══════════════════════════════════════════════════════════════
// 夹具（与 Dart `lecture_tree_test.dart` / `lecture_polish_test.dart` 同形）
// ═══════════════════════════════════════════════════════════════

/** 页眉（几乎每页都有的一行）。 */
const HDR = 'Inverted File Index';

/** 一段够长的正文（让「短行 = 标题」那条判据生效）。必须超过 30 字符。 */
const BODY = '这是一段足够长的正文，用来模拟 PPT 上真正的讲解内容行，长度超过三十个字符。';

const p = (page, text) => ({ page, text });
const b = (index, page) => ({ index, page });

/** 造一份课件：`spec` 是「标题 : 页数」，按顺序铺开；页眉铺在每一页上。 */
function deck(spec) {
  const pages = [];
  let pg = 1;
  for (const [title, count] of spec) {
    for (let i = 0; i < count; i++) {
      pages.push(p(pg, title === '' ? `${HDR}\n${BODY}` : `${HDR}\n${title}\n${BODY}`));
      pg++;
    }
  }
  assert.ok(pages.length >= 8, '样本至少 8 页（见文件头）');
  return pages;
}

/** 8 页标准课件：Alpha 3 页 / Beta 2 页 / Gamma 3 页。 */
const baseDeck = () => deck([['Alpha', 3], ['Beta', 2], ['Gamma', 3]]);

const withPage = (pages, page, text) => pages.map((x) => (x.page === page ? p(page, text) : x));

/** 给这些页各配一个主线块。 */
const blocksFor = (pageNumbers) => pageNumbers.map((page, i) => b(i + 1, page));
const blocksForAll = (pages) => blocksFor(pages.map((x) => x.page));

const titles = (t) => t.chapters.flatMap((c) => c.topics.map((x) => x.title));
const covered = (t) => new Set(t.chapters.flatMap((c) => c.topics.flatMap((x) => x.blockIndexes)));

/** 一段**真实形态的老师原话**（含口语填充词、重复、断句混乱）。 */
const RAW_ASR =
  '这个纵坐标呃这横坐标就逻辑上都是所有的特单词呃，所有的这个呃在那里'
  + '这个呢就一列列的1234呢，就是所有的老粉们呃';

/** 假 llm 里的书面语版本（落在 RAW_ASR 的上下界之内）。 */
const WRITTEN =
  '矩阵的纵坐标与横坐标对应全部词项；每一列依次编号 1234，代表文档在各维度上的编号。';

/** 一页一个知识点的 8 页讲义夹具（块 i 落在第 i 页）。 */
function lessonFixture({ pages = 8, text = RAW_ASR, title = (i) => `知识点${i}` } = {}) {
  const slides = [];
  const blocks = [];
  for (let i = 1; i <= pages; i++) {
    slides.push(p(i, `${HDR}\n${title(i)}\n${BODY}`));
    blocks.push({ index: i, page: i, text, summary: `第 ${i} 块的概述`, startMs: i * 1000 });
  }
  return { slides, blocks, tree: buildLectureTree({ slides, blocks }) };
}

/** 从请求体里解析出「章号 / 知识点号 / 正文」。形状由 buildLecturePolishBody 定。 */
function parseRequest(body) {
  const out = [];
  const lines = body.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const m = /^--- c(\d+) t(\d+) ---$/.exec(lines[k].trim());
    if (!m) continue;
    let j = k + 1;
    while (j < lines.length && !lines[j].startsWith('## 老师讲的话')) j++;
    out.push({ c: Number(m[1]), t: Number(m[2]), text: (j + 1) < lines.length ? lines[j + 1].trim() : '' });
  }
  return out;
}

/** 把请求里出现的每个知识点都回成 `rewrite(原正文)` 的 JSON 响应。 */
function echoAll(body, rewrite) {
  const byChapter = new Map();
  for (const r of parseRequest(body)) {
    if (!byChapter.has(r.c)) byChapter.set(r.c, []);
    byChapter.get(r.c).push(`{"t": ${r.t}, "passages": [{"text": ${JSON.stringify(rewrite(r.text))}}]}`);
  }
  const chapters = [...byChapter].map(([c, list]) => `{"c": ${c}, "topics": [${list.join(',')}]}`);
  return `{"chapters":[${chapters.join(',')}]}`;
}

/** 假 llm 的默认改写：**真的把口语词删掉**（模拟一次合格的去口语化）。 */
function fakeWritten(source) {
  let s = source;
  for (const w of kLectureFillerWords) s = s.replaceAll(w, '');
  return `书面语改写：${s}`;
}

/**
 * 记录调用的假 llm：**可返回任意文本，也可抛错**。
 *
 * `bodies` 是这次测试的**成本证据**：断言「调了几次」是「空树零调用」、
 * 「每个知识点各一次」这类纪律唯一能用代码判的东西。
 */
function fakeLlm({ responder, onCall } = {}) {
  const llm = {
    bodies: [],
    stages: [],
    calls: [],
    active: 0,
    peak: 0,
    get callCount() { return llm.calls.length; },
    get allBodies() { return llm.bodies.join('\n'); },
    async call({ stage, route, constant, variable, signal }) {
      if (signal?.aborted) throw signal.reason;
      llm.active++;
      llm.peak = Math.max(llm.peak, llm.active);
      llm.bodies.push(variable);
      llm.stages.push(stage);
      llm.calls.push({ stage, route, constant, variable });
      try {
        await onCall?.({ stage, variable, signal });
        if (signal?.aborted) throw signal.reason;
        if (responder) return { text: responder(constant, variable), usage: { totalTokens: 1 } };
        return { text: echoAll(variable, fakeWritten), usage: { totalTokens: 1 } };
      } finally {
        llm.active--;
      }
    },
  };
  return llm;
}

/** 一个把请求里每个知识点都回成 [text] 的假 llm。 */
const respondAll = (text) => fakeLlm({ responder: (_c, body) => echoAll(body, () => text) });

/** 走一遍：建树 → 习坎填充。两者都要断言，所以都返回。 */
async function run(fixture, llm, options = {}) {
  const assembler = createLectureAssembler({ llm, ...options });
  const out = await assembler.assemble({ tree: fixture.tree, blocks: fixture.blocks, context: 'T' });
  assembler.dispose();
  return out;
}

const allTopics = (out) => out.chapters.flatMap((c) => c.topics);

// ═══════════════════════════════════════════════════════════════
// ① 知识树：从 PPT 标题抽知识点与区间
// ═══════════════════════════════════════════════════════════════

test('① 页眉被剔掉，标题按页区间抽成知识点', () => {
  const tree = buildLectureTree({ slides: baseDeck(), blocks: blocksForAll(baseDeck()) });
  assert.ok(!titles(tree).includes(HDR), '页眉不该成为知识点 —— 否则整棵树只有它一个节点');
  assert.deepEqual(titles(tree), ['Alpha', 'Beta', 'Gamma']);
  const alpha = tree.chapters[0].topics[0];
  assert.equal(alpha.title, 'Alpha');
  assert.equal(alpha.fromPage, 1);
  assert.equal(alpha.toPage, 3);
  assert.deepEqual(alpha.blockIndexes, [1, 2, 3], '知识点覆盖的块区间');
  assert.equal(alpha.isCovered, true);
  assert.equal(tree.coveredTopicCount, 3);
});

test('① 连续同名页合成一个知识点；不相邻的同名页**不**归并', () => {
  const pages = deck([['Alpha', 2], ['Beta', 2], ['Alpha', 2], ['Gamma', 2]]);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.deepEqual(titles(tree), ['Alpha', 'Beta', 'Alpha', 'Gamma'],
    '中间隔着 Beta，两个 Alpha 在讲义里就该出现在两个位置');
});

test('① 页眉之外的重复行不算页眉（跨 2–3 页的真标题必须保住）', () => {
  const tree = buildLectureTree({ slides: baseDeck(), blocks: blocksForAll(baseDeck()) });
  assert.ok(titles(tree).includes('Beta'), 'Beta 只占 2 页，不该被当成页眉剔掉');
});

test('① 退化输入：没有页 → 空树，一个节点都不编', () => {
  const tree = buildLectureTree({ slides: [], blocks: [] });
  assert.deepEqual(tree.chapters, []);
  assert.equal(tree.topicCount, 0);
  assert.equal(tree.blockCount, 0);
  assert.equal(tree.uncoveredBlocks.size, 0);
});

test('① 退化输入：只有页、没有块 → 树**照样建出来**（只是本次课没讲到）', () => {
  const tree = buildLectureTree({ slides: baseDeck(), blocks: [] });
  assert.notEqual(tree.chapters.length, 0, '树是空间性的知识地图，不能因为没打标就塌掉');
  assert.equal(tree.topicCount, 3);
  assert.equal(tree.coveredTopicCount, 0);
  assert.equal(tree.uncoveredBlocks.size, 0);
});

test('① 退化输入：整页没有可用文字 → 不产出标题（不编造），也不炸', () => {
  const pages = withPage(baseDeck(), 4, '（无）');
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.equal(tree.uncoveredBlocks.size, 0);
  assert.equal(covered(tree).size, pages.length, '块一个不丢');
});

test('① 整份课件没有标题 → 知识点全无名，但块全被覆盖 + 如实告警', () => {
  // 「没有标题」的退化输入：每页只有页眉与长正文，抽不出标题。
  // 纪律 2 要求**不编造**：留空是诚实的，编一个假名字会让知识树本身错掉。
  const pages = [];
  for (let i = 1; i <= 8; i++) pages.push(p(i, `${HDR}\n${BODY}`));
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.deepEqual(titles(tree), [''],
    '认不出标题就留空 —— 合并成一个无名节点，而不是编 8 个名字');
  assert.equal(tree.uncoveredBlocks.size, 0, '无名只影响名字，绝不许丢块');
  assert.equal(covered(tree).size, 8);
  assert.ok(tree.warnings.some((w) => w.includes('没有可用的 PPT 标题')), '留空要如实说');
  assert.ok(tree.warnings.includes('课件形态：有页眉'), '版式判据也要如实报出');
});

test('② 样板课件**根本没有页眉**时，判据自动退回逐行过滤（不把整棵树判没）', () => {
  // ⚠️ 这份样本**必须真的不带页眉** —— 用 deck() 造的话它会给每页都加上页眉，
  //    测的就不是这条分支了。
  const pages = [];
  let pg = 1;
  for (const [topic, count] of [['Topic A', 3], ['Topic B', 3], ['Topic C', 2]]) {
    for (let i = 0; i < count; i++) {
      pages.push(p(pg, `${topic}\n${BODY}`)); // 第一行就是标题，没有页眉
      pg++;
    }
  }
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(titles(tree).includes('Topic B'), '没有页眉时不能把每一页都判成截图');
  assert.ok(tree.warnings.some((w) => w.includes('没有识别出页眉')), '退化了要如实说，不能静默换判据');
});

test('② 界面截图页不产出标题（真机：抽出过「剪贴板：粘贴」）', () => {
  const excel = '**窗口标题栏**：Pre安排.xlsx - Excel  登录\n'
    + '菜单栏：文件 开始 插入\n剪贴板：粘贴\n字体：等线 12\n对齐方式：（左对齐 / 居中 / 右对齐）';
  const pages = withPage(baseDeck(), 4, excel);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(!titles(tree).includes('剪贴板：粘贴'), '界面文字不该变成知识点标题');
  assert.ok(titles(tree).includes('Alpha'));
  // ★ 本组最要紧的一条：判成截图只影响「这一页有没有标题」，绝不能丢掉这一页的块。
  assert.equal(tree.uncoveredBlocks.size, 0, '截图页的讲解内容照旧收录 —— 那是「讲义比视频少一段」');
  assert.equal(covered(tree).size, pages.length);
});

test('② 截图页**自成一段**，不会被并进上一个知识点', () => {
  const pages = withPage(baseDeck(), 4, '窗口标题栏：Pre安排.xlsx - Excel\n剪贴板：粘贴');
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  const alpha = allTopicsOf(tree).find((x) => x.title === 'Alpha');
  assert.ok(!alpha.blockIndexes.includes(4), '截图页的块不该算进 Alpha —— 那是错的归属');
  assert.ok(covered(tree).has(4), '但它自己不能被丢掉');
});

test('② 课件页没认出标题时并进上一段（续表），不另起无名节点', () => {
  const pages = withPage(baseDeck(), 2, `${HDR}\n| Doc | Text |\n${BODY}`);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  const alpha = allTopicsOf(tree).find((x) => x.title === 'Alpha');
  assert.ok(alpha.blockIndexes.includes(2), '续表要并进 Alpha');
  assert.ok(!titles(tree).includes(''));
});

test('③ 标题判据：表格行 / 版式标签 / 半句话 / 代码行都不当标题', () => {
  const withCandidate = (candidate) => {
    const pages = withPage(baseDeck(), 4, `${HDR}\n${candidate}\n${BODY}`);
    return titles(buildLectureTree({ slides: pages, blocks: blocksForAll(pages) }));
  };
  assert.ok(!withCandidate('| Doc | Text |').includes('| Doc | Text |'), '表格行');
  assert.ok(!withCandidate('左侧表格：').includes('左侧表格：'), '全角冒号收尾的版式标签');
  assert.ok(!withCandidate('Returns relevant documents but').includes('Returns relevant documents but'), '半句话');
  assert.ok(!withCandidate('while ( read a document D ) {').includes('while ( read a document D ) {'), '代码行');
});

test('③ ★ `Index Generator` 是标题（结尾的 or 不能当英文连词）', () => {
  // 真机踩过：中英文连词合成一条正则且漏了词边界，`Generator` 被 `or$` 命中，
  // 这个真标题被判成半句话，「倒排索引构建」整段丢了名字。
  const pages = withPage(baseDeck(), 4, `${HDR}\nIndex Generator\n${BODY}`);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(titles(tree).includes('Index Generator'));
});

test('③ 71 字的长标题只要跨页重复就认（阈值卡在 60 会丢整段知识点）', () => {
  const long = "Distributed indexing (for web-scale indexing — don't try this at home!)";
  const pages = deck([['Alpha', 3], [long, 2], ['Gamma', 3]]);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(titles(tree).includes(long));
});

test('③-c ★★ 封面页兜底不许捡「判据已否决的行」（半句话不能当标题）', () => {
  // 破口形状：8 页课件，真页眉只在 P2–P8（P1 没抄到页眉 —— 真机里这是常态），
  // P1 的首行可用文字是半句话。兜底的逻辑天生是反的（认得出就不兜），
  // 用 `!looksLikeTitle` 当条件等于把「判据明确判成正文的行」也放进了候选池。
  const prose = 'Returns relevant documents but';
  const pages = [
    p(1, `${prose}\n这是第一页正文里的另外一行，用来让它不是唯一行。`),
    ...Array.from({ length: 7 }, (_, i) => p(i + 2, `${HDR}\nTopic ${i + 2}\n这是第 ${i + 2} 页的正文内容行，长度足够长以模拟真实幻灯片。`)),
  ];
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(!titles(tree).includes(prose), '兜底候选必须先过 isRejectedAsTitle（半句话是明确否决）');
  assert.equal(tree.chapters[0].topics[0].title, '', '抽不出标题 ⇒ 留空（空标题是诚实的）');
  assert.equal(tree.uncoveredBlocks.size, 0, '兜底判错只该影响「有没有标题」，绝不能丢块');
});

test('③-c ★ 兜底仍然要能认出**封面页的真标题**（别修过头）', () => {
  // 防「修过头」：封面页那行只出现一次、不匹配任何标题形态、也不算短 ⇒
  // looksLikeTitle 返回 false，但它**不是**被明确否决的行 ⇒ 兜底要认它。
  const pages = [
    p(1, ''),
    p(2, '高级数据结构与算法分析\nAdvanced Data Structures and\nAlgorithm Analysis\n主讲教师： 卜佳俊\n助教： 郑卓男'),
    p(3, '13:22\n2026/9/15'),
  ];
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.ok(titles(tree).includes('高级数据结构与算法分析'), '封面页的真标题必须仍被兜底抽出');
});

test('④ 文本清洗：markdown 记号、装饰前缀、定位词、省略号统一', () => {
  // 必须放**两页**而不是一页：标题判据里有一条是「在别页也当过标题」。
  const titleAt = (raw) => {
    const pages = deck([[raw, 2], ['Gamma', 6]]);
    return buildLectureTree({ slides: pages, blocks: blocksForAll(pages) }).chapters[0].topics[0].title;
  };
  const got = titleAt('**_Relevance_ measurement requires 3 elements:**');
  assert.ok(!got.includes('$1'), 'Dart 的 replaceAll 不解析组引用 —— 移植时不许留下 `$1` 字面量');
  assert.ok(got.includes('Relevance'));
  assert.ok(!got.includes('_'));
  assert.equal(titleAt('☞ Solution 3: Compact Version'), 'Solution 3: Compact Version');
  assert.equal(titleAt('标题：☞ Solution 3: Compact Version'), 'Solution 3: Compact Version');
  // 省略号统一：`......` 与 `……` 归并成同一个知识点。
  const dots = deck([['While accessing a term ......', 2], ['While accessing a term ……', 2], ['Gamma', 4]]);
  const tree = buildLectureTree({ slides: dots, blocks: blocksForAll(dots) });
  assert.equal(titles(tree).filter((x) => x.startsWith('While')).length, 1, '两种省略号写法应归并');
});

test('④ 页码、代码围栏、表格分隔行、时间戳被丢掉', () => {
  const pages = withPage(baseDeck(), 1, `${HDR}\nAlpha\n\`\`\`\n${BODY}\n12\n|---|---|\n13:22\n2026/9/15`);
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  for (const t of allTopicsOf(tree)) {
    for (const bad of ['12', '```', '|---|---|', '13:22', '2026/9/15']) {
      assert.ok(!t.pptLines.includes(bad), `「${bad}」不该进要点行`);
    }
  }
});

test('⑤ 挂载与不遗漏：每个主线块恰好落在一个知识点上', () => {
  const pages = baseDeck();
  const tree = buildLectureTree({ slides: pages, blocks: blocksForAll(pages) });
  assert.equal(tree.uncoveredBlocks.size, 0);
  assert.deepEqual([...covered(tree)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 1; i <= 8; i++) {
    assert.equal(tree.assignments.get(i)?.length, 1, `第 ${i} 块应恰好属于一个知识点`);
  }
});

test('⑤ ★ 页号在课件范围之外的块也被收下（不凭空消失）', () => {
  // 块的页号来自终稿，而 slides.json 可能缺页。不兜底的话那些块会消失，
  // 症状是「讲义比视频少了一段」而用户无从发现。
  const tree = buildLectureTree({
    slides: baseDeck(),
    blocks: [...blocksForAll(baseDeck()), b(99, 500)],
  });
  assert.equal(tree.uncoveredBlocks.size, 0);
  assert.ok(covered(tree).has(99));
  assert.ok(tree.warnings.some((w) => w.includes('页号不在课件页范围')), '兜底了要如实说');
});

test('⑦ 章：分节页优先，其次整节梳理的语义分段；且分段**不切开概念**', () => {
  const pages = baseDeck();
  const withOutline = buildLectureTree({
    slides: pages,
    blocks: blocksForAll(pages),
    outline: [{ title: '第一章', from: 1, to: 3 }, { title: '第二章', from: 4, to: 8 }],
  });
  assert.deepEqual(titles(withOutline), ['Alpha', 'Beta', 'Gamma'], '分段不许增删知识点');
  assert.deepEqual(withOutline.chapters.map((c) => c.title), ['第一章', '第二章']);
  assert.equal(withOutline.chapters.reduce((a, c) => a + c.blockCount, 0), 8, '块没丢');

  // 分节页开新章，概念不跨章。
  const divided = deck([['第1章 检索', 3], ['Alpha', 2], ['第2章 排序', 1], ['Beta', 2]]);
  const deckTree = buildLectureTree({ slides: divided, blocks: blocksForAll(divided) });
  assert.deepEqual(deckTree.chapters.map((c) => c.title), ['第1章 检索', '第2章 排序']);
  assert.ok(deckTree.chapters[0].topics.map((x) => x.title).includes('Alpha'));
  assert.ok(deckTree.chapters[1].topics.map((x) => x.title).includes('Beta'));

  // 口述跨过边界时概念保持完整，并如实告警。
  const crossing = buildLectureTree({
    slides: pages,
    blocks: blocksForAll(pages),
    outline: [{ title: '前一章', from: 1, to: 1 }, { title: '后一章', from: 2, to: 8 }],
  });
  assert.equal(titles(crossing).filter((x) => x === 'Alpha').length, 1);
  assert.ok(crossing.warnings.some((w) => w.includes('概念保持完整')));
});

test('⑦ ★ PPT 有、本次课没讲的标题**保留在树里**（树是完整的）', () => {
  const pages = deck([['Alpha', 3], ['Beta', 2], ['NeverTaught', 2], ['Gamma', 1]]);
  const tree = buildLectureTree({ slides: pages, blocks: blocksFor([1, 2, 3, 4, 5, 8]) });
  assert.ok(titles(tree).includes('NeverTaught'), '空间性的知识地图不能因为这次课没走那条路就把路抹掉');
  assert.ok(tree.coveredTopicCount < tree.topicCount, '但「讲到」与「没讲到」要能分辨');
  assert.ok(tree.warnings.some((w) => w.includes('没讲到')), '没讲到必须如实报数');
});

test('⑦ 分节页 / 版式判定的辅助函数', () => {
  assert.equal(looksLikeSectionDivider('第1章 检索'), true);
  assert.equal(looksLikeSectionDivider('Chapter 3'), true);
  assert.equal(looksLikeSectionDivider('Part 2'), true);
  assert.equal(looksLikeSectionDivider('Alpha'), false);
  assert.equal(looksLikeSectionDivider(''), false);
  assert.equal(detectSlideTemplate({ pageCount: 0, headerPages: 0, shellPages: 0 }), SLIDE_TEMPLATE.plain);
  assert.equal(detectSlideTemplate({ pageCount: 10, headerPages: 5, shellPages: 0 }), SLIDE_TEMPLATE.header);
  assert.equal(detectSlideTemplate({ pageCount: 10, headerPages: 5, shellPages: 3 }), SLIDE_TEMPLATE.shellHeavy);
  assert.equal(detectSlideTemplate({ pageCount: 10, headerPages: 1, shellPages: 0 }), SLIDE_TEMPLATE.plain);
});

test('④ 清洗与噪声判据的单元口径', () => {
  assert.equal(cleanLine('  **粗体**  '), '粗体');
  assert.equal(cleanLine('1. 有序前缀'), '有序前缀');
  assert.equal(cleanLine('```json'), '');
  assert.equal(tidySlideHeading('12'), '', '纯页码不是证据行');
  assert.equal(tidySlideHeading('右上角页眉：'), '', '版式定位行不是内容');
  // 「弱」外壳词只在**短行**（≤ 20 字）上算数：长行里的「共享」可能是正经内容。
  const longShare = '共享内存的读写与并发控制策略，以及工具链上的取舍说明';
  assert.ok(longShare.length > 20, '夹具本身要够长，否则测的不是这条分支');
  assert.equal(tidySlideHeading(longShare), longShare, '长行里的「共享」不算界面文字');
  assert.equal(tidySlideHeading('共享'), '', '但短行上算');
});

// ═══════════════════════════════════════════════════════════════
// ② 书面语验收：通过 / 不通过两档
// ═══════════════════════════════════════════════════════════════

test('② 书面语验收：通过档 —— 干净书面语判 written 且 notes 为空', () => {
  const verdict = judgeWritten({ source: '呃，内存足够就随机寻址。', rewritten: '内存充足时采用随机寻址。' });
  assert.equal(verdict.register, REGISTER.written);
  assert.deepEqual(verdict.notes, []);
});

test('② 书面语验收：不通过档 —— 空稿 / 照抄 / 课堂称呼 / 半截句各判各的', () => {
  const empty = judgeWritten({ source: '原话。', rewritten: '  ' });
  assert.equal(empty.register, REGISTER.failed, '空稿是 failed（这次没产出）');
  assert.deepEqual(empty.notes, ['加工结果是空的']);

  const copied = judgeWritten({ source: '内存充足时采用随机寻址。', rewritten: '内存充足时采用随机寻址。' });
  assert.equal(copied.register, REGISTER.draft);
  assert.ok(copied.notes.includes('与口述相同'));

  const marks = judgeWritten({ source: '看这里。', rewritten: '同学们，内存采用随机寻址。' });
  assert.equal(marks.register, REGISTER.draft);
  assert.ok(marks.notes.join().includes('同学们'));
  for (const mark of kClassroomMarks) {
    assert.ok(judgeWritten({ source: '看这里。', rewritten: `内存采用${mark}随机寻址。` }).notes.join().includes(mark));
  }

  const half = judgeWritten({ source: '原话。', rewritten: '内存采用随机寻址的' });
  assert.equal(half.register, REGISTER.draft);
  assert.deepEqual(half.notes, ['有说半截的句子']);
});

test('② 归一化：只加标点/空白仍算「与口述相同」（加标点不是加工）', () => {
  assert.equal(normalizeLectureText('内存 充足，寻址。'), '内存充足寻址');
  const onlyPunctuation = judgeWritten({ source: '内存充足时采用随机寻址', rewritten: '内存充足时，采用随机寻址。' });
  assert.equal(onlyPunctuation.register, REGISTER.draft);
  assert.ok(onlyPunctuation.notes.includes('与口述相同'), '★ 只加标点 == 照抄，判得出来');
});

// ═══════════════════════════════════════════════════════════════
// ③ 习坎：按树填充
// ═══════════════════════════════════════════════════════════════

test('③ 每个知识点各发一次调用，正文落到**对应**的知识点上（不串位）', async () => {
  const fx = lessonFixture();
  const llm = fakeLlm({
    responder: (_c, body) => echoAll(body, (src) => {
      // 用请求体里那一段的正文当输入，产出**与输入一一对应**的文本。
      const key = parseRequest(body).find((r) => r.text === src);
      return `${WRITTEN}【c${key.c}t${key.t}】`;
    }),
  });
  const out = await run(fx, llm);
  const topics = allTopics(out);
  assert.equal(topics.length, 8);
  assert.equal(llm.callCount, 8, '八个知识点 = 八次请求（一个概念一次调用）');
  for (const t of topics) {
    assert.equal(t.passages.length, 1);
    assert.ok(t.passages[0].text.includes(WRITTEN));
  }
  // ★ 不串位：每条产出带的记号必须与它自己所在的知识点序号一致。
  const marks = topics.map((t, i) => {
    const m = /【c(\d+)t(\d+)】/.exec(t.passages[0].text);
    assert.ok(m, '每条正文都该带它自己的序号记号');
    return `${m[1]}/${m[2]}`;
  });
  assert.deepEqual(new Set(marks).size, 8, '八条产出必须落在八个不同的知识点上');
  // 章/知识点序号与树一致
  assert.equal(out.chapters[0].topics[0].passages[0].text.includes('【c1t1】'), true);
  assert.equal(out.chapters[0].topics[1].passages[0].text.includes('【c1t2】'), true);
});

test('③ 请求体里带上了 PPT 标题与课件线索（模型据此知道这一段该讲什么）', async () => {
  const fx = lessonFixture();
  const llm = fakeLlm();
  await run(fx, llm);
  assert.ok(llm.allBodies.includes('# 知识点：知识点3'), '标题要带给模型');
  assert.ok(llm.allBodies.includes('## 课件线索'), 'PPT 要点是「这一页在讲什么」的最强线索');
  assert.ok(llm.allBodies.includes('## 老师讲的话'), '正文要带给模型');
  assert.ok(llm.allBodies.includes(RAW_ASR), '原话必须真的到了模型面前');
  assert.ok(llm.stages.every((s) => s === kStage), 'stage 要如实标出是讲义加工');
});

test('③ 标题为空时**不编造**（如实说课件没写标题）', async () => {
  const slides = [];
  const blocks = [];
  for (let i = 1; i <= 8; i++) {
    slides.push(p(i, `${HDR}\n${BODY}`));
    blocks.push({ index: i, page: i, text: RAW_ASR, startMs: i * 1000 });
  }
  const tree = buildLectureTree({ slides, blocks });
  const llm = fakeLlm();
  const assembler = createLectureAssembler({ llm });
  await assembler.assemble({ tree, blocks, context: 'T' });
  assembler.dispose();
  assert.ok(llm.allBodies.includes('课件这几页没有文字标题，请从下面老师讲的内容判断'));
  assert.ok(!llm.allBodies.includes('# 知识点：\n'), '空标题不许变成一行空标题');
});

test('★★ 失败的知识点保留上一版正文（老师原话），并如实记进 failures', async () => {
  const fx = lessonFixture();
  // 第 2 个知识点回坏 JSON，其余正常。
  const llm = fakeLlm({
    responder: (_c, body) => {
      const req = parseRequest(body);
      if (req.some((r) => r.c === 1 && r.t === 2)) return '这不是 JSON';
      return echoAll(body, fakeWritten);
    },
  });
  const out = await run(fx, llm);
  const topics = allTopics(out);
  assert.equal(topics[0].passages[0].text.startsWith('书面语改写：'), true, '第 1 条写成了稿');
  assert.equal(topics[1].passages[0].text, RAW_ASR, '★ 第 2 条必须保持老师原话，不许变空');
  assert.equal(topics[1].register, REGISTER.failed, '没写成稿要如实标出');
  assert.ok(topics[1].notes.includes('这次没有写成稿'));
  assert.ok(out.failures.some((f) => f.includes('响应无法解析')), '失败要有名字');
  assert.ok(out.failures.some((f) => f.includes('c1t2')), '失败要指到具体是哪个知识点');
  assert.equal(topics[2].passages[0].text.startsWith('书面语改写：'), true, '一条失败不牵连别人');
  // 坏 JSON 重试一次（2 次尝试），其余各 1 次。
  assert.equal(llm.callCount, 9);
});

test('★★ client 抛错 → 保持原话 + 记 failures（不许静默）', async () => {
  const fx = lessonFixture();
  // 让「抛错」落在**指定**的知识点上（并发下调用顺序不确定，不能靠第几次计数）。
  const llm = fakeLlm({
    responder: (_c, body) => {
      if (parseRequest(body).some((r) => r.c === 1 && r.t === 1)) throw new Error('网络断了');
      return echoAll(body, fakeWritten);
    },
  });
  const out = await run(fx, llm);
  assert.equal(allTopics(out)[0].passages[0].text, RAW_ASR, '调用失败的知识点保持原话');
  assert.ok(out.failures.join().includes(kStageName), '失败原因要带阶段名');
  assert.ok(out.failures.some((f) => f.includes('调用失败')), '失败要有名字（调用失败 ≠ 响应无法解析）');
  const failed = out.calls.filter((c) => !c.ok);
  assert.ok(failed.length >= 1, '失败的调用也要记进 calls（成本要能核对）');
  assert.equal(failed[0].error.code, 'LLM_FAILED');
  assert.equal(allTopics(out)[1].passages[0].text.startsWith('书面语改写：'), true, '一条失败不牵连别人');
});

test('★★「没有返回」与「被护栏拦下」是两件事，分开报', async () => {
  const fx = lessonFixture();
  // 第 1 条：模型干脆不回它（只回别的）。第 2 条：回一个暴涨的正文（被护栏拦下）。
  const huge = '甲'.repeat(contentChars(RAW_ASR) * 20);
  const llm = fakeLlm({
    responder: (_c, body) => {
      const req = parseRequest(body);
      if (req.some((r) => r.t === 1)) {
        // 回一个别的知识点（不存在的号）——「没返回本概念」。
        return '{"chapters":[{"c":1,"topics":[{"t":99,"passages":[{"text":"别的东西"}]}]}]}';
      }
      if (req.some((r) => r.t === 2)) return echoAll(body, () => huge);
      return echoAll(body, fakeWritten);
    },
  });
  const out = await run(fx, llm);
  const missing = out.failures.filter((f) => f.includes('没有返回'));
  const rejected = out.failures.filter((f) => f.includes('保持老师原话'));
  assert.ok(missing.length >= 1, '「没返回」要有自己的一条');
  assert.ok(rejected.some((f) => f.includes('超过原稿')), '护栏拦下要有自己的一条（说清是护栏，不是模型没干活）');
  assert.ok(!missing.join().includes('c1t2'), '被护栏拦下的那条不该被说成「没有返回」');
  assert.equal(allTopics(out)[1].passages[0].text, RAW_ASR, '被拦下的保持原话');
});

test('③ 模型编了一个不存在的知识点号 → 忽略并如实报出（不污染别卷）', async () => {
  const fx = lessonFixture();
  const llm = fakeLlm({
    responder: (_c, body) => {
      const own = echoAll(body, fakeWritten);
      // 额外塞一个不存在的 c9t9。
      return own.replace('{"chapters":[', '{"chapters":[{"c":9,"topics":[{"t":9,"passages":[{"text":"凭空来的"}]}]},');
    },
  });
  const out = await run(fx, llm);
  assert.ok(out.failures.some((f) => f.includes('不属于本卷')), '越界的产出不许静默丢弃');
  assert.ok(!allTopics(out).some((t) => t.passages[0].text === '凭空来的'), '不许污染讲义');
});

test('★★ 成本纪律：空树 / 没讲到的点 → 一次调用都不发', async () => {
  const empty = { chapters: [] };
  const llm = fakeLlm();
  const assembler = createLectureAssembler({ llm });
  const out = await assembler.assemble({ tree: empty, blocks: [], context: 'T' });
  assembler.dispose();
  assert.equal(llm.callCount, 0, '空树一次请求都不发（本仓对白花钱敏感）');
  assert.deepEqual(out.chapters, []);
  assert.deepEqual(out.failures, []);

  // 「树上有、但本次课没讲到」的知识点不进讲义，也就不送模型。
  // Alpha 占 P1–3、NeverTaught 占 P4–5（本次课没讲到）、Gamma 占 P6–8。
  const pages = deck([['Alpha', 3], ['NeverTaught', 2], ['Gamma', 3]]);
  const spec = [1, 2, 3, 6, 7, 8];
  const blocks = spec.map((page, i) => ({ index: i + 1, page, text: RAW_ASR, startMs: page * 1000 }));
  const tree = buildLectureTree({ slides: pages, blocks });
  const llm2 = fakeLlm();
  const a2 = createLectureAssembler({ llm: llm2 });
  const out2 = await a2.assemble({ tree, blocks, context: 'T' });
  a2.dispose();
  assert.ok(!titles(out2).includes('NeverTaught'), '没讲到的节点不进讲义（那是投影，不是删树）');
  assert.ok(!llm2.allBodies.includes('NeverTaught'), '也就不该送模型');
  assert.equal(llm2.callCount, 2, '两个讲到的知识点 = 两次调用');
  assert.ok(out2.warnings.some((w) => w.includes('没讲到')));
});

test('★ 并发下 failures / calls 的**顺序是确定的**（并发是吞吐手段，不是语义）', async () => {
  // ⚠️ 这条防的是一个只有并发才会出现的退化：若各分卷直接往共享数组里 push，
  //    failures 的次序就随**完成顺序**漂移 —— 同一份输入每次给出次序不同的告警，
  //    用户会以为「这次又出了别的问题」。所以每个分卷各攒自己的、按分卷下标拼装。
  const fx = lessonFixture({ pages: 8 });
  const runOnce = async (delays) => {
    let i = 0;
    const llm = fakeLlm({
      onCall: async () => { await new Promise((r) => setTimeout(r, delays[i++ % delays.length])); },
      responder: (_c, body) => {
        // 让**每一个**知识点都因为暴涨被护栏拦下 → 每个分卷都产出告警。
        const req = parseRequest(body);
        if (req.length === 0) return '{}';
        return echoAll(body, () => '甲'.repeat(contentChars(RAW_ASR) * 20));
      },
    });
    const out = await run(fx, llm, { concurrency: 4 });
    return out.failures;
  };
  // 同一批输入，两种完全不同的完成顺序（延迟递减 vs 递增）。
  const a = await runOnce([1, 20, 2, 15, 3, 12, 4, 9]);
  const b = await runOnce([20, 1, 15, 2, 12, 3, 9, 4]);
  assert.ok(a.some((f) => f.includes('保持老师原话')), '夹具要真的产出告警，否则这条测的是空集');
  assert.deepEqual(a, b, '★ 完成顺序变了，告警次序不许跟着变');
  // 而且次序是按知识点排的（c1t1 在 c1t2 之前）。
  const idx = a.map((f) => /知识点 (\d+\/\d+)/.exec(f)?.[1]).filter(Boolean);
  assert.deepEqual(idx, [...idx].sort(), '告警次序应当与知识点次序一致');
});

test('★ 结构不被破坏：树在填充前后一字不动，正文初值是老师原话', async () => {  const fx = lessonFixture();
  const before = JSON.stringify(titles(fx.tree));
  const llm = fakeLlm();
  const out = await run(fx, llm);
  assert.equal(JSON.stringify(titles(fx.tree)), before, '★ 树是空间性的知识图谱，讲义只是它的一次投影 —— 原地改树是错的');
  assert.equal(out.chapters.length, fx.tree.chapters.length);
  assert.deepEqual(titles(out), titles(fx.tree));
  // 锚点：页号 + 秒数（「一键回家」用），与源的块一致。
  assert.deepEqual(out.chapters[0].topics[0].anchor, { page: 1, tSec: 1 });
  assert.deepEqual(out.chapters[0].topics[0].sourceBlockIndexes, [1]);
  assert.equal(allTopics(out).every((t) => t.draft === RAW_ASR), true, '草稿原话留着，失败时要能退回去');
});

test('★ 一个知识点的多个块被拼成同一段草稿（本版的核心修正）', async () => {
  // 一块一段会让「同一个知识点讲了 9 个块」变成 9 张互不相连的卡。
  const slides = [];
  const blocks = [];
  for (let i = 1; i <= 8; i++) {
    slides.push(p(i, `${HDR}\nAlpha\n${BODY}`));
    blocks.push({ index: i, page: i, text: `第${i}块的原话`, startMs: i * 1000 });
  }
  const tree = buildLectureTree({ slides, blocks });
  assert.equal(tree.topicCount, 1, '连续 8 页同名 → 一个知识点');
  const llm = fakeLlm();
  const assembler = createLectureAssembler({ llm });
  const out = await assembler.assemble({ tree, blocks, context: 'T' });
  assembler.dispose();
  assert.equal(llm.callCount, 1, '一个知识点一次调用');
  for (let i = 1; i <= 8; i++) {
    assert.ok(llm.allBodies.includes(`第${i}块的原话`), `第 ${i} 块的原话要拼进同一段草稿`);
  }
  assert.equal(out.chapters[0].topics[0].draft.split('\n\n').length, 8, '八块拼成一段（空行分隔）');
});

// ═══════════════════════════════════════════════════════════════
// ④ 取消
// ═══════════════════════════════════════════════════════════════

test('④ 取消信号让 assemble 抛 CANCELLED（不是降级成草稿）', async () => {
  const fx = lessonFixture({ pages: 12 });
  const controller = new AbortController();
  let started = 0;
  const llm = fakeLlm({
    onCall: async ({ signal }) => {
      started++;
      if (started === 1) controller.abort();
      if (signal?.aborted) throw signal.reason;
    },
  });
  const assembler = createLectureAssembler({ llm, concurrency: 1 });
  await assert.rejects(
    assembler.assemble({ tree: fx.tree, blocks: fx.blocks, context: 'T', signal: controller.signal }),
    (error) => error instanceof LectureError && error.code === 'CANCELLED',
  );
  assembler.dispose();
  assert.ok(started < 12, '取消之后不该继续把剩下的都发出去');
});

test('④ dispose() 会中断在飞的请求，之后再用抛 DISPOSED', async () => {
  const fx = lessonFixture();
  const llm = fakeLlm({ onCall: async () => { await new Promise((r) => setTimeout(r, 50)); } });
  const assembler = createLectureAssembler({ llm, concurrency: 1 });
  const running = assembler.assemble({ tree: fx.tree, blocks: fx.blocks, context: 'T' });
  await new Promise((r) => setTimeout(r, 5));
  assembler.dispose();
  await assert.rejects(running, (error) => error instanceof LectureError && error.code === 'CANCELLED');
  await assert.rejects(
    assembler.assemble({ tree: fx.tree, blocks: fx.blocks }),
    (error) => error instanceof LectureError && error.code === 'DISPOSED',
  );
});

// ═══════════════════════════════════════════════════════════════
// ⑤ 并发
// ═══════════════════════════════════════════════════════════════

test('⑤ 并发不超过配置值（且确实并行，不是碰巧串行）', async () => {
  const fx = lessonFixture({ pages: 12 });
  const llm = fakeLlm({ onCall: async () => { await new Promise((r) => setTimeout(r, 10)); } });
  const out = await run(fx, llm, { concurrency: 2 });
  assert.equal(llm.callCount, 12);
  assert.ok(llm.peak <= 2, `并发峰值 ${llm.peak} 不得超过配置的 2`);
  assert.equal(llm.peak, 2, '★ 峰值应当真的到 2 —— 否则这条测的不是「限流」，而是「碰巧串行」');
  assert.equal(allTopics(out).length, 12);
  assert.equal(llm.stages.every((s) => s === kStage), true);
});

test('⑤ 并发 1 时严格串行；并发上限校验拒绝坏值', async () => {
  const fx = lessonFixture();
  const llm = fakeLlm({ onCall: async () => { await new Promise((r) => setTimeout(r, 2)); } });
  await run(fx, llm, { concurrency: 1 });
  assert.equal(llm.peak, 1, '并发 1 必须严格串行');
  for (const bad of [0, -1, 17, 2.5, '3']) {
    assert.throws(() => createLectureAssembler({ llm, concurrency: bad }),
      (error) => error instanceof LectureError && error.code === 'CONFIG');
  }
  assert.throws(() => createLectureAssembler({}), (error) => error.code === 'CONFIG',
    '没注入 llm 要立刻报配置错，而不是等到跑的时候');
});

test('⑤ 排队中取消：队列里的任务不发出去', async () => {
  const fx = lessonFixture({ pages: 12 });
  const controller = new AbortController();
  const llm = fakeLlm({ onCall: async () => { await new Promise((r) => setTimeout(r, 20)); } });
  const assembler = createLectureAssembler({ llm, concurrency: 1 });
  const running = assembler.assemble({
    tree: fx.tree, blocks: fx.blocks, context: 'T', signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 5));
  const sentBefore = llm.callCount;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assembler.dispose();
  assert.ok(sentBefore <= 2, '排队中的不该已经发出去了');
});

// ═══════════════════════════════════════════════════════════════
// ⑥ 护栏与解析器（直接钉住口径）
// ═══════════════════════════════════════════════════════════════

test('⑥ 长度上限**会回退**；缩水与口语词**只报告不回退**', () => {
  const huge = '甲'.repeat(contentChars(RAW_ASR) * 20);
  assert.ok(checkPolishLength({ source: RAW_ASR, rewritten: huge }) !== null, '字数变多是客观事实 —— 可以驱动回退');
  assert.equal(checkPolishLength({ source: RAW_ASR, rewritten: '内存充足时采用随机寻址。' }), null);
  // 标点不计入内容字数：重新断句不是「新增内容」。
  assert.equal(checkPolishLength({
    source: '矩阵的纵横坐标对应全部词项',
    rewritten: '矩阵的，纵横坐标：对应、全部词项！！！（见注）',
  }), null);
  // 缩水只报告。
  assert.ok(checkPolishShrink({ source: RAW_ASR, rewritten: '甲乙丙' }) !== null);
  assert.equal(checkPolishShrink({ source: RAW_ASR, rewritten: RAW_ASR }), null);
  // 口语词用**相对下降**，不是绝对密度。
  assert.equal(checkPolishFiller({ source: '呃呃呃呃呃呃呃呃呃呃这个这个这个', rewritten: '甲乙丙' }), null, '降到 0 一定通过');
  assert.ok(checkPolishFiller({ source: '呃呃呃呃呃呃呃呃呃呃', rewritten: '呃呃呃呃呃呃呃呃呃呃' }) !== null, '一处没降就该报');
  assert.equal(checkPolishFiller({ source: '这句话里没有填充词', rewritten: '这句话里没有填充词' }), null, '原话本来就没有可去的东西 → 不判');
});

test('⑥ 产出残缺**会回退**：靠形态，不靠长度', () => {
  assert.equal(isBrokenOutput({ source: RAW_ASR, rewritten: '类型：教学安排' }), true, '把输入的标签当正文回填');
  assert.equal(isBrokenOutput({ source: RAW_ASR, rewritten: '' }), true);
  assert.equal(isBrokenOutput({ source: '甲'.repeat(300), rewritten: '甲乙丙' }), true, '极短 + 原稿成规模');
  assert.equal(isBrokenOutput({ source: RAW_ASR, rewritten: '内存充足时采用随机寻址；外存访问效率较低。' }), false);
});

test('⑥ 成稿清洗：删语气词、丢整句画面描述；清空则保留原文', () => {
  assert.equal(tidyWrittenText('我们来看，内存充足时采用随机寻址。'), '内存充足时采用随机寻址。');
  assert.equal(tidyWrittenText('页眉：AVL Trees\n内存采用随机寻址。'), '内存采用随机寻址。');
  assert.equal(tidyWrittenText('呃嗯啊'), '');
});

test('⑥ 请求体形状：元信息带前缀、正文不带（防「把标签当正文回填」）', () => {
  const body = buildLecturePolishBody([{ chapterNo: 1, topicNo: 1, title: 'Alpha', pptLines: [BODY], text: RAW_ASR }], { title: 'T' });
  assert.ok(body.includes('--- c1 t1 ---'));
  assert.ok(body.includes('# 知识点：Alpha'), '标题带 # 前缀');
  assert.ok(body.includes('## 老师讲的话（口语，要整理的就是它）：'));
  const lines = body.split('\n');
  const at = lines.indexOf('## 老师讲的话（口语，要整理的就是它）：');
  assert.equal(lines[at + 1], RAW_ASR, '★ 正文行不加任何前缀');
  const glossary = lectureGlossary([{ chapterNo: 1, topicNo: 1, title: 'Alpha', pptLines: [], text: '' }]);
  assert.ok(glossary.includes('- Alpha'));
});

test('⑥ 切卷：默认一个概念一卷，两个上限都 ≤ 0 = 整份一卷', () => {
  const inputs = Array.from({ length: 5 }, (_, i) => ({
    chapterNo: 1, topicNo: i + 1, title: `T${i + 1}`, pptLines: [], text: RAW_ASR,
  }));
  assert.deepEqual(chunkLectureForPolish(inputs).map((c) => c.length), [1, 1, 1, 1, 1]);
  assert.equal(chunkLectureForPolish(inputs, { maxChars: 0, maxTopics: 0 }).length, 1);
  assert.deepEqual(chunkLectureForPolish([]), []);
  // 字数上限是兜底：把 maxTopics 放开，按字数切。
  const long = Array.from({ length: 3 }, (_, i) => ({
    chapterNo: 1, topicNo: i + 1, title: '', pptLines: [], text: '字'.repeat(100),
  }));
  assert.deepEqual(chunkLectureForPolish(long, { maxChars: 250, maxTopics: 0 }).map((c) => c.length), [2, 1]);
});

test('⑥ 解析器的容忍与拒绝（⚠️ 序号必须是数字）', () => {
  assert.equal(parseLecturePolishResponse('```json\n{"chapters":[{"c":1,"topics":[{"t":1,"passages":[{"text":"正文"}]}]}]}\n```')[0].passages[0].text, '正文', '容忍围栏');
  assert.equal(parseLecturePolishResponse('[{"c":1,"topics":[{"t":1,"passages":[{"text":"正文"}]}]}]')[0].chapterNo, 1, '容忍少了外层对象');
  assert.equal(parseLecturePolishResponse('{"data":{"chapters":[{"c":1,"topics":[{"t":1,"passages":["正文"]}]}]}}')[0].passages[0].text, '正文', '容忍包一层 + passages 是字符串数组');
  assert.equal(parseLecturePolishResponse('{"chapters":[{"c":1,"topics":[{"t":1,"passages":[{"body":"正文"}]}]}]}')[0].passages[0].text, '正文', '容忍 body 键');
  assert.equal(parseLecturePolishResponse('{"chapters":[{"c":1,"items":[{"i":1,"text":"正文"}]}]}')[0].topicNo, 1, '容忍旧键名 items / i');
  assert.equal(parseLecturePolishResponse('{"chapters":[{"c":1,"topics":[{"t":1,"slots":[{"kind":"讲解","text":"正文"}]}]}]}')[0].blocks[0].kind.wire, 'elaboration', '容忍顶层 slots + 中文类型名');

  const throws = (raw) => assert.throws(() => parseLecturePolishResponse(raw), (e) => e instanceof LectureError && e.code === 'PARSE');
  throws('{"chapters":[{"c":"1","topics":[{"t":1,"passages":[{"text":"正文"}]}]}]}');
  throws('{"chapters":[{"c":1,"topics":[{"t":"1","passages":[{"text":"正文"}]}]}]}');
  throws('{"chapters":[{"c":1,"topics":[{"t":1,"slots":[{"kind":"不存在的类型","text":"正文"}]}]}]}');
  throws('{"chapters":[{"c":1,"topics":[{"t":1,"passages":[]}]}]}');
  throws('{"chapters":[]}');
  throws('');
  throws('不是 JSON');
});

test('⑥ 提示词：只规定产物、不规定步骤；不写长度禁令；写死忠实', () => {
  assert.ok(kLectureWrittenSystemPrompt.startsWith('\n'), '★ 开头那个显式换行是实验条件的一部分（逐字节对齐）');
  assert.ok(kLectureWrittenSystemPrompt.includes('你是把大学课堂录音稿整理成**讲义**的编辑'));
  assert.ok(kLectureWrittenSystemPrompt.includes('# 产物要求'), '规定产物');
  assert.ok(!/第一步|第二步|先删|然后合并/.test(kLectureWrittenSystemPrompt), '不许规定步骤');
  assert.ok(!/长度应当与原文相当|不要分点|不要加小标题/.test(kLectureWrittenSystemPrompt),
    '★ 那两句被实测否过（99.6% / 口语词 9→9），不许再写');
  assert.ok(kLectureWrittenSystemPrompt.includes('不新增'), '忠实要写死');
  assert.ok(kLectureWrittenSystemPrompt.includes('力度对照'), '唯一被证明会失效的维度是「力度」');
  assert.ok(kLectureWrittenSystemPrompt.includes('{"c":1,"t":1,"slots"'), '输出格式要写清');
});

test('⑥ ★★ Dart golden：系统提示词与 App 的 kLectureWrittenSystemPrompt **逐字节相同**', async () => {
  // ⚠️ 这条是本文件最容易被忽视、代价最大的一条。
  //
  //    提示词就是那次 A/B 对照的**实验条件**（40 次生成调用，判据层过 159 / 不过 6）。
  //    差一个反引号，产出的东西就不再是那一版实验的产物，而「这个提示词好」
  //    这个结论也就不再适用 —— 而它从外面**完全看不出来**。
  //
  //    移植时真的踩到了：用手写字符串拼接绕开反引号，漏掉了 4 个反引号
  //    （提示词少 4 字符）。所以这里钉一份从 Dart 源码提取的冻结契约：
  //    改提示词的人必须同时改这个夹具，那就必须**显式面对**「实验条件变了」这件事。
  //
  //    夹具放在**包内**（`packages/dsh-zhiyun-lecture/fixtures/`）而不是
  //    `tests/fixtures/`：它是这个包自己的磁盘契约，跟着包走才不会被
  //    「测试目录归别人管」的写作范围挡住。
  const { readFile } = await import('node:fs/promises');
  const golden = await readFile(
    new URL('../packages/dsh-zhiyun-lecture/fixtures/system-prompt.txt', import.meta.url), 'utf8');
  assert.equal(kLectureWrittenSystemPrompt, golden,
    '提示词与 App 不一致 —— 这不是排版问题，是把那次 A/B 对照的实验条件改掉了');
  assert.ok(golden.includes('`$...$`'), '行内代码的反引号必须真的在（先前正是这里漏了 4 个）');
  assert.ok(golden.includes('`\\log`') && golden.includes('`\\le`'), '反斜杠命令要是字面反斜杠，不能被模板串吃掉');
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 插件包装
// ═══════════════════════════════════════════════════════════════

test('⑦ 插件：provide 服务 + disposer 释放（宿主服务由注入项提供）', async () => {
  const plugin = await import('../packages/dsh-zhiyun-lecture/src/index.js');
  assert.equal(plugin.name, 'zhiyun-lecture');
  assert.deepEqual(plugin.inject, ['zhiyunParser']);

  const provided = new Map();
  const llm = fakeLlm();
  const ctx = {
    zhiyunParser: { llm: { call: llm.call, resolve: async () => ({ text: { provider: 'p', model: 'm' } }) } },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
  };
  const dispose = await plugin.apply(ctx, { concurrency: 2 });
  const service = provided.get('zhiyunLecture');
  assert.ok(service, 'ctx.zhiyunLecture 要可用');
  assert.equal(service.concurrency, 2);

  const fx = lessonFixture();
  const out = await service.assemble({ tree: fx.tree, blocks: fx.blocks, context: 'T' });
  assert.equal(allTopics(out).length, 8);
  assert.equal(llm.callCount, 8);
  assert.deepEqual(llm.calls[0].route, { provider: 'p', model: 'm' }, '路由由集成层解析后透传');

  await dispose();
  assert.equal(provided.get('zhiyunLecture'), undefined, '卸载后服务要消失');
  assert.equal(service.closed, true, '加工器要被释放');
  await assert.rejects(service.assemble({ tree: fx.tree, blocks: fx.blocks }),
    (error) => error.code === 'DISPOSED');
});

test('⑨ ★★ 真实 Cordis 宿主：服务挂载 / 隔离 / 卸载释放（不是拿假 ctx 自证）', async (t) => {
  // ⚠️ 上面那条 ⑦ 用的是**手写的假 ctx**，它测不出 `ctx.provide` 的真实契约
  //    （比如「卸载后服务是不是真的消失」）。所以这里按本仓既有路子
  //    （见 `tests/classroom-cordis.test.mjs`）挂一次**真实**的 @deepseek-ai/cordis。
  const { pathToFileURL } = await import('node:url');
  const { access } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');
  const versions = ['0.2.0-rc.2', '0.2.1-alpha.1'];
  let ran = 0;

  for (const version of versions) {
    const modulePath = path.join(root, '.runtime', `dsh-${version}`, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
    try { await access(modulePath); } catch { continue; } // 该宿主未安装 → 跳过
    ran++;
    const { Context } = await import(pathToFileURL(modulePath).href);
    const plugin = await import('../packages/dsh-zhiyun-lecture/src/index.js');
    const first = new Context();
    const second = new Context();
    const calls = [];
    // 回包要**逐知识点**回（照请求里的 c/t 号），否则除第一条外全部不能命中
    // 「本卷有本概念」→ 每个都重试一次（那是正确行为，但会让「八次调用」这条断言失真）。
    const replyFor = (body) => echoAll(body, () => '书面语正文');
    const stub = () => ({ llm: { call: async ({ stage, variable }) => { calls.push(stage); return { text: replyFor(variable), usage: { totalTokens: 1 } }; } } });
    first.provide('zhiyunParser', stub());
    second.provide('zhiyunParser', stub());

    try {
      const fiber = await first.plugin(plugin);
      const other = await second.plugin(plugin);
      const service = first.get('zhiyunLecture');
      const isolated = second.get('zhiyunLecture');
      assert.ok(service, `Cordis ${version}: 插件要挂上 zhiyunLecture`);
      assert.ok(isolated, `Cordis ${version}: 第二个 Context 也要挂上`);
      assert.notEqual(service, isolated, `Cordis ${version}: 两个 Context 之间必须隔离`);

      const fx = lessonFixture();
      const out = await service.assemble({ tree: fx.tree, blocks: fx.blocks, context: 'T' });
      const topics = allTopics(out);
      assert.equal(topics.length, 8, `Cordis ${version}: 八个知识点`);
      assert.equal(calls.length, 8, `Cordis ${version}: 八次调用`);
      assert.equal(topics[0].passages[0].text, '书面语正文', `Cordis ${version}: 正文写进去了`);

      await fiber.dispose();
      assert.equal(first.get('zhiyunLecture'), undefined, `Cordis ${version}: 卸载后服务要消失`);
      assert.equal(service.closed, true, `Cordis ${version}: 加工器要被释放`);
      await assert.rejects(service.assemble({ tree: fx.tree, blocks: fx.blocks }),
        (error) => error.code === 'DISPOSED', `Cordis ${version}: 释放后再用要抛 DISPOSED`);
      await other.dispose();
    } finally {
      await first.fiber.dispose();
      await second.fiber.dispose();
    }
  }
  if (ran === 0) t.skip('本机没有装任何宿主运行时');
  else assert.ok(ran >= 1, '至少要在真实宿主上跑过一次');
});

test('⑦ 插件：没有 llm 时如实报配置错（不静默降级）', async () => {
  const plugin = await import('../packages/dsh-zhiyun-lecture/src/index.js');
  const ctx = { provide() { return () => {}; } };
  await assert.rejects(plugin.apply(ctx, {}), (error) => error.code === 'CONFIG');
  // 显式注入 config.llm 时仍然可用（集成层可以用别的适配器）。
  const llm = fakeLlm();
  const provided = new Map();
  const ctx2 = { provide(n, v) { provided.set(n, v); return () => provided.delete(n); } };
  const dispose = await plugin.apply(ctx2, { llm });
  assert.ok(provided.get('zhiyunLecture'));
  await dispose();
});

// ═══════════════════════════════════════════════════════════════
// ⑧ 包边界（本包必须零宿主依赖）
// ═══════════════════════════════════════════════════════════════

test('⑧ 零宿主依赖：源码里不 import 任何 @deepseek-ai/*，也不碰 ctx.storage / 环境变量', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = new URL('../packages/dsh-zhiyun-lecture/src/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, 'tree / register / polish / index / errors');
  // ⚠️ 必须**先去掉注释**再扫：正文注释里就写着「本文件不碰 ctx.storage」，
  //    不剥注释的话这条自检会被它自己的说明文档判红（而且会诱使人删掉那句
  //    约束说明 —— 那正好丢掉了最该留下的东西）。
  const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of files) {
    const code = stripComments(await readFile(new URL(file, dir), 'utf8'));
    for (const [what, pattern] of [
      ['宿主包', /@deepseek-ai\//],
      ['落盘 / 读环境变量', /ctx\.storage|process\.env|node:fs|require\(/],
    ]) {
      assert.ok(!pattern.test(code), `${file} 不许${what}（llm 与落盘都由集成层负责）`);
    }
    // import 只能是相对路径或 node 内置的纯计算模块。
    for (const m of code.matchAll(/^\s*import\s.*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('.'), `${file} 的 import「${m[1]}」不是相对路径 —— 本包必须零宿主依赖`);
    }
  }
});

function allTopicsOf(tree) {
  return tree.chapters.flatMap((c) => c.topics);
}

// ═══════════════════════════════════════════════════════════════
// ⑨ Dart golden：与 App 真实实现的**冻结差分快照**
// ═══════════════════════════════════════════════════════════════

/**
 * 这份 golden 是**真的跑 Dart 导出来的**，不是手写的期望值：
 *
 * ```text
 * node .runtime/parity/golden.mjs   # 内部调 dart run driver.dart
 * ```
 *
 * 它比「我读懂了 Dart 源码」强的地方在于：它抓的是**两个实现的实际行为差异**。
 * 先前正是它抓出了 `looksLikeNotationOnly` 里那条「注释与代码说的不是同一件事」
 * 的正则 —— 我按注释「顺手修正」成了 `\\[a-zA-Z]+`，于是 `\le 5` 这类行
 * 在 Dart 里保留、在我的版本里被丢掉。**读代码是读不出这个的。**
 *
 * ⚠️ 它冻在包内（`packages/dsh-zhiyun-lecture/fixtures/dart-golden.json`），
 *    所以**不需要装 Dart** 也能长期复核。
 */
test('⑨ ★★ Dart golden：知识树 / 书面语验收 / 清洗与 App 真实实现逐字段一致', async () => {
  const { readFile } = await import('node:fs/promises');
  const golden = JSON.parse(await readFile(
    new URL('../packages/dsh-zhiyun-lecture/fixtures/dart-golden.json', import.meta.url), 'utf8'));

  // ① 知识树
  for (const c of golden.tree) {
    const tree = buildLectureTree({ slides: c.slides, blocks: c.blocks, outline: c.outline });
    const got = {
      chapters: tree.chapters.map((ch) => ({
        title: ch.title,
        blockCount: ch.blockCount,
        topics: ch.topics.map((t) => ({
          title: t.title, fromPage: t.fromPage, toPage: t.toPage,
          pptLines: [...t.pptLines], blockIndexes: [...t.blockIndexes],
          isCovered: t.isCovered, titleOnly: t.titleOnly,
        })),
      })),
      warnings: [...tree.warnings],
      uncoveredBlocks: [...tree.uncoveredBlocks].sort((a, b) => a - b),
      topicCount: tree.topicCount,
      coveredTopicCount: tree.coveredTopicCount,
      blockCount: tree.blockCount,
      register: null,
      clean: {},
    };
    assert.deepEqual(got, c.expected, `树用例「${c.name}」与 Dart 不一致`);
  }
  assert.ok(golden.tree.length >= 20, 'golden 覆盖的树用例数不该缩水');

  // ② 书面语验收（含五条课堂称呼与全部半截句结尾字符）
  for (const c of golden.register) {
    assert.deepEqual(judgeWritten({ source: c.source, rewritten: c.rewritten }), c.expected,
      `验收用例（rewritten=${JSON.stringify(c.rewritten)}）与 Dart 不一致`);
  }

  // ③ 清洗
  for (const [raw, expected] of Object.entries(golden.clean)) {
    assert.equal(tidySlideHeading(raw), expected, `清洗用例 ${JSON.stringify(raw)} 与 Dart 不一致`);
  }
});

test('⑨ ★★ `looksLikeNotationOnly` 里的正则**故意保留** Dart 的写法（不是笔误）', async () => {
  // Dart 的 `RegExp(r'\[a-zA-Z]+')` 在 Dart 里是**字面左括号**（`\[` 被转义），
  // 所以它匹配「`[` + 若干字母」，而作者的注释写的是「反斜杠命令（`\le` / `\mathrm`）」
  // —— **代码与注释说的不是同一件事**。
  //
  // ⚠️ 移植时我按注释「顺手修正」成 `\\[a-zA-Z]+`，差分测试当场抓出来：
  //    `\le 5` 在 Dart 里**保留**、在我的版本里被当成纯记号丢掉。
  //    那会让一行真内容从 PPT 要点里消失 —— 正是「不许自己发明算法」要防的事。
  //
  // ⛔ 要改它必须先去 App 侧改（并把那条注释与代码对齐）；那是跨仓的行为变更，
  //    不是移植该顺手做的事。
  const { readFile } = await import('node:fs/promises');
  const golden = JSON.parse(await readFile(
    new URL('../packages/dsh-zhiyun-lecture/fixtures/dart-golden.json', import.meta.url), 'utf8'));
  for (const raw of ['\\le 5', '$x$\\le', '\\mathrm']) {
    assert.equal(golden.clean[raw], raw, `Dart 侧对这些行是保留的：「${raw}」`);
    assert.equal(tidySlideHeading(raw), raw, '★ 移植版必须与 Dart 一致地保留它（不许「修正」）');
  }
  // 反过来：那两条**真的**会命中 Dart 正则的行，两边都要丢掉。
  assert.equal(tidySlideHeading('[a-zA-Z]'), '', '[ + 字母 会被那条正则整段吃掉');
  assert.equal(tidySlideHeading('$k_1$'), '', '纯记号仍然要丢（这是那条正则的正当用途）');
});
