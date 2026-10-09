/**
 * `dedupe.js` —— 新题和已有题的去重。
 *
 * # 规格来源
 *
 * 逐条对齐 App 的 `lib/fusion/quiz_dedupe.dart`。
 *
 * 题干规范化之后完全一样的，本地直接丢掉。
 * 换了说法、仍在考同一件事的，交给模型标下标，解析在 `parseQuizDedupeIndexes`。
 *
 * # 为什么本地那一层是「确定」的
 *
 * `quizStemKey` 只做「去空白 + 忽略大小写」—— 它**不做同义判断**。
 * 理由与硬检查里的 `normalizeOptionText` 同源：同义判断会有假阳性，
 * 而这一步的结果是**直接丢掉一道题**。要判「换了说法但仍在考同一件事」，
 * 那是模型的活（`quizDedupePrompt`），不是正则的活。
 */

/**
 * 语义去重一次最多对照这么多道已有题。更早的题仍参与题干完全相同的过滤。
 *
 * 60 是个上下文预算判断：**不编造实测依据**。它的作用是让
 * 「一门课攒了 500 道题之后，去重请求体大到送不出去」这条路径在参数上撞墙。
 */
export const kQuizDedupeMaxExisting = 60;

/** 去重工具名。出题那一轮**不调用**它（去重是出题之后、采纳之前的一步）。 */
export const kQuizDedupeTool = 'drop_duplicates';

/** 题干比较用的键：去掉空白并忽略大小写。 */
export function quizStemKey(stem) {
  return String(stem).replace(/\s+/g, '').toLowerCase();
}

/**
 * 去掉题干和已有题（或本批里更早的一道）完全一样的新题。
 *
 * ⚠️ 空题干的题**不保留**，且**有名字**（`notes` 里写明「一道题没有题干」）——
 * 静默丢弃会让「这次怎么少了一道」无从追问。
 *
 * @template T
 * @param {{existing?: Array<T>, fresh: Array<T>, stemOf: (item: T) => string}} options
 * @returns {{kept: Array<T>, notes: string[]}}
 */
export function dropExactQuizDuplicates({ existing = [], fresh, stemOf }) {
  const seen = new Set(existing.map((item) => quizStemKey(stemOf(item))));
  const kept = [];
  const notes = [];
  for (const item of fresh) {
    const stem = String(stemOf(item)).trim();
    const key = quizStemKey(stem);
    if (key === '') {
      notes.push('一道题没有题干，没有收下');
      continue;
    }
    if (seen.has(key)) {
      notes.push(`题干和已有题一样，没有收下：${stem}`);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return { kept, notes };
}

/**
 * 让模型标出新题里哪些下标和已有题重复。
 *
 * ⚠️ 「拿不准就留下」这一句是**判据的一部分**，不是客套：去重的假阳性
 * （把一道真正不同的题当成重复丢掉）比假阴性（多留一道相似题）代价高得多
 * —— 前者是**静默丢内容**，而后者用户自己删一下就行了。
 */
export function quizDedupePrompt() {
  return `你在判断新出的题是否和已有的题重复。

重复：问的是同一件事，答案也是同一个结论。换了说法、换了题型，仍然算重复。
不重复：同一节课，但问的是另一个事实或另一个原因。
拿不准就留下。不要为了少题而删。

只调用 ${kQuizDedupeTool}。duplicateIndexes 是新题列表的下标，从 0 开始。没有重复就传空数组。`;
}

/**
 * 送给模型的两组题干。已有题超过 `kQuizDedupeMaxExisting` 时只送最近的那些。
 *
 * ⚠️ 截断**必须写进正文**（「更早的 N 道没有列在这里」）：不写的话，
 * 模型会把「我只看到 60 道」读成「总共只有 60 道」，于是「和更早的题重复」
 * 这条判据静默失效。
 */
export function quizDedupeInput({ existing, fresh }) {
  const shown = existing.length <= kQuizDedupeMaxExisting
    ? existing
    : existing.slice(existing.length - kQuizDedupeMaxExisting);
  const lines = ['已有的题：'];
  if (shown.length < existing.length) {
    lines.push(`（更早的 ${existing.length - shown.length} 道没有列在这里。）`);
  }
  shown.forEach((s, i) => lines.push(`${i}. ${s}`));
  lines.push('', '新出的题：');
  fresh.forEach((s, i) => lines.push(`${i}. ${s}`));
  return `${lines.join('\n')}\n`;
}

/** `drop_duplicates` 的参数结构。 */
export function quizDedupeSchema() {
  return {
    type: 'object',
    properties: {
      duplicateIndexes: {
        type: 'array',
        description: '新题里和已有题重复的下标，从 0 开始。没有就给空数组。',
        items: { type: 'integer' },
      },
    },
    required: ['duplicateIndexes'],
  };
}

/**
 * 模型标出的下标。读不懂时 `problem` 有名字，`indexes` 为空。
 *
 * ⚠️ `problem` 非空时 `indexes` **必须**为空 —— 「解析失败」与「没有重复」
 * 是两件事：把解析失败当成「没有重复」就等于静默放行重复题。
 */
export function parseQuizDedupeIndexes(raw, freshCount) {
  let decoded;
  try {
    decoded = JSON.parse(String(raw));
  } catch {
    return { indexes: new Set(), problem: '去重结果不是 JSON' };
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { indexes: new Set(), problem: '去重结果不是对象' };
  }
  const rawIndexes = decoded.duplicateIndexes ?? decoded.duplicates;
  if (!Array.isArray(rawIndexes)) {
    return { indexes: new Set(), problem: '去重结果里没有 duplicateIndexes' };
  }
  const indexes = new Set();
  for (const item of rawIndexes) {
    const n = Number.isInteger(item) ? item : Number.parseInt(String(item), 10);
    // 越界的下标忽略（模型偶尔会数错）；`Number.parseInt` 的 NaN 也在这里被挡下。
    if (!Number.isInteger(n) || n < 0 || n >= freshCount) continue;
    indexes.add(n);
  }
  return { indexes, problem: null };
}

/**
 * 把「本地精确去重」与「模型语义去重」串起来：**两步都要过**。
 *
 * 顺序不能颠倒：本地那一层用来在**发模型之前**先把完全一样的题去掉
 * （省一次调用，也让送给模型的「新出的题」列表更短）。
 *
 * ⚠️ 模型解析失败时**一道都不丢**（`problem` 有名字交给调用方显示）：
 * 那一步是「宁多留」的设计，把解析失败升级成丢题会让一次格式抖动
 * 变成静默丢内容。
 *
 * @returns {{kept: Array<T>, notes: string[], indexes: Set<number>, problem: string|null}}
 */
export function dedupeQuizBatch({ existing = [], fresh, stemOf, semanticIndexes = null }) {
  const exact = dropExactQuizDuplicates({ existing, fresh, stemOf });
  if (semanticIndexes === null || semanticIndexes === undefined) {
    return { kept: exact.kept, notes: exact.notes, indexes: new Set(), problem: null };
  }
  const { indexes, problem } = semanticIndexes;
  if (problem !== null) {
    return { kept: exact.kept, notes: exact.notes, indexes: new Set(), problem };
  }
  const kept = [];
  const notes = [...exact.notes];
  exact.kept.forEach((item, i) => {
    if (indexes.has(i)) {
      notes.push(`模型判定和已有题重复，没有收下：${String(stemOf(item)).trim()}`);
      return;
    }
    kept.push(item);
  });
  return { kept, notes, indexes, problem: null };
}
