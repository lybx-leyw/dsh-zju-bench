/**
 * `store.js` —— 题目 / 作答 / 额度台账的**形状与服务接口**。
 *
 * # ⚠️ 本文件**不做任何落盘**
 *
 * App 侧的 `lib/data/quiz_store.dart` 是**数据层**：它自己拼路径、自己
 * tmp+rename 原子写三个 JSON 文件。本包**刻意不是**那个东西：
 *
 * - 本包**不 import 文件系统模块**、不拼路径、不写文件（有一条扫源码的测试钉住它）；
 * - 持久化由**集成层**用宿主的存储服务完成 —— 那是宿主已有的能力，
 *   在这里自己写一遍文件就是本仓明令禁止的「重复造轮子」；
 * - 本文件只导出**领域服务**：形状 + 读 / 改 / 变化的判定。
 *
 * 于是「同一份领域逻辑」不会因为换宿主（桌面 App / Harness / 测试）而被改一遍。
 *
 * # 三条平行的数据（与 App 一致）
 *
 * | 轨道 | 内容 | 为什么单独一条 |
 * |---|---|---|
 * | items | 生成的题（proposed / accepted / rejected） | 它要经用户采纳，生命周期与作答不同 |
 * | attempts | 作答记录 | 错题归因与薄弱点统计的**唯一**依据，是**已经发生过的事** |
 * | rate | 额度台账（今天用掉多少） | 它按天 / 按节计数，与题目数据无关 |
 *
 * ⚠️ 三条都**与不可变产物平行**：条目的锚点指向产物里的块，但**没有任何写路径
 * 回到产物目录**。「产物是不可变事实，用户数据写平行文件」。
 *
 * # 为什么「默认不入库」落在**这一层**
 *
 * 生成的题**默认不进复习队列**，必须用户一键采纳。这条纪律如果只写在界面上，
 * 任何一条新的调用路径都能绕过它。所以它落在**类型 / 接口**上：
 *
 * | 方法 | 能不能让题进队列 |
 * |---|---|
 * | `saveGenerated` | **不能**。它把状态**强制**写成 `proposed`（且**记录一条 note**） |
 * | `saveSelfAudited` | 能，但只收讲义模式里已经自审通过、依据写在 warnings 里、且块号是 -1 的题 |
 * | `adopt` / `discard` | 能 —— 这是**用户动作**的两个入口 |
 * | `delete` | 从题库里删掉这一道。**作答记录留着**（那是已经发生过的事） |
 * | `reviewQueue` | **只返回 `accepted` 的** |
 *
 * # FSRS 隔离（最容易做错的地方）
 *
 * **AI 判分的结果不得直接当复习调度评分用。** 依据：Anki 手册 —— FSRS 几乎能
 * 适应任何习惯，**唯独不能容忍「忘了却按 Hard 而不按 Again」**，一旦如此
 * **所有间隔都会严重偏长**，而且是**静默地**坏。
 *
 * 所以这里有两个**分开**的字段：
 * - `selfRecall`（四档评分或 `null`）—— 用户**真实回忆**时的评分，
 *   它是 `fsrsRating` 的**唯一**来源；
 * - `autoVerdict`（`correct` / `incorrect` / `unknown`）—— AI 判对/判错，
 *   **只是一个参考信号**；它进了作答记录，但进不了四档评分。
 *
 * 这不是约定，是**签名**：`selfRecall === null` 时 `fsrsRating` 就是 `null`，
 * 调用方拿不到一个可用的评分值去喂调度器。
 */

import { QUIZ_STATUSES, itemFromJson, itemToJson, withItem } from './model.js';
import { kLectureQuizBasisPrefix, kLectureQuizNoAnchorBlock } from './lecture.js';

/** 三条轨道的名字（集成层据此决定存到宿主的哪个键下）。 */
export const kQuizTracks = Object.freeze(['items', 'attempts', 'rate']);

/** 落盘用的 schema 名（与 App 的三个文件一一对应）。 */
export const kQuizSchemas = Object.freeze({
  items: 'quiz_items',
  attempts: 'quiz_attempts',
  rate: 'quiz_rate',
  export: 'quiz_export',
});

