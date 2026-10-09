/**
 * `generate.js` —— R4（第 3 期）**填空 / 短答**的出题层。
 *
 * # 规格来源
 *
 * 逐条对齐 App 的 `lib/fusion/quiz_generate.dart`（先筛后出、每块两次调用、
 * 提示词与请求体、规则门禁、拒绝/问题**有名字**都照抄，**不自己发明算法**）。
 *
 * # 这一层只出两类题，而且**先筛后出**
 *
 * 四类题按**验证成本**分成两批：填空（成本最低）与短答（**不需要构造干扰项**、
 * 诊断价值最高）先上；选择题要造干扰项（实测 AI 干扰项仅 **45%** 功能有效），
 * 留到后面。所以题型白名单是 `kPhase3QuizTypes`：请求里出现别的题型 →
 * **明确拒绝**，不做「顺手也出一题」这种事（那会绕过质检链的验证顺序）。
 *
 * **先筛后出**是这一层最容易被做错的地方：COSER 实测原话是「用全部字幕 /
 * 关键帧当上下文，**在多数情况下效果最差**」，而 **`+Rewrite`**
 * （把材料改写成含答案的知识陈述）才是主要收益来源。所以：
 *
 * 1. **输入单位是「已经筛过的块」**，不是整节：每块必须写明它是**怎么被选中的**
 *    （`selection`），其中 `wholeSection` 会被 `planQuizGeneration` **拒绝** ——
 *    「整节一把丢」这条路径在**类型上**就走不通；
 * 2. **每次都先 Rewrite 再出题**：对每块**发两次调用**
 *    （先 `buildRewritePrompt`，再 `buildGenerationPrompt`），第二段拿到的输入是
 *    **陈述句**而不是原始 ASR。这两步的先后由返回值的 `calls` 记录，
 *    测试据此断言，而不是靠注释。
 *
 * # 生成物**默认不入库**
 *
 * 生成的题 `status = 'proposed'`，**不进复习队列**，必须用户一键采纳。
 * 本文件里**没有任何**把 `proposed` 改成 `accepted` 的路径 —— 那个动作在
 * `store.js` 里，且只有用户动作能触发。
 *
 * # 三道「不许」在这一层的样子
 *
 * - **不许静默失败**：被规则挡下的草稿进 `rejected`，每条**带名字**
 *   （规则名或检查项 `code`）与原文；解析失败的响应进 `problems`。
 *   **一条都不丢，只是不采用**。
 * - **不许假装完成**：没接质检判官时质检链会给 `undecided`（→ 进人工队列），
 *   本层**照实**把 `admitted=false` 传出去，不因为「用户点了生成」就宣称质检通过。
 * - **不许假装准确**：模型返回的页号 / 时间戳一律**不采用** —— 锚点只从源块取
 *   （见 `anchorFromMaterial`）。模型给的锚点与源块不一致时留一条警告文本，
 *   而不是悄悄覆盖。
 */

import {
  QUIZ_STATUSES, QUIZ_TYPES, makeItem, withItem,
} from './model.js';
import {
  QuizError, countBlanks, kQuizBlankMarkers, kQuizHardCheckDefaults,
} from './quality.js';

// ═══════════════════════════════════════════════════════════════
// 常量：本轮题型白名单、数量口径、禁用词
// ═══════════════════════════════════════════════════════════════

/**
 * 第 3 期允许的题型（填空 + 短答）。**别的题型一律拒绝**。
 *
 * ⚠️ 这是默认值，也就是**保守**的那一档：想要选择题必须显式传 `kPhase4QuizTypes`。
 */
export const kPhase3QuizTypes = Object.freeze([QUIZ_TYPES.cloze, QUIZ_TYPES.shortAnswer]);

/**
 * 第 4 期允许的题型（第 3 期 + 选择题 + 案例题）。
 *
 * ⚠️ 它**不是**默认值，这是有意的：最贵的一档要放在质检链路验证之后 ——
 * 先用便宜的题型把整条链路跑通并留下评测数，再上选择题。所以
 * 「不小心多出一个题型」这条路径要撞墙：白名单必须**显式**给。
 */
export const kPhase4QuizTypes = Object.freeze([
  QUIZ_TYPES.cloze, QUIZ_TYPES.shortAnswer, QUIZ_TYPES.mcq, QUIZ_TYPES.caseStudy,
]);

/** 选择题的**选项个数**（4 是四选一的默认；下限 3 与上限 6 由硬检查把关）。 */
export const kMcqOptionCount = 4;

/** 案例题至少要几块材料（案例题要**综合多块** + 应用层）。 */
export const kMinCaseMaterials = 2;

/**
 * 至少要几个**干扰项候选**才允许出一道选择题。
 *
 * 3 = 四选一减去正确答案。少于 3 个候选就**不出选择题**（而不是让模型临时编两个）
 * —— 干扰项必须来自**同域材料**，「凭空造」既是最劣的做法，也是实测里只 45%
 * 功能有效的那个数字的来源。
 */
export const kMinDistractorCandidates = 3;

/**
 * 干扰项文本与所引材料的**最低可追溯性**：共享子串的**字符数**下限。
 *
 * ⚠️ 定值取 **2 个汉字 / 4 个拉丁字符**，与「泄题判定」同一口径：
 * 中文 2 字才有信息量（「熵」这种单字术语单独出现在两段材料里是巧合），
 * 而拉丁词 4 字符起（`the`/`and` 这种出现在任何材料里都不构成证据）。
 */
export const kMinTraceableCjkRun = 2;
export const kMinTraceableLatinRun = 4;

/**
 * 目标密度下限：**1.5 张 / 页**。
 *
 * 依据开发者复盘：35 页讲义生成 **259 张卡**（7+ 张/页），用户评价
 * 「**80–90% 可以直接删掉**」；同一批复盘给出的三条便宜规则之一就是
 * **目标 1.5–2.5 张/页**（35 页 → ~52 张）。
 */
export const kTargetCardsPerPageMin = 1.5;

/** 目标密度上限：**2.5 张 / 页**（同上）。 */
export const kTargetCardsPerPageMax = 2.5;

/** 每卡最多几个挖空。**2**（每卡 ≤2 个 cloze）。 */
export const kMaxBlanksPerCard = 2;

/**
 * **一次请求**最多选几块。
 *
 * 6 是个产品判断，不是实测阈值，所以**不编造依据**：它的作用是让「整节一把丢」
 * 在参数层面就撞墙。实测依据只是「上下文越多越差」这条方向性的结论，
 * 具体数字按一节通常 4–8 块取。
 */
export const kMaxMaterialsPerRequest = 6;

/** 单选一块（一键成题）时用的上限：就是 1。 */
export const kSingleBlockMaterialCount = 1;

/**
 * **本包已实现构造路径的题型**（第 3 期：填空 / 短答）。
 *
 * ⚠️ 它与 `kPhase3QuizTypes` 值相同但**含义不同**，所以是两个常量：
 * - `kPhase3QuizTypes` 是 **App 的分期白名单**（「这一期产品上先上哪两类」）；
 * - `kImplementedQuizTypes` 是 **本包的实现范围**（「本包的代码里真的有这条构造路径吗」）。
 *
 * 两者的值今天恰好一样。一旦 App 上了第 4 期，白名单会变成四类，
 * 而本包的实现范围**不会**跟着变 —— 那时把两者合成一个常量，
 * 就会让「白名单允许」被静默读成「本包实现好了」。
 * 这是本仓「不许假装完成」在常量表上的落点。
 */
export const kImplementedQuizTypes = Object.freeze([QUIZ_TYPES.cloze, QUIZ_TYPES.shortAnswer]);

/**
 * 填空题的禁用词表 —— **复用质检链的那一份**，不另立一份。
 *
 * ⚠️ 两份表是最容易发生的漂移：生成侧放行一个词、质检侧判它 fail，
 * 于是每一张含这个词的卡都要来回一次人工。单一真相在这里比多一层解耦重要。
 */
