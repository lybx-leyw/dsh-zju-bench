/**
 * **出题与质检**的契约测试 —— 全部离线（假 llm，不联网、不落盘）。
 *
 * # 规格来源
 *
 * 被测层是 App 的 `fusion/quiz_model.dart` + `fusion/quiz_generate.dart` +
 * `fusion/quiz_quality.dart` + `fusion/quiz_dedupe.dart` +
 * `fusion/lecture_quiz.dart` + `data/quiz_store.dart` 六件的移植，
 * 所以下面每条断言都对应 App 侧一条**已经写在注释里的判据**。
 *
 * # 为什么每条都要「同时断言反例」
 *
 * 只断言「成功路径对了」的测试**抓不到退化**：实现改成「永远返回固定伪造值」
 * 时，正向断言照样绿。所以多数用例都配一句「不该出现的东西」。
 *
 * # 任务书列的八条硬验收
 *
 * ① 默认不入库 ② 硬检查不通过就丢弃且有原因 ③ 三态（不在场是 undecided）
 * ④ 锚点等式 ⑤ 先筛后出（wholeSection 被拒） ⑥ 每块两次调用且次序 Rewrite→出题
 * ⑦ 取消抛 CANCELLED ⑧ 源码不出现 node:fs / ctx.storage / process.env
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  QUIZ_TYPES, QUIZ_STATUSES, QUIZ_CHECK_IDS, CHECK_VERDICTS, QUIZ_SEVERITIES,
  materialIdOf, makeItem, makeOption, makeSourceBlock, withItem,
  itemToJson, itemFromJson, stripLabelPrefix, quizTypeFromCode,
} from '../packages/dsh-zhiyun-quiz/src/model.js';
import {
  QuizError, runHardChecks, createQualityPipeline, countBlanks, normalizeOptionText,
  parseNumericValue, numericValuesEquivalent, possibleCorrectLabels,
  ANSWERABILITY_VERDICTS, GROUNDED_VERDICTS,
  unavailableAnswerabilityChecker, unavailableGroundedJudge,
  scriptedAnswerabilityChecker, scriptedGroundedJudge,
  buildGroundedJudgePrompt, buildGroundedJudgeRequest, assertNoGenericRubric,
  kGroundedJudgeSystemPrompt, wilsonInterval, ratioWithWilson,
} from '../packages/dsh-zhiyun-quiz/src/quality.js';
import {
  createQuizGenerator, planQuizGeneration, makeSourceMaterial, makeGenerationRequest,
  QUIZ_MATERIAL_SELECTIONS, kPhase3QuizTypes, kPhase4QuizTypes,
  kRewriteSystemPrompt, kClozeSystemPrompt, kShortAnswerSystemPrompt,
  buildRewritePrompt, buildGenerationPrompt, applyClozeRules, applyShortAnswerRules,
  parseRewriteResponse, parseGenerationResponse, anchorFromMaterial,
  distractorTraceability, normalizeForTrace, adviseCardsPerPage, computeBacklog,
  kForbiddenTermRuleName, kMaxBlanksPerCard,
} from '../packages/dsh-zhiyun-quiz/src/generate.js';
import {
  dropExactQuizDuplicates, quizStemKey, parseQuizDedupeIndexes, dedupeQuizBatch,
  quizDedupeInput, kQuizDedupeMaxExisting,
} from '../packages/dsh-zhiyun-quiz/src/dedupe.js';
import {
  kLectureQuizNoAnchorBlock, kLectureQuizBasisPrefix, kLectureQuizMinQuoteChars,
  lecturePlainText, admitLectureDrafts, lectureQuizDraftsFromArgs,
  parseLectureQuizTurn, lectureDraftToItemFields,
} from '../packages/dsh-zhiyun-quiz/src/lecture.js';
import {
  createQuizStore, makeRateLedger, rateDayKey, quizStoreWritable, quizStoreRemedy,
  QUIZ_READ_STATUSES, makeAttempt, attemptToJson, attemptFromJson,
  QUIZ_AUTOGRADE_VERDICTS, kQuizTracks,
} from '../packages/dsh-zhiyun-quiz/src/store.js';

/** 每次调用**前进 1 秒**的时钟：「近 3 次」这类判据需要可分辨的先后。 */
function tickingClock(start = Date.UTC(2026, 9, 7, 0, 0, 0)) {
  let t = start;
  return () => new Date((t += 1000));
}

/** **本地时间**构造（`rateDayKey` 的口径是本地日，用 UTC 串会跨日）。 */
const localDate = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);

// ═══════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dsh-zhiyun-quiz', 'src');

/** 固定时钟：测试要可复现。 */
const FIXED = () => new Date('2026-10-07T00:00:00.000Z');

/** 一块已标记的材料。 */
const block = (blockIndex, overrides = {}) => makeSourceMaterial({
  blockIndex,
  page: blockIndex + 1,
  atSec: blockIndex * 10,
  summary: `块${blockIndex}的摘要：牛顿第二定律说明合力等于质量乘以加速度。`,
  pointIds: [`p${blockIndex}`],
  selection: QUIZ_MATERIAL_SELECTIONS.markedBlock,
  ...overrides,
});

/** 造一道形状合法的填空题。 */
function clozeItem(overrides = {}) {
  return makeItem({
    id: 'q1',
    courseId: 'c1',
    sectionId: 's1',
    blockIndex: 0,
    page: 1,
    atSec: 0,
    type: QUIZ_TYPES.cloze,
    stem: '牛顿第二定律说明合力等于{{质量}}乘以加速度。',
    answer: '质量',
    status: QUIZ_STATUSES.proposed,
    createdAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  });
}

const v = (c) => c.verdict.code;
const byId = (report, id) => report.checks.find((c) => c.id === id);

/**
 * 假 llm：按 `{stage}` 依次吐回预置响应，并**如实记录**收到的一切。
 *
 * ⚠️ 它记录的是完整请求（`stage` / `constant` / `variable`），所以测试能断言
 * 「第二段拿到的输入是陈述句而不是原始 ASR」—— 那件事只看返回值是看不出来的。
 */
function fakeLlm(script = {}) {
  const calls = [];
  return {
    calls,
    /** 只看得见「调用的名字」的视图，方便断言次序。 */
    get stages() { return calls.map((c) => c.stage); },
    async call(request) {
      calls.push(request);
      const key = request.stage;
      const answer = typeof script[key] === 'function' ? script[key](request, calls.length) : script[key];
      if (answer instanceof Error) throw answer;
      return { text: answer ?? '{"statements":["默认陈述。"]}' };
    },
  };
}

/** 一份标准的假 llm 脚本：改写 + 出题各一。 */
const happyScript = (rows = []) => ({
  'quiz-rewrite': '{"statements":["牛顿第二定律说明合力等于质量乘以加速度。"]}',
  'quiz-cloze': JSON.stringify(rows.length > 0 ? rows : [
    { stem: '牛顿第二定律说明合力等于{{质量}}乘以加速度。', answer: '质量', blockIndex: 0 },
  ]),
  'quiz-shortAnswer': JSON.stringify([
    { stem: '牛顿第二定律里的「质量」指的是什么？', answer: '物体的惯性质量', keywords: ['惯性', '质量'], blockIndex: 0 },
  ]),
});

// ═══════════════════════════════════════════════════════════════
// ① 默认不入库
// ═══════════════════════════════════════════════════════════════

test('① 默认不入库：saveGenerated 只能产出 proposed，且进不了 reviewQueue', () => {
  const store = createQuizStore({ now: FIXED });

  // 故意传一道**已经是 accepted** 的题：保存时必须被强制打回 proposed，
  // 且**逐条写明**（不许静默改写）。
  const smuggled = clozeItem({ id: 'sneaky', status: QUIZ_STATUSES.accepted });
  const res = store.saveGenerated([clozeItem({ id: 'a' }), clozeItem({ id: 'b' }), smuggled]);

  assert.equal(res.saved, 3);
  assert.equal(store.reviewQueue.length, 0, '生成的题一道都不许进复习队列');
  assert.equal(store.pending.length, 3);
  assert.ok(store.all.every((q) => q.status === QUIZ_STATUSES.proposed));
  assert.equal(store.byId('sneaky').status, QUIZ_STATUSES.proposed, 'accepted 必须被强制写回 proposed');
  assert.equal(res.notes.length, 1, '强制改写必须有名字，不许静默');
  assert.match(res.notes[0], /强制写回 proposed/);

  // 只有 **adopt（用户动作）** 才进队列。
  const adopted = store.adopt('a');
  assert.equal(adopted.status, QUIZ_STATUSES.accepted);
  assert.deepEqual(store.reviewQueue.map((q) => q.id), ['a']);
  assert.equal(store.pending.length, 2);

  // discard 是另一个用户动作，它**只**让题离开待审，不进队列。
  store.discard('b');
  assert.equal(store.byId('b').status, QUIZ_STATUSES.rejected);
  assert.deepEqual(store.reviewQueue.map((q) => q.id), ['a']);

  // 找不到 id 时**明确报错**，不静默当成功。
  assert.throws(() => store.adopt('nope'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.discard('nope'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.delete('nope'), (e) => e.code === 'NOT_FOUND');
});

test('① 生成器产出的题状态恒为 proposed（不是 accepted）', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({ blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 } });

  assert.ok(out.admitted.length >= 1);
  for (const cand of out.admitted) {
    assert.equal(cand.item.status, QUIZ_STATUSES.proposed, '生成物不许自己变成 accepted');
  }
  // 而且生成器**没有任何**能把它改成 accepted 的输出字段。
  assert.equal('accepted' in out, false);
});

test('① saveSelfAudited 是唯一另一条入队通道，且判据可核对', () => {
  const store = createQuizStore({ now: FIXED });

  // 带依据前缀 + 块号 -1 → 收下并直接 accepted。
  const lecture = clozeItem({
    id: 'lec-1',
    blockIndex: kLectureQuizNoAnchorBlock,
    page: 0,
    warnings: [`${kLectureQuizBasisPrefix}knowledge｜这一段来自检索回包原文`],
  });
  // 带前缀但块号不是 -1 → 拒绝。
  const wrongBlock = clozeItem({
    id: 'lec-2',
    warnings: [`${kLectureQuizBasisPrefix}knowledge｜这一段来自检索回包原文`],
  });
  // 块号是 -1 但没有前缀 → 拒绝。
  const noBasis = clozeItem({ id: 'lec-3', blockIndex: kLectureQuizNoAnchorBlock, page: 0, warnings: [] });

  const res = store.saveSelfAudited([lecture, wrongBlock, noBasis]);
  assert.equal(res.saved, 1);
  assert.deepEqual(store.reviewQueue.map((q) => q.id), ['lec-1']);
  assert.equal(res.notes.length, 2);
  assert.ok(res.notes.every((n) => /没有讲义自审依据/.test(n)));
});

// ═══════════════════════════════════════════════════════════════
// ② 硬检查不通过 → **丢弃**且有原因（不是降级保留）
// ═══════════════════════════════════════════════════════════════

test('② 禁用词（"The" 做成 cloze）被丢弃，且原因有名字', () => {
  const draft = { stem: 'The {{the}} theorem is important.', answer: 'the', keywords: [], raw: '{"raw":1}' };
  const { draft: ok, rejection } = applyClozeRules(draft, { blockIndex: 0 });
  assert.equal(ok, null, '不合规的草稿不许留下');
  assert.equal(rejection.rule, kForbiddenTermRuleName);
  assert.match(rejection.reason, /禁用词/);
  assert.equal(rejection.raw, '{"raw":1}', '原样保留模型输出（不许丢）');
  assert.equal(rejection.blockIndex, 0);
});

test('② 「theorem」不许因为含 "the" 被误杀（整词判定）', () => {
  const draft = { stem: '{{theorem}} 是定理的意思。', answer: 'theorem', keywords: [], raw: '' };
  const { draft: ok, rejection } = applyClozeRules(draft, { blockIndex: 0 });
  assert.equal(rejection, null, 'theorem 不是禁用词，不许被 the 误杀');
  assert.equal(ok.answer, 'theorem');
  assert.ok(ok.stem.includes('{{theorem}}'), '挖空模板必须留在题干里（渲染时才摘掉）');
});

