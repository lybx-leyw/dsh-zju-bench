/**
 * `model.js` —— R4（AI 出题）的**题**与**质检结果**的形状。
 *
 * # 规格来源
 *
 * 逐条对齐 App 的 `lib/fusion/quiz_model.dart`。本文件只做两件事：
 * 把一道题**钉成一个形状**，把一次质检**钉成一个记录**。出题在 `generate.js`，
 * 质检在 `quality.js` —— 形状先于功能存在，理由是「评测集必须先于功能就位」：
 * 没有固定的题形状，'这题好不好' 就无法被**机器**回答，质量只能由「感觉不错」判定。
 *
 * # 三个锚点字段不是装饰
 *
 * `blockIndex` / `page` / `atSec` 是「每道题都能**点回原文**」的落点。
 * `QuizSourceBlock.materialId` 与 `QuizItem.materialIdWith()` 由**同一组**锚点算出，
 * 于是「这道题的材料是这一块」是**可校验的等式**而不是一句注释 ——
 * 质检第一层有一条 `anchorBacklink` 专门核对它。
 *
 * # 质检结果为什么是**三态**
 *
 * 当一项检查的输入根本不在场（例如没给源材料，于是「答案在原文里有依据吗」
 * 无从判断），把它记成 `pass` 就是假装完成，记成 `fail` 又是假装失败。
 * 所以判定是三态：`pass` / `fail` / `undecided`。三态**不放松**任何东西，反而更紧：
 *
 * | 判定 | 含义 | 对题目的后果 |
 * |---|---|---|
 * | `pass` | 检查**适用**且通过 | 继续走后面的层 |
 * | `fail` | 检查**适用**且不通过 | 硬检查失败 → **直接丢弃**（不用 LLM 判） |
 * | `undecided` | 检查**适用但输入不在场**，机器无法判定 | **不许**自动采纳，**进人工队列** |
 *
 * 「检查**不适用**于这道题」（例如纯文字题去查「数值等价性」）算 `pass` 并在
 * `detail` 里写明「不适用」—— 那不是缺失输入，而是这道题**根本没有**那个维度；
 * 记成 `undecided` 会让人工队列被「每道纯文字题都待人工」淹掉，那就等于把
 * 人工环节做成橡皮图章。
 */

// ═══════════════════════════════════════════════════════════════
// 题型
// ═══════════════════════════════════════════════════════════════

/**
 * 四类题型。**数组顺序 = 分期顺序**（验证成本从低到高）。
 *
 * ⚠️ 第 3 期只做前两类（填空 / 短答）的**质检**；选择题与案例题的**形状**先留。
 * 留形状 ≠ 假装实现了检查。
 *
 * ⚠️ 案例题的对外代号是 `'case'`，不是 `'caseStudy'`：Dart 侧成员名被迫叫
 * `caseStudy`（`case` 是保留字），而**落盘一律走代号** —— 若直接落成员名，
 * 这种「为了避开保留字而改名」的历史就会漏进数据文件，将来改名会变成数据迁移。
 * JS 里没有这个保留字冲突，但**代号必须与 Dart 一致**，否则同一个文件两边读不懂。
 */
export const QUIZ_TYPES = Object.freeze({
  cloze: Object.freeze({ code: 'cloze', label: '填空' }),
  shortAnswer: Object.freeze({ code: 'shortAnswer', label: '短答' }),
  mcq: Object.freeze({ code: 'mcq', label: '选择题' }),
  caseStudy: Object.freeze({ code: 'case', label: '案例' }),
});

/** 全部题型的数组（顺序 = 成本序）。 */
export const QUIZ_TYPE_LIST = Object.freeze([
  QUIZ_TYPES.cloze,
  QUIZ_TYPES.shortAnswer,
  QUIZ_TYPES.mcq,
  QUIZ_TYPES.caseStudy,
]);

/** 从落盘代号还原题型；不认识返回 `null`（调用方负责报错，不许静默当默认值）。 */
export function quizTypeFromCode(code) {
  if (typeof code !== 'string') return null;
  return QUIZ_TYPE_LIST.find((t) => t.code === code) ?? null;
}

// ═══════════════════════════════════════════════════════════════
// 质检：严重度、判定、检查项
// ═══════════════════════════════════════════════════════════════

