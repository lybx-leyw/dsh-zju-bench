/**
 * `quality.js` —— R4（AI 出题）的**质检链**：确定性硬检查 → 可回答性 →
 * grounded judge → 人工台账。
 *
 * # 规格来源
 *
 * 逐条对齐 App 的 `lib/fusion/quiz_quality.dart`（阈值、判据、失败文案、
 * 三态语义都照抄，**不自己发明算法**）。
 *
 * # 这里**不生成**任何题
 *
 * 没有固定的质检口径，出题质量就只能靠「看着还行」判断。所以本文件只做
 * 「拿到一道题，回答它够不够格进复习队列」。
 *
 * # 四层防线的顺序是**成本序**，不许倒过来
 *
 * | 层 | 成本 | 这一层能保证什么 | 落点 |
 * |---|---|---|---|
 * | 1 确定性硬检查 | 近零（**不用 LLM**） | **结构合法** | `runHardChecks` |
 * | 2 可回答性 | 低 | 答案**在源材料里有依据** | `runAnswerability` |
 * | 3 grounded judge | 中 | 教学上有价值（**同源好 / 坏样例局部比较**） | `runGroundedJudge` |
 * | 4 人工 | 高 | 教学与学科相关性 —— **只有人能做** | `QuizQualityPipeline` |
 *
 * ⚠️ **第一层证明不了教学正确性**：实测 120/122 条候选通过全部硬检查，
 * 但警告层仍标记了 8/120。也就是说，「硬检查通过」只意味着
 * 「**这题的形状是对的**」，不意味着它值得做。
 *
 * # 三层各自**不许**做的事（都已被实证证伪）
 *
 * 1. **硬检查层不许调用任何模型**。`QuizHardCheckConfig` 里**故意没有任何
 *    LLM 字段** —— 想在里面塞一个模型调用，得先改配置的形状。
 * 2. **可回答性层必须用「只给该块原文」的独立问答**。`AnswerabilityRequest`
 *    的字段就两个：`question` 与 `passage`。**没有**「正确答案」字段 ——
 *    所以「把答案也喂给判官，让它确认答案对」这种自证在这里**写不出来**。
 * 3. **grounded judge 不许给通用 rubric**，必须把**同一源材料上已人工标注的
 *    好 / 坏样例**摆给模型做局部比较。`GroundedJudgeRequest` 里因此**没有**
 *    rubric 字段。这条约束由 `assertNoGenericRubric` 在**运行时**守住。
 *
 * # 一致性**不得**当放行闸门
 *
 * 已证伪的事实：265,000 样本审计里一致性与正确性的 ρ 仅 0.20–0.59；
 * **最一致的模型校准最差**；且**高一致性里 48% 是错的**。
 * 所以本文件**不提供**任何「一致性 > x ⇒ 采纳」的分支（见 `kAgreementGatingBanReason`）。
 *
 * # 三条「不许」在这一层的样子
 *
 * - **不许静默失败**：失败项**有名字**（检查项 `code`）；没有源材料时判
 *   `undecided` 并写明「没有拿到源块」，而不是当成通过。
 * - **不许假装完成**：`numericEquivalence` 只覆盖可精确解析为有理数的选项，
 *   其余**逐条**记进 `uncovered`。
 * - **不许假装准确**：所有比例都带样本量或 Wilson 区间，且 `n=0` 时**拒绝给数**。
 */

import {
  CHECK_VERDICTS, QUIZ_CHECK_IDS, QUIZ_SEVERITIES, QUIZ_TYPES,
  checkFail, checkPass, checkUndecided, isFail, isUndecided,
  itemFromJson, itemToJson,
} from './model.js';

// ═══════════════════════════════════════════════════════════════
// 具名失败
// ═══════════════════════════════════════════════════════════════

/**
 * 质检层的具名失败。
 *
 * 与 `dsh-zhiyun-lecture` 的 `LectureError` 同形（本包不重复造错误类型）。
 * 集成层靠 `code` 决定「重试 / 报配置 / 静默丢弃」——
 * 靠 message 猜是猜不准的，而猜错的代价是重试一个永远失败的调用。
 */
export class QuizError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuizError';
    this.code = code;
    this.details = details;
  }
}

// ═══════════════════════════════════════════════════════════════
// 挖空标记 / 数值 / 文本规范化（纯函数，第一层的地基）
// ═══════════════════════════════════════════════════════════════

/**
 * 填空题的挖空标记。`____` / `___` / `{{…}}` / `[[…]]` 都是实际会出现的写法，
 * 所以四种都认 —— 只认一种会让「明明挖了空却没标记」变成**假失败**。
 */
export const kQuizBlankMarkers = Object.freeze(['____', '___', '{{', ']]']);

/**
 * 填空题挖空个数 = 标记出现次数的**最大值**（标记可能混用，取最大不取和：
 * 两种标记同时出现时只能说明是同一处挖空换了写法，不能算两处）。
 */
export function countBlanks(stem) {
  let max = 0;
  for (const marker of kQuizBlankMarkers) {
    let n = 0;
    let i = stem.indexOf(marker);
    while (i >= 0) {
      n++;
      i = stem.indexOf(marker, i + marker.length);
    }
    if (n > max) max = n;
  }
  return max;
}

/** 全角 → 半角（`\u3000` 空格也归一）。 */
function foldFullWidth(s) {
  let out = '';
  for (const ch of s) {
    const r = ch.codePointAt(0);
    if (r === 0x3000) out += ' ';
    else if (r >= 0xff01 && r <= 0xff5e) out += String.fromCodePoint(r - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 尾部标点表。 */
const TRAILING_PUNCT = '。．.,，;；:：!！?？、';

/**
 * ⚠️ **字母支与数字支必须分开**（与 `generate.js` 的 `normalizeForTrace`、
 * `model.js` 的 `stripLabelPrefix` 是同一条判据的三份副本 ——
 * Dart 侧的 import 方向决定了不能抽公共函数，否则成环；三份**用一致性测试钉住**）。
 *
 * 数字支的 `(?!\d)`：标号后紧邻不许是数字 —— 否则 `0.5` 的 `5` 会被当成
 * 「标号 0 + 内容 5」，于是 `normalizeOptionText('0.5') === normalizeOptionText('5')`
 * → **「0.5」与「5」这两个数值不同的选项被判成同一个**（假重复），
 * 一条有效的干扰项会被**静默丢掉**（假阴性，且不报错）。
 *
 * 为什么不改成「标号后必须跟空格」：中文里 `B.选项` / `1.选项` / `A、C`
 * 都是无空格的常见形态，那样会集体**回归**。
 */
function stripLabelPrefixForOption(s) {
  const m = /^([a-z])[.)、:：]\s*/.exec(s) ?? /^([0-9]{1,2})[.)、:：](?!\d)\s*/.exec(s);
  return m === null ? s : s.slice(m[0].length);
}

function stripTrailingPunct(s) {
  // ⚠️ 先**去掉所有空白**：「20 米」与「20米」显然是同一个选项，
  //    不合并就是**漏判**（两个一样的选项当成两个，白送一个选项位）。
  let t = s.replace(/\s+/g, '').toLowerCase();
  while (t.length > 0 && TRAILING_PUNCT.includes(t[t.length - 1])) {
    t = t.slice(0, -1).replace(/\s+$/, '');
  }
  return t;
}

/**
 * 规范化选项文本，用于**重复干扰项**判定。
 *
 * ⚠️ 只做「**确定等价**」的合并：全角→半角、去空白、去大小写、去尾部标点、
 * 去开头的选项标号。**不做同义合并**：同义判断会有假阳性，而这一条是
 * **硬失败**（误判会直接丢好题）。同义的题目交给第二 / 三层去判。
 *
 * 去标号（`A. 势能函数` → `势能函数`）是必要的：否则同一个选项写成
 * `A. 势能函数` 与 `势能函数` 会被判成两个不同选项，那是**漏判**。
 */
export function normalizeOptionText(s) {
  return stripLabelPrefixForOption(stripTrailingPunct(foldFullWidth(s)));
}

/** 用于「原文里有没有」这类**确定**匹配的规范化：全角→半角、去大小写、去所有空白。 */
function normalizeForMatch(s) {
  return foldFullWidth(s).toLowerCase().replace(/\s+/g, '');
}

// ── 精确数值 ────────────────────────────────────────────────────

/**
 * 一个**可以精确比较**的数值：有理数 `num/den`（`den > 0`），外加可选的单位。
 *
 * 「精确」是这条检查的全部价值所在：`1/2` 与 `0.5` 在这里是**同一个有理数**，
 * 所以它们是重复干扰项；而 `1/3` 与 `0.333` 不是（前者永远不能用有限小数表示），
 * 这一对会被记进 `uncovered` —— **不假装比过**。
 */
export function makeNumericValue(numerator, denominator, unit) {
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new QuizError('INPUT', `分母必须为正整数：${denominator}`);
  }
  if (!Number.isSafeInteger(numerator)) {
    throw new QuizError('INPUT', `分子必须是安全整数：${numerator}`);
  }
  return {
    numerator,
    denominator,
    unit,
    value: numerator / denominator,
    /** 去掉单位后是否数值相等（**精确比较**：交叉相乘，不做浮点近似）。 */
    equalsValue(other) {
      return numerator * other.denominator === other.numerator * denominator;
    },
    toString() {
      const v = denominator === 1 ? `${numerator}` : `${numerator}/${denominator}`;
      return unit === '' ? v : `${v} ${unit}`;
    },
  };
}