test('② 挖空过多 / 无挖空 / 空字段各有名字', () => {
  const many = applyClozeRules(
    { stem: '{{a}} 与 {{b}} 与 {{c}} 的关系', answer: 'a', keywords: [], raw: '' }, { blockIndex: 2 });
  assert.equal(many.rejection.rule, 'tooManyBlanks');
  assert.match(many.rejection.reason, new RegExp(`上限 ${kMaxBlanksPerCard}`));

  const none = applyClozeRules({ stem: '没有挖空的题干', answer: 'x', keywords: [], raw: '' }, { blockIndex: 0 });
  assert.equal(none.rejection.rule, 'noBlank');

  const empty = applyClozeRules({ stem: '  ', answer: '', keywords: [], raw: '' }, { blockIndex: 0 });
  assert.equal(empty.rejection.rule, 'emptyField');
});

test('② 答案印在题干里（泄题）被丢弃', () => {
  const { rejection } = applyClozeRules(
    { stem: '牛顿第二定律中的质量与加速度相乘，{{质量}}没被挖掉。', answer: '质量', keywords: [], raw: '' },
    { blockIndex: 0 });
  assert.equal(rejection.rule, 'answerInStem');
});

test('② 硬检查失败 → 质检链直接丢弃，且 reason 里带失败项的名字', async () => {
  // 一道**没有挖空标记**的填空题：blankMarker + blankCount... 至少 blankMarker 会 fail。
  const bad = clozeItem({ stem: '这道题忘了挖空。', answer: '质量' });
  const pipeline = createQualityPipeline();
  const t = await pipeline.evaluate(bad, { source: null });

  assert.equal(t.admitted, false);
  assert.ok(t.hard.hardFails.length > 0);
  assert.ok(t.hard.failedIds.includes('blankMarker'), `失败项要有名字，实际：${t.hard.failedIds}`);
  assert.match(t.reason, /硬检查不通过/);
  assert.equal(t.answerability, null, '硬检查挂了就不许往下走（不花模型钱）');
  assert.equal(t.judge, null);
});

test('② 硬检查失败时不调用任何判官（成本纪律）', async () => {
  let answerabilityCalls = 0;
  let judgeCalls = 0;
  const pipeline = createQualityPipeline({
    answerability: { async answerable() { answerabilityCalls++; return { verdict: ANSWERABILITY_VERDICTS.answerable, detail: '' }; } },
    judge: { async judge() { judgeCalls++; return { verdict: GROUNDED_VERDICTS.betterThanBad, rationale: '' }; } },
  });
  await pipeline.evaluate(clozeItem({ stem: '忘了挖空。' }), { source: null });
  assert.equal(answerabilityCalls, 0, '硬检查挂了就不许打第二层');
  assert.equal(judgeCalls, 0, '硬检查挂了就不许打第三层');
});

test('② 生成路径：被规则挡下的题进 rejected，且**没有**进 admitted', async () => {
  const llm = fakeLlm({
    'quiz-rewrite': '{"statements":["陈述。"]}',
    'quiz-cloze': JSON.stringify([
      { stem: 'The {{the}} thing is here.', answer: 'the', blockIndex: 0 }, // 禁用词 → 丢弃
      { stem: '{{质量}}乘以加速度等于合力。', answer: '质量', blockIndex: 0 }, // 合规
    ]),
  });
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({ blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 } });

  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].rule, kForbiddenTermRuleName);
  assert.equal(out.admitted.length, 1);
  // 关键：被丢弃的那道题**不在**任何采用路径上。
  assert.ok(!out.admitted.some((c) => c.item.stem.includes('The')));
});

// ═══════════════════════════════════════════════════════════════
// ③ 三态：输入不在场 → undecided（**不是** pass）
// ═══════════════════════════════════════════════════════════════

test('③ 没有源块：answerInSource / anchorBacklink 是 undecided，不是 pass', () => {
  const report = runHardChecks(clozeItem(), { source: null });

  const ansIn = byId(report, QUIZ_CHECK_IDS.answerInSource);
  const anchor = byId(report, QUIZ_CHECK_IDS.anchorBacklink);
  assert.equal(v(ansIn), 'undecided', '没查 ≠ 查过没问题');
  assert.equal(v(anchor), 'undecided');
  assert.match(ansIn.detail, /没有拿到源块/);
  assert.match(anchor.detail, /没有拿到源块/);

  // 三态各自的存在性：这道题同时有 undecided，也不许因此被说成 fail。
  assert.ok(report.hardUndecided.length >= 2);
  assert.equal(report.requiresHumanReview, true, '判不了的项必须进人工');
  assert.equal(report.canProceed, true, '没有硬失败 → 可以往下走');
});

test('③ undecided 不算通过：passedAll 为 false，且不许被自动采纳', async () => {
  const item = clozeItem();
  const report = runHardChecks(item, { source: null });
  assert.equal(report.passedAll, false, 'undecided 不许被当成 pass');

  // 即使第二 / 三层都说好，硬检查有 undecided 也**不得** admitted。
  const pipeline = createQualityPipeline({
    answerability: scriptedAnswerabilityChecker({ verdict: ANSWERABILITY_VERDICTS.answerable, detail: '可答' }),
    judge: scriptedGroundedJudge({ verdict: GROUNDED_VERDICTS.betterThanBad, rationale: '像好样例' }),
  });
  const t = await pipeline.evaluate(item, { source: null });
  assert.equal(t.admitted, false, '有判不了的硬项 → 不许自动采纳');
  assert.equal(t.needsHuman, true);
});

test('③ 各层都过了才 admitted（正向对照，防止「永远 false」）', async () => {
  const item = clozeItem();
  const source = makeSourceBlock({
    blockId: 'b0', blockIndex: 0, page: 1, atSec: 0,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    goodExamples: ['好样例'], badExamples: ['坏样例'],
    sectionId: 's1', sourceRevision: 'r1',
  });
  const report = runHardChecks(item, { source });
  assert.equal(report.passedAll, true, `这道夹具应当全过，实际失败：${report.failedIds} 判不了：${report.undecidedIds}`);

  const pipeline = createQualityPipeline({
    answerability: scriptedAnswerabilityChecker({ verdict: ANSWERABILITY_VERDICTS.answerable, detail: '可答' }),
    judge: scriptedGroundedJudge({ verdict: GROUNDED_VERDICTS.betterThanBad, rationale: '像好样例' }),
  });
  const t = await pipeline.evaluate(item, { source });
  assert.equal(t.admitted, true);
  assert.equal(t.needsHuman, false);
  assert.match(t.reason, /够格给用户看/);
  // 「够格给用户看」**不等于**已采纳 —— 这件事在类型上就要看得见。
  assert.equal(t.item.status, QUIZ_STATUSES.proposed);
});

test('③ 默认装配（没接判官）：第二 / 三层给 undecided，不是「可答 / 像好样例」', async () => {
  const item = clozeItem();
  const source = makeSourceBlock({
    blockId: 'b0', blockIndex: 0, page: 1, atSec: 0,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    sectionId: 's1', sourceRevision: 'r1',
  });
  const pipeline = createQualityPipeline(); // 全部默认 = 都不接
  const t = await pipeline.evaluate(item, { source });

  assert.equal(t.answerability.verdict, ANSWERABILITY_VERDICTS.undecided);
  assert.equal(t.judge.verdict, GROUNDED_VERDICTS.uncertain);
  assert.equal(t.admitted, false);
  assert.equal(t.needsHuman, true);
  assert.match(t.answerability.detail, /没有接入可回答性判官/);
  assert.match(t.judge.rationale, /没有接入 grounded 裁判/);
});

test('③ 「检查不适用」算 pass 并写明不适用（不是 undecided）', () => {
  // 短答题没有挖空这个维度 → blankMarker / blankCount 应判 pass 且写「不适用」。
  const shortAnswer = clozeItem({
    type: QUIZ_TYPES.shortAnswer,
    stem: '牛顿第二定律里的「质量」指的是什么？',
    answer: '物体的惯性质量',
  });
  const report = runHardChecks(shortAnswer, { source: null });
  for (const id of [QUIZ_CHECK_IDS.blankMarker, QUIZ_CHECK_IDS.blankCount, QUIZ_CHECK_IDS.forbiddenTargetTerm]) {
    const c = byId(report, id);
    assert.equal(v(c), 'pass', `${id.code} 对短答应不适用`);
    assert.match(c.detail, /不适用/);
  }
});

test('③ 警告层 fail 只标记，不拦采纳、不占人工队列', () => {
  const item = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '下列哪个是惯性质量？',
    answer: 'A',
    choices: [
      makeOption({ label: 'A', text: '惯性质量' }),
      makeOption({ label: 'B', text: '引力质量' }),
      makeOption({ label: 'C', text: '电荷量' }),
    ],
  });
  const report = runHardChecks(item, { source: null });
  const warn = byId(report, QUIZ_CHECK_IDS.answerNotInStem);
  assert.equal(warn.severity, QUIZ_SEVERITIES.warn);
  // 硬项里的 undecided 仍然要求人工，但**警告层不额外加人工负担**。
  assert.ok(report.warnFlags.every((c) => c.severity === QUIZ_SEVERITIES.warn));
  assert.equal(report.hardUndecided.every((c) => c.severity === QUIZ_SEVERITIES.hard), true);
});

// ═══════════════════════════════════════════════════════════════
// ④ 锚点等式 materialIdWith
// ═══════════════════════════════════════════════════════════════

test('④ 锚点等式：materialIdWith 与源块 materialId 同式', () => {
  const item = clozeItem({ sectionId: 's1', blockIndex: 3 });
  assert.equal(item.materialIdWith({ sourceRevision: 'rev1' }), 's1#b3@rev1');
  assert.equal(materialIdOf('s1', 3, 'rev1'), 's1#b3@rev1');

  const source = makeSourceBlock({
    blockId: 'b3', blockIndex: 3, page: 1, atSec: 0, groundingText: 'x',
    sectionId: 's1', sourceRevision: 'rev1',
  });
  assert.equal(source.materialId, 's1#b3@rev1');
});

test('④ materialIdWith 对不上 → anchorBacklink 判 fail', () => {
  const item = clozeItem({ sectionId: 's1', blockIndex: 3, page: 4, atSec: 30 });
  // 源块标的是**另一节**：块 / 页 / 秒都对得上，唯独材料 id 的节不同 → 必须 fail。
  const wrongSection = makeSourceBlock({
    blockId: 'b3', blockIndex: 3, page: 4, atSec: 30,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    sectionId: 'OTHER', sourceRevision: 'rev1',
  });
  const report = runHardChecks(item, { source: wrongSection });
  const anchor = byId(report, QUIZ_CHECK_IDS.anchorBacklink);
  assert.equal(v(anchor), 'fail');
  assert.match(anchor.detail, /材料 id 不一致/);
  assert.ok(report.failedIds.includes('anchorBacklink'));
});

test('④ 块号 / 页号 / 秒数不一致各自判 fail', () => {
  const item = clozeItem({ blockIndex: 3, page: 4, atSec: 30 });
  const cases = [
    [{ blockIndex: 9, page: 4, atSec: 30 }, /块号不一致/],
    [{ blockIndex: 3, page: 9, atSec: 30 }, /页号不一致/],
    [{ blockIndex: 3, page: 4, atSec: 99 }, /时间戳不一致/],
  ];
  for (const [patch, pattern] of cases) {
    const source = makeSourceBlock({
      blockId: 'b', groundingText: '正文', sectionId: 's1', sourceRevision: 'r1', ...patch,
    });
    const c = byId(runHardChecks(item, { source }), QUIZ_CHECK_IDS.anchorBacklink);
    assert.equal(v(c), 'fail', `${pattern} 应判 fail`);
    assert.match(c.detail, pattern);
  }
});

test('④ 源块缺 sourceRevision → anchorBacklink 是 undecided（不是 pass）', () => {
  const item = clozeItem({ sectionId: 's1', blockIndex: 0 });
  const source = makeSourceBlock({
    blockId: 'b0', blockIndex: 0, page: 1, atSec: 0,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    sectionId: 's1', sourceRevision: null,
  });
  const c = byId(runHardChecks(item, { source }), QUIZ_CHECK_IDS.anchorBacklink);
  assert.equal(v(c), 'undecided');
  assert.match(c.detail, /缺少 sourceRevision/);
});