export const kClozeForbiddenTerms = kQuizHardCheckDefaults.forbiddenTargetTerms;

/** 术语表 / 禁用词命中的**名字**（失败要有名字）。 */
export const kForbiddenTermRuleName = 'forbiddenTargetTerm';

// ═══════════════════════════════════════════════════════════════
// 输入：已筛的块
// ═══════════════════════════════════════════════════════════════

/** 这一块是**怎么被选中的**（先筛后出的「筛」必须可追问）。 */
export const QUIZ_MATERIAL_SELECTIONS = Object.freeze({
  /** 用户在逐字稿 / 看课页上显式选中了它（先筛后出的首选单位）。 */
  userSelected: Object.freeze({ code: 'userSelected', label: '用户选中' }),
  /** 用户标记过 → 按标记出题。 */
  markedBlock: Object.freeze({ code: 'markedBlock', label: '已标记的块' }),
  /** 同节**相邻块**的 summary —— 只用于「补充上下文」，不单独作为出题单位。 */
  adjacentSummary: Object.freeze({ code: 'adjacentSummary', label: '相邻块摘要（只作补充）' }),
  /**
   * ⚠️ **整节**。这一档存在**只为了被拒绝**：请求里出现它就说明调用方
   * 在「整节一把丢」，而那正是先筛后出要拦的路径。
   */
  wholeSection: Object.freeze({ code: 'wholeSection', label: '整节（禁止：先筛后出）' }),
});

/**
 * 一块**已融合**的材料（出题的最小单位）。
 *
 * ⚠️ `summary` 在场时**优先用它**，而不是 `text`（原始 ASR）：
 * 「优先用已融合的页级笔记，而不是原始 ASR」。两个都在场时取 summary
 * 并留一条「用了 summary」的痕迹（`materialSource`）。
 */
export function makeSourceMaterial({
  blockIndex,
  page,
  atSec,
  summary = null,
  facets = [],
  text = '',
  pointIds = [],
  selection = QUIZ_MATERIAL_SELECTIONS.markedBlock,
}) {
  const material = {
    blockIndex,
    page,
    atSec,
    summary,
    facets: [...facets],
    text,
    pointIds: [...pointIds],
    selection,
  };
  /** 真正要发给出题模型的材料（summary 优先）。 */
  material.materialText = () => {
    const s = (summary ?? '').trim();
    if (s !== '') return s;
    return text.trim();
  };
  /** 用了 summary 还是原始正文（测试与日志都用它，别去猜）。 */
  material.materialSource = () => (((summary ?? '').trim() !== '') ? 'summary' : 'rawText');
  /** 材料是否为空（空的不能出题，且**要说出来**，不许悄悄跳过）。 */
  material.isEmpty = () => material.materialText() === '';
  return material;
}

// ═══════════════════════════════════════════════════════════════
// 干扰项候选：**只能来自同域材料**
// ═══════════════════════════════════════════════════════════════

/**
 * 规范化用于**可追溯性**比对的文本。
 *
 * 与质检链的 `normalizeOptionText` 同口径（全角→半角、去空白、去大小写、
 * 去尾部标点、去选项标号前缀）。**照抄同一套规则**并留一条测试把
 * 「两处口径一致」钉住 —— 不对齐的代价是**假阴性**（明明追得到却判不追到）
 * → 会把好选项挡掉。
 */
export function normalizeForTrace(s) {
  let t = String(s).replace(/\u3000/g, ' ').replace(/\s+/g, '').toLowerCase();
  // 全角 → 半角
  let folded = '';
  for (const ch of t) {
    const r = ch.codePointAt(0);
    folded += (r >= 0xff01 && r <= 0xff5e) ? String.fromCodePoint(r - 0xfee0) : ch;
  }
  t = folded;
  // 去尾部标点
  while (t !== '' && '。．.,，;；:：!！?？、'.includes(t[t.length - 1])) {
    t = t.slice(0, -1);
  }
  // 去开头选项标号。
  // ⚠️ 字母支与数字支必须分开（同 `quality.js` 的 `stripLabelPrefixForOption`）。
  //    数字支的 `(?!\d)`：标号后紧邻不许是数字 —— 否则 `0.5` 会变成 `5`，
  //    于是一条本该可追溯的干扰项会被判成「追不到同域材料」而**误杀**。
  const m = /^([a-z])[.)、:：]/.exec(t) ?? /^([0-9]{1,2})[.)、:：](?!\d)/.exec(t);
  if (m !== null) t = t.slice(m[0].length);
  return t;
}

function isCjkRun(s) {
  for (const ch of s) {
    const r = ch.codePointAt(0);
    if (r >= 0x4e00 && r <= 0x9fff) return true;
  }
  return false;
}

/** 最长公共**连续**子串（朴素实现；选项与材料都很短，够用）。 */
function longestCommonRun(a, b) {
  if (a === '' || b === '') return '';
  let best = '';
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.length) best = a.slice(i - cur[j], i);
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 判一条干扰项**是不是真的来自** `pool` 里某一块。
 *
 * 判据（**确定性、不看语义**）：规范化之后，干扰项与某一候选材料之间要么
 * **存在包含关系**，要么共享一段 ≥ 2 汉字 / 4 拉丁字符的子串。
 *
 * ⚠️ 刻意**不**用「语义相似度 / embedding」：那会把「凭什么算来自同一块」
 * 变成一个不可复算的判断，而这一条要拦的是**凭空造干扰项**。
 * 共享子串是**可复算、可人工核对**的：追不到时报告里会印出两段原文。
 *
 * @param {string} distractorText
 * @param {{pool: Array<{index:number, material:object, text:string, quote:string}>, claimedBlockIndex?:number|null}} options
 * @returns {{distractorText:string, claimedBlockIndex:number|null, traced:boolean, detail:string}}
 */
export function distractorTraceability(distractorText, { pool, claimedBlockIndex = null } = {}) {
  const norm = normalizeForTrace(distractorText);
  if (norm === '') {
    return {
      distractorText, claimedBlockIndex, traced: false,
      detail: '干扰项文本为空：追不到任何材料',
    };
  }

  // 声称了来源块 → **只在该块**里找（这才是「追回同域材料」的意思；
  // 在全池里找会让「声称块 A、其实抄的块 B」被判通过）。
  const scoped = claimedBlockIndex === null
    ? pool
    : pool.filter((c) => c.material.blockIndex === claimedBlockIndex);
  if (claimedBlockIndex !== null && scoped.length === 0) {
    const have = [...new Set(pool.map((c) => c.material.blockIndex))].join('、');
    return {
      distractorText, claimedBlockIndex, traced: false,
      detail: `声称来自块 ${claimedBlockIndex}，但干扰项池里没有这一块 —— `
        + `**不猜**它来自哪（池里只有 ${have}）`,
    };
  }

  for (const c of scoped) {
    const src = normalizeForTrace(c.quote);
    if (src === '') continue;
    // ① 包含关系（任一方向）：`摩擦系数为零` vs 材料里的 `…摩擦系数为零，因此…`
    if (src.includes(norm) || norm.includes(src)) {
      return {
        distractorText,
        claimedBlockIndex: c.material.blockIndex,
        traced: true,
        detail: `与块 ${c.material.blockIndex} 的原文存在包含关系`
          + `（${norm.length < src.length ? '干扰项是原文的一部分' : '原文是干扰项的一部分'}）`,
      };
    }
    // ② 共享一段足够长的子串
    const run = longestCommonRun(norm, src);
    const need = isCjkRun(norm) ? kMinTraceableCjkRun : kMinTraceableLatinRun;
    if (run.length >= need) {
      return {
        distractorText,
        claimedBlockIndex: c.material.blockIndex,
        traced: true,
        detail: `与块 ${c.material.blockIndex} 共享「${run}」（${run.length} 字符）`,
      };
    }
  }

  const need = isCjkRun(norm) ? kMinTraceableCjkRun : kMinTraceableLatinRun;
  return {
    distractorText, claimedBlockIndex, traced: false,
    detail: `在${claimedBlockIndex === null ? '干扰项池' : `块 ${claimedBlockIndex}`}里`
      + `找不到依据（判据：包含关系，或共享 ≥ ${need} 字符的连续片段）。`
      + '⚠️ 这**不是**「意思不像」，而是「这段文字在那一块里找不到」—— '
      + '凭空造的干扰项正是实测里 45% 功能有效的那个来源',
  };
}