/** 读写状态（**有名字**，不许用空列表冒充「没问题」）。 */
export const QUIZ_READ_STATUSES = Object.freeze({
  ok: Object.freeze({ code: 'ok', label: '读到了' }),
  noFile: Object.freeze({ code: 'noFile', label: '还没有文件（首次运行）' }),
  corrupt: Object.freeze({ code: 'corrupt', label: '文件坏了（不覆盖，等人工修）' }),
  ioError: Object.freeze({ code: 'ioError', label: '这次没读成功（可重试）' }),
  /**
   * 这个路径上**不是**我们那个文件 —— 有目录（或别的东西）占住了它。
   *
   * ⚠️ 这一档不是洁癖，它挡的是一个**真的会发生**的静默失败：
   * `exists()` 对一个**目录**返回 `false`，于是「路径被占住」会被读成
   * `noFile`（那是**正常态**、允许写）→ 我们照写不误 → 写 tmp 成功、
   * 但 rename 到目标时撞上那个目录而失败，用户看到的是一句与真实原因
   * 毫无关系的报错，而他盘上正放着一份**读不出来**的题。
   */
  pathBlocked: Object.freeze({ code: 'pathBlocked', label: '路径被别的东西占住了（不覆盖，要人工处理）' }),
});

/** 这一档读盘状态算正常吗（含「首次运行、还没有文件」这个正常态）。 */
export const quizReadStatusOk = (status) =>
  status === QUIZ_READ_STATUSES.ok || status === QUIZ_READ_STATUSES.noFile;

/** 读盘结果。 */
export const makeQuizRead = (status, items = [], message = null) => ({
  status, items, message, ok: quizReadStatusOk(status),
});

/**
 * **允许写盘吗** —— 两条轨道各自的读盘状态 → 一个布尔。
 *
 * ⚠️ 三个非正常态**都**不允许写，但理由各不相同：
 * - `ioError`：内存里是一份**不完整**的列表 → 落盘 = 用残缺覆盖**可能完好**的文件；
 * - `corrupt`：盘上那份可能还能人工抢救 → 覆盖 = 把用户的字节删掉；
 * - `pathBlocked`：**我们连里面有什么都不知道** → 更不该写。
 *
 * 这三条合起来是一句话：**写入的前提是「我们确实读到了它现在的样子」**。
 */
export const quizStoreWritable = (items, attempts) =>
  quizReadStatusOk(items) && quizReadStatusOk(attempts);