function pow10(n) {
  if (n < 0 || n > 12) return null;
  let v = 1;
  for (let i = 0; i < n; i++) v *= 10;
  return Number.isSafeInteger(v) ? v : null;
}

/** `m × 10^e`，**精确**（`m` 与结果都用整数；`e` 越界返回 null 而不是猜）。 */
function scaleByPow10(m, e, unit) {
  if (e === 0) return makeNumericValue(m, 1, unit);
  if (e > 0) {
    const f = pow10(e);
    if (f === null) return makeNumericValue(m, 1, unit);
    return makeNumericValue(m * f, 1, unit);
  }
  const f = pow10(-e);
  if (f === null) return makeNumericValue(m, 1, unit);
  return makeNumericValue(m, f, unit);
}

function percentValue(v, percent) {
  return percent ? makeNumericValue(v.numerator, v.denominator * 100, v.unit) : v;
}

/**
 * 选项文本 → 精确数值。解析不出来返回 `null`（**不猜**）。
 *
 * 认这些写法：`0.5` / `.5` / `50%`(→1/2) / `1/2` / `-3` / `1_000` / `1,000`
 * / `3.5×10^3`、`3.5e3`（十进制指数）/ `5 米`（带单位）。
 *
 * ⚠️ 单位与数值**都**保留在返回值里：`50 N` 与 `50 J` 数值相等但**不同量纲**，
 * 把它们当成重复选项是错的（那是两道不同的题）。
 */
export function parseNumericValue(raw) {
  let s = foldFullWidth(String(raw).trim()).toLowerCase().replace(/\u2212/g, '-');
  if (s === '') return null;

  // 1) 结尾的百分号（`50%` / `50 %`）先摘掉，它就是「除以 100」。
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }

  // 2) 单位：结尾连续的字母 / 希腊字母 / `°` / `·` / `/`（`m/s`、`N·m`）。
  //    ⚠️ 指数写法（`e3`）**不是**单位，所以结尾是 `字母+数字` 时不当单位。
  let unit = '';
  const unitMatch = /[a-zµΩ°·/]+$/.exec(s);
  if (unitMatch !== null) {
    unit = unitMatch[0];
    s = s.slice(0, s.length - unit.length).trim();
  }

  s = s.replace(/_/g, '').replace(/,/g, '');
  s = s.replace(/×10/g, 'e').replace(/\*10/g, 'e').replace(/x10/g, 'e');

  // 3) 分数：`a/b`
  const frac = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac !== null) {
    const n = Number.parseInt(frac[1], 10);
    const d = Number.parseInt(frac[2], 10);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) return null;
    return percentValue(makeNumericValue(n, d, unit), percent);
  }

  // 4) 科学计数：`m.mmm e ±k` —— 用**整数**拼出分子分母，不走 double。
  const sci = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(s);
  if (sci !== null) {
    const sign = sci[1] === '-' ? -1 : 1;
    const digits = `${sci[2]}${sci[3] ?? ''}`;
    const decLen = (sci[3] ?? '').length;
    const exp = Number.parseInt(sci[4], 10);
    const mant = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(mant)) return null;
    const e = exp - decLen;
    if (e > 12 || e < -12) return null; // 超出精确表示范围 → 不猜
    return percentValue(scaleByPow10(sign * mant, e, unit), percent);
  }

  // 5) 普通十进制：`0.5` / `-0.5` / `.5` / `3`
  const dec = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(s);
  if (dec !== null) {
    const sign = dec[1] === '-' ? -1 : 1;
    const intPart = dec[2] ?? '0';
    const fracPart = dec[3] ?? dec[4] ?? '';
    const digits = `${intPart}${fracPart}`;
    const mant = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(mant)) return null;
    return percentValue(scaleByPow10(sign * mant, -fracPart.length, unit), percent);
  }

  return null;
}

/**
 * **两个数值答案是不是同一个值**（跨写法）。
 *
 * `1/2` 与 `0.5` 与 `50%` 是**同一个答案**；而 `50 N` 与 `50 J` **不是**
 * （数值相等但量纲不同，是两道不同的题）。
 *
 * ⚠️ 比较是**精确**的（交叉相乘，不走浮点）：浮点近似会把 `0.1+0.2` 那一类
 * 噪声变成「相等」，而这是**硬判定**（误判会丢题或放行错题）。
 * 精确比较也意味着 `1/3` 与 `0.333` **不**等价 —— 这是有意的：
 * 那不是「同一个值的两种写法」，而是**舍入**，属于另一条检查（`roundingNote`）。
 */
export function numericValuesEquivalent(a, b) {
  if (a.unit !== '' && b.unit !== '' && a.unit !== b.unit) return false;
  return a.equalsValue(b);
}

/** 便捷版：直接给两个文本。 */
export function numericAnswersEquivalent(a, b) {
  const x = parseNumericValue(a);
  const y = parseNumericValue(b);
  if (x === null || y === null) return false;
  return numericValuesEquivalent(x, y);
}