// ═══════════════════════════════════════════════════════════════
// 请求与计划
// ═══════════════════════════════════════════════════════════════

/**
 * 把调用方给的 `context` 规范成出题请求。
 *
 * ⚠️ 字段名与 Dart 的 `QuizGenerationRequest` 一一对应，好让两边读同一份规格。
 */
export function makeGenerationRequest({
  blocks = [],
  context = {},
} = {}) {
  const c = context ?? {};
  return {
    courseId: String(c.courseId ?? ''),
    sectionId: String(c.sectionId ?? ''),
    /** 已筛的块（**不是整节**）。 */
    materials: [...blocks],
    /** 这次要出哪些题型。 */
    types: c.types ?? kPhase3QuizTypes,
    /** **这次允许哪些题型**。默认是保守的那一档（只有填空 + 短答）。 */
    allowedTypes: c.allowedTypes ?? kPhase3QuizTypes,
    /** 一键成题：只出这一块。给了就必须在 `materials` 里（否则拒绝）。 */
    focusBlockIndex: c.focusBlockIndex ?? null,
    /** 这一节有多少页（算 1.5–2.5 张/页 的分母）。 */
    pageCount: Number.isInteger(c.pageCount) ? c.pageCount : 0,
    /** 源产物的修订号（锚点身份的一部分）。 */
    sourceRevision: c.sourceRevision ?? '',
    /** 干扰项的**取材池**：同一节**其它块**的摘要。 */
    distractorPool: c.distractorPool ?? [],
    /** 调用方注入的上下文（原样透传给 llm.call，例如 route）。 */
    llmContext: c.llmContext ?? {},
  };
}

/**
 * **先筛后出**的守门人：把「这次请求合规吗」变成一个可测的**纯函数**。
 *
 * 它拦的是**路径**，不是内容：整节一把丢 / 一次太多块 / 本轮不支持的题型 /
 * 空材料。每一条都给出名字与依据，让调用方能把理由**显示给用户**
 * （不许静默截断，也不许静默放行）。
 *
 * @returns {{allowed:boolean, message:string, refusals:string[],
 *   selected:Array<object>, dropped:Array<{material:object, reason:string}>,
 *   distractorCandidates:Array<object>}}
 */
export function planQuizGeneration(req) {
  const refusals = [];
  const dropped = [];

  // ① 题型白名单（**显式**给出才允许）
  const allowedCodes = new Set(req.allowedTypes.map((t) => t.code));
  const unsupported = [...req.types].filter((t) => !allowedCodes.has(t.code)).map((t) => t.code);
  if (unsupported.length > 0) {
    const allowed = [...allowedCodes].sort();
    refusals.push(`unsupportedType：这次允许的题型是 ${allowed.join('、')}，`
      + `请求里还有 ${unsupported.join('、')}。`
      + '⚠️ 想要选择题 / 案例题必须**显式**把 kPhase4QuizTypes 传进来 —— '
      + '最贵的一档要放在质检链路验证之后（实测 AI 干扰项仅 45% 功能有效）');
  }
  if (req.types.length === 0) refusals.push('noTypes：没有指定任何题型');

  // ①b **本包未实现的题型**：选择题 / 案例题。App 侧属于第 4 期，本包范围是
  //     「题形状 + 先筛后出 + 三态硬检查」（第 3 期 = 填空 / 短答）。
  //
  // ⚠️ 这一判**必须落在计划层**，不能等到逐块循环里再报：那时第一块已经发过
  //     一次 `rewrite` 了 —— 而这次请求**必然一道题都出不来**，
  //     那一次调用是**纯粹白花的钱**。本仓的成本纪律是
  //     「拒绝要在任何模型调用之前」（与硬检查在 LLM 之前、速率在 LLM 之前同源）。
  const notImplemented = [...req.types]
    .filter((t) => !kImplementedQuizTypes.includes(t))
    .map((t) => t.code);
  if (notImplemented.length > 0) {
    refusals.push(`typeNotImplementedInJs：本包**没有实现** ${notImplemented.join('、')} 的构造路径`
      + `（现在能出的是 ${kImplementedQuizTypes.map((t) => t.code).join('、')}）。`
      + '⚠️ 选择题要造干扰项（实测 AI 干扰项仅 45% 功能有效）、案例题要综合多块，'
      + '它们的**形状与质检**已经实现并有测试覆盖，缺的是**构造那一步**。'
      + '这里直接拒绝，**不产出一道构造不完整的题**，也不先花一次 rewrite 的钱');
  }

  // ② 整节一把丢
  const wholeSection = req.materials
    .filter((m) => m.selection === QUIZ_MATERIAL_SELECTIONS.wholeSection)
    .map((m) => m.blockIndex);
  if (wholeSection.length > 0) {
    refusals.push(`wholeSection：材料里有整节（块 ${wholeSection.join('、')}）。`
      + 'COSER 实测：用全部字幕 / 关键帧当上下文**在多数情况下效果最差**'
      + '（"excessive or unfiltered context negatively impacts question quality"），'
      + '所以出题必须以「已标记的知识点 / 已筛的块」为单位');
  }

  // ③ 一次太多块
  if (req.materials.length > kMaxMaterialsPerRequest) {
    refusals.push(`tooManyMaterials：一次选了 ${req.materials.length} 块，`
      + `上限 ${kMaxMaterialsPerRequest}。要更多内容请分批 —— `
      + '一次丢一整节正是「上下文越多效果越差」那条实测的翻版');
  }

  // ④ 空
  if (req.materials.length === 0) refusals.push('noMaterials：没有选中任何块');

  // ⑤ 一键成题：focus 必须在场且只有它
  const focus = req.focusBlockIndex;
  if (focus !== null && focus !== undefined) {
    if (!req.materials.some((m) => m.blockIndex === focus)) {
      refusals.push(`focusNotSelected：一键成题指定的块 ${focus} 不在已选材料里`);
    }
    if (req.materials.length !== kSingleBlockMaterialCount) {
      refusals.push('focusWithExtraMaterials：一键成题只出一块，'
        + `但请求里带了 ${req.materials.length} 块`);
    }
  }

  // ⑥ 同一块被选两次（会让同一块出两遍题）
  const blocksSet = new Set(req.materials.map((m) => m.blockIndex));
  if (blocksSet.size !== req.materials.length) {
    refusals.push(`duplicateBlock：同一块被选了多次（${req.materials.length} 条材料 / `
      + `${blocksSet.size} 个不同块），这会让同一块出两遍题`);
  }

  const selected = [];
  for (const m of req.materials) {
    if (m.isEmpty()) {
      dropped.push({
        material: m,
        reason: `emptyMaterial：块 ${m.blockIndex} 既没有 summary 也没有正文，`
          + '没有材料可出题（**不跳过**：这条要显示出来）',
      });
      continue;
    }
    selected.push(m);
  }
  if (selected.length === 0 && refusals.length === 0) {
    refusals.push('allMaterialsEmpty：选中的块全部没有材料');
  }

  // ⑦ 干扰项池：**只能**是同一节**其它**块的摘要。
  //
  // 这里做三件事，每一件都在拦一种「凭空造干扰项」的形态：
  //   ① 排除**本批出题材料**（否则「干扰项」就是同一块的另一句话，
  //      学生凭「都出自同一段」就能排除它）；
  //   ② 排除**空材料**（没文本就没得抄）；
  //   ③ 编号稳定（下标是模型唯一能引用的东西）。
  const asMaterials = new Set(selected.map((m) => m.blockIndex));
  const distractorCandidates = [];
  for (const m of req.distractorPool) {
    if (asMaterials.has(m.blockIndex)) continue;
    if (m.isEmpty()) continue;
    const quote = m.materialText();
    distractorCandidates.push({
      index: distractorCandidates.length,
      material: m,
      text: quote,
      quote,
    });
  }
  // ⑧ 案例题**必须**有多块可综合
  if (req.types.includes(QUIZ_TYPES.caseStudy) && selected.length < kMinCaseMaterials) {
    refusals.push(`notEnoughCaseMaterials：案例题要**综合多块**材料，`
      + `至少需要 ${kMinCaseMaterials} 块，但这次只有 ${selected.length} 块。`
      + '⚠️ 单块材料写出来的「案例题」只是换了问法的短答 —— '
      + '这里直接拒绝，不产出一道名不副实的案例题');
  }
  if (req.types.includes(QUIZ_TYPES.mcq) && distractorCandidates.length < kMinDistractorCandidates) {
    refusals.push(`notEnoughDistractorMaterials：选择题需要至少 `
      + `${kMinDistractorCandidates} 个**同域**干扰项候选（同一节其它块的摘要），`
      + `但只有 ${distractorCandidates.length} 个。`
      + '⚠️ 这里直接拒绝，**不**让模型临时编干扰项 —— '
      + '干扰项必须来自同域材料（实测 AI 干扰项仅 45% 功能有效）');
  }

  const allowed = refusals.length === 0 && selected.length > 0;
  const message = allowed
    ? `将按「先 Rewrite 成含答案的知识陈述、再出题」两步处理 ${selected.length} 块`
      + `（${selected.map((m) => m.blockIndex).join('、')}），`
      + `材料来源：${selected.map((m) => `块${m.blockIndex}=${m.materialSource()}`).join('，')}`
      + `${distractorCandidates.length === 0 ? '' : `；同域干扰项候选 ${distractorCandidates.length} 个`
        + `（块 ${distractorCandidates.map((c) => c.material.blockIndex).join('、')}）`}`
    : `这次请求被拒绝：${refusals.join('；')}`;

  return { allowed, message, refusals, selected, dropped, distractorCandidates };
}