/**
 * 检查项的严重度。**这两档的差别不是「重要程度」，而是「机器能不能判」**。
 *
 * - `hard`：判据是**局部且可判定**的（结构合法 / 唯一正解 / 数值等价 / 答案在不在原文里）。
 *   失败 → 直接丢；判定不了 → 进人工队列。
 * - `warn`：判据**有把握的假阳性**（选项长度分布、单位一致、答案没印在题干里）。
 *   它标记的是「值得看一眼」，**不拦采纳、不占人工队列** —— 做成硬失败会因为一条
 *   启发式规则误杀好题。实测：120/122 通过全部硬检查，仍有 8/120 被警告层标记
 *   → **硬检查保证结构，不保证教学正确**。
 */
export const QUIZ_SEVERITIES = Object.freeze({
  hard: Object.freeze({ code: 'hard', label: '硬检查' }),
  warn: Object.freeze({ code: 'warn', label: '警告' }),
});

/** 一项检查的判定。三态，理由见文件头（`bool` 装不下「拿不到数据」）。 */
export const CHECK_VERDICTS = Object.freeze({
  pass: Object.freeze({ code: 'pass', label: '通过' }),
  fail: Object.freeze({ code: 'fail', label: '不通过' }),
  undecided: Object.freeze({ code: 'undecided', label: '未判定' }),
});

/** 判定代号 → 判定。不认识返回 `null`。 */
export function checkVerdictFromCode(code) {
  if (typeof code !== 'string') return null;
  return Object.values(CHECK_VERDICTS).find((v) => v.code === code) ?? null;
}

/**
 * 检查项登记表。
 *
 * ⚠️ 每一项后面的注释写的是这条检查的**断言**（它到底声称了什么）。
 * 写清楚断言不是洁癖：断言决定**覆盖范围**，而覆盖范围决定
 * 「这条检查通过了」能不能被读成「这道题没问题」。
 */