/** 从一段文本里取出**全部可精确解析**的数值写法（原样文本 + 解析值）。 */
export function numericTokensIn(text) {
  const out = [];
  const re = /[+\-]?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?(?:[eE][+\-]?\d+)?\s*%?/g;
  for (const m of String(text).matchAll(re)) {
    const v = parseNumericValue(m[0]);
    if (v !== null) out.push({ raw: m[0], value: v });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 第一层：确定性硬检查（**不用 LLM**）
// ═══════════════════════════════════════════════════════════════

/**
 * 硬检查的配置。**这份配置里没有任何模型 / 端点 / API Key 字段，这是有意的**：
 * 「硬检查不调用 LLM」不该只靠注释保证，而应当**没有可调的东西**。
 *
 * 所有阈值都是**中文语料的定值**，各自写明了取值依据 —— 不许从英文工具抄数。
 */
export const kQuizHardCheckDefaults = Object.freeze({
  /** 选择题选项数下限。**3**：二选一的猜测基线是 50%，测不出东西。 */
  minOptions: 3,
  /** 选项数上限。**6**：选项越多要造的干扰项越多，而干扰项正是最易失败的环节（AI 干扰项仅 45% 功能有效）。 */
  maxOptions: 6,
  /** 每卡挖空数上限。**2**（PRD §4.5：每卡 ≤2 个 cloze）。 */
  maxBlanks: 2,
  /** 选项最长 ÷ 最短 的上限（警告层用）。3 倍是个宽松起点。 */
  maxOptionLengthRatio: 3.0,
  /** 最长选项 ÷ 选项长度中位数 的上限（警告层用）。只标记不拦，宁可有假阳性。 */
  maxOptionLengthVsMedian: 2.5,
  /**
   * 挖空处 / 答案的**禁用词**。依据失败案例原文（把 "The" 做成 cloze）
   * 与人工出题规范（避免 yes/no/none of the above 这类无意义答案）。
   *
   * ⚠️ 只列**明确无信息量**的词。像「其中」「由于」这类口语连接词**不在**表内，
   * 因为它们在某些课程里是真正的术语（中文语料，不能照搬英文停用词表）。
   */
  forbiddenTargetTerms: Object.freeze([
    // 失败案例原文
    'the', 'a', 'an',
    // 人工出题规范点名的「无意义答案」
    'yes', 'no', 'none', 'none of the above', 'all of the above',
    '以上都不对', '以上都对', '都不是', '都对', '都是',
    '无', '没有', '是', '否',
  ]),
  /**
   * 挖空处 / 答案的**最短字数**。
   *
   * ⚠️ 定值是 **1，不是 2 也不是 4** —— 这是中文语料的结论，不是英文抄来的：
   * 「熵」「域」在本项目的课程里是**完整术语**。英文侧的长度过滤会把
   * 短词误判成「无意义片段」，而本产品是纯中文语料，按字符数过滤**必然**踩坑。
   */
  minTargetRunes: 1,
  /** 舍入容差（警告层用）。 */
  roundingTolerance: 0.02,
});

/** 从覆盖项造一份配置（缺项走默认）。**没有 llm 字段**，见 `kQuizHardCheckDefaults`。 */
export function makeHardCheckConfig(overrides = {}) {
  return { ...kQuizHardCheckDefaults, ...overrides };
}

/** 舍入说明的提示词。带其中任何一个，就不算「没说明」。 */
export const kRoundingHintPattern = /[≈~～约]|保留|四舍五入|取整|进一|两位小数|三位小数|有效数字|精确到/;

/** 挖空处 / 答案的**目标文本**。题干里的 `{{…}}` / `[[…]]`，否则是答案本身。 */
export function blankTargets(item) {
  const out = [];
  for (const m of item.stem.matchAll(/\{\{([^}]*)\}\}/g)) out.push(m[1]);
  for (const m of item.stem.matchAll(/\[\[([^\]]*)\]\]/g)) out.push(m[1]);
  if (out.length === 0) {
    const a = item.answer.trim();
    if (a !== '') out.push(a);
  }
  return out;
}

/** 填空题挖空处两侧的**词**（用于禁用词判定：挖掉的是 "the" 还是 "theorem"）。 */
export function blankWords(item) {
  const out = [];
  for (const m of item.stem.matchAll(/_{3,}/g)) {
    const before = item.stem.slice(0, m.index);
    const word = /[A-Za-z\u4e00-\u9fff]+$/.exec(before);
    if (word !== null) out.push(word[0]);
  }
  return out;
}

/** 「哪些选项**可能是**这道题的正确答案」—— 两种判定都要有：标签 / 全文命中 + 数值等价命中。 */
export function possibleCorrectLabels(item) {
  const hits = new Set(item.correctOptionCandidates());
  const ans = parseNumericValue(item.answerContent());
  if (ans !== null) {
    for (const c of item.choices) {
      const v = parseNumericValue(c.text);
      if (v === null) continue;
      if (numericValuesEquivalent(ans, v)) hits.add(c.label);
    }
  }
  return [...hits];
}

// ── 逐项检查 ────────────────────────────────────────────────────

function checkSchema(item) {
  const bad = [];
  if (item.id.trim() === '') bad.push('id 为空');
  if (item.courseId.trim() === '') bad.push('courseId 为空');
  if (item.sectionId.trim() === '') bad.push('sectionId 为空');
  if (item.stem.trim() === '') bad.push('stem（题干）为空');
  if (item.answer.trim() === '') bad.push('answer（答案）为空');
  if (item.blockIndex < 0) bad.push(`blockIndex 为负（${item.blockIndex}）`);
  if (item.page < 1) bad.push(`page 必须 1 基（拿到 ${item.page}）`);
  if (item.atSec < 0) bad.push(`atSec 为负（${item.atSec}）`);

  if (item.type === QUIZ_TYPES.mcq && item.choices.length < 2) {
    bad.push(`选择题必须 ≥2 个选项（拿到 ${item.choices.length} 个）`);
  }
  const labels = [];
  for (const c of item.choices) {
    if (c.label.trim() === '') bad.push('有选项没有标签');
    if (c.text.trim() === '') bad.push(`选项 ${c.label} 的文本为空`);
    labels.push(c.label.trim().toUpperCase());
  }
  if (new Set(labels).size !== labels.length) {
    bad.push(`选项标签有重复：${labels.join('/')}`);
  }

  if (bad.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.schema, `结构合法（${item.type.code}，${item.choices.length} 个选项）`);
  }
  return checkFail(QUIZ_CHECK_IDS.schema, `结构不合法：${bad.join('；')}`);
}

function checkJsonRoundTrip(item) {
  try {
    const again = itemFromJson(JSON.parse(JSON.stringify(itemToJson(item))));
    if (again === null) {
      return checkFail(QUIZ_CHECK_IDS.jsonRoundTrip, `读不回来：题型或状态代号不认识（${item.type.code}）`);
    }
    const a = JSON.stringify(itemToJson(item));
    const b = JSON.stringify(itemToJson(again));
    if (a !== b) {
      return checkFail(QUIZ_CHECK_IDS.jsonRoundTrip, '存下来再读回来与原件不一致（字段丢失或不可解析）');
    }
    return checkPass(QUIZ_CHECK_IDS.jsonRoundTrip, `存得下也读得回来（${item.checks.length} 项检查记录也在）`);
  } catch (e) {
    return checkFail(QUIZ_CHECK_IDS.jsonRoundTrip, `序列化 / 反序列化失败：${e}`);
  }
}

function checkSingleCorrect(item) {
  if (item.type !== QUIZ_TYPES.mcq) {
    return checkPass(QUIZ_CHECK_IDS.singleCorrectAnswer, `不适用：${item.type.label}没有「选项」这个维度`);
  }
  if (item.choices.length < 2) {
    return checkFail(QUIZ_CHECK_IDS.singleCorrectAnswer, `选项少于 2 个（${item.choices.length} 个），无法判断唯一正解`);
  }
  const hits = possibleCorrectLabels(item);
  if (hits.length === 1) return checkPass(QUIZ_CHECK_IDS.singleCorrectAnswer, `恰好一个正确选项：${hits[0]}`);
  if (hits.length === 0) {
    return checkFail(QUIZ_CHECK_IDS.singleCorrectAnswer,
      `无唯一正解：答案「${item.answer}」既不是选项标签，也不等于任何选项的文本，也不与任何选项数值等价`);
  }
  return checkFail(QUIZ_CHECK_IDS.singleCorrectAnswer,
    `有多个正确选项（${hits.join('/')}）：答案「${item.answer}」同时命中 ${hits.length} 个选项`);
}

function checkOptionCount(item, config) {
  if (item.choices.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.optionCount, `不适用：${item.type.label}没有选项`);
  }
  const n = item.choices.length;
  if (n < config.minOptions) {
    return checkFail(QUIZ_CHECK_IDS.optionCount,
      `选项过少：${n} 个（下限 ${config.minOptions}，二选一的猜测基线是 50%，测不出东西）`);
  }
  if (n > config.maxOptions) {
    return checkFail(QUIZ_CHECK_IDS.optionCount,
      `选项过多：${n} 个（上限 ${config.maxOptions}，选项越多要造的干扰项越多，而干扰项最易失败）`);
  }
  return checkPass(QUIZ_CHECK_IDS.optionCount, `选项数 ${n} 在 [${config.minOptions}, ${config.maxOptions}] 内`);
}

function checkDuplicateOptions(item) {
  if (item.choices.length < 2) {
    return checkPass(QUIZ_CHECK_IDS.duplicateOption, '不适用：选项少于 2 个，谈不上重复');
  }
  const seen = new Map();
  for (const c of item.choices) {
    const key = normalizeOptionText(c.text);
    seen.set(key, [...(seen.get(key) ?? []), c.label]);
  }
  const dups = [...seen.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([key, labels]) => `${labels.join('/')}（规范化后都是「${key}」）`);
  if (dups.length === 0) return checkPass(QUIZ_CHECK_IDS.duplicateOption, `${item.choices.length} 个选项两两不同`);
  return checkFail(QUIZ_CHECK_IDS.duplicateOption, `有重复选项：${dups.join('；')}`);
}