/** 用户该做什么（**有名字**的失败才可行动）。 */
export function quizStoreRemedy(items, attempts) {
  const all = [items, attempts];
  if (all.includes(QUIZ_READ_STATUSES.corrupt)) {
    return '有文件损坏，本层不会覆盖它：请先备份并修好（或移走）后再试';
  }
  if (all.includes(QUIZ_READ_STATUSES.pathBlocked)) {
    return '这个路径上放的不是文件（多半是个目录）：请把它移走后重试。'
      + '本层不会覆盖它 —— 因为一旦覆盖，你盘上那份读不出来的题就没了';
  }
  if (all.includes(QUIZ_READ_STATUSES.ioError)) {
    return '这次读盘没成功（文件可能完好）：点重试即可，**不要**让它写盘';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 作答
// ═══════════════════════════════════════════════════════════════

/** 一次作答的**自动**判定（来自 AI / 字符串比对）。 */
export const QUIZ_AUTOGRADE_VERDICTS = Object.freeze({
  correct: Object.freeze({ code: 'correct', label: '自动判定：对' }),
  incorrect: Object.freeze({ code: 'incorrect', label: '自动判定：错' }),
  unknown: Object.freeze({ code: 'unknown', label: '自动判定：判不了（进人工）' }),
});

/** 自动判定代号 → 判定；认不出返回 `null`（**不许**静默当默认值）。 */
export function autoVerdictFromCode(code) {
  if (typeof code !== 'string') return null;
  return Object.values(QUIZ_AUTOGRADE_VERDICTS).find((v) => v.code === code) ?? null;
}

/**
 * 用户**真实回忆**后的四档评分。
 *
 * ⚠️ 这四档与自动判定是**两个世界**：只有它们能被喂进复习调度。
 * 本包不认识调度器（零宿主依赖），所以这里只定义**代号**，
 * 由集成层把它映到宿主的评分类型上。
 */
export const QUIZ_SELF_RECALLS = Object.freeze(['again', 'hard', 'good', 'easy']);

/**
 * 一次作答。
 *
 * ⚠️ `selfRecall` 与 `autoVerdict` 是**两个独立字段，不互相推导**：
 * 用户自评可以与自动判定不一致（比如他答对了但觉得是蒙的），
 * 而**只有前者**能进调度。
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.quizId
 * @param {string} input.courseId
 * @param {string} input.sectionId
 * @param {number} input.blockIndex
 * @param {string} input.response 用户写下的答案（短答是自由文本；填空是那一空的内容）。
 * @param {object} input.autoVerdict 见 `QUIZ_AUTOGRADE_VERDICTS`。
 * @param {string|null} [input.selfRecall] 四档评分之一，或 `null`（用户没有自评）。
 * @param {string} input.at ISO-8601 时间串。
 */
export function makeAttempt({
  id, quizId, courseId, sectionId, blockIndex, response, autoVerdict, selfRecall = null, at,
}) {
  const attempt = {
    id, quizId, courseId, sectionId, blockIndex, response, autoVerdict, selfRecall, at,

    /**
     * 能喂给复习调度的评分：**只有用户自评**。
     *
     * ⚠️ 这个 getter 是本层 FSRS 隔离的落点。它**不会**回落到 `autoVerdict`：
     * `autoVerdict === correct` 时它仍是 `null`。一次「AI 说对了」
     * 不构成一次「我记得」。
     */
    get fsrsRating() { return selfRecall; },

    /** 自动判定与用户自评是否一致（**参考**，不是判据）。`null` = 判不了。 */
    get autoMatchesSelfRecall() {
      if (selfRecall === null || selfRecall === undefined) return null;
      if (autoVerdict === QUIZ_AUTOGRADE_VERDICTS.unknown) return null;
      const autoSaysCorrect = autoVerdict === QUIZ_AUTOGRADE_VERDICTS.correct;
      const userSaysCorrect = selfRecall !== 'again';
      return autoSaysCorrect === userSaysCorrect;
    },

    /**
     * 「这道题你答错了吗」—— 按**用户自评优先**。
     *
     * ⚠️ 用户没自评时才看自动判定，且 `unknown` 一律**不算错**
     * （不许把「判不了」当成「错了」）。
     */
    get countsAsWrong() {
      if (selfRecall !== null && selfRecall !== undefined) return selfRecall === 'again';
      return autoVerdict === QUIZ_AUTOGRADE_VERDICTS.incorrect;
    },
  };
  return attempt;
}

export function attemptToJson(a) {
  const out = {
    id: a.id,
    quizId: a.quizId,
    courseId: a.courseId,
    sectionId: a.sectionId,
    blockIndex: a.blockIndex,
    response: a.response,
    autoVerdict: a.autoVerdict.code,
  };
  if (a.selfRecall !== null && a.selfRecall !== undefined) out.selfRecall = a.selfRecall;
  out.at = a.at;
  return out;
}

/**
 * 从 JSON 还原。**认不出的判定 / 评分抛**（`QuizError`），
 * 绝不当成默认值 —— 「把不认识的 autoVerdict 当成 correct」会让错题归因静默错掉。
 */
export function attemptFromJson(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new QuizDataError('DATA', '作答记录不是 JSON 对象');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new QuizDataError('DATA', '作答记录缺少 id');
  }
  const av = autoVerdictFromCode(raw.autoVerdict);
  if (av === null) {
    throw new QuizDataError('DATA', `作答记录 ${id} 的 autoVerdict 认不出来：${raw.autoVerdict}`);
  }
  let recall = null;
  if (raw.selfRecall !== null && raw.selfRecall !== undefined) {
    if (!QUIZ_SELF_RECALLS.includes(raw.selfRecall)) {
      throw new QuizDataError('DATA', `作答记录 ${id} 的 selfRecall 认不出来：${raw.selfRecall}`);
    }
    recall = raw.selfRecall;
  }
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) {
    throw new QuizDataError('DATA', `作答记录 ${id} 的 at 不是 ISO-8601 时间`);
  }
  return makeAttempt({
    id,
    quizId: String(raw.quizId ?? ''),
    courseId: String(raw.courseId ?? ''),
    sectionId: String(raw.sectionId ?? ''),
    blockIndex: Number.isFinite(raw.blockIndex) ? Math.trunc(raw.blockIndex) : 0,
    response: String(raw.response ?? ''),
    autoVerdict: av,
    selfRecall: recall,
    at: raw.at,
  });
}