// ═══════════════════════════════════════════════════════════════
// 数量控制：1.5–2.5 张/页
// ═══════════════════════════════════════════════════════════════

export const CARDS_PER_PAGE_VERDICTS = Object.freeze({
  tooFew: Object.freeze({ code: 'tooFew', label: '偏少' }),
  target: Object.freeze({ code: 'target', label: '在目标区间' }),
  tooMany: Object.freeze({ code: 'tooMany', label: '偏多（卡片雪崩风险）' }),
});

/**
 * 算出「这一节出了多少张 / 页」，并与目标区间比对。
 *
 * ⚠️ 这个数**不是进度**、**不展示成成就**：「生成数量」被当成进度指标是错觉，
 * 而「Illusion of Progress」是 Anki 十大退出原因之一。
 * 它唯一的用途是**报警**：太多了就是卡片雪崩的前兆。
 */
export function adviseCardsPerPage(pages, cards) {
  if (!Number.isInteger(pages) || pages <= 0) {
    return {
      pages, cards, cardsPerPage: 0,
      verdict: CARDS_PER_PAGE_VERDICTS.tooFew,
      message: `页码数不可用（${pages}）：无法判断密度（不猜）`,
    };
  }
  const ratio = cards / pages;
  if (ratio > kTargetCardsPerPageMax) {
    return {
      pages, cards, cardsPerPage: ratio,
      verdict: CARDS_PER_PAGE_VERDICTS.tooMany,
      message: `密度 ${ratio.toFixed(2)} 张/页 > 上限 ${kTargetCardsPerPageMax}：`
        + '**卡片雪崩风险**。实测参考：35 页讲义生成 259 张卡（7+ 张/页），'
        + '用户评价「80–90% 可以直接删掉」',
    };
  }
  if (ratio < kTargetCardsPerPageMin) {
    return {
      pages, cards, cardsPerPage: ratio,
      verdict: CARDS_PER_PAGE_VERDICTS.tooFew,
      message: `密度 ${ratio.toFixed(2)} 张/页 < 下限 ${kTargetCardsPerPageMin}：`
        + `这一节还有没被考到的内容（目标区间 ${kTargetCardsPerPageMin}–${kTargetCardsPerPageMax}）`,
    };
  }
  return {
    pages, cards, cardsPerPage: ratio,
    verdict: CARDS_PER_PAGE_VERDICTS.target,
    message: `密度 ${ratio.toFixed(2)} 张/页，在目标区间内`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 提示词（第 1 步 Rewrite、第 2 步出题）
// ═══════════════════════════════════════════════════════════════

/**
 * ⚠️ 第 1 步（**主要收益来源**）：把材料改写成**含答案的知识陈述**。
 *
 * `+Rewrite` 是实验里多数组提升的那一步，而「整节塞上下文」是最差的。
 * 所以这一步**不是可选优化**，它是这条流水线的第一道工序：
 * 第二段提示词拿到的输入必须是陈述句，而不是原始 ASR 或讲义片段。
 *
 * 指令里**刻意不包含**任何「什么叫好题」的评分标准（那是 grounded judge 的职责，
 * 且通用 rubric 已被证伪无效）。
 */
export const kRewriteSystemPrompt = `你在做一道**预处理**：把材料改写成**能直接拿去出题的知识陈述**。

规则：
1. 只保留材料里**确实写了**的内容。材料里没有的，一个字都不许补 ——
   宁可少写，也不许编（编出来的内容会让后面的题变成幻觉题）。
2. 每条陈述写成**自足的一句话**，让没上过这节课的人也读得懂。
3. 数字、单位、符号**原样照抄**，不要换算、不要四舍五入、不要补单位。
4. 如果你不确定某处，就**不要**写成陈述，而是原样留在 \`uncertain\` 里。
5. 不要写「如上图」「该式」这类指代 —— 改用具体的名字。

只输出 JSON：
{"statements":["..."],"uncertain":["..."]}`;

/**
 * 第 2 步 a：填空（cloze）。
 *
 * ⚠️ 三条便宜规则写进提示词**并且**在 `applyClozeRules` 里**机械复查**：
 * 只写在提示词里等于没写（模型会违反），所以规则必须同时是可执行的门禁。
 */
export const kClozeSystemPrompt = `把下面这些**知识陈述**变成填空题。

规则（会被程序逐条检查，违反的会被丢弃）：
1. 挖空处必须是**考点**：术语、数值、条件、公式里的量。
   **不许**挖连接词、冠词、助词（英文的 the/a/an、中文的「的/了/是」这类）。
2. 每道题最多 **2** 个挖空，用 \`{{...}}\` 包住被挖掉的词。
3. 题干里**不要**出现答案本身（那是泄题）。
4. 答案必须是材料里**原样出现**的说法，不要换同义词。
5. 只输出 JSON 数组，每个元素：
   {"stem":"...{{...}}...","answer":"...","blockIndex":<material.blockIndex>}`;

/**
 * 第 2 步 b：短答。
 *
 * 短答**不需要构造干扰项**，所以这里**没有**任何「造 3 个错误选项」的指令 ——
 * 那是选择题才要付的成本，而干扰项正是最易失败的环节。
 *
 * ⚠️ 答案之外**额外**要 `keywords`：短答的判分是**用户自评 + 关键词提示**
 * （自评本身有学习价值）。关键词是给用户自评时对照的，**不是**给机器判分用的
 * —— 本产品不自动判短答对错。
 */
export const kShortAnswerSystemPrompt = `把下面这些**知识陈述**变成简答题。

规则：
1. 问题要能**脱离讲义**读懂，答案要能用**一句话**说清。
2. 给出 2–4 个关键词，作为**用户自评**时的对照提示（不是让机器判分）。
3. 题干里不要出现答案。
4. 只输出 JSON 数组，每个元素：
   {"stem":"...","answer":"...","keywords":["..."],"blockIndex":<material.blockIndex>}`;

/** 第 1 步请求体。**只发这一块** —— 整节字幕在这条路径上根本进不来。 */
export function buildRewritePrompt(m) {
  return JSON.stringify({
    step: 'rewrite',
    blockIndex: m.blockIndex,
    page: m.page,
    atSec: m.atSec,
    selection: m.selection.code,
    facets: m.facets,
    pointIds: m.pointIds,
    materialSource: m.materialSource(),
    material: m.materialText(),
  });
}

/** 第 2 步请求体。`statements` 是第 1 步的产物（**不是原始材料**）。 */
export function buildGenerationPrompt({ type, m, statements }) {
  return JSON.stringify({
    step: type === QUIZ_TYPES.cloze ? 'cloze' : 'shortAnswer',
    type: type.code,
    blockIndex: m.blockIndex,
    page: m.page,
    atSec: m.atSec,
    pointIds: m.pointIds,
    // ⚠️ 这里喂的是**改写后的知识陈述**，不是原始 ASR / 整节字幕。
    //    这一条由测试捕获请求体断言（`'step':'rewrite'` 必须在这之前出现过）。
    statements,
    maxBlanks: kMaxBlanksPerCard,
    forbiddenTerms: [...kClozeForbiddenTerms].sort(),
  });
}

// ═══════════════════════════════════════════════════════════════
// 解析：模型输出 → 候选（**只信材料，不信模型给的锚点**）
// ═══════════════════════════════════════════════════════════════

/** 响应体里的代码围栏（```json … ```）。**只剥围栏，不改内容**。 */
export function stripFences(raw) {
  let t = String(raw).trim();
  if (!t.startsWith('```')) return t;
  const firstNl = t.indexOf('\n');
  if (firstNl < 0) return t;
  t = t.slice(firstNl + 1);
  const end = t.lastIndexOf('```');
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

/** 解析失败 —— **有名字**（错误里带原文片段，便于查看模型到底返回了什么）。 */
export class QuizParseError extends QuizError {
  constructor(message, raw) {
    const text = String(raw ?? '');
    const snippet = text.length <= 800 ? text : `${text.slice(0, 800)}…`;
    super('PARSE', `${message}（响应开头：${snippet}）`, { raw: snippet });
    this.name = 'QuizParseError';
  }
}

function decodeJsonObject(raw, where) {
  const text = stripFences(raw).trim();
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    throw new QuizParseError(`${where} 响应不是合法 JSON：${e.message}`, raw);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new QuizParseError(`${where} 响应不是 JSON 对象（拿到 ${Array.isArray(decoded) ? 'array' : typeof decoded}）`, raw);
  }
  return decoded;
}

/**
 * 解析 `{"statements":[...]}`。
 *
 * 失败**抛** `QuizParseError`（带原文片段）：调用方把它变成 `problems` 的一条，
 * **不许**当成「这一段没有知识点」。
 */
export function parseRewriteResponse(raw) {
  const map = decodeJsonObject(raw, 'rewrite');
  const st = map.statements;
  if (!Array.isArray(st)) throw new QuizParseError('rewrite 响应里没有 statements 数组', raw);
  const out = st.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  if (out.length === 0) throw new QuizParseError('rewrite 响应里 statements 是空的：没有可出题的陈述', raw);
  return out;
}

/** 解析出题响应（数组）。容忍被包在对象里（`{"items":[...]}`）。 */
export function parseGenerationResponse(raw, { where }) {
  const text = stripFences(raw).trim();
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    throw new QuizParseError(`${where} 响应不是合法 JSON：${e.message}`, raw);
  }
  if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) && Array.isArray(decoded.items)) {
    decoded = decoded.items;
  }
  if (!Array.isArray(decoded)) {
    throw new QuizParseError(`${where} 响应不是 JSON 数组（拿到 ${decoded === null ? 'null' : typeof decoded}）`, raw);
  }
  const out = [];
  for (const e of decoded) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      throw new QuizParseError(`${where} 响应数组里有非对象元素：${JSON.stringify(e)}`, raw);
    }
    out.push(e);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 规则门禁（**机械复查**，不是「提示词里写过就算」）