function checkNumericEquivalence(item) {
  const texts = item.choices.length > 0
    ? item.choices.map((c) => c.text)
    : (item.answerContent().trim() === '' ? [] : [item.answerContent()]);
  if (texts.length === 0) return checkPass(QUIZ_CHECK_IDS.numericEquivalence, '不适用：没有可选文本');

  const parsed = new Map();
  const uncovered = [];
  for (const t of texts) {
    const v = parseNumericValue(t);
    if (v === null) {
      if (/\d/.test(t)) uncovered.push(`「${t}」含数字，但无法精确解析为有理数（未参与比较）`);
      continue;
    }
    parsed.set(t, v);
  }

  if (parsed.size === 0) {
    return uncovered.length === 0
      ? checkPass(QUIZ_CHECK_IDS.numericEquivalence, '不适用：文本里没有数值')
      : checkUndecided(QUIZ_CHECK_IDS.numericEquivalence,
        '这份文本里没有**可精确解析**的数值，比较不了（不是「已通过」）', uncovered);
  }

  const problems = [];

  // ① 「按数值算，正确选项必须唯一」——`singleCorrectAnswer` 的数值版本。
  //    答案写 `1/2`、某个选项写 `0.5`（同一个值）时**恰好命中一个**，所以通过：
  //    它们不是两个答案，是同一个答案的两种写法。而若两个选项都与答案数值等价，
  //    就分不清学生选哪个才对 → 那才是白送一个选项。
  if (item.choices.length > 0) {
    const ans = parseNumericValue(item.answerContent());
    if (ans === null) {
      uncovered.push(`答案「${item.answerContent()}」不是可精确解析的数值（只检查了选项之间）`);
    } else {
      const hits = item.choices
        .filter((c) => parsed.has(c.text) && numericValuesEquivalent(ans, parsed.get(c.text)))
        .map((c) => c.label);
      if (hits.length === 0) {
        problems.push(`答案的数值 ${ans.value} 在选项里一个都对不上（标签命中与数值命中都没有）`);
      } else if (hits.length > 1) {
        problems.push(`有 ${hits.length} 个选项与答案的数值等价（${hits.join('/')}）：按数值算没有唯一正解，学生选哪个机器都判对`);
      }
    }

    // ② 两个**错误的**选项数值等价 → 重复干扰项（数值版）。
    const correctLabels = possibleCorrectLabels(item);
    const wrong = item.choices
      .filter((c) => parsed.has(c.text) && !correctLabels.includes(c.label))
      .map((c) => ({ label: c.label, v: parsed.get(c.text) }));
    for (let i = 0; i < wrong.length; i++) {
      for (let j = i + 1; j < wrong.length; j++) {
        if (numericValuesEquivalent(wrong[i].v, wrong[j].v)) {
          problems.push(`干扰项 ${wrong[i].label} 与 ${wrong[j].label} 数值等价（${wrong[i].v.value}）：它们是同一个干扰项，白送一个选项位`);
        }
      }
    }
  }

  if (problems.length > 0) {
    return checkFail(QUIZ_CHECK_IDS.numericEquivalence, `数值等价性：${problems.join('；')}`, uncovered);
  }
  return checkPass(QUIZ_CHECK_IDS.numericEquivalence,
    `${parsed.size} 个可精确解析的数值：按数值算正确选项唯一、干扰项互不等价`, uncovered);
}

// ── 源材料相关的检查（拿不到源材料 → undecided，不是 pass）────────

function checkAnswerInSource(item, source) {
  if (source === null || source === undefined) {
    return checkUndecided(QUIZ_CHECK_IDS.answerInSource,
      '没有拿到源块（sourceBlock=null）：无法核对答案在原文里有没有依据 —— '
      + '「没查」不等于「查过没问题」，所以这一项进人工，不许自动采纳');
  }
  const passage = normalizeForMatch(source.groundingText);
  if (passage === '') {
    return checkUndecided(QUIZ_CHECK_IDS.answerInSource,
      `源块 ${source.blockId} 的正文是空的：没有依据可查，不能判通过`);
  }
  const ans = normalizeForMatch(item.answerContent());
  if (ans === '') return checkFail(QUIZ_CHECK_IDS.answerInSource, '答案规范化后为空');
  if (passage.includes(ans)) {
    return checkPass(QUIZ_CHECK_IDS.answerInSource, `答案原文出现在源块 ${source.blockId} 的正文里`);
  }
  // 精确文本找不到时，再按**数值等价**找一次：答案写 `1/2`、源材料写 `0.5`
  // 是同一件事（数值等价性本来就是硬检查之一）。
  const ansNum = parseNumericValue(item.answerContent());
  if (ansNum !== null) {
    for (const tok of numericTokensIn(source.groundingText)) {
      if (numericValuesEquivalent(ansNum, tok.value)) {
        return checkPass(QUIZ_CHECK_IDS.answerInSource,
          `答案 ${item.answerContent()} 与源块 ${source.blockId} 里的 ${tok.raw} 数值等价（写法不同、值是同一个）`);
      }
    }
  }
  // ⚠️ 这里**不用**字符重叠率之类的近似：近似阈值会把「答案换了同义词」的题
  //    既可能误判通过、也可能误判失败，而这是**硬失败**（会丢题）。
  //    近似的活交给第二层（可回答性）去做，那一层本来就是这个职责。
  return checkFail(QUIZ_CHECK_IDS.answerInSource,
    `答案「${item.answer}」在源块 ${source.blockId} 的正文里找不到原文依据`);
}

/**
 * 断言：题目记录的锚点与该源块的锚点**一致** —— 也就是「点回原文」真的能点到
 * 出题时用的那一块。
 *
 * 核对的是**四件事**：块号 / 页号 / 时间戳 / **材料 id 等式**。
 * 最后一条是本仓「锚点是可校验的等式，不是一句注释」的落点：
 * `item.materialIdWith({sourceRevision}) !== source.materialId` 就是 fail。
 */
function checkAnchorBacklink(item, source) {
  if (source === null || source === undefined) {
    return checkUndecided(QUIZ_CHECK_IDS.anchorBacklink,
      '没有拿到源块：无法核对「点回原文」是否指向出题时用的那一块');
  }
  const bad = [];
  if (item.blockIndex !== source.blockIndex) {
    bad.push(`块号不一致（题 ${item.blockIndex} vs 源 ${source.blockIndex}）`);
  }
  if (item.page !== source.page) {
    bad.push(`页号不一致（题 ${item.page} vs 源 ${source.page}）`);
  }
  if (Math.abs(item.atSec - source.atSec) > 0.001) {
    bad.push(`时间戳不一致（题 ${item.atSec}s vs 源 ${source.atSec}s）`);
  }
  if (item.materialIdWith({ sourceRevision: source.sourceRevision }) !== source.materialId) {
    bad.push(`材料 id 不一致（题端 ${item.materialIdWith({ sourceRevision: source.sourceRevision })} `
      + `vs 源端 ${source.materialId}）`);
  }
  if (source.sourceRevision === null || source.sourceRevision === undefined || String(source.sourceRevision).trim() === '') {
    return checkUndecided(QUIZ_CHECK_IDS.anchorBacklink,
      '源块缺少 sourceRevision（产物修订号）：锚点无法与**当前**产物核对。'
      + `产物被重新融合后旧锚点会静默指到别的块上，所以这里进人工\n${bad.join('；')}`,
      bad);
  }
  if (bad.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.anchorBacklink,
      `锚点与源块一致：${source.materialId}（第 ${source.page} 页 / ${source.atSec}s）`);
  }
  return checkFail(QUIZ_CHECK_IDS.anchorBacklink, `锚点对不上源块：${bad.join('；')}`);
}

// ── 填空题 / 挖空相关 ────────────────────────────────────────────