// ═══════════════════════════════════════════════════════════════
// 错题归因 / 薄弱点（带样本量，不给点估计）
// ═══════════════════════════════════════════════════════════════

/** 一条**错题归因**（归因到知识点，而不是只记「错了几道」）。 */
export function makePointAttribution({
  pointId, pointName = null, attemptCount, wrongCount, lastWrong = null,
}) {
  return { pointId, pointName, attemptCount, wrongCount, lastWrong };
}

/**
 * 一个知识点上的「你答得怎么样」。
 *
 * ⚠️ `masteryLabel` **不是**模型推断的分数（「掌握度」不许做成模型推断；
 * 不报「掌握度 87%」）。它只由**可解释规则**得出：
 *
 * | 条件 | 说法 |
 * |---|---|
 * | 做过 < 3 题 | **数据不足**（「Too little data」口径） |
 * | 最近 3 次都错 | **近 3 次都错**（可核对的原话，不是分数） |
 * | 最近 3 次都对 | **近 3 次都对** |
 * | 其余 | **有对有错** |
 *
 * 每个说法都带样本量。规则与依据是一条注释，不是一个数字。
 */
export function makePointMastery({
  pointId, pointName = null, attemptCount, wrongCount, recentWrong,
}) {
  /** 可解释规则的阈值：少于 3 次作答一律「数据不足」。 */
  const minAttemptsForRule = 3;
  const enoughData = attemptCount >= minAttemptsForRule;
  const rule = !enoughData ? 'insufficientData' : 'lastThree';
  return {
    pointId, pointName, attemptCount, wrongCount, recentWrong: [...recentWrong],
    enoughData,
    rule,
    get masteryLabel() {
      if (!enoughData) return `数据不足（做过 ${attemptCount} 题，少于 ${minAttemptsForRule} 题）`;
      const last3 = recentWrong.slice(0, 3);
      if (last3.every((w) => w)) return `近 3 次都错（共做过 ${attemptCount} 题，错 ${wrongCount} 题）`;
      if (last3.every((w) => !w)) return `近 3 次都对（共做过 ${attemptCount} 题，错 ${wrongCount} 题）`;
      return `有对有错（共做过 ${attemptCount} 题，错 ${wrongCount} 题）`;
    },
  };
}

/**
 * 错题归因的形状说明：它的实现是 `createQuizStore` 的方法
 * （`attributeByPoint` / `masteryByPoint`）—— 因为归因必须看**题**才能
 * 把作答映到知识点，而题在服务里。这里只留形状，不另写一份实现：
 * 「同一件事有两份实现」在本仓是明令禁止的。
 */

// ═══════════════════════════════════════════════════════════════
// 额度台账（速率）
// ═══════════════════════════════════════════════════════════════

/**
 * 生成速率策略。默认值写死在这里，**同时**是界面上要显示的额度。
 */
export const kQuizRatePolicyDefaults = Object.freeze({
  /**
   * 每天最多**采纳前的待审题**多少张。
   *
   * ⚠️ 20 这个数不是实测最优，是本仓定的**保守上限**，注释里不编依据。
   * 依据只到方向：Anki 社区每天加 20 张新卡 → 两周后每天要复习 **150–200 张**；
   * 漏一个周末就面对 300–400 张。所以**每天 20 张**已经是上限而不是目标。
   */
  perDay: 20,
  /** 每节最多多少张（防止「一门课里某一节突然堆出 80 张」）。 */
  perSection: 30,
});