export const QUIZ_CHECK_IDS = Object.freeze({
  /** 断言：这一题能被解析成 `QuizItem` 的形状（必填项非空、选项标签互不相同、锚点合法）。**不**断言内容对不对。 */
  schema: Object.freeze({ code: 'schema', severity: QUIZ_SEVERITIES.hard, label: 'JSON 结构合规' }),
  /** 断言：这一题**存得下也读得回来** —— `toJson()` → `fromJson()` 结果与原件一致。 */
  jsonRoundTrip: Object.freeze({ code: 'jsonRoundTrip', severity: QUIZ_SEVERITIES.hard, label: '存得下也读得回来' }),
  /** 断言：选择题**恰好一个**选项被标为正确。0 个（无解）与 ≥2 个（多解）都是 fail。 */
  singleCorrectAnswer: Object.freeze({ code: 'singleCorrectAnswer', severity: QUIZ_SEVERITIES.hard, label: '唯一被标记的正确选项' }),
  /** 断言：选择题的选项个数在 `[minOptions, maxOptions]` 内（默认 3–6）。 */
  optionCount: Object.freeze({ code: 'optionCount', severity: QUIZ_SEVERITIES.hard, label: '选项数量' }),
  /** 断言：**规范化之后**选项两两不相同（重复干扰项 = 白送分）。只做「确定等价」的合并，不做同义。 */
  duplicateOption: Object.freeze({ code: 'duplicateOption', severity: QUIZ_SEVERITIES.hard, label: '选项不重复' }),
  /** 断言：在所有**可精确解析为有理数**的选项之间，没有两个数值相等；覆盖不到的逐条写进 `uncovered`。 */
  numericEquivalence: Object.freeze({ code: 'numericEquivalence', severity: QUIZ_SEVERITIES.hard, label: '数值等价性' }),
  /** 断言：答案文本能在源材料里找到依据。没有源材料 → `undecided`（不是 pass：无依据可查 ≠ 有依据）。 */
  answerInSource: Object.freeze({ code: 'answerInSource', severity: QUIZ_SEVERITIES.hard, label: '答案在源材料里有依据' }),
  /** 断言：题目记录的锚点与该源块的锚点**一致**。没有源块 → `undecided`。 */
  anchorBacklink: Object.freeze({ code: 'anchorBacklink', severity: QUIZ_SEVERITIES.hard, label: '能点回原文（锚点与源块一致）' }),
  /** 断言：填空题的题干里**至少有一个**挖空标记。非填空题**不适用**（pass + detail 写明）。 */
  blankMarker: Object.freeze({ code: 'blankMarker', severity: QUIZ_SEVERITIES.hard, label: '填空题有挖空标记' }),
  /** 断言：挖空个数 ≤ `maxBlanks`（默认 2）。依据实测：35 页讲义生成 259 张卡，用户「80–90% 可以直接删掉」。 */
  blankCount: Object.freeze({ code: 'blankCount', severity: QUIZ_SEVERITIES.hard, label: '每卡 ≤2 个挖空' }),
  /** 断言：挖空处 / 答案不是禁用词。依据失败案例原文：**把 "The" 做成 cloze**。 */
  forbiddenTargetTerm: Object.freeze({ code: 'forbiddenTargetTerm', severity: QUIZ_SEVERITIES.hard, label: '挖空不是禁用词' }),
  /**
   * 断言：挖空处 / 答案**至少 1 个字**。
   *
   * ⚠️ 下限是 **1，不是 2 也不是 4** —— 这是**中文语料**的定值。
   * 英文侧的长度过滤会把短词误判成「无意义片段」，而「熵」「域」在本项目的课程里
   * 是**完整术语**（同一结论已落在 R1 的知识点词表：允许 1 个汉字）。
   */
  targetLength: Object.freeze({ code: 'targetLength', severity: QUIZ_SEVERITIES.hard, label: '挖空 / 答案长度合理' }),
  /**
   * 断言：数值答案的**舍入是有说明的** —— 源材料里的值比题面更精确、两者数值接近
   * 但不相等，而题面没有任何舍入提示时 fail。
   *
   * ⚠️ 这条**必须有源材料**才能判：只看题面，`0.25` 与 `1.41` 在结构上同类，
   * 无法判断哪个是精确值、哪个是舍入值 —— 所以宁可返回 `undecided`，也不猜。
   */
  roundingNote: Object.freeze({ code: 'roundingNote', severity: QUIZ_SEVERITIES.warn, label: '数值答案带舍入说明' }),
  /** 断言：答案没有**原样印在题干里**（印了就是泄题）。非 ASCII 单字答案也查。 */
  answerNotInStem: Object.freeze({ code: 'answerNotInStem', severity: QUIZ_SEVERITIES.warn, label: '答案没印在题干里' }),
  /** 断言：选项文本长度分布均衡（最长 ÷ 最短 ≤ 阈值，且最长不超过中位数的阈值倍）。 */
  optionLengthSpread: Object.freeze({ code: 'optionLengthSpread', severity: QUIZ_SEVERITIES.warn, label: '选项长度分布均衡' }),
  /**
   * 断言：选项携带的单位**不是两种以上**混用。
   *
   * ⚠️ 这条是 **warn 而不是 hard**：单位混用有一种**合法**情形 —— 题干本身给了量纲，
   * 某个干扰项故意用别的单位诱人犯错（单位换算题）。硬失败会误杀这类题。
   */
  unitConsistency: Object.freeze({ code: 'unitConsistency', severity: QUIZ_SEVERITIES.warn, label: '选项单位一致' }),
});

/** 全部检查项的数组，顺序 = `runHardChecks` 的登记顺序（**不许**改，报告顺序是它的一部分）。 */
export const QUIZ_CHECK_ID_LIST = Object.freeze([
  QUIZ_CHECK_IDS.schema,
  QUIZ_CHECK_IDS.jsonRoundTrip,
  QUIZ_CHECK_IDS.singleCorrectAnswer,
  QUIZ_CHECK_IDS.optionCount,
  QUIZ_CHECK_IDS.duplicateOption,
  QUIZ_CHECK_IDS.numericEquivalence,
  QUIZ_CHECK_IDS.answerInSource,
  QUIZ_CHECK_IDS.anchorBacklink,
  QUIZ_CHECK_IDS.blankMarker,
  QUIZ_CHECK_IDS.blankCount,
  QUIZ_CHECK_IDS.forbiddenTargetTerm,
  QUIZ_CHECK_IDS.targetLength,
  QUIZ_CHECK_IDS.optionLengthSpread,
  QUIZ_CHECK_IDS.unitConsistency,
  QUIZ_CHECK_IDS.roundingNote,
  QUIZ_CHECK_IDS.answerNotInStem,
]);