function checkBlankMarker(item) {
  if (item.type !== QUIZ_TYPES.cloze) {
    return checkPass(QUIZ_CHECK_IDS.blankMarker, `不适用：${item.type.label}不挖空`);
  }
  const n = countBlanks(item.stem);
  if (n === 0) {
    return checkFail(QUIZ_CHECK_IDS.blankMarker,
      `填空题的题干里一个挖空标记都没有（认 ${kQuizBlankMarkers.join(' / ')}）`);
  }
  return checkPass(QUIZ_CHECK_IDS.blankMarker, `有 ${n} 个挖空（标记：${kQuizBlankMarkers.join(' / ')}）`);
}

function checkBlankCount(item, config) {
  if (item.type !== QUIZ_TYPES.cloze) {
    return checkPass(QUIZ_CHECK_IDS.blankCount, `不适用：${item.type.label}不挖空`);
  }
  const n = countBlanks(item.stem);
  if (n > config.maxBlanks) {
    return checkFail(QUIZ_CHECK_IDS.blankCount,
      `挖空过多：${n} 处（上限 ${config.maxBlanks}，依据「每卡 ≤2 个 cloze」）`);
  }
  return checkPass(QUIZ_CHECK_IDS.blankCount, `挖空 ${n} 处 ≤ ${config.maxBlanks}`);
}

function checkForbiddenTarget(item, config) {
  if (item.type !== QUIZ_TYPES.cloze) {
    return checkPass(QUIZ_CHECK_IDS.forbiddenTargetTerm, `不适用：${item.type.label}不挖空`);
  }
  const targets = [...blankTargets(item), ...blankWords(item)];
  if (targets.length === 0) {
    return checkUndecided(QUIZ_CHECK_IDS.forbiddenTargetTerm, '没有可判的挖空文本：禁用词无从判断');
  }
  const banned = new Set(config.forbiddenTargetTerms);
  const hit = [];
  for (const t of targets) {
    const key = t.trim().toLowerCase();
    if (key === '') continue;
    // 整串相等 → 命中。
    if (banned.has(key)) { hit.push(t.trim()); continue; }
    // 拉丁字母的挖空处往往是**一个词**（`The {blank} theorem`），
    // 所以再按「整词」拆一层：严禁 "the"，但 "theorem" 不许因为含 "the" 被误杀。
    for (const w of key.split(/[^a-z]+/)) {
      if (w !== '' && banned.has(w)) { hit.push(t.trim()); break; }
    }
  }
  if (hit.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.forbiddenTargetTerm,
      `${new Set(targets.map((t) => t.trim())).size} 个挖空 / 答案都不是禁用词`
      + `（禁用表 ${config.forbiddenTargetTerms.length} 条，依据失败案例原文：把 "The" 做成 cloze）`);
  }
  return checkFail(QUIZ_CHECK_IDS.forbiddenTargetTerm,
    `挖空 / 答案是禁用词：${[...new Set(hit)].join('、')}（依据失败案例原文：把 "The" 做成 cloze）`);
}

function checkTargetLength(item, config) {
  if (item.type !== QUIZ_TYPES.cloze && item.type !== QUIZ_TYPES.shortAnswer) {
    return checkPass(QUIZ_CHECK_IDS.targetLength, `不适用：${item.type.label}的答案不是「被考的词」`);
  }
  const targets = item.type === QUIZ_TYPES.cloze
    ? [...blankTargets(item), ...blankWords(item)]
    : [item.answer];
  if (targets.length === 0) {
    return checkUndecided(QUIZ_CHECK_IDS.targetLength, '没有可判的挖空 / 答案文本：长度无从判断');
  }
  const seen = new Set();
  const tooShort = [];
  for (const t of targets) {
    const key = t.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if ([...key].length < config.minTargetRunes) {
      tooShort.push(`「${key}」（${[...key].length} 字）`);
    }
  }
  if (tooShort.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.targetLength,
      `${seen.size} 个挖空 / 答案都 ≥ ${config.minTargetRunes} 字（中文定值：允许 1 个汉字，「熵」是完整术语）`);
  }
  return checkFail(QUIZ_CHECK_IDS.targetLength, `挖空 / 答案过短：${tooShort.join('、')}`);
}

// ── 警告层（只标记，不拦采纳，不占人工队列）──────────────────────

function checkOptionLengthSpread(item, config) {
  if (item.choices.length < 2) {
    return checkPass(QUIZ_CHECK_IDS.optionLengthSpread, '不适用：选项少于 2 个，谈不上分布');
  }
  const lens = item.choices.map((c) => [...c.text.trim()].length).sort((a, b) => a - b);
  const minLen = lens[0];
  const maxLen = lens[lens.length - 1];
  if (minLen <= 0) return checkPass(QUIZ_CHECK_IDS.optionLengthSpread, '有选项文本为空（已由 schema 项拦下）');
  const mid = lens[Math.floor(lens.length / 2)];
  const ratio = maxLen / minLen;
  const vsMedian = mid === 0 ? 0 : maxLen / mid;
  const problems = [];
  if (ratio > config.maxOptionLengthRatio) {
    problems.push(`最长 ÷ 最短 = ${ratio.toFixed(2)} > ${config.maxOptionLengthRatio}`);
  }
  if (vsMedian > config.maxOptionLengthVsMedian) {
    problems.push(`最长 ÷ 中位 = ${vsMedian.toFixed(2)} > ${config.maxOptionLengthVsMedian}`
      + '（「正确答案最长」是出题人最常留下的线索）');
  }
  if (problems.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.optionLengthSpread,
      `长度 ${minLen}–${maxLen} 字，最长 ÷ 最短 = ${ratio.toFixed(2)}`);
  }
  return checkFail(QUIZ_CHECK_IDS.optionLengthSpread, `选项长度分布不均衡：${problems.join('；')}`);
}

function checkUnitConsistency(item) {
  if (item.choices.length < 2) {
    return checkPass(QUIZ_CHECK_IDS.unitConsistency, '不适用：选项少于 2 个');
  }
  const byUnit = new Map();
  let parsedCount = 0;
  for (const c of item.choices) {
    const v = parseNumericValue(c.text);
    if (v === null) continue;
    parsedCount++;
    if (v.unit === '') continue;
    byUnit.set(v.unit, [...(byUnit.get(v.unit) ?? []), c.label]);
  }
  if (parsedCount === 0) return checkPass(QUIZ_CHECK_IDS.unitConsistency, '不适用：选项里没有数值，谈不上单位');
  if (byUnit.size === 0) {
    return checkPass(QUIZ_CHECK_IDS.unitConsistency,
      `${parsedCount} 个数值选项都没有单位（没有单位不是问题，不因此报）`);
  }
  if (byUnit.size === 1) {
    return checkPass(QUIZ_CHECK_IDS.unitConsistency, `单位一致：都是「${[...byUnit.keys()][0]}」`);
  }
  return checkFail(QUIZ_CHECK_IDS.unitConsistency,
    `选项里混用了 ${byUnit.size} 种单位：`
    + `${[...byUnit.entries()].map(([k, v]) => `${k}（${v.join('/')}）`).join('、')}`
    + '—— 标记而已，不拦采纳：题干自己给量纲、干扰项故意用别的单位（单位换算题）是合法形态',
    ['不在选项里的单位无法检查']);
}