test('④ 模型自报的锚点一律不采用（只用材料的）', () => {
  const m = block(2);
  const anchor = anchorFromMaterial(m, { page: 99, atSec: 999, blockIndex: 77 });
  assert.equal(anchor.page, m.page);
  assert.equal(anchor.atSec, m.atSec);
  assert.equal(anchor.blockIndex, m.blockIndex);
  assert.ok(anchor.warning !== null, '不一致要留警告，不许静默覆盖');
  assert.match(anchor.warning, /模型自报页号 99/);

  // 一致的锚点 → 不留警告（否则每道题都挂一条噪声）。
  const clean = anchorFromMaterial(m, { page: m.page, atSec: m.atSec, blockIndex: m.blockIndex });
  assert.equal(clean.warning, null);
});

test('④ answerContent：标签式答案回落到选项文本（否则是假失败）', () => {
  const mcq = makeItem({
    id: 'm1', courseId: 'c', sectionId: 's', blockIndex: 0, page: 1, atSec: 0,
    type: QUIZ_TYPES.mcq, stem: '哪个是惯性质量？', answer: 'B',
    choices: [makeOption({ label: 'A', text: '惯性质量' }), makeOption({ label: 'B', text: '引力质量' })],
    createdAt: '2026-10-07T00:00:00.000Z',
  });
  assert.equal(mcq.answerContent(), '引力质量');
  assert.deepEqual(mcq.correctOptionCandidates(), ['B']);
  assert.equal(mcq.correctOptionLabel(), 'B');
});

test('④ 多标签答案（A、C）命中多个 → 不是唯一正解', () => {
  const mcq = makeItem({
    id: 'm2', courseId: 'c', sectionId: 's', blockIndex: 0, page: 1, atSec: 0,
    type: QUIZ_TYPES.mcq, stem: '选两个', answer: 'A、C',
    choices: [makeOption({ label: 'A', text: '甲' }), makeOption({ label: 'B', text: '乙' }), makeOption({ label: 'C', text: '丙' })],
    createdAt: '2026-10-07T00:00:00.000Z',
  });
  assert.deepEqual(mcq.correctOptionCandidates(), ['A', 'C']);
  assert.equal(mcq.correctOptionLabel(), null);
  const c = byId(runHardChecks(mcq, { source: null }), QUIZ_CHECK_IDS.singleCorrectAnswer);
  assert.equal(v(c), 'fail');
});

// ═══════════════════════════════════════════════════════════════
// ⑤ 先筛后出
// ═══════════════════════════════════════════════════════════════

test('⑤ wholeSection 这类选择被**拒绝**（整节一把丢走不通）', () => {
  const req = makeGenerationRequest({
    blocks: [block(0, { selection: QUIZ_MATERIAL_SELECTIONS.wholeSection })],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 10 },
  });
  const plan = planQuizGeneration(req);

  assert.equal(plan.allowed, false);
  assert.ok(plan.refusals.some((r) => r.startsWith('wholeSection：')));
  assert.match(plan.message, /这次请求被拒绝/);
  // ⚠️ 与 Dart 一致：`selected` 仍然算出来（它描述「材料本身可用吗」），
  //    「不许出题」这件事由 `allowed === false` 表达，而不是靠清空 selected。
  assert.equal(plan.selected.length, 1, 'selected 描述材料可用性，与 allowed 是两件事');
});

test('⑤ 其余「先筛后出」的拦截各有名字', () => {
  const cases = [
    [{ blocks: [] }, 'noMaterials'],
    [{ blocks: [block(0), block(1), block(2), block(3), block(4), block(5), block(6)] }, 'tooManyMaterials'],
    [{ blocks: [block(0), block(0)] }, 'duplicateBlock'],
    [{ blocks: [block(0)], context: { types: [] } }, 'noTypes'],
    [{ blocks: [block(0)], context: { types: kPhase4QuizTypes } }, 'unsupportedType'],
    [{ blocks: [block(0), block(1)], context: { focusBlockIndex: 0 } }, 'focusWithExtraMaterials'],
    [{ blocks: [block(0)], context: { focusBlockIndex: 5 } }, 'focusNotSelected'],
    [{ blocks: [block(0)], context: { types: kPhase4QuizTypes, allowedTypes: kPhase4QuizTypes } }, 'notEnoughCaseMaterials'],
  ];
  for (const [input, name] of cases) {
    const plan = planQuizGeneration(makeGenerationRequest(input));
    assert.equal(plan.allowed, false, `${name} 应当被拒绝`);
    assert.ok(plan.refusals.some((r) => r.startsWith(`${name}：`)),
      `${name} 的拒绝项要有名字，实际：${plan.refusals.join(' | ')}`);
  }
});

test('⑤ 空材料**单独列出来**（不许静默少发）', () => {
  const plan = planQuizGeneration(makeGenerationRequest({
    blocks: [block(0), block(1, { summary: '   ', text: '' })],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 2 },
  }));
  assert.equal(plan.allowed, true, '有一块可用就该继续');
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].reason, /emptyMaterial：块 1/);
});

test('⑤ summary 优先于原始 ASR，且痕迹可查', () => {
  const withSummary = block(0);
  assert.equal(withSummary.materialSource(), 'summary');
  assert.match(withSummary.materialText(), /摘要/);

  const raw = block(0, { summary: null, text: '  原始 ASR 文本  ' });
  assert.equal(raw.materialSource(), 'rawText');
  assert.equal(raw.materialText(), '原始 ASR 文本');
  assert.equal(raw.isEmpty(), false);
});

test('⑤ generate 对 wholeSection 请求**不发任何模型调用**', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({
    blocks: [block(0, { selection: QUIZ_MATERIAL_SELECTIONS.wholeSection })],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 5 },
  });

  assert.equal(llm.calls.length, 0, '被拒的请求一分钱模型预算都不许花');
  assert.equal(out.calls.length, 0);
  assert.ok(out.problems.some((p) => /wholeSection/.test(p)));
  assert.equal(out.admitted.length, 0);
});

test('⑤ 未实现的题型在**任何模型调用之前**被拒绝（不先花一次 rewrite 的钱）', async () => {
  // ⚠️ 这条是本包**与 App 的一处刻意差异**：App 侧选择题 / 案例题属于第 4 期，
  //    本包只实现到第 3 期（填空 / 短答）的构造路径。
  //    它们的**形状与质检**都已实现（见 ④ / ② 的用例），缺的是**构造那一步**。
  //
  //    关键是：拒绝必须发生在**计划层**。若放到逐块循环里报，第一块已经发过一次
  //    `rewrite` —— 而这次请求必然一道题都出不来，那一笔就是纯白花。
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const pool = [block(1), block(2), block(3)];
  const out = await gen.generate({
    blocks: [block(0)],
    context: {
      courseId: 'c1', sectionId: 's1', pageCount: 2,
      types: kPhase4QuizTypes, allowedTypes: kPhase4QuizTypes, distractorPool: pool,
    },
  });

  assert.equal(llm.calls.length, 0, '未实现的题型不许先花一次 rewrite');
  assert.deepEqual(out.calls, []);
  assert.equal(out.admitted.length, 0);
  assert.ok(out.problems.some((p) => /typeNotImplementedInJs/.test(p)), '拒绝要有名字');
  assert.ok(out.problems.some((p) => /不产出一道构造不完整的题/.test(p)));
});

test('⑤ 只请求 mcq 时同样在计划层拒绝（四种题型都试一遍）', async () => {
  for (const type of [QUIZ_TYPES.mcq, QUIZ_TYPES.caseStudy]) {
    const llm = fakeLlm(happyScript());
    const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
    const out = await gen.generate({
      blocks: [block(0)],
      context: { courseId: 'c1', sectionId: 's1', pageCount: 2, types: [type], allowedTypes: [type] },
    });
    assert.equal(llm.calls.length, 0, `${type.code} 不许花模型钱`);
    assert.ok(out.problems.some((p) => /typeNotImplementedInJs/.test(p)), `${type.code} 要有名字`);
  }
});

test('⑤ 已实现的题型不会被这条拒绝误伤（正向对照）', async () => {
  for (const type of kPhase3QuizTypes) {
    const llm = fakeLlm(happyScript());
    const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
    const out = await gen.generate({
      blocks: [block(0)],
      context: { courseId: 'c1', sectionId: 's1', pageCount: 1, types: [type], allowedTypes: [type] },
    });
    assert.equal(out.problems.some((p) => /typeNotImplementedInJs/.test(p)), false, `${type.code} 该被放行`);
    assert.deepEqual(out.calls, ['rewrite', 'generate'], `${type.code} 要走完整的两次调用`);
  }
});

test('⑤ 干扰项池排除本批材料与空材料', () => {
  const plan = planQuizGeneration(makeGenerationRequest({
    blocks: [block(0)],
    context: {
      courseId: 'c1', sectionId: 's1', pageCount: 2,
      distractorPool: [block(0), block(1), block(2, { summary: '', text: '' })],
    },
  }));
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.distractorCandidates.map((c) => c.material.blockIndex), [1]);
  assert.equal(plan.distractorCandidates[0].index, 0, '下标是模型唯一能引用的东西，必须稳定');
});

// ═══════════════════════════════════════════════════════════════
// ⑥ 每块两次调用且次序 Rewrite → 出题
// ═══════════════════════════════════════════════════════════════

test('⑥ 每块两次调用，次序固定 rewrite → generate', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({
    blocks: [block(0)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1, types: [QUIZ_TYPES.cloze] },
  });

  assert.deepEqual(out.calls, ['rewrite', 'generate'], '次序要能从 calls 里看出来');
  assert.deepEqual(llm.stages, ['quiz-rewrite', 'quiz-cloze']);

  // 第二段拿到的是**陈述句**，不是原始 ASR。
  const first = JSON.parse(llm.calls[0].variable);
  const second = JSON.parse(llm.calls[1].variable);
  assert.equal(first.step, 'rewrite');
  assert.match(first.material, /摘要/);
  assert.equal(second.step, 'cloze');
  assert.deepEqual(second.statements, ['牛顿第二定律说明合力等于质量乘以加速度。']);
  assert.equal('material' in second, false, '第二段不许再喂原始材料');
  assert.equal(llm.calls[0].constant, kRewriteSystemPrompt);
  assert.equal(llm.calls[1].constant, kClozeSystemPrompt);
});

test('⑥ 两块材料 → 四次调用，且每块的次序都是 rewrite → generate', async () => {
  const llm = fakeLlm({
    'quiz-rewrite': '{"statements":["陈述。"]}',
    'quiz-cloze': JSON.stringify([{ stem: '{{甲}}与乙。', answer: '甲', blockIndex: 0 }]),
  });
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({
    blocks: [block(0), block(1)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1, types: [QUIZ_TYPES.cloze] },
    maxCards: 2,
  });

  assert.deepEqual(out.calls, ['rewrite', 'generate', 'rewrite', 'generate']);
  // 每块的 rewrite 请求里的 blockIndex 必须轮到它自己。
  assert.deepEqual(llm.calls.filter((c) => c.stage === 'quiz-rewrite').map((c) => JSON.parse(c.variable).blockIndex), [0, 1]);
});

test('⑥ 改写失败 → 明确报名字，且**不许**跳过它直接出题', async () => {
  const llm = fakeLlm({ 'quiz-rewrite': new Error('网络抖动'), 'quiz-cloze': '[]' });
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({
    blocks: [block(0)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1, types: [QUIZ_TYPES.cloze] },
  });

  assert.ok(out.problems.some((p) => /改写.*失败/.test(p) && /名字：rewrite/.test(p)));
  assert.deepEqual(out.calls, ['rewrite'], '改写失败就不许发出题那一次');
  assert.equal(out.admitted.length, 0);
  assert.equal(out.ok, false);
});