// ═══════════════════════════════════════════════════════════════

/** 挖空处的**目标文本**（`{{…}}` / `[[…]]`；没有模板时回落成答案）。 */
export function blankTargetsOf({ stem, answer }) {
  const out = [];
  for (const m of stem.matchAll(/\{\{([^}]*)\}\}/g)) out.push(m[1]);
  for (const m of stem.matchAll(/\[\[([^\]]*)\]\]/g)) out.push(m[1]);
  if (out.length === 0 && answer.trim() !== '') out.push(answer.trim());
  return out;
}

/** 挖空处**两侧的词**（用于禁用词判定：挖掉的是 "the" 还是 "theorem"）。 */
export function blankWordsOf(stem) {
  const out = [];
  for (const m of stem.matchAll(/_{3,}/g)) {
    const before = stem.slice(0, m.index);
    const word = /[A-Za-z\u4e00-\u9fff]+$/.exec(before);
    if (word !== null) out.push(word[0]);
    const after = stem.slice(m.index + m[0].length);
    const next = /^[A-Za-z\u4e00-\u9fff]+/.exec(after);
    if (next !== null) out.push(next[0]);
  }
  return out;
}

/** 摘掉挖空模板与下划线，得到**渲染后**的题干。 */
export function stripBlankTemplates(stem) {
  return stem
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/_{3,}/g, ' ');
}

/**
 * 一条**被规则挡下**的草稿（**有名字、可重试**）。
 *
 * - `rule`：规则名或检查项 `code`（例如 `forbiddenTargetTerm` / `tooManyBlanks`）。
 * - `raw`：原样保留的模型输出（**不丢**：用户/开发者要能看见模型到底写了什么）。
 */
export function makeRejection({ rule, reason, raw, blockIndex }) {
  return {
    rule, reason, raw, blockIndex,
    toString() { return `[${rule}] 块${blockIndex}：${reason}`; },
  };
}

/**
 * **填空题的三条便宜规则**，逐条机械执行。
 *
 * 为什么必须在代码里再查一遍：规则写在提示词里**只降低**违反概率，不会消除它。
 * 而这三条各自对应一个**已实测的失败样例**：
 *
 * | 规则 | 失败样例 |
 * |---|---|
 * | 禁用词 | 把 **"The"** 做成 cloze |
 * | 每卡 ≤2 个挖空 | 35 页讲义生成 259 张卡，用户说「80–90% 可以直接删掉」 |
 * | 不泄题 | 答案印在题干里 —— 那一道题不用想就能答 |
 *
 * @returns {{draft: object|null, rejection: object|null}} **拒绝必须有名字**。
 */