function checkRoundingNote(item, source, config) {
  const ans = parseNumericValue(item.answerContent());
  if (ans === null) return checkPass(QUIZ_CHECK_IDS.roundingNote, '不适用：答案不是可精确解析的数值');
  if (source === null || source === undefined || source.groundingText.trim() === '') {
    // ⚠️ 这一条**必须有源材料**才能判：只看题面，`0.25` 与 `1.41` 在结构上同类
    //    （都是有限小数），无法判断哪个是精确值、哪个是舍入值。
    return checkUndecided(QUIZ_CHECK_IDS.roundingNote,
      '没有拿到源材料：无法判断这个数值是不是**舍入值**（只看题面判不了，所以不猜）');
  }
  const rawAns = item.answerContent().trim();
  const candidates = [];
  const re = /[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+|\/\d+)?\s*%?[A-Za-zµΩ°·/]*/g;
  for (const m of source.groundingText.matchAll(re)) {
    const raw = m[0];
    if (raw.trim() === rawAns) continue; // 同一个写法不是「更精确的源值」
    const v = parseNumericValue(raw);
    if (v === null) continue;
    if (v.unit !== ans.unit && v.unit !== '' && ans.unit !== '') continue;
    if (v.equalsValue(ans)) continue;
    if (raw.length <= rawAns.length) continue; // 源材料不比答案更精确
    const tol = config.roundingTolerance * (Math.abs(ans.value) < 1 ? 1 : Math.abs(ans.value));
    if (Math.abs(v.value - ans.value) > tol) continue;
    candidates.push(v);
  }
  if (candidates.length === 0) {
    return checkPass(QUIZ_CHECK_IDS.roundingNote, '源材料里没有「更精确且接近」的数值：不涉及舍入');
  }
  const hint = kRoundingHintPattern.test(`${item.stem} ${item.answer}`);
  if (hint) {
    return checkPass(QUIZ_CHECK_IDS.roundingNote,
      `答案 ${ans.value} 是源值 ${candidates.map((c) => c.value).join('/')} 的舍入，且题面写了舍入说明`);
  }
  return checkFail(QUIZ_CHECK_IDS.roundingNote,
    `答案 ${ans.value} 接近源材料里的更精确值 ${candidates.map((c) => c.value).join('/')}，`
    + `但题面没有任何舍入说明（认 ${kRoundingHintPattern.source}）`);
}

function checkAnswerNotInStem(item) {
  const content = item.answerContent();
  if (content.trim() === '') {
    return checkUndecided(QUIZ_CHECK_IDS.answerNotInStem, '答案为空（已由 schema 项拦下），无从判断是否泄题');
  }
  // 挖空模板 `{{…}}` / `[[…]]` 里的文本在**渲染后**会被挖掉，所以先把它摘掉再查，
  // 否则每一道填空题都会被判「答案是印在题干里的」—— 那是假阳性。
  const rendered = item.stem
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/_{3,}/g, ' ');
  const stem = normalizeForMatch(rendered);
  const ans = normalizeForMatch(content);
  if (stem === '' || ans === '') {
    return checkPass(QUIZ_CHECK_IDS.answerNotInStem, '不适用：题干或答案为空');
  }
  // ⚠️ 严格度按**字符种类**定：拉丁词要 ≥4 个字符（"a" / "to" / "the" 出现在题干里
  //    是正常的语法，不是泄题），而 CJK 只要 ≥2 个字（「熵」这类单字术语在题干里
  //    出现是**语法**的一部分，跳过；「牛顿第二定律」出现在题干里就是泄题）。
  const isCjkOnly = /^[\u4e00-\u9fff]+$/.test(ans);
  const enough = isCjkOnly ? [...ans].length >= 2 : ans.length >= 4;
  if (!enough) {
    return checkPass(QUIZ_CHECK_IDS.answerNotInStem,
      `不适用：答案「${content}」短于泄题判定的最小长度（拉丁 ≥4 字符 / 汉字 ≥2 字）`);
  }
  if (stem.includes(ans)) {
    return checkFail(QUIZ_CHECK_IDS.answerNotInStem, `答案是「${content}」，已经印在（渲染后的）题干里`);
  }
  return checkPass(QUIZ_CHECK_IDS.answerNotInStem, '答案没有印在（渲染后的）题干里');
}

// ── 第一层的对外入口 ────────────────────────────────────────────

/**
 * **第一层：确定性硬检查**。近零成本、**不调用任何模型**。
 *
 * `source` 是这道题的源块。为空时【答案在源材料里有依据】与【锚点一致】
 * 判 `undecided`（**不是** `pass`）——「拿不到数据」和「数据说没问题」是两件事，
 * 前者必须进人工队列。
 */
export function runHardChecks(item, { source = null, config = kQuizHardCheckDefaults } = {}) {
  const checks = [
    checkSchema(item),
    checkJsonRoundTrip(item),
    checkSingleCorrect(item),
    checkOptionCount(item, config),
    checkDuplicateOptions(item),
    checkNumericEquivalence(item),
    checkAnswerInSource(item, source),
    checkAnchorBacklink(item, source),
    checkBlankMarker(item),
    checkBlankCount(item, config),
    checkForbiddenTarget(item, config),
    checkTargetLength(item, config),
    checkOptionLengthSpread(item, config),
    checkUnitConsistency(item),
    checkRoundingNote(item, source, config),
    checkAnswerNotInStem(item),
  ];
  return makeHardCheckReport(checks, config);
}

/** 第一层跑完的结果。 */
export function makeHardCheckReport(checks, config = kQuizHardCheckDefaults) {
  const hard = checks.filter((c) => c.severity === QUIZ_SEVERITIES.hard);
  const warn = checks.filter((c) => c.severity === QUIZ_SEVERITIES.warn);
  const hardFails = hard.filter(isFail);
  const hardUndecided = hard.filter(isUndecided);
  return {
    checks: [...checks],
    config,
    hard,
    warn,
    /** 硬检查里判 `fail` 的（有名字、可重试：模型拿这条名字重新出题即可）。 */
    hardFails,
    /** 硬检查里**判不了**的（输入不在场）。这些**不许**自动采纳，进人工队列。 */
    hardUndecided,
    /** 警告层标记的（不拦采纳、不占人工队列）。 */
    warnFlags: warn.filter(isFail),
    /**
     * **结构合法**：全部硬检查都判 `pass`。
     *
     * ⚠️ 这个为真**不代表题目值得做**：实测 120/122 通过全部硬检查，
     * 但仍有 8/120 被警告层标记 → **硬检查保证结构，不保证教学正确**。
     */
    passedAll: hard.every((c) => c.verdict === CHECK_VERDICTS.pass),
    /** 没有硬失败 → 可以继续走第二 / 三层。 */
    canProceed: hardFails.length === 0,
    /** 有硬项判不了 → **必须**进人工，不许自动采纳。 */
    requiresHumanReview: hardUndecided.length > 0,
    /** 失败项的名字（可重试的把手）。 */
    failedIds: hardFails.map((c) => c.id.code),
    /** 判不了项的名字。 */
    undecidedIds: hardUndecided.map((c) => c.id.code),
  };
}

// ═══════════════════════════════════════════════════════════════
// 第二层：可回答性校验（低）
// ═══════════════════════════════════════════════════════════════

/** 独立问答 / NLI 的判定。 */
export const ANSWERABILITY_VERDICTS = Object.freeze({
  /** 材料足以回答。 */
  answerable: Object.freeze({ code: 'answerable', label: '可答' }),
  /** 材料不足以回答 → 这一题**不得**进「可采纳」集合。 */
  notAnswerable: Object.freeze({ code: 'notAnswerable', label: '不可答' }),
  /** 判定器自己说不准 / 调用失败。**不许**当成可答 —— 失败要有名字，进人工。 */
  undecided: Object.freeze({ code: 'undecided', label: '判不了' }),
});

/**
 * ⚠️ **这个请求只有两个字段，而且故意没有「正确答案」**：本层要回答的问题是
 * 「**只给这一段材料，这道题能不能被回答**」。把预期答案也塞给判官，
 * 这个判官就变成「确认答案对不对」的自证。
 */
export function makeAnswerabilityRequest({ question, passage }) {
  return { question, passage };
}

/** 假实现：**不接判官就判「判不了」**，而不是判「可答」。 */
export function unavailableAnswerabilityChecker() {
  return {
    async answerable() {
      return {
        verdict: ANSWERABILITY_VERDICTS.undecided,
        detail: '没有接入可回答性判官（AnswerabilityChecker 未注入）：无法判定，进人工队列。'
          + '⚠️ 这里**不**回落到「可答」—— 拿不到数据就是拿不到数据',
      };
    },
  };
}

/** 固定回答的假实现（测试 / 离线校准用）。它**如实**记录自己收到的请求。 */
export function scriptedAnswerabilityChecker(result) {
  const calls = [];
  return {
    calls,
    async answerable(request) {
      calls.push(request);
      return result;
    },
  };
}