test('⑥ rewrite 响应坏掉时不静默当「这一段没知识点」', async () => {
  const llm = fakeLlm({ 'quiz-rewrite': '这不是 JSON' });
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const out = await gen.generate({
    blocks: [block(0)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1 },
  });
  assert.ok(out.problems.some((p) => /不是合法 JSON/.test(p)));
  assert.equal(out.problems.some((p) => /没有知识点/.test(p)), false, '不许把解析失败说成「没有知识点」');
});

test('⑥ statements 为空 → 抛解析错误（而不是产出空题）', () => {
  assert.throws(() => parseRewriteResponse('{"statements":[]}'), (e) => e.name === 'QuizParseError' && e.code === 'PARSE');
  assert.throws(() => parseRewriteResponse('{"other":1}'), (e) => e.name === 'QuizParseError');
  assert.deepEqual(parseRewriteResponse('```json\n{"statements":[" 甲 ",""]}\n```'), ['甲'], '剥围栏 + 去空 + 去空白');
});

test('⑥ 出题响应容错：围栏与 {"items":[…]} 包装都认，非数组要抛', () => {
  const rows = parseGenerationResponse('```json\n[{"stem":"a"}]\n```', { where: 'cloze' });
  assert.deepEqual(rows, [{ stem: 'a' }]);
  const wrapped = parseGenerationResponse('{"items":[{"stem":"b"}]}', { where: 'cloze' });
  assert.deepEqual(wrapped, [{ stem: 'b' }]);
  assert.throws(() => parseGenerationResponse('{"nope":1}', { where: 'cloze' }), (e) => e instanceof QuizError);
});

test('⑥ 题型顺序按成本序：填空先于短答（额度不够时被截掉的是贵的那档）', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  // 只要 1 张：填空题应该拿到这个名额，短答一次都不该发。
  await gen.generate({
    blocks: [block(0)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1, types: kPhase3QuizTypes },
    maxCards: 1,
  });
  assert.deepEqual(llm.stages, ['quiz-rewrite', 'quiz-cloze'], '便宜的那档先烧额度');
});

test('⑥ 额度不够时**在任何模型调用之前**拒绝', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  const rate = makeRateLedger();
  rate.consume({ courseId: 'c1', sectionId: 's1', count: 20, now: FIXED() }); // 今日额度用满

  const out = await gen.generate({
    blocks: [block(0)],
    context: { courseId: 'c1', sectionId: 's1', pageCount: 1 },
    rate,
  });
  assert.equal(llm.calls.length, 0, '额度不够不许花模型预算');
  assert.equal(out.rate.allowed, false);
  assert.match(out.rate.message, /不会静默少出几张/);
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 取消
// ═══════════════════════════════════════════════════════════════

test('⑦ 取消让 generate 抛 CANCELLED（不降级成「没出题」）', async () => {
  const controller = new AbortController();
  const llm = {
    async call() { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  };
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });

  await assert.rejects(
    () => gen.generate({ blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 }, signal: controller.signal }),
    (e) => e instanceof QuizError && e.code === 'CANCELLED',
  );
});

test('⑦ 进 generate 之前就已取消 → 也抛 CANCELLED，且一次调用都不发', async () => {
  const controller = new AbortController();
  controller.abort('用户点了停止');
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });

  await assert.rejects(
    () => gen.generate({ blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 }, signal: controller.signal }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(llm.calls.length, 0);
});

test('⑦ dispose 之后再用抛 DISPOSED；再 dispose 不炸', async () => {
  const llm = fakeLlm(happyScript());
  const gen = createQuizGenerator({ llm, now: FIXED, pipeline: createQualityPipeline() });
  assert.equal(gen.closed, false);
  gen.dispose();
  gen.dispose();
  assert.equal(gen.closed, true);
  await assert.rejects(
    () => gen.generate({ blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 } }),
    (e) => e.code === 'DISPOSED',
  );
});

test('⑦ 没注入 llm 时**报配置错**，而不是「生成了 0 题」', () => {
  assert.throws(() => createQuizGenerator({}), (e) => e.code === 'CONFIG' && /窄 llm 接口/.test(e.message));
  assert.throws(() => createQuizGenerator({ llm: { call() {} }, concurrency: 99 }), (e) => e.code === 'CONFIG');
  // active 可读：并发上限这件事要能用代码判。
  const gen = createQuizGenerator({ llm: fakeLlm(), now: FIXED, concurrency: 4 });
  assert.equal(gen.concurrency, 4);
  assert.equal(gen.active, 0);
});

test('⑦ 取消时并发闸不留下占位的名额（否则一次取消永久堵死）', async () => {
  const gen = createQuizGenerator({ llm: fakeLlm(happyScript()), now: FIXED, concurrency: 2 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => gen.generate({
    blocks: [block(0)], context: { courseId: 'c1', sectionId: 's1', pageCount: 1 }, signal: controller.signal,
  }), (e) => e.code === 'CANCELLED');
  assert.equal(gen.active, 0, '取消之后名额必须归零');
});

// ═══════════════════════════════════════════════════════════════
// ⑧ 源码扫描：本包不落盘、不读环境变量
// ═══════════════════════════════════════════════════════════════

/**
 * 剥掉注释，只留**代码**。
 *
 * ⚠️ 这一步是必须的，而且它本身就是一条纪律：
 * 本包的注释里**故意**写着「这里不 import node:fs」「持久化由集成层的 ctx.storage
 * 负责」「不走 tmp+rename」—— 那些是**说明为什么不这么做**的取舍记录。
 * 对整份文件做关键词扫描会把这类注释误判成违规，于是为了过测试就得**删掉理由**。
 * 那正好把最有价值的注释换成了最没价值的门禁 —— 所以扫描只针对代码。
 *
 * 只处理块注释与行内注释；本包源码里没有字符串里含 `//` 或 `/*` 的情形
 * （`kLectureQuizBasisPrefix` 之类不含斜杠），所以这个剥离是安全的。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('⑧ 本包源码不出现 node:fs / ctx.storage / process.env', () => {
  const files = readdirSync(PKG).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 6, `源码文件数不对：${files.join(', ')}`);

  const forbidden = [
    [/node:fs/, 'node:fs（本包不落盘）'],
    [/require\(\s*['"]fs['"]\s*\)/, "require('fs')"],
    [/\bctx\.storage\b/, 'ctx.storage（持久化由集成层做）'],
    [/\bprocess\.env\b/, 'process.env（本包不读环境变量）'],
    [/writeFileSync|writeFile\(|createWriteStream|readFileSync|readFile\(/, '文件读写 API'],
    [/renameSync|\btmp\b[^\n]*\brename\b/, 'tmp+rename 原子写（裸原子写走 @deepseek-ai/dsh-atomic-write，且本包不用）'],
    [/@deepseek-ai\//, '任何 @deepseek-ai/* 依赖（宿主能力由集成层接线）'],
  ];

  for (const file of files) {
    const code = stripComments(readFileSync(join(PKG, file), 'utf8'));
    for (const [pattern, why] of forbidden) {
      assert.equal(pattern.test(code), false, `${file} 的**代码**里出现了 ${why}`);
    }
  }

  // 反向对照：剥离函数本身要真的在剥 —— 否则上面那圈断言可能因为「什么都匹配不到」而假绿。
  assert.equal(stripComments('const a = 1; // node:fs\n').includes('node:fs'), false);
  assert.equal(stripComments('/* ctx.storage */ const a = 1;').includes('ctx.storage'), false);
  assert.equal(stripComments('const a = "keep";').includes('keep'), true);
  // 而且**注释里确实说了**这些词（证明这些注释是刻意留的，不是漏网）。
  const indexSrc = readFileSync(join(PKG, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('ctx.storage') || indexSrc.includes('宿主的存储服务'),
    'index.js 的注释应当说明「持久化不在这里做」的取舍');
});

test('⑧ 「进队列」的写点在**源码层**只有两处（用户动作 + 讲义自审）', () => {
  // 这条是「默认不入库」的**结构**保证，比逐个用例更硬：
  // 光测「saveGenerated 写不进 accepted」是测一个**行为**；
  // 扫源码是测**没有别的路径** —— 将来有人加一个批量采纳函数，这条会红。
  const code = stripComments(readFileSync(join(PKG, 'store.js'), 'utf8'));
  const sites = [...code.matchAll(/status:\s*QUIZ_STATUSES\.accepted/g)].map((m) => m.index);
  assert.equal(sites.length, 2,
    `只有两处能把题写成 accepted（saveSelfAudited 与 adopt），实际 ${sites.length} 处`);

  // 这两处必须在**具名方法**里，且写清楚各自的准入判据。
  const before = (idx) => code.slice(Math.max(0, idx - 900), idx);
  assert.match(before(sites[0]), /saveSelfAudited/, '第一处应在 saveSelfAudited 里');
  assert.match(before(sites[1]), /adopt/, '第二处应在 adopt 里');

  // saveGenerated 里**只能**写回 proposed（连 accepted 这个词都不该出现在它的函数体里）。
  const saveGen = /saveGenerated\(generated\)\s*\{[\s\S]*?\n    \},/.exec(code);
  assert.ok(saveGen, '要能定位 saveGenerated 的函数体');
  assert.match(saveGen[0], /QUIZ_STATUSES\.proposed/);
  assert.equal(/QUIZ_STATUSES\.accepted/.test(saveGen[0]), false,
    'saveGenerated 的函数体里不许出现 accepted');

  // 而 model.js 里 proposed 必须是**默认值**（漏传 status 时落到待审，不是已采纳）。
  const modelCode = stripComments(readFileSync(join(PKG, 'model.js'), 'utf8'));
  assert.match(modelCode, /status\s*=\s*QUIZ_STATUSES\.proposed/, 'proposed 必须是默认值');
  assert.equal(/status\s*=\s*QUIZ_STATUSES\.accepted/.test(modelCode), false,
    'model.js 里不许有任何「默认 accepted」的签名');
});

test('⑧ 本包源码不引入任何外部依赖（零依赖）', () => {
  const files = readdirSync(PKG).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(join(PKG, file), 'utf8');
    for (const m of text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      assert.ok(spec.startsWith('./'), `${file} 引入了外部依赖 ${spec}（本包零依赖）`);
    }
  }
});

test('⑧ 本包不 import 任何兄弟包（零宿主依赖，可单独发布）', () => {
  const files = readdirSync(PKG).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(join(PKG, file), 'utf8');
    // 只看 **import 语句**：注释里提别的包的名字是**说明取舍**（"为什么不复用"），
    // 那不是依赖。真正的依赖只出现在 import 说明符里。
    for (const m of text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('./'), `${file} import 了兄弟包 / 外部包：${m[1]}`);
    }
    assert.equal(/^\s*import\s+['"][^'"]*dsh-zhiyun-(?!quiz)/m.test(text), false, `${file} 有副作用式 import 兄弟包`);
  }
});

test('⑧ package.json 的 exports 覆盖全部算法层入口', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  for (const key of ['.', './model', './generate', './quality', './dedupe', './lecture', './store']) {
    assert.ok(pkg.exports[key], `exports 缺少 ${key}`);
  }
  assert.equal(pkg.dependencies, undefined, '本包不引入任何依赖');
});

// ═══════════════════════════════════════════════════════════════
// 去重
// ═══════════════════════════════════════════════════════════════

test('去重：题干规范化后完全相同 → 本地丢掉，且有 note', () => {
  const stemOf = (q) => q.stem;
  const res = dropExactQuizDuplicates({
    existing: [{ stem: '牛顿 第二定律' }],
    fresh: [{ stem: '牛顿第二定律' }, { stem: '动量守恒' }],
    stemOf,
  });
  assert.equal(res.kept.length, 1);
  assert.equal(res.kept[0].stem, '动量守恒');
  assert.equal(res.notes.length, 1);
  assert.match(res.notes[0], /题干和已有题一样/);
});

test('去重：空题干不许静默丢（也要有名字）', () => {
  const res = dropExactQuizDuplicates({ existing: [], fresh: [{ stem: '   ' }], stemOf: (q) => q.stem });
  assert.equal(res.kept.length, 0);
  assert.match(res.notes[0], /没有题干/);
});

test('去重：本批内部也要互相比（否则同一批里出现两道一样的）', () => {
  const res = dropExactQuizDuplicates({
    existing: [], fresh: [{ stem: 'A' }, { stem: 'A' }], stemOf: (q) => q.stem,
  });
  assert.equal(res.kept.length, 1);
  assert.match(res.notes[0], /题干和已有题一样/);
});