/** `yyyy-MM-dd`（**本地日**，与 App 的 `dayKey` 同口径）。 */
export function rateDayKey(now) {
  const d = now instanceof Date ? now : new Date(now);
  const y = `${d.getFullYear()}`.padStart(4, '0');
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * **速率台账**（按天 / 按节的计数）。
 *
 * 与题目数据**平行**存放，不进产物目录。
 *
 * ⚠️ `check` 的 `message` 在拒绝时**必须**说清「要了多少、还剩多少」——
 * 只显示「已达上限」而不说剩余，用户无法判断是等一小时还是等一天，
 * 而那种含糊正是「静默截断」的另一种形态（截断了却不说截了多少）。
 */
export function makeRateLedger({ policy = kQuizRatePolicyDefaults, byDay = {}, bySection = {} } = {}) {
  const day = new Map(Object.entries(byDay));
  const section = new Map(Object.entries(bySection));
  const sectionKey = (courseId, sectionId) => `${courseId}/${sectionId}`;

  return {
    policy,
    get byDay() { return Object.fromEntries(day); },
    get bySection() { return Object.fromEntries(section); },
    usedToday(now) { return day.get(rateDayKey(now)) ?? 0; },
    usedInSection(courseId, sectionId) { return section.get(sectionKey(courseId, sectionId)) ?? 0; },

    /** **先问再发**：要 `requested` 张，够吗？ */
    check({ courseId, sectionId, requested, now }) {
      const leftToday = policy.perDay - (day.get(rateDayKey(now)) ?? 0);
      const leftSection = policy.perSection - (section.get(sectionKey(courseId, sectionId)) ?? 0);
      const remDay = leftToday < 0 ? 0 : leftToday;
      const remSec = leftSection < 0 ? 0 : leftSection;
      const allowed = requested <= remDay && requested <= remSec;
      let message;
      if (allowed) {
        message = `这次要出 ${requested} 张，额度够（今日还剩 ${remDay} 张，本节还剩 ${remSec} 张）`;
      } else if (remDay < requested && remSec < requested) {
        message = `这次要出 ${requested} 张，但**今日只剩 ${remDay} 张**、本节只剩 ${remSec} 张：`
          + '不够就是不够，**不会静默少出几张**。可以改小本次数量，或明天再来'
          + '（生成速率上限的依据：Anki 社区每天加 20 张新卡，两周后每天要复习 150–200 张，'
          + '漏一个周末就是 300–400 张，用户的词是 review debt / avalanche）';
      } else if (remDay < requested) {
        message = `这次要出 ${requested} 张，但**今日只剩 ${remDay} 张**（本节还剩 ${remSec} 张）：`
          + '不够就是不够，**不会静默少出几张**。可以改小本次数量，或明天再来';
      } else {
        message = `这次要出 ${requested} 张，但**这一节只剩 ${remSec} 张额度**（今日还剩 ${remDay} 张）：`
          + '不够就是不够，**不会静默少出几张**。可以改小本次数量';
      }
      return {
        allowed, requested, remainingToday: remDay, remainingSection: remSec, message,
        get remaining() { return remDay < remSec ? remDay : remSec; },
      };
    },

    /** 记账（**只允许在真的出了题之后调**）。 */
    consume({ courseId, sectionId, count, now }) {
      if (!Number.isInteger(count) || count <= 0) return;
      const k = rateDayKey(now);
      day.set(k, (day.get(k) ?? 0) + count);
      const s = sectionKey(courseId, sectionId);
      section.set(s, (section.get(s) ?? 0) + count);
    },

    toJson() {
      return {
        schema: kQuizSchemas.rate,
        perDay: policy.perDay,
        perSection: policy.perSection,
        byDay: Object.fromEntries(day),
        bySection: Object.fromEntries(section),
      };
    },

    /**
     * 由 JSON 还原。
     *
     * ⚠️ 认不出的结构**抛** `QuizDataError`（调用方要么报出来、要么显式丢弃）：
     * 读成一份空台账等于**把今天的额度清零**，那会让「每天 20 张」这条上限
     * 在每次重启后失效。
     */
    fromJson(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new QuizDataError('DATA', 'quiz_rate 顶层不是对象');
      }
      const byDayIn = {};
      const bySecIn = {};
      for (const [k, v] of Object.entries(raw.byDay ?? {})) {
        if (Number.isFinite(v)) byDayIn[k] = Math.trunc(v);
      }
      for (const [k, v] of Object.entries(raw.bySection ?? {})) {
        if (Number.isFinite(v)) bySecIn[k] = Math.trunc(v);
      }
      return makeRateLedger({
        policy: {
          perDay: Number.isFinite(raw.perDay) ? Math.trunc(raw.perDay) : kQuizRatePolicyDefaults.perDay,
          perSection: Number.isFinite(raw.perSection) ? Math.trunc(raw.perSection) : kQuizRatePolicyDefaults.perSection,
        },
        byDay: byDayIn,
        bySection: bySecIn,
      });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 领域服务（**不落盘**：持久化由集成层用宿主的存储服务完成）
// ═══════════════════════════════════════════════════════════════

/** 数据层的具名失败。 */
export class QuizDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuizDataError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 建一个题库领域服务。
 *
 * ⚠️ **它不落盘**。它的职责是「回答这次改动合不合规」与「改完之后的列表长什么样」；
 * 把结果写到哪里由集成层决定（宿主的存储服务）。
 *
 * 这个分工让「默认不入库」这条纪律**能被单测钉死**：测试只要构造这个服务、
 * 调一次 `saveGenerated`，就能断言「产出的题状态只能是 proposed，
 * 且进不了 reviewQueue」—— 不需要盘、不需要宿主。
 *
 * @param {object} [options]
 * @param {Function} [options.now] 注入的时钟（测试要固定时间）。
 */
export function createQuizStore({ now = () => new Date() } = {}) {
  /** 内存里的题目表（**不是**落盘副本；集成层负责持久化）。 */
  let items = [];
  let attempts = [];
  let seq = 0;

  const byId = (id) => items.find((q) => q.id === id) ?? null;
  const replace = (item) => {
    const index = items.findIndex((q) => q.id === item.id);
    if (index >= 0) items = items.map((q, i) => (i === index ? item : q));
    else items = [...items, item];
  };

  const nextAttemptId = () => {
    const t = now();
    const ms = t instanceof Date ? t.getTime() : Number(t);
    return `a${ms}-${seq++}`;
  };

  return {
    /** 只读视图（**不可变快照**，外部改不动内部状态）。 */
    get all() { return [...items]; },
    get attempts() { return [...attempts]; },

    /**
     * **复习队列**：只有 `accepted` 的题。
     *
     * ⚠️ 这是「默认不入库」的**读侧**落点：`proposed` 的题**永远**不会从这里出去，
     * 无论界面怎么写。测试据此断言「生成 5 题 → 队列 0 题」。
     */
    get reviewQueue() { return items.filter((q) => q.status === QUIZ_STATUSES.accepted); },

    /** 待审的题（生成完但还没采纳/丢弃）。 */
    get pending() { return items.filter((q) => q.status === QUIZ_STATUSES.proposed); },

    byId,
    itemsOfSection(sectionId, { courseId = null } = {}) {
      return items.filter((q) => q.sectionId === sectionId && (courseId === null || q.courseId === courseId));
    },

    /**
     * 批量入库**生成**的题。
     *
     * ⚠️ 它**不能**让题进队列：状态**强制**写成 `proposed`。
     * 传入的题若带别的状态，`notes` 里会**逐条写明**（不许静默改写）。
     *
     * @returns {{saved:number, notes:string[]}}
     */
    saveGenerated(generated) {
      const notes = [];
      let n = 0;
      for (const q of generated) {
        if (q.status !== QUIZ_STATUSES.proposed) {
          notes.push(`题 ${q.id} 传入状态是 ${q.status.code}，`
            + '保存时强制写回 proposed —— 生成的题默认不进复习队列，'
            + '进队列只能由用户采纳');
        }
        replace(withItem(q, { status: QUIZ_STATUSES.proposed }));
        n++;
      }
      return { saved: n, notes };
    },

    /**
     * 讲义模式里**自审通过**的题直接进复习队列。
     *
     * 不带 `kLectureQuizBasisPrefix`、或者块号不是 `kLectureQuizNoAnchorBlock`
     * 的题会被拒绝并在 `notes` 里写明。已标记块的生成仍然只能走 `saveGenerated`
     * （强制 `proposed`）再由用户 `adopt`。
     *
     * ⚠️ 它能直接入队**正是因为** `admitLectureDrafts` 已经在规则层把依据
     * 对过了工具原文。少了那一步，它只是一条绕过「默认不入库」的捷径。
     *
     * @returns {{saved:number, notes:string[]}}
     */
    saveSelfAudited(generated) {
      const notes = [];
      let n = 0;
      for (const q of generated) {
        const grounded = q.warnings.some((w) => w.startsWith(kLectureQuizBasisPrefix));
        if (q.blockIndex !== kLectureQuizNoAnchorBlock || !grounded) {
          notes.push(`题 ${q.id} 没有讲义自审依据，拒绝直接进复习队列`);
          continue;
        }
        replace(withItem(q, { status: QUIZ_STATUSES.accepted }));
        n++;
      }
      return { saved: n, notes };
    },

    /**
     * **采纳**（用户动作）。
     *
     * 这是「进复习队列」的**唯一**入口之一。它要求先有题；找不到 id 时
     * **明确报错**，不静默当成功。
     */
    adopt(id) {
      const cur = byId(id);
      if (cur === null) {
        throw new QuizDataError('NOT_FOUND', `采纳失败：找不到题 ${id}（可能已被丢弃）`);
      }
      if (cur.status === QUIZ_STATUSES.accepted) return cur;
      const next = withItem(cur, { status: QUIZ_STATUSES.accepted });
      replace(next);
      return next;
    },

    /** **丢弃**（用户动作）。 */
    discard(id) {
      const cur = byId(id);
      if (cur === null) throw new QuizDataError('NOT_FOUND', `丢弃失败：找不到题 ${id}`);
      const next = withItem(cur, { status: QUIZ_STATUSES.rejected });
      replace(next);
      return next;
    },

    /**
     * 从题库删掉这一道。找不到就报错，**不假装删成功了**。
     *
     * ⚠️ 作答记录**不跟着删**：那是已经发生过的事。
     */
    delete(id) {
      const index = items.findIndex((q) => q.id === id);
      if (index < 0) throw new QuizDataError('NOT_FOUND', `删除失败：找不到题 ${id}`);
      items = items.filter((q) => q.id !== id);
    },

    /**
     * 记一次作答。
     *
     * ⚠️ `selfRecall` **只能**来自用户真实的四档评分；`autoVerdict` 是参考信号。
     * 本方法**不会**用 `autoVerdict` 去补 `selfRecall`。
     */
    recordAttempt({
      quizId, response, autoVerdict, selfRecall = null,
      courseId = null, sectionId = null, blockIndex = null,
    }) {
      const q = byId(quizId);
      if (q === null && (courseId === null || sectionId === null || blockIndex === null)) {
        throw new QuizDataError('NOT_FOUND', `记录作答失败：找不到题 ${quizId}，且调用方没有提供锚点`);
      }
      const attempt = makeAttempt({
        id: nextAttemptId(),
        quizId,
        courseId: q?.courseId ?? courseId,
        sectionId: q?.sectionId ?? sectionId,
        blockIndex: q?.blockIndex ?? blockIndex,
        response,
        autoVerdict,
        selfRecall,
        at: new Date(now()).toISOString(),
      });
      attempts = [...attempts, attempt];
      return attempt;
    },

    /**
     * 错题归因：按知识点聚合，**不是**只记「错了几道」。
     *
     * 一道题可能挂多个知识点：**每个都单独计数**。
     */
    attributeByPoint(pointIdsOf, { nameOf = null } = {}) {
      const sorted = [...attempts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const out = new Map();
      const lastWrong = new Map();
      for (const a of sorted) {
        const q = byId(a.quizId);
        // 题已被删掉时用作答自带的锚点也归不了因（不知道挂哪个知识点）
        // → **明确跳过**（不进任何知识点），不猜。
        if (q === null) continue;
        for (const pointId of pointIdsOf(q)) {
          const cur = out.get(pointId) ?? { attemptCount: 0, wrongCount: 0 };
          cur.attemptCount++;
          if (a.countsAsWrong) {
            cur.wrongCount++;
            lastWrong.set(pointId, a);
          }
          out.set(pointId, cur);
        }
      }
      const result = {};
      // 没有作答但挂了知识点的题也要出现在归因里（样本 0 = **数据不足**，
      // 不许因为「一条记录都没有」就把它从列表里抹掉）。
      for (const q of items) {
        for (const pointId of pointIdsOf(q)) {
          if (!out.has(pointId)) out.set(pointId, { attemptCount: 0, wrongCount: 0 });
        }
      }
      for (const [pointId, v] of out) {
        result[pointId] = makePointAttribution({
          pointId,
          pointName: nameOf === null ? null : nameOf(pointId),
          attemptCount: v.attemptCount,
          wrongCount: v.wrongCount,
          lastWrong: lastWrong.get(pointId) ?? null,
        });
      }
      return result;
    },

    /**
     * 一个知识点上的「你答得怎么样」（**可解释规则**，不是模型推断的分数）。
     *
     * 与 Dart 的 `masteryOf(pointId, …)` 同签名 / 同语义：**一次只看一个知识点**。
     * 不做成「一次算全部」，是因为 Dart 那边也只有一个知识点的入口
     * （界面上一屏看一个）。
     */
    masteryOf(pointId, { pointIdsOf, nameOf = null }) {
      const sortedAsc = [...attempts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      let count = 0;
      let wrong = 0;
      const recent = [];
      for (const a of [...sortedAsc].reverse()) {
        const q = byId(a.quizId);
        if (q === null) continue;
        if (!pointIdsOf(q).includes(pointId)) continue;
        count++;
        if (a.countsAsWrong) wrong++;
        if (recent.length < 5) recent.push(a.countsAsWrong);
      }
      return makePointMastery({
        pointId,
        pointName: nameOf === null ? null : nameOf(pointId),
        attemptCount: count,
        wrongCount: wrong,
        recentWrong: recent,
      });
    },

    /** 批量版：把 `masteryOf` 对全部出现过的知识点跑一遍（**不另写一份实现**）。 */
    masteryByPoint(pointIdsOf, { nameOf = null } = {}) {
      const result = {};
      for (const pointId of Object.keys(this.attributeByPoint(pointIdsOf))) {
        result[pointId] = this.masteryOf(pointId, { pointIdsOf, nameOf });
      }
      return result;
    },

    /** 导出（接「导出我的数据」）。 */
    exportAll() {
      return {
        schema: kQuizSchemas.export,
        items: items.map(itemToJsonSafe),
        attempts: attempts.map(attemptToJson),
      };
    },

    /**
     * 集成层从宿主存储读回来之后，把题目装进来。
     *
     * ⚠️ 认不出的题（题型 / 状态代号不认识）**逐条报出来**并跳过，
     * 不静默丢弃、也不退回默认值。
     */
    loadItems(rawList) {
      const notes = [];
      const loaded = [];
      rawList.forEach((raw, i) => {
        const parsed = itemFromJsonSafe(raw);
        if (parsed === null) {
          notes.push(`第 ${i + 1} 条题读不回来（题型或状态代号不认识 / checked 项认不出）：已跳过，**没有**当成默认值`);
          return;
        }
        loaded.push(parsed);
      });
      items = loaded;
      return { loaded: loaded.length, notes };
    },

    /** 集成层从宿主存储读回来之后，把作答装进来（读不回来**抛**，不静默截断）。 */
    loadAttempts(rawList) {
      attempts = rawList.map(attemptFromJson);
      return attempts.length;
    },

    /** 落盘前要写什么（集成层把这两个数组交给宿主的存储服务）。 */
    snapshot() {
      return {
        items: items.map(itemToJsonSafe),
        attempts: attempts.map(attemptToJson),
      };
    },
  };
}

// 这两个包装只为了「JSON 往返失败时报名字」，避免在领域服务里散落 try/catch。
function itemToJsonSafe(item) { return itemToJson(item); }

function itemFromJsonSafe(raw) {
  try {
    return itemFromJson(raw);
  } catch {
    return null;
  }
}

/**
 * ⚠️ 本文件**刻意不提供**任何「把 proposed 改成 accepted」的批量函数
 * （除了 `saveSelfAudited`，它有一条独立的、可核对的准入判据）。
 * 想让题进队列，只有两条路：**用户动作** `adopt`，或 `saveSelfAudited`
 * 的讲义自审通道。这条约束由测试钉住（扫源码断言没有别的 `accepted` 赋值点）。
 */
export const kDefaultNotEnqueuedNote =
  '生成的题默认不进复习队列：只有 adopt（用户动作）或 saveSelfAudited'
  + '（讲义自审，带依据前缀且块号为 -1）能让题变成 accepted。';

/** 空题库的初始形状（集成层第一次读不到数据时用它，**状态诚实**）。 */
export function emptyQuizData() {
  return { items: [], attempts: [], rate: null };
}

/** 把三条轨道的原始 JSON 组装成导出形状（接「导出我的数据」）。 */
export function exportQuizData({ items = [], attempts = [], rate = null }) {
  return {
    schema: kQuizSchemas.export,
    items,
    attempts,
    rate,
  };
}

/**
 * 从宿主存储读到的三条轨道 → 一个**要么全新、要么读失败**的判定。
 *
 * 这条是「写入的前提是我们确实读到了它现在的样子」的落点：
 * 读失败时**不许**写（否则会用残缺覆盖可能完好的文件）。
 */
export function judgeLoadedQuizData({ items, attempts }) {
  const writable = quizStoreWritable(items.status, attempts.status);
  return {
    writable,
    remedy: quizStoreRemedy(items.status, attempts.status),
    itemsStatus: items.status.code,
    attemptsStatus: attempts.status.code,
  };
}