export function applyClozeRules(draft, { blockIndex } = {}) {
  const stem = draft.stem.trim();
  const answer = draft.answer.trim();
  const rawOf = (fallback) => (draft.raw === '' ? fallback : draft.raw);

  if (stem === '' || answer === '') {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'emptyField',
        reason: `题干或答案是空的（题干「${stem}」/ 答案「${answer}」）`,
        raw: rawOf(`${stem}|${answer}`), blockIndex,
      }),
    };
  }

  const blanks = countBlanks(stem);
  if (blanks === 0) {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'noBlank',
        reason: `题干里没有挖空标记 —— 填空题必须用 ${kQuizBlankMarkers.join(' / ')} 标出被挖掉的词`,
        raw: rawOf(stem), blockIndex,
      }),
    };
  }
  if (blanks > kMaxBlanksPerCard) {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'tooManyBlanks',
        reason: `一张卡有 ${blanks} 个挖空，上限 ${kMaxBlanksPerCard}（每卡 ≤2 个 cloze）`,
        raw: rawOf(stem), blockIndex,
      }),
    };
  }

  // 禁用词：直接命中整串，或挖空处那几个字里含禁用词。
  const targets = [...blankTargetsOf({ stem, answer }), ...blankWordsOf(stem)];
  const banned = new Set(kClozeForbiddenTerms);
  for (const t of targets) {
    const key = t.trim().toLowerCase();
    if (key === '') continue;
    if (banned.has(key)) {
      return {
        draft: null,
        rejection: makeRejection({
          rule: kForbiddenTermRuleName,
          reason: `挖空 / 答案是禁用词「${t}」：它不含信息量`
            + '（失败案例原文就是把 "The" 做成 cloze）',
          raw: rawOf(stem), blockIndex,
        }),
      };
    }
    for (const w of key.split(/[^a-z]+/)) {
      if (w !== '' && banned.has(w)) {
        return {
          draft: null,
          rejection: makeRejection({
            rule: kForbiddenTermRuleName,
            reason: `挖空 / 答案是禁用词「${w}」（出现在「${t}」里）`,
            raw: rawOf(stem), blockIndex,
          }),
        };
      }
    }
  }

  // 泄题：把挖空模板摘掉之后再查（否则每道填空题都会被判泄题）。
  const rendered = stripBlankTemplates(stem);
  const stemNorm = rendered.replace(/\s+/g, '').toLowerCase();
  const ansNorm = answer.replace(/\s+/g, '').toLowerCase();
  const ansIsCjk = /^[\u4e00-\u9fff]+$/.test(ansNorm);
  const minLen = ansIsCjk ? 2 : 4;
  if ([...ansNorm].length >= minLen && stemNorm.includes(ansNorm)) {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'answerInStem',
        reason: `答案是「${answer}」，已经印在（挖空后的）题干里 —— 不用想就能答`,
        raw: rawOf(stem), blockIndex,
      }),
    };
  }

  return { draft: { stem, answer, keywords: [...(draft.keywords ?? [])], raw: draft.raw }, rejection: null };
}

/**
 * 短答的门禁。
 *
 * 比填空**宽松**是有意的，且理由与「短答不需要构造干扰项」同源：
 * 短答的判分是**用户自评**，所以一条「答案印在题干里」对短答的伤害与填空不同
 * —— 但仍然是伤害（那就不用回答了），所以照查。
 * 这里**不查挖空**（短答本来就不挖空）。
 */
export function applyShortAnswerRules(draft, { blockIndex } = {}) {
  const stem = draft.stem.trim();
  const answer = draft.answer.trim();
  const rawOf = (fallback) => (draft.raw === '' ? fallback : draft.raw);

  if (stem === '' || answer === '') {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'emptyField', reason: '题干或答案是空的',
        raw: rawOf(`${stem}|${answer}`), blockIndex,
      }),
    };
  }
  const stemNorm = stem.replace(/\s+/g, '').toLowerCase();
  const ansNorm = answer.replace(/\s+/g, '').toLowerCase();
  const ansIsCjk = /^[\u4e00-\u9fff]+$/.test(ansNorm);
  const minLen = ansIsCjk ? 4 : 8;
  if ([...ansNorm].length >= minLen && stemNorm.includes(ansNorm)) {
    return {
      draft: null,
      rejection: makeRejection({
        rule: 'answerInStem',
        reason: `答案整句印在题干里（短答的答案通常较长，短于 ${minLen} 字不判泄题，`
          + '避免「答案是『熵』」这种正常题被误杀）',
        raw: rawOf(stem), blockIndex,
      }),
    };
  }
  return { draft: { stem, answer, keywords: [...(draft.keywords ?? [])], raw: draft.raw }, rejection: null };
}

// ═══════════════════════════════════════════════════════════════
// 锚点：**只从材料取**（模型给的锚点一律不采用）
// ═══════════════════════════════════════════════════════════════

/**
 * 由源块算出锚点，并**核对模型自报的锚点**。
 *
 * ⚠️ 这是本层最重要的一条纪律：模型很爱在输出里顺手写一个 `page` / `atSec`，
 * 而那些数字**没有任何依据** —— 一旦采用，用户点「回原文」会跳到**别的地方**，
 * 而且不报错（`anchorBacklink` 只有在源块在场时才查得到）。所以：
 *
 * - 锚点**只**来自源材料；
 * - 模型自报的锚点与材料不一致时，**保留一条警告文本**（不静默丢弃，
 *   也不静默采信）—— 用户与开发者都能看见「模型自己说的和材料不一样」。
 */
export function anchorFromMaterial(material, parsed) {
  const claimedPage = Number.isFinite(parsed.page) ? Math.trunc(parsed.page) : null;
  const claimedAt = Number.isFinite(parsed.atSec) ? Number(parsed.atSec) : null;
  const claimedBlock = Number.isFinite(parsed.blockIndex) ? Math.trunc(parsed.blockIndex) : null;

  const warns = [];
  if (claimedBlock !== null && claimedBlock !== material.blockIndex) {
    warns.push(`模型自报块号 ${claimedBlock}，与材料 ${material.blockIndex} 不一致 —— 锚点以材料为准`);
  }
  if (claimedPage !== null && claimedPage !== material.page) {
    warns.push(`模型自报页号 ${claimedPage}，与材料第 ${material.page} 页不一致 —— `
      + '锚点以材料为准（宁可指到材料，也不指到模型编的页）');
  }
  if (claimedAt !== null && Math.abs(claimedAt - material.atSec) > 0.5) {
    warns.push(`模型自报时间戳 ${claimedAt}s，与材料 ${material.atSec}s 不一致 —— 锚点以材料为准`);
  }

  return {
    blockIndex: material.blockIndex,
    page: material.page,
    atSec: material.atSec,
    warning: warns.length === 0 ? null : warns.join('；'),
  };
}

// ═══════════════════════════════════════════════════════════════
// 并发闸
// ═══════════════════════════════════════════════════════════════

/**
 * 并发闸：限制同时打到模型端点上的请求数。
 *
 * ⚠️ 这是**本地 20 行原语**，与 `dsh-zhiyun-parser` 的 `Limiter`、
 * `dsh-zhiyun-lecture` 的同名原语同语义（排队、异常也释放名额、排队中可取消）。
 * 不跨包复用的理由：本包必须零宿主依赖且能单独发布。
 *
 * 三条语义都是必须的，少一条就出真事故：
 *  - 异常也释放名额：否则一次失败把闸永久堵死；
 *  - 排队中可取消：否则用户点了停止，队列里的请求还会照发（白花钱）；
 *  - `active` 可读：这是「并发不超过配置值」唯一能用代码判的东西。
 */
class Limiter {
  constructor(limit = 3) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
    this.closed = false;
  }

  async run(task, signal) {
    if (this.closed) throw new QuizError('DISPOSED', '出题器已关闭');
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise((resolve, reject) => {
        const entry = { resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); } };
        const cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        };
        this.queue.push(entry);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.active--;
    }
  }

  dispose() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) entry.resolve();
  }
}

// ═══════════════════════════════════════════════════════════════
// 一次生成的结果
// ═══════════════════════════════════════════════════════════════

/**
 * 一次生成的结果：候选 + 拒绝 + 问题，**三类分开**（不许混成一个「成功/失败」）。
 */