test('去重：quizStemKey 只做确定等价（去空白 + 忽略大小写），不做同义', () => {
  assert.equal(quizStemKey('Newton  Law'), quizStemKey('newtonlaw'));
  assert.notEqual(quizStemKey('牛顿第二定律'), quizStemKey('牛顿运动定律'));
});

test('去重：模型下标解析越界忽略；解析失败时**一道都不丢**', () => {
  const ok = parseQuizDedupeIndexes('{"duplicateIndexes":[0,2,99,-1,"1"]}', 3);
  assert.deepEqual([...ok.indexes].sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(ok.problem, null);

  const bad = parseQuizDedupeIndexes('不是 JSON', 3);
  assert.equal(bad.indexes.size, 0);
  assert.equal(bad.problem, '去重结果不是 JSON');

  const fresh = [{ stem: 'A' }, { stem: 'B' }];
  const merged = dedupeQuizBatch({ existing: [], fresh, stemOf: (q) => q.stem, semanticIndexes: bad });
  assert.equal(merged.kept.length, 2, '解析失败 ≠ 没有重复，不许借此丢题');
  assert.equal(merged.problem, '去重结果不是 JSON');
});

test('去重：已经有题时只送最近 kQuizDedupeMaxExisting 道，且**写明截断**', () => {
  const existing = Array.from({ length: kQuizDedupeMaxExisting + 5 }, (_, i) => `旧题${i}`);
  const text = quizDedupeInput({ existing, fresh: ['新题'] });
  assert.match(text, /更早的 5 道没有列在这里/);
  assert.equal(text.includes('旧题0\n'), false, '最早的那些不该出现');
  assert.match(text, new RegExp(`旧题${kQuizDedupeMaxExisting + 4}`), '最近的那道要在');
});

// ═══════════════════════════════════════════════════════════════
// 数值等价（硬检查的地基）
// ═══════════════════════════════════════════════════════════════

test('数值等价：1/2 = 0.5 = 50%，但 1/3 ≠ 0.333（那是舍入，不是等价）', () => {
  const eq = (a, b) => numericValuesEquivalent(parseNumericValue(a), parseNumericValue(b));
  assert.equal(eq('1/2', '0.5'), true);
  assert.equal(eq('0.5', '50%'), true);
  assert.equal(eq('.5', '1/2'), true);
  assert.equal(eq('1,000', '1000'), true);
  assert.equal(eq('1_000', '1000'), true);
  assert.equal(eq('3.5e3', '3500'), true);
  assert.equal(eq('3e3', '3000'), true);
  assert.equal(eq('1/3', '0.333'), false, '无限小数不是同一个值（精确比较，不走浮点）');
  assert.equal(eq('50 N', '50 J'), false, '同值不同量纲是两道题');
  assert.equal(eq('50', '50 N'), true, '一边没单位时按数值算');
  assert.equal(eq('−3', '-3'), true, 'U+2212 减号要认（教材里常见）');
});

test('数值等价：`3.5×10^3` 这类写法**解析不出来**（Dart 同样解析不出来）', () => {
  // ⚠️ 这条是**如实钉住一个 Dart 侧文档与实现不符的地方**：
  //    `quiz_quality.dart` 的 `parseNumericValue` 文档说认 `3.5×10^3`，
  //    但实现先把 `×10` 替换成 `e`（得到 `3.5e^3`），而科学计数正则不接受 `^`
  //    → 返回 `null`。本包**照抄实现的判据**，不照抄文档的承诺。
  //    （落进 `uncovered` 而不是被猜成 3500 —— 那正是「不许假装准确」。）
  assert.equal(parseNumericValue('3.5×10^3'), null);
  assert.equal(parseNumericValue('3.5e3').value, 3500, '标准科学计数要认');
});

test('数值等价：0.5 与 5 **不许**被判成同一个（标号剥离的 (?!\\d)）', () => {
  assert.notEqual(normalizeOptionText('0.5'), normalizeOptionText('5'));
  assert.equal(normalizeOptionText('A. 势能函数'), normalizeOptionText('势能函数'));
  assert.equal(normalizeOptionText('1. 势能函数'), normalizeOptionText('势能函数'));
  assert.equal(normalizeOptionText('20 米'), normalizeOptionText('20米'));
  assert.equal(normalizeOptionText('熵。'), normalizeOptionText('熵'));
});

test('数值等价：无法精确解析但含数字 → 记进 uncovered（不假装比过）', () => {
  const item = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '选一个',
    answer: 'A',
    choices: [
      makeOption({ label: 'A', text: '1/3' }),
      makeOption({ label: 'B', text: '0.333' }),
      makeOption({ label: 'C', text: '约 1/3 左右' }),
    ],
  });
  const c = byId(runHardChecks(item, { source: null }), QUIZ_CHECK_IDS.numericEquivalence);
  // 「约 1/3 左右」含数字但解析不出来 → 必须**逐条**记进 uncovered。
  assert.ok(c.uncovered.some((u) => /约 1\/3 左右/.test(u)), `应进 uncovered：${c.uncovered}`);
  assert.equal(v(c), 'pass',
    'A=1/3 与 B=0.333 都精确可解析且**不相等**（1/3 是无限小数）→ 不是重复干扰项');
  // 「0.333」本身是**可精确解析**的（333/1000），所以它参与了比较，不进 uncovered。
  assert.equal(c.uncovered.some((u) => /^「0\.333」/.test(u)), false, '0.333 可精确解析，不该进 uncovered');
});

test('数值等价：答案与选项数值等价时**只算一个**命中（不是「无唯一正解」）', () => {
  const item = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '一半是多少？',
    answer: '1/2',
    choices: [
      makeOption({ label: 'A', text: '0.5' }),
      makeOption({ label: 'B', text: '0.25' }),
      makeOption({ label: 'C', text: '2' }),
    ],
  });
  const numeric = byId(runHardChecks(item, { source: null }), QUIZ_CHECK_IDS.numericEquivalence);
  assert.equal(v(numeric), 'pass', '答案 1/2 与选项 0.5 是同一个值，不是两个答案');

  // 而**两个**选项都与答案数值等价 → 那才是白送一个选项位。
  const two = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '一半是多少？',
    answer: '1/2',
    choices: [
      makeOption({ label: 'A', text: '0.5' }),
      makeOption({ label: 'B', text: '50%' }),
      makeOption({ label: 'C', text: '2' }),
    ],
  });
  const twoReport = runHardChecks(two, { source: null });
  assert.equal(v(byId(twoReport, QUIZ_CHECK_IDS.numericEquivalence)), 'fail');
  assert.equal(v(byId(twoReport, QUIZ_CHECK_IDS.duplicateOption)), 'pass',
    '「0.5」与「50%」文本不同 → 那一项不该报重复；报重复的是**数值**那一项');
});

test('数值等价：0.5 与 1/2 两个干扰项等价 → fail（白送一个选项位）', () => {
  const item = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '选一个',
    answer: 'A',
    choices: [
      makeOption({ label: 'A', text: '2' }),
      makeOption({ label: 'B', text: '0.5' }),
      makeOption({ label: 'C', text: '1/2' }),
    ],
  });
  const c = byId(runHardChecks(item, { source: null }), QUIZ_CHECK_IDS.numericEquivalence);
  assert.equal(v(c), 'fail');
  assert.match(c.detail, /干扰项 B 与 C 数值等价/);
});

test('数值等价：答案 1/2、选项写 0.5 → 唯一正解（不是「无解」）', () => {
  const item = clozeItem({
    type: QUIZ_TYPES.mcq,
    stem: '一半是多少？',
    answer: '1/2',
    choices: [
      makeOption({ label: 'A', text: '0.5' }),
      makeOption({ label: 'B', text: '0.25' }),
      makeOption({ label: 'C', text: '2' }),
    ],
  });
  assert.deepEqual(possibleCorrectLabels(item), ['A']);
  const c = byId(runHardChecks(item, { source: null }), QUIZ_CHECK_IDS.singleCorrectAnswer);
  assert.equal(v(c), 'pass', '数值命中要算命中，否则是假失败');
});

// ═══════════════════════════════════════════════════════════════
// 模式：填空 / 短答的规则差异
// ═══════════════════════════════════════════════════════════════

test('短答：答案短于 4 字不判泄题（避免「答案是熵」被误杀）', () => {
  const ok = applyShortAnswerRules({ stem: '「熵」是什么的量度？', answer: '熵', keywords: [], raw: '' }, { blockIndex: 0 });
  assert.equal(ok.rejection, null);

  const leak = applyShortAnswerRules(
    { stem: '请解释牛顿第二定律的完整表述', answer: '牛顿第二定律的完整表述', keywords: [], raw: '' },
    { blockIndex: 0 });
  assert.equal(leak.rejection.rule, 'answerInStem');
});

test('填空题：模板摘掉之后再查泄题（否则每道填空题都被判泄题）', () => {
  const ok = applyClozeRules(
    { stem: '合力等于{{质量}}乘以加速度。', answer: '质量', keywords: [], raw: '' }, { blockIndex: 0 });
  assert.equal(ok.rejection, null);
});

test('countBlanks：混用标记取**最大**不取和（同一处挖空换了写法）', () => {
  assert.equal(countBlanks('{{甲}} 与 ___ 的关系'), 1);
  assert.equal(countBlanks('{{甲}} 与 {{乙}} 的关系'), 2);
  assert.equal(countBlanks('没有挖空'), 0);
});

// ═══════════════════════════════════════════════════════════════
// grounded judge 的源码级约束
// ═══════════════════════════════════════════════════════════════

test('grounded judge：指令里出现通用评分口径 → 抛错（不是打日志）', () => {
  assert.throws(() => assertNoGenericRubric('请按以下标准打分：满分 100'), (e) => e.code === 'RUBRIC');
  assert.throws(() => assertNoGenericRubric('rubric: 5 = excellent'), (e) => e.code === 'RUBRIC');
  // 自己的 scaffold 必须干净。
  assertNoGenericRubric(kGroundedJudgeSystemPrompt);
});

test('grounded judge：提示词里**必须**能追到同源好 / 坏样例', () => {
  const item = clozeItem();
  const source = makeSourceBlock({
    blockId: 'b0', blockIndex: 0, page: 1, atSec: 0,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    goodExamples: ['好样例甲', '好样例乙'], badExamples: ['坏样例甲'],
    sectionId: 's1', sourceRevision: 'r1',
  });
  const req = buildGroundedJudgeRequest(item, source);
  const prompt = buildGroundedJudgePrompt(req);

  assert.ok(prompt.includes('G1. 好样例甲') && prompt.includes('G2. 好样例乙'));
  assert.ok(prompt.includes('B1. 坏样例甲'));
  assert.equal('rubric' in req, false, '请求里**没有** rubric 字段（结构上写不出通用标准）');
  assert.match(prompt, /不要引入外部标准/);
});

test('grounded judge：样例缺一侧时提示词写明「任何结论都应当回答 uncertain」', () => {
  const req = {
    passage: '材料', candidateStem: '题干', candidateAnswer: '答案', candidateChoices: [],
    goodExamples: ['只有好样例'], badExamples: [], traits: [],
  };
  assert.match(buildGroundedJudgePrompt(req), /样例只有一侧/);
});

test('可回答性：请求里**没有**「正确答案」字段（自证在结构上写不出来）', async () => {
  const seen = [];
  const checker = { async answerable(request) { seen.push(request); return { verdict: ANSWERABILITY_VERDICTS.answerable, detail: '' }; } };
  const item = clozeItem();
  const source = makeSourceBlock({
    blockId: 'b0', blockIndex: 0, page: 1, atSec: 0,
    groundingText: '牛顿第二定律说明合力等于质量乘以加速度。',
    sectionId: 's1', sourceRevision: 'r1',
  });
  await createQualityPipeline({ answerability: checker }).evaluate(item, { source });

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['passage', 'question']);
  assert.equal(seen[0].passage, '牛顿第二定律说明合力等于质量乘以加速度。');
});