/** 检查项代号 → 检查项；认不出返回 `null`（调用方**报出来**，不许悄悄跳过）。 */
export function quizCheckIdFromCode(code) {
  if (typeof code !== 'string') return null;
  return QUIZ_CHECK_ID_LIST.find((c) => c.code === code) ?? null;
}

// ═══════════════════════════════════════════════════════════════
// 一次检查的结果
// ═══════════════════════════════════════════════════════════════

/**
 * 一项检查的结果。**逐项**返回。
 *
 * `uncovered` 是「不许假装准确」的落点：当一项检查只覆盖了**部分**输入时，
 * 它必须把没覆盖到的部分**逐条写出来**。例：`numericEquivalence` 只比得了
 * 「可精确解析为有理数」的选项对；`'1/3'` 与 `'0.333'` 因为前者是无限小数、
 * 两者永远不精确相等，就落进 `uncovered` —— 报告里因此不会出现
 * 「数值等价性：通过」这种把没比过的部分也算成通过的读法。
 */
export function makeCheck({ id, verdict, detail, uncovered = [] }) {
  return { id, severity: id.severity, verdict, detail, uncovered: [...uncovered] };
}

export const checkPass = (id, detail, uncovered = []) => makeCheck({ id, verdict: CHECK_VERDICTS.pass, detail, uncovered });
export const checkFail = (id, detail, uncovered = []) => makeCheck({ id, verdict: CHECK_VERDICTS.fail, detail, uncovered });
export const checkUndecided = (id, detail, uncovered = []) => makeCheck({ id, verdict: CHECK_VERDICTS.undecided, detail, uncovered });

/** 这一项是硬检查且判 `pass`。`undecided` **不算**通过。 */
export const isHardPass = (c) => c.severity === QUIZ_SEVERITIES.hard && c.verdict === CHECK_VERDICTS.pass;
export const isFail = (c) => c.verdict === CHECK_VERDICTS.fail;
export const isUndecided = (c) => c.verdict === CHECK_VERDICTS.undecided;

export function checkToJson(c) {
  const out = { id: c.id.code, severity: c.severity.code, verdict: c.verdict.code, detail: c.detail };
  if (c.uncovered.length > 0) out.uncovered = [...c.uncovered];
  return out;
}

/** 从 JSON 还原。认不出的检查项代号返回 `null`（由调用方报出来，比悄悄跳过有用得多）。 */
export function checkFromJson(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = quizCheckIdFromCode(raw.id);
  if (id === null) return null;
  const verdict = checkVerdictFromCode(raw.verdict);
  if (verdict === null) return null;
  return makeCheck({
    id,
    verdict,
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    uncovered: Array.isArray(raw.uncovered) ? raw.uncovered.filter((u) => typeof u === 'string') : [],
  });
}

// ═══════════════════════════════════════════════════════════════
// 源块与锚点等式
// ═══════════════════════════════════════════════════════════════

/**
 * 锚点算出的**材料 id**。
 *
 * ⚠️ **材料的身份 = 节 + 块 + 源文件的修订号**：
 * - 少了「块」，同一节内所有题都指向同一份材料 → 「这道题的材料是这一块」失去意义；
 * - 少了「修订号」，产物被重新融合（同一节的块**整体偏移一位**、每块正文微改）
 *   之后，旧题的锚点会**静默**指到另一块上 —— 那是「产物是不可变事实」的
 *   静默违反，比报错危险得多。
 *
 * `sourceRevision` 允许 `null`/`undefined`（落成空串）—— 那种情况下
 * `anchorBacklink` 判 `undecided`，**不是**判通过。
 */
export const materialIdOf = (sectionId, blockIndex, sourceRevision) =>
  `${sectionId ?? ''}#b${blockIndex}@${sourceRevision ?? ''}`;

/**
 * 一次出题里被选中的**源块**。
 *
 * ⚠️ `materialId` **不由调用方随便填**：它由锚点算出，
 * 使得「这道题的材料是这一块」成为可校验的等式。
 */