/**
 * 第二层。返回 `null` 表示**没跑**（硬检查就挂了），与「跑了但判不了」区分开。
 *
 * ⚠️ 只发**题干**，不发答案、不发选项 —— 见 `makeAnswerabilityRequest` 的注释。
 */
export async function runAnswerability(item, { source = null, checker } = {}) {
  if (source === null || source === undefined) {
    return {
      verdict: ANSWERABILITY_VERDICTS.undecided,
      detail: '没有拿到源块（sourceBlock=null），只给该块原文这一条**做不到** → 进人工',
    };
  }
  try {
    return await checker.answerable(makeAnswerabilityRequest({
      question: item.stem,
      passage: source.groundingText,
    }));
  } catch (e) {
    // 失败要有名字、可重试 —— **不许**静默当成可答。
    return {
      verdict: ANSWERABILITY_VERDICTS.undecided,
      detail: `可回答性判官调用失败：${e}（可重试；这次不算可答）`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 第三层：grounded judge（中）
// ═══════════════════════════════════════════════════════════════

/**
 * 与题目正交的**教学维度**（pluckability 那一类判断的落点）。
 *
 * ⚠️ **这不是通用 rubric**。它只声明「哪些维度要判」，**不给判分标准** ——
 * 标准由 `goodExamples` / `badExamples` 里**同一源材料上已人工标注的样例**提供。
 * 每个 `question` 都是**相对于样例**的问法，这样即使换成别的领域，
 * 标准也仍然来自**该领域的样例**而不是这份清单。
 */
export const QUIZ_TRAITS = Object.freeze([
  Object.freeze({
    code: 'pluckability',
    label: '值得独立回忆',
    question: '与上面被人工采纳 / 否掉的样例相比，这一题考的东西是一个会被**单独**取出来的知识点吗？',
  }),
  Object.freeze({
    code: 'selfContained',
    label: '脱离讲义能读懂',
    question: '与样例相比，一个没上过这节课的人能读懂题干吗（不依赖「如图」「上式」这类指代）？',
  }),
  Object.freeze({
    code: 'unambiguous',
    label: '答案唯一无争议',
    question: '与样例相比，这一题的答案会不会引出**多个**都说得通的答案？',
  }),
]);

/** grounded judge 的判定。 */
export const GROUNDED_VERDICTS = Object.freeze({
  /** 与好样例同类、与坏样例不同类 → **建议采纳**（仍由用户一键采纳，不自动入库）。 */
  betterThanBad: Object.freeze({ code: 'betterThanBad', label: '更像好样例' }),
  /** 像坏样例 → 退回（不采纳）。 */
  likeBad: Object.freeze({ code: 'likeBad', label: '更像坏样例' }),
  /**
   * 裁判自己说不准。
   *
   * ⚠️ 这一档**有明确去向**：进**人工队列**。它**不是**「拿不准就放行」——
   * 那会把人工环节的入口堵死（人工队列恒为空）。
   */
  uncertain: Object.freeze({ code: 'uncertain', label: '拿不准' }),
});

/**
 * grounded judge 的**固定指令部分**。
 *
 * ⚠️ 注意它**没有**「什么叫好题」的定义：好 / 坏的标准全部来自请求里的同源人工样例。
 */
export const kGroundedJudgeSystemPrompt = `你是一个出题质检员。你**不做**通用评价，只做**局部比较**。

我会给你四样东西：
1. 一段源材料（这道题和所有样例都出自它）；
2. 若干条**已经人工采纳**的样例；
3. 若干条**已经被人工否掉**的样例；
4. 一条待判的候选题。

请你只回答一件事：**候选更像哪一类**。
不要让任何外部标准介入 —— 你手上的样例就是标准本身。
如果样例不足以让你判断，回答 \`uncertain\`（这一档会进人工队列，**不是**放行）。
不要给分数、不要给分档：分数会把判断伪装成精确的。`;

/**
 * 提示词里**禁止出现**的通用评分口径。
 *
 * 通用 rubric 已被实证**无效**（而 grounded 把 pluckability 精确率 56%→78%、
 * 假阳性 52%→17%）。让这条纪律只活在注释里，它迟早会被一句
 * 「顺手给模型讲讲什么叫好题」抹掉；做成会抛错的断言，它才活得下来。
 */
export const kForbiddenPromptPhrases = Object.freeze([
  '评分标准', '打分标准', '打分表', '评分细则', '评分量表', '评分维度',
  '满分', '及格线', '按以下标准', '按下列标准', 'rubric', 'scoring guide',
]);

/** 核验一段**指令**里没有通用评分口径；有就抛 `QuizError`。 */
export function assertNoGenericRubric(instruction) {
  const lowered = String(instruction).toLowerCase();
  for (const bad of kForbiddenPromptPhrases) {
    if (lowered.includes(bad.toLowerCase())) {
      throw new QuizError('RUBRIC',
        `grounded judge 的**指令**里出现了通用评分口径「${bad}」。`
        + '通用 rubric 已被实证无效：判据必须来自**同源人工样例**。');
    }
  }
}

/** 组装 grounded judge 的提示词：**同源好 / 坏样例 + 相对比较的问法**。 */
export function buildGroundedJudgePrompt(req) {
  const lines = [];
  lines.push(kGroundedJudgeSystemPrompt, '');
  lines.push('## 源材料（这道题与全部样例都出自这里）');
  lines.push(req.passage.trim() === '' ? '（空）' : req.passage.trim(), '');
  lines.push(`## 已人工采纳的样例（${req.goodExamples.length} 条）`);
  if (req.goodExamples.length === 0) lines.push('（一条都没有）');
  else req.goodExamples.forEach((e, i) => lines.push(`G${i + 1}. ${e}`));
  lines.push('', `## 已被人工否掉的样例（${req.badExamples.length} 条）`);
  if (req.badExamples.length === 0) lines.push('（一条都没有）');
  else req.badExamples.forEach((e, i) => lines.push(`B${i + 1}. ${e}`));
  lines.push('', '## 待判的候选');
  lines.push(`题干：${req.candidateStem}`);
  if (req.candidateChoices.length > 0) {
    lines.push('选项：');
    for (const c of req.candidateChoices) lines.push(`  ${c}`);
  }
  lines.push(`答案：${req.candidateAnswer}`, '');
  lines.push('## 逐维度回答（每条都**相对于上面的样例**，不要引入外部标准）');
  for (const t of req.traits) lines.push(`- ${t.code}（${t.label}）：${t.question}`);
  lines.push('', '最后给一个总判定：betterThanBad / likeBad / uncertain。');

  const prompt = lines.join('\n');
  // ⚠️ 只核验**指令部分**（scaffold + 维度问法），**不**核验材料 / 样例 / 候选题：
  //    那些是**数据**（讲义原文里出现「满分」「及格线」是正常的），
  //    对数据做关键词门禁会误伤真实材料。要防的是**有人往指令里写通用标准**。
  assertNoGenericRubric(kGroundedJudgeSystemPrompt);
  for (const t of req.traits) assertNoGenericRubric(t.question);
  if (req.goodExamples.length === 0 || req.badExamples.length === 0) {
    // ⚠️ 只有好样例或只有坏样例同样判不了：局部比较缺一侧就没有对照物。
    // 这里不抛错（那是调用方该决定的事），但要**落在提示词里**，
    // 免得裁判在缺一侧时照样给一个自信的结论。
    return `${prompt}\n（注意：样例只有一侧，任何结论都应当回答 uncertain。）`;
  }
  return prompt;
}

/**
 * 从题目与源块组装 grounded judge 请求。
 *
 * ⚠️ `goodExamples` / `badExamples` **只能**来自源块（**同一源材料**上已人工标注的样例）。
 * 所以这个函数要求源块 —— 没有源块就没有 grounded 判据，那就只能进人工。
 */
export function buildGroundedJudgeRequest(item, source) {
  return {
    passage: source.groundingText,
    candidateStem: item.stem,
    candidateAnswer: item.answer,
    candidateChoices: item.choices.map((c) => `${c.label}. ${c.text}`),
    goodExamples: source.goodExamples,
    badExamples: source.badExamples,
    traits: QUIZ_TRAITS,
  };
}

/** 假实现：**不接裁判就判「拿不准」**，而不是判「像好样例」。 */
export function unavailableGroundedJudge() {
  return {
    async judge() {
      return {
        verdict: GROUNDED_VERDICTS.uncertain,
        rationale: '没有接入 grounded 裁判（GroundedJudge 未注入）：进人工队列。'
          + '⚠️ 不回落到「像好样例」—— 拿不到判断就说拿不到',
        grounded: false,
      };
    },
  };
}

/** 固定回答的假实现（测试 / 离线校准用）。 */
export function scriptedGroundedJudge(result) {
  const calls = [];
  return {
    calls,
    async judge(request) {
      calls.push(request);
      return result;
    },
  };
}

/** 第三层。返回 `null` 表示**没跑**。 */
export async function runGroundedJudge(item, { source = null, judge } = {}) {
  if (source === null || source === undefined) {
    return {
      verdict: GROUNDED_VERDICTS.uncertain,
      rationale: '没有源块 → 没有同源人工样例 → grounded 比较做不了（通用 rubric 不许用）',
      grounded: false,
    };
  }
  try {
    const req = buildGroundedJudgeRequest(item, source);
    // 先跑一次「提示词组装」：它会在**任何模型调用之前**核验提示词里没有通用评分口径
    // （有就抛错）。宁可在这里报错，也不要发出一条带 rubric 的请求。
    buildGroundedJudgePrompt(req);
    return await judge.judge(req);
  } catch (e) {
    return {
      verdict: GROUNDED_VERDICTS.uncertain,
      rationale: `grounded 裁判调用失败：${e}（可重试；这次按「拿不准」处理，进人工）`,
      grounded: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 四层防线的编排
// ═══════════════════════════════════════════════════════════════

/** 一致性**不得**作为放行阈值（见文件头）。 */
export const kAgreementGatingBanReason =
  '一致性不得作为放行阈值：ρ 仅 0.20–0.59、最一致的模型校准最差、高一致性里 48% 是错的。'
  + '它只能用于排序与分配算力。';

/**
 * 质检链本体：**成本从低到高**，任何一层挂了就不往下走。
 *
 * ⚠️ 顺序**不许**倒过来：第一层近零成本且不用 LLM，先跑它能在花任何模型钱之前
 * 丢掉结构就不合法的题。倒过来的代价不是「慢」，而是**把模型预算花在了会被
 * 硬检查丢掉的题上**。
 */
export function createQualityPipeline({
  answerability = unavailableAnswerabilityChecker(),
  judge = unavailableGroundedJudge(),
  config = kQuizHardCheckDefaults,
} = {}) {
  /**
   * 跑完四层（第四层是**人**，不在这里跑完 —— 这里只负责把人该看的挑出来）。
   *
   * @returns {Promise<object>} 见 `QuizTriagedQuiz` 的形状：
   *   `{item, source, hard, answerability, judge, answerable, judgeUnsure, admitted, needsHuman, reason}`
   */
  async function evaluate(item, { source = null } = {}) {
    // ── 第一层：确定性硬检查（不用 LLM）────────────────────────
    const hard = runHardChecks(item, { source, config });
    if (hard.hardFails.length > 0) {
      return {
        item,
        source,
        hard,
        answerability: null,
        judge: null,
        answerable: false,
        judgeUnsure: false,
        admitted: false,
        needsHuman: hard.requiresHumanReview,
        reason: `硬检查不通过（${hard.failedIds.join('、')}）→ 直接丢弃。`
          + '依据：结构硬检查不通过**直接丢，不用 LLM 判**',
      };
    }

    // ── 第二层：可回答性（只给该块原文）──────────────────────────
    const ans = await runAnswerability(item, { source, checker: answerability });

    if (ans.verdict === ANSWERABILITY_VERDICTS.notAnswerable) {
      return {
        item,
        source,
        hard,
        answerability: ans,
        judge: null,
        answerable: false,
        judgeUnsure: false,
        admitted: false,
        needsHuman: hard.requiresHumanReview,
        reason: '可回答性判定为**不可答**：只给这一块原文，这道题答不出来 → '
          + '**不得**进可采纳集合',
      };
    }

    // ── 第三层：grounded judge（同源好 / 坏样例局部比较）──────────
    const judged = await runGroundedJudge(item, { source, judge });

    // ── 结论：**每一层都要过**才够格给用户看 ────────────────────
    const hardUndecided = hard.hardUndecided.length > 0;
    const admitted = !hardUndecided
      && ans.verdict === ANSWERABILITY_VERDICTS.answerable
      && judged.verdict === GROUNDED_VERDICTS.betterThanBad;

    const reasons = [];
    if (hardUndecided) reasons.push(`硬检查有判不了的项（${hard.undecidedIds.join('、')}）`);
    if (ans.verdict === ANSWERABILITY_VERDICTS.undecided) reasons.push('可回答性判不了');
    if (judged.verdict === GROUNDED_VERDICTS.uncertain) reasons.push('裁判拿不准');
    if (judged.verdict === GROUNDED_VERDICTS.likeBad) reasons.push('裁判判定「更像坏样例」');

    const reason = admitted
      ? `过了硬检查（${hard.checks.length} 项）+ 可回答 + 更像同源好样例 → `
        + '**够格给用户看**（仍要用户点采纳才进队列）'
      : `不进可采纳集合：${reasons.join('；')} → `
        + `${judged.verdict === GROUNDED_VERDICTS.likeBad ? '退回修改' : '进人工队列（只审这一小部分）'}`;

    return {
      item,
      source,
      hard,
      answerability: ans,
      judge: judged,
      answerable: ans.verdict === ANSWERABILITY_VERDICTS.answerable,
      judgeUnsure: judged.verdict === GROUNDED_VERDICTS.uncertain,
      /**
       * ⚠️ `admitted` 为真**不代表**这道题会自动进复习队列：生成的题
       * **默认不直接进队列**，必须经用户一键采纳。这里只回答「它够格给用户看吗」。
       * 字段名刻意叫 `admitted`（「可采纳」）而不是 `accepted`：
       * 后者是**用户**的动作，机器不该替用户做完。
       */
      admitted,
      /**
       * 要人工看 = 硬检查有判不了的项，或裁判拿不准（人工**只审**这一小部分）。
       */
      needsHuman: hard.requiresHumanReview
        || judged.verdict === GROUNDED_VERDICTS.uncertain
        || ans.verdict === ANSWERABILITY_VERDICTS.undecided,
      reason,
    };
  }

  /**
   * 逐题跑。**串行**（不是 `Promise.all`）：质检链的每一层都可能打模型，
   * 并发会把「第几道题花了多少预算」这件事变得查不出来 —— 而生成速率与预算
   * 必须**显式呈现**。
   */
  async function evaluateAll(batch) {
    const out = [];
    for (const e of batch) out.push(await evaluate(e.item, { source: e.source ?? null }));
    return out;
  }

  return { evaluate, evaluateAll, answerability, judge, config };
}

/**
 * Wilson 区间（比例必须带区间或样本量，`n=0` 时**拒绝给数**）。
 *
 * ⚠️ 它只用于**展示**不确定度，**不得**当放行阈值（见 `kAgreementGatingBanReason`）。
 */
export function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(total) || total <= 0) return null; // 没有样本 → 拒绝给数
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
    n: total,
    successes,
  };
}

/** 带样本量 / 区间的比例文本。`n=0` 时返回「没有样本」而不是 0%。 */
export function ratioWithWilson(successes, total, { minN = 5, label = null } = {}) {
  const name = label ?? '比例';
  if (!Number.isInteger(total) || total <= 0) return `${name}：没有样本（n=0），不给数`;
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (total < minN) return `${name}：${successes}/${total}（n=${total} < ${minN}，样本太少，只报原始计数）`;
  const w = wilsonInterval(successes, total);
  return `${name}：${pct(successes / total)}（${successes}/${total}，95% 区间 ${pct(w.low)}–${pct(w.high)}）`;
}