test('可回答性判官抛错 → undecided（不是「可答」）', async () => {
  const pipeline = createQualityPipeline({
    answerability: { async answerable() { throw new Error('端点 500'); } },
  });
  const t = await pipeline.evaluate(clozeItem(), { source: null });
  assert.equal(t.answerable, false);
  assert.equal(t.needsHuman, true);
});

test('比例必须带样本量或区间；n=0 拒绝给数', () => {
  assert.equal(wilsonInterval(0, 0), null);
  assert.match(ratioWithWilson(0, 0), /没有样本/);
  assert.match(ratioWithWilson(1, 2), /样本太少/);
  assert.match(ratioWithWilson(50, 100), /95% 区间/);
});

// ═══════════════════════════════════════════════════════════════
// 干扰项可追溯性
// ═══════════════════════════════════════════════════════════════

test('干扰项可追溯性：包含关系与共享子串都算追到', () => {
  const m = block(1);
  const pool = [{ index: 0, material: m, text: m.materialText(), quote: m.materialText() }];

  const contained = distractorTraceability('合力等于质量乘以加速度', { pool, claimedBlockIndex: 1 });
  assert.equal(contained.traced, true);
  assert.match(contained.detail, /包含关系/);

  const shared = distractorTraceability('质量乘以加速度的另一种说法', { pool, claimedBlockIndex: 1 });
  assert.equal(shared.traced, true);
});

test('干扰项可追溯性：凭空造的干扰项追不到，且理由写清「不是意思不像」', () => {
  const m = block(1);
  const pool = [{ index: 0, material: m, text: m.materialText(), quote: m.materialText() }];
  const t = distractorTraceability('完全不相关的天文观测数据', { pool, claimedBlockIndex: 1 });
  assert.equal(t.traced, false);
  assert.match(t.detail, /找不到依据/);
  assert.match(t.detail, /不是\*\*「意思不像」/);
});

test('干扰项可追溯性：声称块 A 其实抄块 B → 判**不追到**（不许跨块放行）', () => {
  // ⚠️ 两块的材料必须**共享少于 2 个连续汉字**，否则「共享子串」那条判据
  //    会在错误的块上也成立，这条用例就测不到「只在声称块里找」。
  const a = makeSourceMaterial({ blockIndex: 1, page: 2, atSec: 10, summary: '力学：合力等于质量乘以加速度。' });
  const b = makeSourceMaterial({ blockIndex: 2, page: 3, atSec: 20, summary: '热学：温度是分子平均动能的量度。' });
  const pool = [
    { index: 0, material: a, text: a.materialText(), quote: a.materialText() },
    { index: 1, material: b, text: b.materialText(), quote: b.materialText() },
  ];
  const onlyInB = '温度是分子平均动能的量度';

  const t = distractorTraceability(onlyInB, { pool, claimedBlockIndex: 1 });
  assert.equal(t.traced, false, '只在声称的那一块里找');

  // 正向对照：同一段文本、声称来自块 2 → 追到。
  // 少了这条对照，上面那次失败就可能是因为「这段文本本来就追不到任何块」。
  const t2 = distractorTraceability(onlyInB, { pool, claimedBlockIndex: 2 });
  assert.equal(t2.traced, true);
  assert.equal(t2.claimedBlockIndex, 2);

  // 不给声称块时在全池里找 → 允许追到块 2（那才是「追回同域材料」的本意）。
  const t3 = distractorTraceability(onlyInB, { pool });
  assert.equal(t3.traced, true);
  assert.equal(t3.claimedBlockIndex, 2);
});

test('干扰项可追溯性：声明的块不在池里 → 不猜它来自哪', () => {
  const m = block(1);
  const pool = [{ index: 0, material: m, text: m.materialText(), quote: m.materialText() }];
  const t = distractorTraceability('任意文本', { pool, claimedBlockIndex: 7 });
  assert.equal(t.traced, false);
  assert.match(t.detail, /干扰项池里没有这一块/);
});