export function makeSourceBlock({
  blockId,
  pointIds = [],
  blockIndex,
  page,
  atSec,
  groundingText,
  goodExamples = [],
  badExamples = [],
  sectionId = null,
  sourceRevision = null,
}) {
  return {
    blockId,
    pointIds: [...pointIds],
    blockIndex,
    page,
    atSec,
    groundingText,
    goodExamples: [...goodExamples],
    badExamples: [...badExamples],
    sectionId,
    sourceRevision,
    /** 锚点算出的材料 id。**只用锚点**（不用题干文本），所以「换一种问法重出同一块」仍指向同一份材料。 */
    get materialId() {
      return materialIdOf(sectionId, blockIndex, sourceRevision);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 选项
// ═══════════════════════════════════════════════════════════════

/**
 * 选择题的一个选项。
 *
 * - `label`：稳定标签（`A` / `B` / `C` / `D`）。唯一正解检查读的就是它。
 * - `sourceIds`：这个干扰项**取材于哪个块 / 哪个知识点**。空 = 不是干扰项（它是正确答案）。
 * - `pickCount`：有多少**真实作答**选了这个选项（干扰项功能率要单独统计，
 *   所以计数必须落在选项上，而不是只落在一个总数里）。
 */
export function makeOption({ label, text, sourceIds = [], pickCount = 0 }) {
  return { label, text, sourceIds: [...sourceIds], pickCount };
}

export function optionToJson(o) {
  const out = { label: o.label, text: o.text };
  if (o.sourceIds.length > 0) out.sourceIds = [...o.sourceIds];
  if (o.pickCount !== 0) out.pickCount = o.pickCount;
  return out;
}

export function optionFromJson(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return makeOption({
    label: String(m.label ?? ''),
    text: String(m.text ?? ''),
    sourceIds: Array.isArray(m.sourceIds) ? m.sourceIds.filter((s) => typeof s === 'string') : [],
    pickCount: Number.isFinite(m.pickCount) ? Math.trunc(m.pickCount) : 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// 题目状态
// ═══════════════════════════════════════════════════════════════

/**
 * 一道题的**状态**。生成的题**默认不直接进复习队列**，必须经用户采纳 ——
 * 所以 `proposed` 是默认值，且从 `proposed` 到 `accepted` 之间必须**有人**
 * 做过判断（见 `store.js`）。
 */
export const QUIZ_STATUSES = Object.freeze({
  proposed: Object.freeze({ code: 'proposed', label: '待审' }),
  accepted: Object.freeze({ code: 'accepted', label: '已采纳' }),
  rejected: Object.freeze({ code: 'rejected', label: '已丢弃' }),
});

/** 从代号还原状态；不认识返回 `null`。 */
export function quizStatusFromCode(code) {
  if (typeof code !== 'string') return null;
  return Object.values(QUIZ_STATUSES).find((s) => s.code === code) ?? null;
}

// ═══════════════════════════════════════════════════════════════
// 一道题
// ═══════════════════════════════════════════════════════════════

/**
 * 从答案里剥掉选项标签前缀，取**答案的正文内容**。
 *
 * `answer` 有两种常见写法：`'B'` / `'B. 势能函数'`（标签式，选择题）、
 * `'势能函数'`（内容式）。检查「答案在原文里有依据」「答案有没有印在题干里」
 * 「数值舍入」时，要的是**内容**而不是标签 —— 直接拿 `'B. 势能函数'` 去
 * 源材料里找原文，永远找不到（那是**假失败**，会把好题丢掉）。
 *
 * ⚠️ **字母支与数字支必须分开**：字母支 `[A-Za-z]` 本来无歧义 → 不动；
 * 数字支要让**标号后紧邻的字符不许是数字**（`(?!\d)`），因为 `0.5` 的 `5`
 * 是数字 → 那不是「标号 + 内容」而是**一个小数**。
 *
 * 为什么不是「标号后必须跟空格」：**中文教材里「标号紧贴内容」是无空格的常态**
 * （`B.选项` / `1.选项` / `A、C`），统一要求空格会把六种常见形态打回不剥标签 ——
 * 那是**回归**。同一判据在 `quality.js`（`stripLabelPrefix`）与 `generate.js`
 * （`normalizeForTrace`）各有一份副本，三份**用一致性测试钉住**。
 */
export function stripLabelPrefix(raw) {
  const s = raw.trim();
  const m = /^([A-Za-z])\s*[.)、:．]\s*(.+)$/.exec(s) ?? /^([0-9]{1,2})\s*[.)、:．](?!\d)\s*(.+)$/.exec(s);
  return m === null ? null : { label: m[1].toUpperCase(), rest: m[2].trim() };
}

/**
 * 一道题。
 *
 * ⚠️ **它是不可变值对象**：所有「改一改」都走 `withItem()` 返回新实例。
 * 理由是质检链要能回答「**这道题被改过什么**」—— 原地改字段会让人工修正台账
 * 失去对照物（改前的形态再也取不回来）。
 */
export function makeItem({
  id,
  courseId,
  sectionId,
  blockIndex,
  page,
  atSec,
  type,
  stem,
  answer,
  choices = [],
  distractorSourceIds = [],
  checks = [],
  warnings = [],
  status = QUIZ_STATUSES.proposed,
  createdAt,
}) {
  const item = {
    id,
    courseId,
    sectionId,
    blockIndex,
    page,
    atSec,
    type,
    stem,
    answer,
    choices: [...choices],
    distractorSourceIds: [...distractorSourceIds],
    checks: [...checks],
    warnings: [...warnings],
    status,
    createdAt,
  };

  /**
   * 点回原文用的材料 id（与 `QuizSourceBlock.materialId` **同式**）。
   *
   * ⚠️ 少了 `sourceRevision` 时返回的串里修订号为空 —— 质检会把这种情况判成
   * `undecided`（锚点无法与源块核对），**不是**判成通过。
   */
  item.materialIdWith = ({ sourceRevision } = {}) => materialIdOf(sectionId, blockIndex, sourceRevision);

  const optionByLabel = (label) =>
    item.choices.find((c) => c.label.trim().toUpperCase() === String(label).toUpperCase()) ?? null;

  /**
   * 答案**命中的**全部选项标签（可能 0 个、1 个、多个）。
   *
   * 「命中」只认两种写法：答案与标签**完全相等**（`'B'`），或者答案以
   * `'B.'` / `'B、'` / `'B)'` 开头。出题人（模型）这两种写法都常见，
   * 只认一种会把「有唯一正解」的题误判成「无唯一正解」（那是**假失败**）。
   *
   * ⚠️ **不**用「答案文本等于某个选项的文本」来**替代**标签命中：那会在
   * 「选项文本恰好是单个字母」时把多个选项一起命中。所以两种判据都做：
   * 先按标签命中，没有标签命中时再按**选项全文**命中。
   */
  item.correctOptionCandidates = () => {
    const ans = String(answer).trim().toUpperCase();
    if (ans === '') return [];
    const labels = item.choices.map((c) => c.label.trim()).filter((l) => l !== '');
    const upper = new Set(labels.map((l) => l.toUpperCase()));

    // ① **多标签**答案（`A、C` / `A,C` / `A C`）：每一段都是选项标签时全部算命中。
    //    「答案：A、C」在模型输出里很常见，只认单标签会**漏判**成「恰好一个正确」。
    const segs = ans.split(/[、,，;；/\s]+/).filter((t) => t !== '');
    if (segs.length > 1 && segs.every((t) => upper.has(t))) return segs;

    // ② **单标签**：`B` / `B. 势能函数` / `B、势能函数` / `B)`。
    const hit = labels.filter((l) => {
      const lu = l.toUpperCase();
      return ans === lu || ans.startsWith(`${lu}.`) || ans.startsWith(`${lu}、`)
        || ans.startsWith(`${lu})`) || ans.startsWith(`${lu}．`);
    });
    if (hit.length > 0) return hit;

    // ③ 退路：答案**逐字等于**选项全文（≥2 个选项与它相同 → 同样是「无唯一正解」）。
    return item.choices.filter((c) => c.text.trim().toUpperCase() === ans).map((c) => c.label.trim());
  };

  /** 标为正确的那**一个**选项标签。0 个或 ≥2 个返回 `null`。 */
  item.correctOptionLabel = () => {
    const hit = item.correctOptionCandidates();
    return hit.length === 1 ? hit[0] : null;
  };

  /**
   * **答案的正文内容**（剥掉选项标签前缀）。
   *
   * 纯标签式（答案就是 `'B'`）时回落到选项 B 的**文本**；找不到对应选项就原样返回标签。
   */
  item.answerContent = () => {
    const raw = String(answer).trim();
    if (raw === '') return '';
    const split = stripLabelPrefix(raw);
    if (split !== null) {
      if (split.rest !== '') return split.rest;
      const opt = optionByLabel(split.label);
      if (opt !== null && opt.text.trim() !== '') return opt.text.trim();
      return raw;
    }
    if (/^[A-Za-z]$/.test(raw)) {
      const opt = optionByLabel(raw.toUpperCase());
      if (opt !== null && opt.text.trim() !== '') return opt.text.trim();
    }
    return raw;
  };

  /** 全部判定为 `fail` 的检查项代号。 */
  item.failedChecks = () => item.checks.filter(isFail).map((c) => c.id.code);

  /** 全部**无法判定**的检查项代号（要人工看，不许自动放行）。 */
  item.undecidedChecks = () => item.checks.filter(isUndecided).map((c) => c.id.code);

  return item;
}

/** 返回一个新实例（不可变值对象，见 `makeItem` 的注释）。 */
export function withItem(item, patch = {}) {
  return makeItem({
    id: patch.id ?? item.id,
    courseId: item.courseId,
    sectionId: item.sectionId,
    blockIndex: patch.blockIndex ?? item.blockIndex,
    page: patch.page ?? item.page,
    atSec: patch.atSec ?? item.atSec,
    type: patch.type ?? item.type,
    stem: patch.stem ?? item.stem,
    answer: patch.answer ?? item.answer,
    choices: patch.choices ?? item.choices,
    distractorSourceIds: patch.distractorSourceIds ?? item.distractorSourceIds,
    checks: patch.checks ?? item.checks,
    warnings: patch.warnings ?? item.warnings,
    status: patch.status ?? item.status,
    createdAt: item.createdAt,
  });
}

export function itemToJson(item) {
  const out = {
    id: item.id,
    courseId: item.courseId,
    sectionId: item.sectionId,
    blockIndex: item.blockIndex,
    page: item.page,
    atSec: item.atSec,
    type: item.type.code,
    stem: item.stem,
    answer: item.answer,
  };
  if (item.choices.length > 0) out.choices = item.choices.map(optionToJson);
  if (item.distractorSourceIds.length > 0) out.distractorSourceIds = [...item.distractorSourceIds];
  out.checks = item.checks.map(checkToJson);
  if (item.warnings.length > 0) out.warnings = [...item.warnings];
  out.status = item.status.code;
  out.createdAt = item.createdAt;
  return out;
}

/**
 * 从 JSON 还原。
 *
 * ⚠️ **认不出的题型 / 状态一律返回 `null`**，绝不「退回默认值」：
 * 把一个不认识的题型静默当成填空题，会让质检对着错的口径说「通过」——
 * 那是本仓纪律里最忌讳的「假装完成」。调用方拿到 `null` 应当**报出来**。
 */
export function itemFromJson(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = quizTypeFromCode(raw.type);
  if (type === null) return null;
  const status = quizStatusFromCode(raw.status);
  if (status === null) return null;

  const checks = [];
  for (const c of Array.isArray(raw.checks) ? raw.checks : []) {
    const parsed = checkFromJson(c);
    if (parsed === null) return null;
    checks.push(parsed);
  }

  const created = typeof raw.createdAt === 'string' ? raw.createdAt : null;
  if (created === null || Number.isNaN(Date.parse(created))) return null;

  return makeItem({
    id: String(raw.id ?? ''),
    courseId: String(raw.courseId ?? ''),
    sectionId: String(raw.sectionId ?? ''),
    blockIndex: Number.isFinite(raw.blockIndex) ? Math.trunc(raw.blockIndex) : 0,
    page: Number.isFinite(raw.page) ? Math.trunc(raw.page) : 0,
    atSec: Number.isFinite(raw.atSec) ? Number(raw.atSec) : 0,
    type,
    stem: String(raw.stem ?? ''),
    answer: String(raw.answer ?? ''),
    choices: (Array.isArray(raw.choices) ? raw.choices : [])
      .filter((c) => c !== null && typeof c === 'object')
      .map(optionFromJson),
    distractorSourceIds: Array.isArray(raw.distractorSourceIds)
      ? raw.distractorSourceIds.filter((s) => typeof s === 'string')
      : [],
    checks,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : [],
    status,
    createdAt: created,
  });
}