export function makeGenerationOutcome({
  admitted = [], rejected = [], problems = [], calls = [], rate = null, density = null,
} = {}) {
  return {
    /** 过了规则门禁、`status = 'proposed'` 的候选（**默认不进复习队列**）。 */
    admitted,
    /** 被规则挡下的（有名字、可重试）。 */
    rejected,
    /** 调用层面的问题（没接模型 / 响应不是 JSON / 超时…）。**非空就必须显示**。 */
    problems,
    /** 这次实际发出的调用序列（`rewrite` / `generate`），供测试与审计。 */
    calls,
    /** 速率判定（拒绝了就是拒绝了，不是静默少出）。 */
    rate,
    /** 这次生成的张数与密度的**报警**（不是进度）。 */
    density,
    get ok() { return problems.length === 0 && (admitted.length > 0 || rejected.length > 0); },
    /**
     * ⚠️ **本层刻意不提供** `total` / `count` 这类「生成了 N 题」的 getter：
     * 「生成数量」不许当进度或成就展示（「Illusion of Progress」是 Anki 十大
     * 退出原因之一）。要显示的数量只有两种：**待审多少**、**队列到期多少**。
     */
    get summary() {
      return `采用 ${admitted.length} 条候选（**待审**，还没进复习队列）、`
        + `挡下 ${rejected.length} 条`
        + `${problems.length === 0 ? '' : `；${problems.length} 个问题需要处理`}`;
    },
  };
}

/**
 * 由「到期时间 + 新卡」算积压。
 *
 * 积压**必须在界面上显式呈现**：Anki 社区的第一号退出原因就是 review debt
 * —— 每天加 20 张新卡，两周后每天要复习 150–200 张。而「攒着不说」正是
 * 雪崩的成因：用户看不见它，直到某天面对 300–400 张。
 *
 * ⚠️ [dueCards] 与 [newCards] **不许合并成一个数**：一个说的是「该复习了」，
 * 另一个说的是「还没开始」—— 合成一个「共 150 张」会让用户无法判断
 * 该先清哪一边。
 */
export function computeBacklog({ cards, now }) {
  const at0 = now instanceof Date ? now.getTime() : Date.parse(now);
  let due = 0;
  let fresh = 0;
  for (const c of cards) {
    if (c.isNew) {
      fresh++;
      continue;
    }
    const at = c.dueAt === null || c.dueAt === undefined ? null : Date.parse(c.dueAt);
    // 到期 = `dueAt <= now`（**含**此刻：刚好到点的卡不该再等一轮）。
    // 没有到期时间的卡既不算到期也不算新卡（**不猜**）。
    if (at !== null && !Number.isNaN(at) && at <= at0) due++;
  }
  const message = (due === 0 && fresh === 0)
    ? '没有到期卡片，也没有新卡（这不是「你没有问题」，而是「当前没有待复习的卡」）'
    : `到期 ${due} 张、新卡 ${fresh} 张（两个数不合并：一个是「该复习了」，一个是「还没开始」）`;
  return { dueCards: due, newCards: fresh, message };
}

// ═══════════════════════════════════════════════════════════════
// 出题器（注入「改写 + 出题」的模型桩）
// ═══════════════════════════════════════════════════════════════

/**
 * 建一个**出题器**。
 *
 * @param {object} options
 * @param {{call: Function}} options.llm **注入的窄接口**：
 *   `call({stage, route, constant, variable, signal, ...})→{text, usage}`。
 *   本包**不自己发 HTTP**：联网实现由集成层注入。
 * @param {number} [options.concurrency=3] 同时最多几个请求在飞（1–16）。
 *   ⚠️ 本层**按固定次序**发调用并逐次 await（先 rewrite、再 generate），
 *   所以实际并发恒为 1；这个参数的作用是**硬上限**：它使
 *   `active <= concurrency` 成为一条能用代码判的不变量（测试钉住它），
 *   集成层也可以据此对齐整个应用的预算口径。
 * @param {Function} [options.now] 注入的时钟（生成时间戳可复现，测试要固定时间）。
 * @param {Function} [options.idFactory] 生成 id 的工厂（默认时间戳 + 序号）。
 * @param {object} [options.pipeline] 质检链（默认装配：两个判官都没接 →
 *   全部 `undecided` → 进人工队列）。
 */