test('normalizeForTrace 与质检侧的 normalizeOptionText 同口径（两份不许漂开）', () => {
  const samples = ['A. 势能函数', '１．全角标号内容', '0.5', '20 米', '熵。', 'B)选项', '1、内容'];
  for (const s of samples) {
    // 两处的差异只在「尾部标点」的剥离顺序细节上，规范化的**结果**必须一致。
    assert.equal(normalizeForTrace(s), normalizeOptionText(s), `「${s}」两处口径不一致`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 讲义模式
// ═══════════════════════════════════════════════════════════════

test('讲义：块号 -1、依据前缀逐条写在 warnings 上、题型认不出返回 null', () => {
  const draft = {
    type: 'cloze',
    stem: '{{熵}}是混乱度的量度。',
    answer: '熵',
    pass: true,
    audit: '与老师讲法一致',
    evidence: [
      { kind: 'knowledge', quote: '熵是系统混乱程度的量度' },
      { kind: 'web', quote: '熵在信息论里表示不确定度' },
    ],
    choices: [],
  };
  const fields = lectureDraftToItemFields(draft);

  assert.equal(fields.blockIndex, kLectureQuizNoAnchorBlock);
  assert.equal(fields.blockIndex, -1);
  assert.equal(fields.type.code, 'cloze');
  assert.equal(fields.warnings.length, 3, '两条依据 + 一条自审说明');
  assert.ok(fields.warnings[0].startsWith(kLectureQuizBasisPrefix));
  assert.match(fields.warnings[0], /knowledge｜熵是系统混乱程度的量度/);

  // 认不出的题型 → null（调用方报出来并跳过，绝不退回默认值）。
  assert.equal(lectureDraftToItemFields({ ...draft, type: '外星题型' }).type, null);
});

test('讲义：依据核对四条判据各有名字', () => {
  const transcript = '熵是系统混乱程度的量度，这一点在统计力学里是中心结论。';
  const good = {
    stem: '熵是什么的量度？', answer: '混乱程度', pass: true, audit: '',
    evidence: [{ kind: 'knowledge', quote: '熵是系统混乱程度的量度' }], choices: [],
  };
  assert.deepEqual(admitLectureDrafts({ drafts: [good], toolTranscript: transcript }).admitted.length, 1);

  const cases = [
    [{ ...good, stem: '' }, /没有题干或答案/],
    [{ ...good, pass: false, audit: '拿不准' }, /自审没有通过：拿不准/],
    [{ ...good, evidence: [] }, /没有依据/],
    [{ ...good, evidence: [{ kind: '知识库', quote: '熵是系统混乱程度的量度' }] }, /不是 knowledge 或 web/],
    [{ ...good, evidence: [{ kind: 'knowledge', quote: '太短' }] }, /依据太短/],
    [{ ...good, evidence: [{ kind: 'knowledge', quote: '这句话回包里根本没有出现过' }] }, /依据不在工具回包里/],
  ];
  for (const [draft, pattern] of cases) {
    const res = admitLectureDrafts({ drafts: [draft], toolTranscript: transcript });
    assert.equal(res.admitted.length, 0, `${pattern} 应被挡下`);
    assert.match(res.dropped[0], pattern);
    assert.match(res.dropped[0], /^第 1 题/, '被挡下的原因要指得出是哪一题');
  }

  // 没有工具回包 → 依据一律对不上（不许「没有回包就算过」）。
  const noTranscript = admitLectureDrafts({ drafts: [good], toolTranscript: '' });
  assert.equal(noTranscript.admitted.length, 0);
  assert.match(noTranscript.dropped[0], /没有工具回包/);
});

test('讲义：正文超上限要写明截断（不假装后面也送了）', () => {
  const lecture = {
    title: '标题',
    chapters: [{ title: '第一章', topics: [{ title: '小节', passages: [{ text: 'A'.repeat(100) }] }] }],
  };
  assert.equal(lecturePlainText(lecture, { maxChars: 1000 }).includes('截断'), false);
  assert.match(lecturePlainText(lecture, { maxChars: 20 }), /讲义在这里截断了/);
  assert.equal(lecturePlainText({ chapters: [] }), '');
});

test('讲义：turn 解析只认白名单工具，且从后往前取最后一轮', () => {
  const bad = parseLectureQuizTurn('{"tool":"delete_everything","args":{"query":"x"}}');
  assert.match(bad.problem, /不在允许的名单里/);

  const noQuery = parseLectureQuizTurn('{"tool":"web_search","args":{}}');
  assert.match(noQuery.problem, /没有给 query/);

  const ok = parseLectureQuizTurn('{"tool":"search_course","args":{"query":"熵"}}');
  assert.equal(ok.tool.name, 'search_course');
  assert.equal(ok.problem, null);

  assert.match(parseLectureQuizTurn('没有 JSON').problem, /没有给出 JSON/);
  assert.match(parseLectureQuizTurn('{"x":1}').problem, /既没有 tool，也没有 questions/);
});

test('讲义：交题参数认中文别名（不让模型自己排 JSON）', () => {
  const drafts = lectureQuizDraftsFromArgs({
    questions: [
      { 题型: '填空题', 题干: '{{熵}}是什么的量度？', 答案: '混乱程度', 自审: '通过', 依据: 'knowledge｜熵是系统混乱程度的量度' },
      { type: '选择题', stem: '选一个', answer: 'A', pass: 'false', evidence: [], choices: ['A. 甲', 'B. 乙'] },
    ],
  });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].type, 'cloze');
  assert.equal(drafts[0].pass, true, '「通过」要认');
  assert.deepEqual(drafts[0].evidence, [{ kind: 'knowledge', quote: '熵是系统混乱程度的量度' }]);
  assert.equal(drafts[1].type, 'mcq');
  assert.equal(drafts[1].pass, false);
  assert.deepEqual(drafts[1].choices, [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }]);
});

// ═══════════════════════════════════════════════════════════════
// 数据层：作答 / 归因 / 额度
// ═══════════════════════════════════════════════════════════════

test('FSRS 隔离：AI 判对**不会**变成一次「我记得」', () => {
  const a = makeAttempt({
    id: 'a1', quizId: 'q1', courseId: 'c', sectionId: 's', blockIndex: 0,
    response: '质量', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct, selfRecall: null, at: '2026-10-07T00:00:00Z',
  });
  assert.equal(a.fsrsRating, null, '没有自评就拿不到可用的调度评分');
  assert.equal(a.autoMatchesSelfRecall, null);

  const b = makeAttempt({
    id: 'a2', quizId: 'q2', courseId: 'c', sectionId: 's', blockIndex: 0,
    response: '质量', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct, selfRecall: 'again', at: '2026-10-07T00:00:00Z',
  });
  assert.equal(b.fsrsRating, 'again', '只有自评能进调度');
  assert.equal(b.autoMatchesSelfRecall, false, '自评与自动判定可以不一致（且这件事看得见）');
});

test('「判不了」不许被当成「错了」', () => {
  const unknown = makeAttempt({
    id: 'a3', quizId: 'q', courseId: 'c', sectionId: 's', blockIndex: 0,
    response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.unknown, selfRecall: null, at: '2026-10-07T00:00:00Z',
  });
  assert.equal(unknown.countsAsWrong, false);
});

test('作答 JSON 往返；认不出的判定抛错（不许退回默认值）', () => {
  const a = makeAttempt({
    id: 'a4', quizId: 'q', courseId: 'c', sectionId: 's', blockIndex: 1,
    response: '答案', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.incorrect, selfRecall: 'hard', at: '2026-10-07T00:00:00Z',
  });
  const back = attemptFromJson(JSON.parse(JSON.stringify(attemptToJson(a))));
  assert.equal(back.id, 'a4');
  assert.equal(back.selfRecall, 'hard');

  assert.throws(() => attemptFromJson({ id: 'x', autoVerdict: 'maybe', at: '2026-10-07T00:00:00Z' }), (e) => e.code === 'DATA');
  assert.throws(() => attemptFromJson({ id: 'x', autoVerdict: 'correct', selfRecall: '完美', at: '2026-10-07T00:00:00Z' }), (e) => e.code === 'DATA');
  assert.throws(() => attemptFromJson({ autoVerdict: 'correct', at: '2026-10-07T00:00:00Z' }), (e) => e.code === 'DATA');
});

test('作答：题不存在且没给锚点 → 抛；给了锚点 → 能记（错题归因不能因此断掉）', () => {
  const store = createQuizStore({ now: FIXED });
  assert.throws(() => store.recordAttempt({
    quizId: 'ghost', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct,
  }), (e) => e.code === 'NOT_FOUND');

  const a = store.recordAttempt({
    quizId: 'ghost2', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct,
    courseId: 'c', sectionId: 's', blockIndex: 3,
  });
  assert.equal(a.courseId, 'c');
  assert.equal(a.blockIndex, 3);
});

test('错题归因：按知识点分别计数，且**带样本量**', () => {
  const store = createQuizStore({ now: FIXED });
  store.saveGenerated([clozeItem({ id: 'q1' }), clozeItem({ id: 'q2' }), clozeItem({ id: 'q3' })]);
  const pointIdsOf = (q) => (q.id === 'q1' ? ['pA', 'pB'] : ['pA']);

  store.recordAttempt({ quizId: 'q1', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.incorrect });
  store.recordAttempt({ quizId: 'q2', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct });
  store.recordAttempt({ quizId: 'q3', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.unknown });

  const attr = store.attributeByPoint(pointIdsOf, { nameOf: (p) => `知识点${p}` });
  assert.equal(attr.pA.attemptCount, 3, '题挂多个知识点时每个都要单独计数');
  assert.equal(attr.pA.wrongCount, 1, 'unknown 不算错');
  assert.equal(attr.pB.attemptCount, 1);
  assert.equal(attr.pB.wrongCount, 1);
  assert.equal(attr.pA.lastWrong.quizId, 'q1');
  assert.equal(attr.pA.pointName, '知识点pA');
});

test('薄弱点：可解释规则的四种说法，都带样本量，不给伪精确分数', () => {
  // ⚠️ 必须用**递进**的时钟：「近 3 次」是按作答时间排序后的最近 3 条，
  //    同一个时间戳会让排序不稳定，于是这条用例会随机地测到别的分支。
  const store = createQuizStore({ now: tickingClock() });
  const ids = ['q1', 'q2', 'q3', 'q4'];
  store.saveGenerated(ids.map((id) => clozeItem({ id })));
  const pointIdsOf = () => ['pA'];

  // 少于 3 题 → 数据不足
  store.recordAttempt({ quizId: 'q1', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.incorrect });
  let m = store.masteryOf('pA', { pointIdsOf });
  assert.equal(m.enoughData, false);
  assert.equal(m.rule, 'insufficientData');
  assert.match(m.masteryLabel, /数据不足/);
  assert.match(m.masteryLabel, /做过 1 题/, '「数据不足」也要带样本量');

  store.recordAttempt({ quizId: 'q2', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.incorrect });
  store.recordAttempt({ quizId: 'q3', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.incorrect });
  m = store.masteryOf('pA', { pointIdsOf });
  assert.equal(m.rule, 'lastThree');
  assert.match(m.masteryLabel, /近 3 次都错/);
  assert.match(m.masteryLabel, /共做过 3 题/, '说法必须带样本量');
  assert.equal(/\d+%/.test(m.masteryLabel), false, '不许报「掌握度 87%」这类伪精确');

  // 第 4 次答对：最近 3 次变成 [对, 错, 错] → 有对有错。
  store.recordAttempt({ quizId: 'q4', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct });
  const mixed = store.masteryOf('pA', { pointIdsOf });
  assert.deepEqual(mixed.recentWrong, [false, true, true, true], '新→旧，最多留 5 条（现在 4 条）');
  assert.equal(mixed.recentWrong[0], false, '最近一次是答对的');
  assert.match(mixed.masteryLabel, /有对有错/);

  // 再答对一次：最近 3 次 = [对, 对, 错] → 仍有对有错；继续答对到 3 连对。
  store.recordAttempt({ quizId: 'q2', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct });
  store.recordAttempt({ quizId: 'q3', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct });
  const allRight = store.masteryOf('pA', { pointIdsOf });
  assert.equal(allRight.recentWrong[0], false);
  assert.match(allRight.masteryLabel, /近 3 次都对/);
  assert.match(allRight.masteryLabel, /错 3 题/, '「都对」也要报总共错过几道（样本量的一部分）');
});

test('薄弱点：用户自评优先于自动判定（自评说「忘了」就是错）', () => {
  const store = createQuizStore({ now: tickingClock() });
  store.saveGenerated([clozeItem({ id: 'q1' }), clozeItem({ id: 'q2' }), clozeItem({ id: 'q3' })]);
  const pointIdsOf = () => ['pA'];

  // 三次都是「AI 说对，用户自评说忘了」→ 三次都算错。
  // FSRS 纪律：不能容忍「忘了却按 Hard / 却算对」—— 那会让所有间隔静默偏长。
  store.recordAttempt({
    quizId: 'q1', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct, selfRecall: 'again',
  });
  store.recordAttempt({
    quizId: 'q2', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct, selfRecall: 'again',
  });
  // 第三次只给自动判定（没有自评）→ 自动说对 → 不算错。
  store.recordAttempt({ quizId: 'q3', response: 'x', autoVerdict: QUIZ_AUTOGRADE_VERDICTS.correct });

  const m = store.masteryOf('pA', { pointIdsOf });
  assert.equal(m.attemptCount, 3);
  assert.equal(m.wrongCount, 2, '只有两次自评「忘了」算错；第三次没自评且自动判对');
  assert.deepEqual(m.recentWrong, [false, true, true], '新→旧');
  assert.equal(m.rule, 'lastThree');
  assert.match(m.masteryLabel, /有对有错/, '最近 3 次里有对有错');
});

test('额度台账：先问再发；不够时**说清要了多少、还剩多少**；按天 / 按节各自计', () => {
  const rate = makeRateLedger({ policy: { perDay: 5, perSection: 3 } });
  // ⚠️ 用**本地时间**：`rateDayKey` 是本地日，UTC 串在东八区会落到第二天。
  const today = localDate(2026, 10, 7);

  let d = rate.check({ courseId: 'c1', sectionId: 's1', requested: 3, now: today });
  assert.equal(d.allowed, true);
  assert.equal(d.remainingToday, 5);
  assert.equal(d.remainingSection, 3);
  assert.equal(d.remaining, 3);
  assert.match(d.message, /额度够/);

  rate.consume({ courseId: 'c1', sectionId: 's1', count: 3, now: today });
  d = rate.check({ courseId: 'c1', sectionId: 's1', requested: 3, now: today });
  assert.equal(d.allowed, false);
  assert.equal(d.remainingToday, 2);
  assert.equal(d.remainingSection, 0);
  assert.match(d.message, /要出 3 张/, '必须说清要了多少');
  assert.match(d.message, /本节只剩 0 张/, '必须说清还剩多少');
  assert.match(d.message, /不会静默少出几张/);

  // 换一节：**本节**的额度独立（但按天的额度是共享的）。
  const other = rate.check({ courseId: 'c1', sectionId: 's2', requested: 2, now: today });
  assert.equal(other.allowed, true);
  assert.equal(other.remainingSection, 3, '另一节有自己的本节额度');
  assert.equal(other.remainingToday, 2, '按天的额度是全课程共享的');

  // 换一天：**按天**那一格归零（而按节的计数**不**随天归零 —— 它是节级上限）。
  const tomorrow = localDate(2026, 10, 8);
  const nextDay = rate.check({ courseId: 'c1', sectionId: 's3', requested: 3, now: tomorrow });
  assert.equal(nextDay.remainingToday, 5, '新的一天，按天的额度归零');
  assert.equal(nextDay.allowed, true);
  // 同一天里对同一节再要 3 张：按天的额度只剩 2 → 拒绝。
  assert.equal(rate.check({ courseId: 'c1', sectionId: 's3', requested: 3, now: today }).allowed, false);
  // 而**本节**的额度不随天重置：s1 已经用满 3/3，明天仍然要不到。
  assert.equal(rate.check({ courseId: 'c1', sectionId: 's1', requested: 1, now: tomorrow }).remainingSection, 0);
});

test('额度台账：JSON 往返；读到坏结构**抛**（不许把今天的额度清零）', () => {
  const rate = makeRateLedger({ policy: { perDay: 9, perSection: 7 } });
  rate.consume({ courseId: 'c', sectionId: 's', count: 4, now: localDate(2026, 10, 7) });
  const json = JSON.parse(JSON.stringify(rate.toJson()));
  assert.equal(json.schema, 'quiz_rate');

  const back = makeRateLedger().fromJson(json);
  assert.equal(back.policy.perDay, 9);
  assert.equal(back.usedToday(localDate(2026, 10, 7, 23)), 4, '同一天的任何时刻都算同一天');
  assert.equal(back.usedToday(localDate(2026, 10, 8)), 0, '第二天归零');
  assert.equal(back.usedInSection('c', 's'), 4);

  assert.throws(() => makeRateLedger().fromJson('不是对象'), (e) => e.code === 'DATA');
  // 没给 perDay 时回落到保守默认值（而不是 0 = 无限额度）。
  assert.equal(makeRateLedger().fromJson({}).policy.perDay, 20);
});

test('rateDayKey 用**本地日**（跨时区核对时才不会差一天）', () => {
  assert.equal(rateDayKey(localDate(2026, 10, 7)), '2026-10-07');
  assert.equal(rateDayKey(localDate(2026, 1, 5)), '2026-01-05', '个位数月 / 日要补零');
  assert.equal(rateDayKey(localDate(2026, 12, 31, 23)), '2026-12-31');
  assert.equal(rateDayKey(new Date(rateDayKey(new Date()) === '' ? 0 : Date.now())).length, 10);
});

test('写盘许可：只有 ok / noFile 允许写，三个非正常态各有 remedy', () => {
  const S = QUIZ_READ_STATUSES;
  assert.equal(quizStoreWritable(S.ok, S.ok), true);
  assert.equal(quizStoreWritable(S.noFile, S.noFile), true, '首次运行是正常态');
  assert.equal(quizStoreWritable(S.corrupt, S.ok), false);
  assert.equal(quizStoreWritable(S.ok, S.ioError), false);
  assert.equal(quizStoreWritable(S.pathBlocked, S.ok), false);

  assert.match(quizStoreRemedy(S.corrupt, S.ok), /先备份/);
  assert.match(quizStoreRemedy(S.ok, S.pathBlocked), /移走/);
  assert.match(quizStoreRemedy(S.ok, S.ioError), /重试/);
  assert.equal(quizStoreRemedy(S.ok, S.noFile), null);
});

test('题库领域服务：**不落盘**，只交出快照给集成层', () => {
  const store = createQuizStore({ now: FIXED });
  store.saveGenerated([clozeItem({ id: 'q1' })]);
  const snap = store.snapshot();

  assert.deepEqual(Object.keys(snap).sort(), ['attempts', 'items']);
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].status, 'proposed');
  // 服务上**没有**任何路径 / 文件 / 存储字段（这是「不落盘」在接口上的样子）。
  for (const key of Object.keys(store)) {
    assert.equal(/path|dir|file|storage/i.test(key), false, `服务上不该有 ${key}`);
  }
  assert.deepEqual([...kQuizTracks].sort(), ['attempts', 'items', 'rate']);
});

test('读回来的题认不出时**逐条报出来**，不静默丢弃也不退回默认值', () => {
  const store = createQuizStore({ now: FIXED });
  const good = itemToJson(clozeItem({ id: 'ok' }));
  const badType = { ...itemToJson(clozeItem({ id: 'bad' })), type: '外星题型' };
  const badStatus = { ...itemToJson(clozeItem({ id: 'bad2' })), status: '待定' };

  const res = store.loadItems([good, badType, badStatus]);
  assert.equal(res.loaded, 1);
  assert.equal(res.notes.length, 2);
  assert.ok(res.notes.every((n) => /认不出|读不回来/.test(n)));
  assert.deepEqual(store.all.map((q) => q.id), ['ok']);
});

test('题目 JSON 往返一致（存得下也读得回来）', () => {
  const item = clozeItem({ id: 'rt', warnings: ['警告一'], checks: [] });
  const again = itemFromJson(JSON.parse(JSON.stringify(itemToJson(item))));
  assert.equal(JSON.stringify(itemToJson(again)), JSON.stringify(itemToJson(item)));
  const c = byId(runHardChecks(item, { source: null }), QUIZ_CHECK_IDS.jsonRoundTrip);
  assert.equal(v(c), 'pass');

  // 认不出的题型 / 状态 / 检查项 → null，绝不退回默认值。
  assert.equal(itemFromJson({ ...itemToJson(item), type: '外星' }), null);
  assert.equal(itemFromJson({ ...itemToJson(item), status: '???' }), null);
  assert.equal(itemFromJson({ ...itemToJson(item), checks: [{ id: '未知检查' }] }), null);
  assert.equal(itemFromJson({ ...itemToJson(item), createdAt: '不是时间' }), null);
});

// ═══════════════════════════════════════════════════════════════
// 形状辅助
// ═══════════════════════════════════════════════════════════════

test('不可变值对象：withItem 返回新实例，原实例不变', () => {
  const a = clozeItem({ id: 'v1' });
  const b = withItem(a, { status: QUIZ_STATUSES.accepted, warnings: ['新警告'] });
  assert.notEqual(a, b);
  assert.equal(a.status, QUIZ_STATUSES.proposed, '原实例不许被改（人工修正台账要留对照物）');
  assert.equal(b.status, QUIZ_STATUSES.accepted);
  assert.equal(b.createdAt, a.createdAt, 'createdAt 不许被「改一改」弄丢');
});

test('题型代号与 App 一致：案例题是 "case" 而不是 "caseStudy"', () => {
  assert.equal(QUIZ_TYPES.caseStudy.code, 'case');
  assert.equal(quizTypeFromCode('case').label, '案例');
  assert.equal(quizTypeFromCode('caseStudy'), null, '不许接受 Dart 的成员名（落盘只走代号）');
  assert.equal(quizTypeFromCode('外星'), null);
});

test('stripLabelPrefix：数字支不许把 0.5 吃成 5', () => {
  assert.equal(stripLabelPrefix('0.5'), null);
  assert.deepEqual(stripLabelPrefix('B. 势能函数'), { label: 'B', rest: '势能函数' });
  assert.deepEqual(stripLabelPrefix('1、内容'), { label: '1', rest: '内容' });
  assert.equal(stripLabelPrefix('势能函数'), null);
});

test('1.5–2.5 张/页：只报警，不做成进度或成就', () => {
  // 35 页 → 259 张：卡片雪崩。
  const avalanche = adviseCardsPerPage(35, 259);
  assert.equal(avalanche.verdict.code, 'tooMany');
  assert.match(avalanche.message, /卡片雪崩风险/);
  assert.match(avalanche.message, /80–90% 可以直接删掉/);

  // 目标区间的**边界**要按 ≥ 下限 / ≤ 上限 判：
  // 52/35 = 1.486 < 1.5 → 偏少（52 张**不到**下限）；53/35 = 1.514 → 在区间内。
  assert.equal(adviseCardsPerPage(35, 52).verdict.code, 'tooFew', '52 张低于下限');
  assert.equal(adviseCardsPerPage(35, 53).verdict.code, 'target');
  assert.equal(adviseCardsPerPage(35, 87).verdict.code, 'target');
  assert.equal(adviseCardsPerPage(35, 88).verdict.code, 'tooMany', '88/35 = 2.51 > 上限');
  assert.equal(adviseCardsPerPage(35, 10).verdict.code, 'tooFew');
  assert.match(adviseCardsPerPage(0, 5).message, /无法判断密度（不猜）/);
  assert.match(adviseCardsPerPage(35, 10).message, /还有没被考到的内容/);
});

test('每块的材料请求体只带这一块（整节字幕在这条路径上进不来）', () => {
  const m = block(4);
  const body = JSON.parse(buildRewritePrompt(m));
  assert.equal(body.step, 'rewrite');
  assert.equal(body.blockIndex, 4);
  assert.equal(body.selection, 'markedBlock');
  assert.equal(body.materialSource, 'summary');
  assert.equal(body.material, m.materialText());
  assert.equal(body.material.includes('块3'), false, '别的块的内容不许混进来');

  const gen = JSON.parse(buildGenerationPrompt({ type: QUIZ_TYPES.cloze, m, statements: ['甲'] }));
  assert.equal(gen.maxBlanks, kMaxBlanksPerCard);
  assert.ok(Array.isArray(gen.forbiddenTerms));
  assert.ok(gen.forbiddenTerms.includes('the'), '禁用词表与质检侧同一份（不许漂开）');
});

test('积压：到期与新卡**不合并**；两个都是 0 时也不说「你没有问题」', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const backlog = computeBacklog({
    now,
    cards: [
      { dueAt: '2026-10-07T11:00:00Z', isNew: false }, // 已到期
      { dueAt: '2026-10-07T12:00:00Z', isNew: false }, // 刚好到点 → 也算到期（不等下一轮）
      { dueAt: '2026-10-08T12:00:00Z', isNew: false }, // 还没到
      { dueAt: null, isNew: false },                    // 没有到期时间 → 不猜
      { dueAt: null, isNew: true },                     // 新卡
      { dueAt: null, isNew: true },
    ],
  });
  assert.equal(backlog.dueCards, 2);
  assert.equal(backlog.newCards, 2);
  assert.equal(backlog.message.includes('共'), false, '两个数不许合并成一个');
  assert.match(backlog.message, /到期 2 张、新卡 2 张/);

  const empty = computeBacklog({ now, cards: [] });
  assert.equal(empty.dueCards, 0);
  assert.equal(empty.newCards, 0);
  assert.match(empty.message, /这不是「你没有问题」/, '空队列不等于「你没有问题」');
});

test('三条轨道名字与 App 的三个文件一一对应', () => {
  assert.deepEqual([...kQuizTracks], ['items', 'attempts', 'rate']);
});

// ═══════════════════════════════════════════════════════════════
// ⚠️ 已知未对齐：讲义题**过不了**硬检查（与 App 同病，如实钉住）
// ═══════════════════════════════════════════════════════════════

test('⚠️ 未实现判据：讲义题送进硬检查会在 schema 上 fail（App 同样如此）', () => {
  // 这条测试的用途不是「证明实现对了」，而是**把一处真实的不一致钉住**，
  // 免得它被误读成「讲义题也过了质检链」。
  //
  // 事实（两侧都成立）：
  // ① App 的 `lib/state/quiz.dart` 造讲义题时写的是 `blockIndex: -1`（无锚点）
  //    与 `page: 0`；而 `quiz_quality.dart` 的 `schema` 项要求
  //    `blockIndex >= 0` 且 `page >= 1` → 讲义题必然 schema fail。
  // ② App 之所以不受影响，是因为「按讲义出题」**整条绕过质检链**：
  //    它自己的准入判据是 `admitLectureDrafts`（依据必须对得上工具回包原文），
  //    然后走 `saveSelfAudited` 直接进队列。
  //
  // 本包**照抄 App 的取值（-1 / 0），不改成能过 schema 的假值**：
  // 改成 1 是发明一个 App 没有的取值，会让两边读同一份数据时对不上。
  // 于是这里如实断言这份冲突，并断言**绕过质检链的那条路是显式可用的**。
  const fields = lectureDraftToItemFields({
    type: 'cloze', stem: '{{熵}}是混乱度的量度。', answer: '熵', pass: true, audit: '',
    evidence: [{ kind: 'knowledge', quote: '熵是系统混乱程度的量度' }], choices: [],
  });
  assert.equal(fields.blockIndex, -1);
  assert.equal(fields.page, 0, '照抄 App 的 page: 0（不是 1）');

  const item = makeItem({
    id: 'lec-1', courseId: 'c1', sectionId: 's1',
    blockIndex: fields.blockIndex, page: fields.page, atSec: fields.atSec,
    type: fields.type, stem: fields.stem, answer: fields.answer,
    warnings: fields.warnings, status: QUIZ_STATUSES.accepted,
    createdAt: '2026-10-07T00:00:00.000Z',
  });
  const report = runHardChecks(item, { source: null });
  assert.deepEqual(report.failedIds, ['schema'], '这一处不一致是**已知**的，不是回归');
  assert.match(byId(report, QUIZ_CHECK_IDS.schema).detail, /blockIndex 为负（-1）/);
  assert.match(byId(report, QUIZ_CHECK_IDS.schema).detail, /page 必须 1 基（拿到 0）/);

  // 而 App 走的那条路（依据核对 + saveSelfAudited）在本包里是可用的、且**不经过**硬检查。
  const store = createQuizStore({ now: FIXED });
  const saved = store.saveSelfAudited([item]);
  assert.equal(saved.saved, 1, '讲义自审通道可用');
  assert.equal(store.reviewQueue.length, 1);
});

// ═══════════════════════════════════════════════════════════════
// Cordis 插件包装（薄）—— 本包唯一的宿主接缝
// ═══════════════════════════════════════════════════════════════

test('插件：inject 只声明真正需要的（不声明存储），provide zhiyunQuiz 并返回 disposer', async () => {
  const plugin = await import('../packages/dsh-zhiyun-quiz/src/index.js');
  assert.equal(plugin.name, 'zhiyun-quiz');
  assert.deepEqual(plugin.inject, ['zhiyunParser'], '只声明 zhiyunParser（本包不落盘，不声明存储）');
  assert.equal(plugin.inject.includes('storage'), false);

  const provided = [];
  let removed = 0;
  const ctx = {
    zhiyunParser: { llm: { async call() { return { text: '{"statements":["甲"]}' }; } } },
    provide(name, service) {
      provided.push([name, service]);
      return () => { removed++; };
    },
  };

  const dispose = await plugin.apply(ctx, {});
  assert.equal(provided.length, 1);
  assert.equal(provided[0][0], 'zhiyunQuiz');
  const service = provided[0][1];
  for (const key of ['generate', 'dispose', 'store']) {
    assert.ok(key in service, `服务缺少 ${key}`);
  }
  assert.equal(typeof service.generate, 'function');
  assert.equal(service.store.constructor, Object, '领域服务是普通对象');

  // disposer：先中断在飞的请求，再摘服务（顺序反过来会发出没人收的请求）。
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(removed, 1, 'disposer 要摘掉服务');
  assert.equal(service.closed, true, 'disposer 要中断在飞的请求');
});

test('插件：没注入 llm → 抛 CONFIG（而不是「生成了 0 题」）', async () => {
  const plugin = await import('../packages/dsh-zhiyun-quiz/src/index.js');
  await assert.rejects(
    () => plugin.apply({ provide() {} }, {}),
    (e) => e.code === 'CONFIG' && /窄 llm 接口/.test(e.message),
  );
});

test('插件：config.llm 可以直接注入（集成层不必依赖 zhiyunParser）', async () => {
  const plugin = await import('../packages/dsh-zhiyun-quiz/src/index.js');
  const provided = [];
  const ctx = { provide(n, s) { provided.push([n, s]); return () => {}; } };
  await plugin.apply(ctx, { llm: { async call() { return { text: '[]' }; } } });
  assert.equal(provided[0][0], 'zhiyunQuiz');
  assert.equal(provided[0][1].closed, false);
});

test('插件：llm 的 route 延迟解析（没配模型时不该激活失败）', async () => {
  const plugin = await import('../packages/dsh-zhiyun-quiz/src/index.js');
  const seen = [];
  const ctx = {
    provide() { return () => {}; },
    zhiyunParser: {
      llm: {
        resolve: async () => ({ text: 'route-text' }),
        async call(request) { seen.push(request); return { text: '{"statements":["甲"]}' }; },
      },
    },
  };
  await plugin.apply(ctx, {});
  // 激活时不调 resolve（没配模型也能挂上服务）。
  assert.equal(seen.length, 0);

  const provided = [];
  const ctx2 = {
    provide(n, s) { provided.push([n, s]); return () => {}; },
    zhiyunParser: ctx.zhiyunParser,
  };
  await plugin.apply(ctx2, {});
  const svc = provided[0][1];
  await svc.generate({ blocks: [block(0)], context: { courseId: 'c', sectionId: 's', pageCount: 1 } });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].route, 'route-text', 'route 由集成层的 resolve 提供');
  assert.equal(seen[0].stage, 'quiz-rewrite');
});