export function createQuizGenerator({
  llm,
  concurrency = 3,
  now = () => new Date(),
  idFactory = null,
  pipeline = null,
} = {}) {
  if (!llm || typeof llm.call !== 'function') {
    throw new QuizError('CONFIG',
      '出题需要注入窄 llm 接口（{ call({stage,route,constant,variable,signal}) }）；'
      + '宿主侧由 zhiyunParser 提供，也可用 config.llm 直接给出');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new QuizError('CONFIG', '出题并发须为 1–16');
  }

  const limiter = new Limiter(concurrency);
  const controllers = new Set();
  let closed = false;
  let seq = 0;

  const nextId = () => {
    if (typeof idFactory === 'function') return idFactory();
    const t = now();
    const ms = t instanceof Date ? t.getTime() : Number(t);
    return `${ms}-${seq++}`;
  };

  /** 题型顺序固定 = **成本序**：填空 → 短答 → 选择题 → 案例题。 */
  const orderedTypes = (types) => [
    QUIZ_TYPES.cloze, QUIZ_TYPES.shortAnswer, QUIZ_TYPES.mcq, QUIZ_TYPES.caseStudy,
  ].filter((t) => types.includes(t));

  const callLlm = (request, signal) => limiter.run(() => llm.call({ ...request, signal }), signal);

  /**
   * 出一批题。
   *
   * 步骤**固定为**：计划 → 先问速率 → 逐块 `rewrite` → 逐块 `generate` →
   * 规则门禁 → 质检链。任何一步出问题都进 `problems` 或 `rejected`，**绝不静默**。
   *
   * ⚠️ 速率判定在**任何模型调用之前**：额度不够就**直接拒绝**，
   * 一分钱模型预算都不花（这与「硬检查在 LLM 之前」是同一条成本纪律）。
   *
   * @param {object} input
   * @param {Array<object>} input.blocks 已筛的块（`makeSourceMaterial` 的产物）。
   * @param {object} [input.context] `courseId` / `sectionId` / `pageCount` /
   *   `sourceRevision` / `types` / `allowedTypes` / `focusBlockIndex` /
   *   `distractorPool` / `llmContext`。
   * @param {AbortSignal} [input.signal] 取消信号 —— 取消**抛** `CANCELLED`，不降级。
   * @param {Function} [input.onProgress] `({phase,done,total,blockIndex})`。
   * @param {object} [input.rate] 速率台账（`store.js` 的 `makeRateLedger`）。
   * @param {number} [input.maxCards] **本次**要出的张数（界面给的）。
   * @returns {Promise<object>} `makeGenerationOutcome` 的形状。
   */
  async function generate({ blocks = [], context = {}, signal, onProgress, rate = null, maxCards = null } = {}) {
    if (closed) throw new QuizError('DISPOSED', '出题器已关闭');

    const controller = new AbortController();
    controllers.add(controller);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    const calls = [];
    const problems = [];
    const rejected = [];
    const admitted = [];

    try {
      combined.throwIfAborted();

      // ── ① 先筛后出 ────────────────────────────────────────────
      const request = makeGenerationRequest({ blocks, context });
      const plan = planQuizGeneration(request);
      if (!plan.allowed) {
        return makeGenerationOutcome({
          problems: [plan.message, ...plan.dropped.map((d) => d.reason)],
          calls,
        });
      }
      for (const d of plan.dropped) problems.push(d.reason);

      const requested = maxCards ?? plan.selected.length;

      // ── ② 速率（在任何模型调用之前）────────────────────────────
      let decision = null;
      if (rate !== null && rate !== undefined) {
        decision = rate.check({
          courseId: request.courseId,
          sectionId: request.sectionId,
          requested,
          now: now(),
        });
        if (!decision.allowed) {
          // **明确拒绝并说明原因**（不是静默截断到剩余额度）。
          return makeGenerationOutcome({ problems: [decision.message], calls, rate: decision });
        }
      }

      // ── ③ 逐块：先 Rewrite，再出题 ─────────────────────────────
      let produced = 0;
      for (const m of plan.selected) {
        // ⚠️ **这里必须再判一次**：额度在上一块就用满时，这一块的材料
        //    根本不会被用到，而下面紧跟着就是一次 rewrite 调用 —— 那是**真金白银**。
        if (produced >= requested) break;

        let statements;
        try {
          combined.throwIfAborted();
          calls.push('rewrite');
          onProgress?.({ phase: 'rewrite', done: produced, total: requested, blockIndex: m.blockIndex });
          const raw = await callLlm({
            stage: 'quiz-rewrite',
            constant: kRewriteSystemPrompt,
            variable: buildRewritePrompt(m),
            ...request.llmContext,
          }, combined);
          statements = parseRewriteResponse(raw.text ?? raw);
        } catch (e) {
          if (isAbort(e, combined)) throw cancelled();
          problems.push(`块 ${m.blockIndex} 的**改写**这一步失败：${errText(e)}`
            + '（名字：rewrite；可重试 —— 这一步是出题的主要收益来源，不许跳过它直接出题）');
          continue;
        }

        for (const type of orderedTypes(request.types)) {
          if (produced >= requested) break;

          // ⚠️ 到得了这里的题型**必然**是本包实现了构造路径的：计划层已经把
          //    未实现的题型（选择题 / 案例题）在**任何模型调用之前**拒绝掉了。
          //    所以这里不是「顺手也判一下」，而是**不可达路径的守卫** ——
          //    如果哪天有人把计划层的拒绝删掉，这一行会立刻失败，
          //    而不是静默产出一道构造不完整的题。
          if (!kImplementedQuizTypes.includes(type)) {
            throw new QuizError('INTERNAL',
              `${type.code} 走到了构造路径，但本包没有实现它 —— `
              + '计划层本应在任何模型调用之前拒绝这次请求（这是一条不该被触发的守卫）');
          }

          try {
            combined.throwIfAborted();
            calls.push('generate');
            onProgress?.({ phase: 'generate', done: produced, total: requested, blockIndex: m.blockIndex });
            const raw = await callLlm({
              stage: `quiz-${type.code}`,
              constant: type === QUIZ_TYPES.cloze ? kClozeSystemPrompt : kShortAnswerSystemPrompt,
              variable: buildGenerationPrompt({ type, m, statements }),
              ...request.llmContext,
            }, combined);

            const rows = parseGenerationResponse(raw.text ?? raw, { where: type.code });
            for (const row of rows) {
              if (produced >= requested) break;
              const draft = {
                stem: String(row.stem ?? ''),
                answer: String(row.answer ?? ''),
                keywords: Array.isArray(row.keywords)
                  ? row.keywords.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
                  : [],
                raw: JSON.stringify(row),
              };
              const verdict = type === QUIZ_TYPES.cloze
                ? applyClozeRules(draft, { blockIndex: m.blockIndex })
                : applyShortAnswerRules(draft, { blockIndex: m.blockIndex });
              if (verdict.rejection !== null) {
                rejected.push(verdict.rejection);
                continue;
              }
              const d = verdict.draft;
              const anchor = anchorFromMaterial(m, row);
              const item = makeItem({
                id: `${nextId()}-${type.code}-${m.blockIndex}-${produced}`,
                courseId: request.courseId,
                sectionId: request.sectionId,
                blockIndex: anchor.blockIndex,
                page: anchor.page,
                atSec: anchor.atSec,
                type,
                stem: d.stem,
                answer: d.answer,
                warnings: [
                  ...(anchor.warning === null ? [] : [anchor.warning]),
                  ...(d.keywords.length === 0
                    ? []
                    : [`自评关键词：${d.keywords.join('、')}（供你自己对照，不是机器判分）`]),
                  ...(m.selection === QUIZ_MATERIAL_SELECTIONS.adjacentSummary
                    ? [`这块是相邻块摘要（材料来源：${m.materialSource()}），只作补充`]
                    : []),
                ],
                // ⚠️ 状态恒为 proposed：生成的题**默认不进复习队列**。
                status: QUIZ_STATUSES.proposed,
                createdAt: new Date(now()).toISOString(),
              });

              // ── ④ 质检链：过了才进「够格给用户看」 ────────────────
              const source = {
                blockId: `b${m.blockIndex}`,
                pointIds: m.pointIds,
                blockIndex: m.blockIndex,
                page: m.page,
                atSec: m.atSec,
                groundingText: m.materialText(),
                goodExamples: m.goodExamples ?? [],
                badExamples: m.badExamples ?? [],
                sectionId: request.sectionId,
                sourceRevision: request.sourceRevision,
              };

              const triaged = pipeline === null
                ? null
                : await pipeline.evaluate(item, { source });

              if (triaged === null) {
                // 没接质检链 → **照实**说「没有结论」，不宣称通过。
                problems.push(`块 ${m.blockIndex} 的题 ${item.id} 没有跑质检链`
                  + '（integration 没有注入 pipeline）：这次**没有**「这题够格」的结论，'
                  + '要人工看（名字：noPipeline）');
                admitted.push({ item, material: m, keywords: d.keywords, triage: null });
                produced++;
                continue;
              }

              // ⚠️ 质检的结论里，**硬检查之外**的部分没有对应的检查项代号，
              //    所以它们进不了 `item.checks`。但它们**必须可见** ——
              //    否则「过了硬检查但裁判拿不准」会看起来与「全都通过」一模一样。
              const checked = withItem(item, {
                checks: triaged.hard.checks,
                warnings: [
                  ...item.warnings,
                  ...(triaged.needsHuman ? [`质检**没有结论**（要你自己看一眼）：${triaged.reason}`] : []),
                  ...(triaged.hard.warnFlags.length === 0
                    ? []
                    : [`警告层标记：${triaged.hard.warnFlags.map((c) => c.id.code).join('、')}`
                      + '（只标记，不拦采纳）']),
                ],
              });

              if (triaged.hard.hardFails.length > 0) {
                rejected.push(makeRejection({
                  rule: triaged.hard.failedIds.join('/'),
                  reason: `硬检查不通过（${triaged.hard.failedIds.join('、')}）：${triaged.reason}`,
                  raw: d.raw === '' ? d.stem : d.raw,
                  blockIndex: m.blockIndex,
                }));
                continue;
              }
              admitted.push({ item: checked, material: m, keywords: d.keywords, triage: triaged });
              produced++;
            }
          } catch (e) {
            if (isAbort(e, combined)) throw cancelled();
            problems.push(`块 ${m.blockIndex} 的**出题**这一步（${type.code}）失败：${errText(e)}`
              + '（名字：generate；可重试）');
          }
        }
      }

      if (produced > 0 && rate !== null && rate !== undefined) {
        rate.consume({
          courseId: request.courseId,
          sectionId: request.sectionId,
          count: produced,
          now: now(),
        });
      }

      return makeGenerationOutcome({
        admitted,
        rejected,
        problems,
        calls,
        rate: decision,
        density: adviseCardsPerPage(request.pageCount, produced),
      });
    } catch (e) {
      if (e instanceof QuizError) throw e;
      if (isAbort(e, combined)) throw cancelled();
      throw e;
    } finally {
      controllers.delete(controller);
    }
  }

  /** 释放：中断在飞的与排队的请求，之后再用就抛 DISPOSED。 */
  function dispose() {
    closed = true;
    for (const c of controllers) c.abort();
    controllers.clear();
    limiter.dispose();
  }

  return {
    generate,
    dispose,
    /** 只读快照：集成层与测试用它核对并发上限。 */
    get concurrency() { return concurrency; },
    get active() { return limiter.active; },
    get closed() { return closed; },
  };
}

/** 取消：抛而不是降级 —— 取消是调用方的意志，不是「这一节没出题」。 */
function cancelled() {
  return new QuizError('CANCELLED', '出题已取消');
}

function isAbort(error, signal) {
  return signal.aborted || error?.name === 'AbortError'
    || (error instanceof QuizError && error.code === 'CANCELLED');
}

function errText(error) {
  if (error === null || error === undefined) return '未知原因';
  return error?.message ?? String(error);
}
