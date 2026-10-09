/**
 * `lecture.js` —— 按**讲义**出题的纯规则：把一节讲义收成正文、解析模型的下一步、
 * 以及「自审通过的题必须把依据对上工具原文」。
 *
 * # 规格来源
 *
 * 逐条对齐 App 的 `lib/fusion/lecture_quiz.dart`。
 *
 * # 它与 `generate.js` 是**两种模式**，不是两条实现
 *
 * 已标记块的出题走 `generate.js`，那里**整节一把丢会被拒绝**（先筛后出）。
 * 这一文件只服务第二种模式：用户明确选了「按这一节的讲义出题」。
 * 两种模式的差别是**锚点**：
 *
 * | | 已标记块 | 按讲义 |
 * |---|---|---|
 * | 锚点 | 块 / 页 / 秒 | 无（块号 = `kLectureQuizNoAnchorBlock` = -1） |
 * | 依据 | 源块原文（`answerInSource`） | 工具回包原文（写在 warnings 上） |
 * | 入队 | **默认不入库**，等用户采纳 | 自审通过即可直接入队（见 `store.js`） |
 *
 * 「按讲义」那条路能直接入队，**正是因为它先在规则层把依据对过了工具原文** ——
 * 没有那一步，它就只是一条绕过「默认不入库」的捷径。所以下面的
 * `admitLectureDrafts` 是这条路的**前提**，不是可选优化。
 */

import { QUIZ_TYPES } from './model.js';

/**
 * 这种题没有块号、页码和秒数。落盘用这个块号，界面据此**不提供回跳**。
 *
 * ⚠️ 用 `-1` 而不是 `0`：`0` 是一个**合法的块号**（节内第一块），
 * 用它当「无锚点」会让一道讲义题看起来像是从第一块出的，
 * 而它的依据其实在网上的检索结果里。
 */
export const kLectureQuizNoAnchorBlock = -1;

/**
 * 写在题目 `warnings` 上的前缀。数据层只让带这个前缀、且块号是
 * `kLectureQuizNoAnchorBlock` 的题直接进复习队列。
 */
export const kLectureQuizBasisPrefix = '讲义自审依据：';

/** 依据原文至少这么多字，才拿去对工具回包。**太短的片段到处都能碰上**。 */
export const kLectureQuizMinQuoteChars = 8;

/**
 * 讲义正文送进模型前的上限。超了会在末尾写明截断，**不假装后面也送了**。
 *
 * ⚠️ 截断提示必须**写进正文**：不写的话模型会以为「讲义就到这里」，
 * 于是「这一节没讲到的内容」会被它按常识补出来 —— 那正是幻觉题的来源。
 */
export const kLectureQuizMaxChars = 30000;

/**
 * 把一节讲义收成模型能读的正文。空讲义返回空串。
 *
 * @param {{title?:string, chapters?:Array}} lecture
 * @param {{maxChars?:number}} [options]
 */
export function lecturePlainText(lecture, { maxChars = kLectureQuizMaxChars } = {}) {
  const lines = [];
  const title = String(lecture?.title ?? '').trim();
  if (title !== '') lines.push(title);
  for (const chapter of lecture?.chapters ?? []) {
    lines.push('');
    const ct = String(chapter.title ?? '').trim();
    lines.push(`## ${ct === '' ? '（这一章没有标题）' : ct}`);
    for (const topic of chapter.topics ?? []) {
      lines.push('');
      const name = String(topic.title ?? '').trim() === '' ? '（这一小节没有标题）' : String(topic.title).trim();
      lines.push(`### ${name}`);
      for (const passage of topic.passages ?? []) {
        const text = String(passage.text ?? '').trim();
        if (text === '') continue;
        lines.push(text);
      }
    }
  }
  const body = lines.join('\n').trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n（讲义在这里截断了，后面的章节没有送进这一次出题。）`;
}

/** 模型这一轮要调用的工具。**只认** `search_course` 和 `web_search`。 */
export const kLectureQuizToolNames = Object.freeze(['search_course', 'web_search']);

/** 格式转换用的工具名。**出题模型不调用它**，转换那一步才会强制调用。 */
export const kLectureQuizSubmitTool = 'submit_questions';

/**
 * 出题 agent 的系统说明。它只检索、用普通中文写题，**不负责格式**。
 *
 * ⚠️ 「讲义本身不算依据」这一句是这一层的关键约束：讲义是**材料**，
 * 依据必须是**检索回来的原文**。少了这一句，模型会把讲义里的句子当成
 * 「查到的依据」抄进 evidence，于是依据核对退化成自证。
 */
export function lectureQuizSystemPrompt() {
  return `你在为一节课出抽查题。材料是这一节的讲义。

先用工具检索，再把题写出来：
- search_course：查已经解析入库的课程知识库。
- web_search：查网上的资料。讲义外面的内容只能靠它。
每道题的依据必须是这两个工具回包里的原文。出题前至少检索一次。
讲义本身不算依据，不要把讲义里的句子当成检索结果。

检索够了，用普通中文写出题目。不要写 JSON。

每一道题都写清楚：
- 在问什么
- 答案是什么。如果是选择题，写出各选项和哪一个对
- 你核对之后收不收：通过，或不通过，以及为什么
- 依据来自知识库还是网上，并把回包里的那一段原样抄下来

知识库的依据必须来自 search_course。讲义外面的内容可以出，但依据必须来自 web_search。没有检索结果的题不要写。`;
}

/** 发给出题 agent 的第一条消息：讲义正文和题数上限。 */
export function lectureQuizUserPrompt({ lectureText, maxQuestions = null }) {
  const lines = ['下面是这一节的讲义。', '', lectureText, ''];
  if (Number.isInteger(maxQuestions) && maxQuestions > 0) {
    lines.push(`这一次最多给出 ${maxQuestions} 道题。`);
  }
  lines.push('先检索，再用普通中文把题写出来。不要写 JSON。');
  return `${lines.join('\n')}\n`;
}

/** 格式转换那一步的说明。**只把已经写好的题填进工具，不新编**。 */
export function lectureQuizConvertPrompt() {
  return `你只做格式转换：把用户给出的出题结果填进 ${kLectureQuizSubmitTool}。
不要新编题目，不要改写依据原文。
用户没有写「通过」的题，pass 填 false。
依据的 quote 必须能在工具回包里原样找到；找不到就不要填这道题。`;
}

/** 交给格式转换的正文：出题结果，加上检索回包。 */
export function lectureQuizConvertInput({ reply, toolTranscript }) {
  return `出题结果：\n${String(reply).trim()}\n\n工具回包：\n${String(toolTranscript).trim()}\n`;
}

/** `submit_questions` 的参数结构。模型按字段填，本地再转成题目。 */
export function lectureQuizSubmitSchema() {
  const choice = {
    type: 'object',
    properties: {
      label: { type: 'string', description: '选项标签，例如 A。' },
      text: { type: 'string', description: '选项内容。' },
    },
    required: ['label', 'text'],
  };
  const evidence = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['knowledge', 'web'], description: 'knowledge=知识库检索，web=网上检索。' },
      quote: { type: 'string', description: '从对应工具回包里原样抄下的一段。' },
    },
    required: ['kind', 'quote'],
  };
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '这一次要交的题。',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['shortAnswer', 'mcq', 'cloze'], description: '简答 shortAnswer，选择 mcq，填空 cloze。' },
            stem: { type: 'string', description: '题干。' },
            answer: { type: 'string', description: '答案。选择题写正确选项的标签，例如 A。' },
            pass: { type: 'boolean', description: '自审通过才是 true。没把握就是 false。' },
            audit: { type: 'string', description: '为什么跟老师的讲法一致，或为什么不通过。' },
            evidence: { type: 'array', description: '依据。quote 必须是工具回包里的原文。', items: evidence },
            choices: { type: 'array', description: '只有选择题需要。', items: choice },
          },
          required: ['stem', 'answer', 'pass', 'evidence'],
        },
      },
    },
    required: ['questions'],
  };
}

// ── 宽松解码 / 字段别名 ──────────────────────────────────────────

const squash = (text) => String(text).replace(/\s+/g, '');

function firstOf(item, keys) {
  for (const key of keys) {
    if (item?.[key] !== null && item?.[key] !== undefined) return item[key];
  }
  return null;
}

const pickOf = (item, keys) => {
  const v = firstOf(item, keys);
  return v === null || v === undefined ? '' : String(v);
};

/** `true` / `1` / `'true'` / `'yes'` / `'1'` / `'通过'` / `'是'` 都算通过。 */
function passOf(value) {
  if (value === true || value === 1) return true;
  const s = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === '通过' || s === '是';
}

/** 题型别名 → 稳定代号。**认不出的原样返回**（由调用方决定怎么办，不猜静默默认值）。 */
function typeOf(value) {
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (['mcq', '选择', '选择题', '单选'].includes(s)) return 'mcq';
  if (['cloze', '填空', '填空题'].includes(s)) return 'cloze';
  if (['shortAnswer', '简答', '简答题', '问答', ''].includes(s)) return 'shortAnswer';
  return s;
}

/** 依据类型别名 → `knowledge` / `web`。 */
function kindOf(value) {
  const s = (value === null || value === undefined ? '' : String(value).trim()).toLowerCase();
  if (['web', '网上', '课外', '网络'].includes(s)) return 'web';
  if (['knowledge', '知识库', '课程', ''].includes(s)) return 'knowledge';
  return String(value ?? '').trim();
}

function evidenceItem(item) {
  const quote = pickOf(item, ['quote', '原文', 'text', '内容']);
  if (quote.trim() === '') return null;
  return { kind: kindOf(firstOf(item, ['kind', '类型', '来源'])), quote };
}

/** 一行字符串形态的依据：`kind｜quote` 或 `kind|quote`。 */
function evidenceLines(raw) {
  const out = [];
  for (const line of String(raw).split(/[\n；;]/)) {
    const t = line.trim();
    if (t === '') continue;
    const sep = t.includes('｜') ? '｜' : (t.includes('|') ? '|' : '');
    if (sep === '') {
      out.push({ kind: 'knowledge', quote: t });
      continue;
    }
    const at = t.indexOf(sep);
    const kind = kindOf(t.slice(0, at));
    const quote = t.slice(at + sep.length).trim();
    if (quote === '') continue;
    out.push({ kind: kind === '' ? 'knowledge' : kind, quote });
  }
  return out;
}

function evidenceOf(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') return evidenceLines(raw);
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      if (typeof item === 'string') out.push(...evidenceLines(item));
      else if (item !== null && typeof item === 'object') {
        const one = evidenceItem(item);
        if (one !== null) out.push(one);
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    const one = evidenceItem(raw);
    return one === null ? [] : [one];
  }
  return [];
}

/** 选项：字符串行（`A. 内容`）或 `{label,text}` 对象都认。 */
function choicesOf(raw) {
  const lines = [];
  if (typeof raw === 'string') lines.push(...raw.split('\n'));
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') lines.push(item);
      else if (item !== null && typeof item === 'object') {
        const label = pickOf(item, ['label', '标签']).trim();
        const text = pickOf(item, ['text', '内容']).trim();
        if (label !== '' && text !== '') lines.push(`${label}. ${text}`);
      }
    }
  }
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z])\s*[.、．)]\s*(.+)$/.exec(String(line).trim());
    if (m === null) continue;
    const text = m[2].trim();
    if (text === '') continue;
    out.push({ label: m[1].toUpperCase(), text });
  }
  return out;
}

/** 把一批原始条目整理成草稿。 */
function draftsOf(raw) {
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    out.push({
      type: typeOf(firstOf(item, ['type', '题型', '类型'])),
      stem: pickOf(item, ['stem', '题干', '问题', '题目']),
      answer: pickOf(item, ['answer', '答案', '答']),
      pass: passOf(firstOf(item, ['pass', '自审', '通过'])),
      audit: pickOf(item, ['audit', '核对', '说明', '自审说明']),
      evidence: evidenceOf(item.evidence ?? item['依据']),
      choices: choicesOf(item.choices ?? item['选项']),
    });
  }
  return out;
}

/** 宽松解码：先试整段 JSON，失败再从第一个 `{` 到最后一个 `}` 试。 */
function decodeLoose(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return decodeObject(trimmed);
  }
}

function decodeObject(chunk) {
  const start = chunk.indexOf('{');
  const end = chunk.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const decoded = JSON.parse(chunk.slice(start, end + 1));
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** 文本里的全部 JSON 对象候选（先看 ``` 围栏，没有就整段）。 */
function jsonCandidates(raw) {
  const chunks = [];
  for (const m of String(raw).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) chunks.push(m[1].trim());
  if (chunks.length === 0) chunks.push(String(raw).trim());
  const out = [];
  for (const chunk of chunks) {
    const decoded = decodeObject(chunk);
    if (decoded !== null) out.push(decoded);
  }
  return out;
}

/**
 * 把交题工具的参数整理成草稿。**认字段名和中文别名**，不要求模型自己排 JSON。
 */
export function lectureQuizDraftsFromArgs(args) {
  const questions = args?.questions ?? args?.items;
  if (Array.isArray(questions)) return draftsOf(questions);
  if (typeof questions === 'string') {
    const decoded = decodeLoose(questions);
    if (Array.isArray(decoded)) return draftsOf(decoded);
    if (decoded !== null && typeof decoded === 'object') return lectureQuizDraftsFromArgs(decoded);
  }
  if (args?.stem !== null && args?.stem !== undefined) return draftsOf([args]);
  if (args?.['题干'] !== null && args?.['题干'] !== undefined) return draftsOf([args]);
  return [];
}

/** 工具事件里的参数是一段字符串。**解不开就当这次没交上**（返回空数组）。 */
export function lectureQuizDraftsFromArguments(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === '') return [];
  const decoded = decodeLoose(trimmed);
  if (Array.isArray(decoded)) return draftsOf(decoded);
  if (decoded !== null && typeof decoded === 'object') return lectureQuizDraftsFromArgs(decoded);
  return [];
}

/**
 * 解析模型这一轮的输出。认不出就在 `problem` 里**说明**。
 *
 * ⚠️ 从**后往前**扫：模型最后一轮的输出才是它当前的立场
 * （前面几轮可能还在给中间结论）。
 */
export function parseLectureQuizTurn(raw) {
  const objects = jsonCandidates(raw);
  if (objects.length === 0) return { tool: null, questions: [], problem: '模型这一轮没有给出 JSON' };
  for (const decoded of [...objects].reverse()) {
    const tool = decoded.tool;
    if (typeof tool === 'string' && tool.trim() !== '') {
      const name = tool.trim();
      if (!kLectureQuizToolNames.includes(name)) {
        return { tool: null, questions: [], problem: `模型要调用的工具「${name}」不在允许的名单里` };
      }
      const argsRaw = decoded.args;
      const args = {};
      if (argsRaw !== null && typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
        for (const [k, v] of Object.entries(argsRaw)) args[k] = v;
      }
      const query = String(args.query ?? '').trim();
      if (query === '') {
        return { tool: null, questions: [], problem: `模型调用 ${name} 时没有给 query` };
      }
      return { tool: { name, args }, questions: [], problem: null };
    }
    if (Array.isArray(decoded.questions)) {
      return { tool: null, questions: draftsOf(decoded.questions), problem: null };
    }
  }
  return { tool: null, questions: [], problem: '模型这一轮的 JSON 里既没有 tool，也没有 questions' };
}

/** 依据对不上工具回包时的**具名**理由（`null` = 都对得上）。 */
function badEvidence(evidence, haystack) {
  if (haystack === '') return '没有工具回包，依据对不上';
  for (const item of evidence) {
    const kind = String(item.kind).trim();
    if (kind !== 'knowledge' && kind !== 'web') {
      return `依据类型「${kind}」不是 knowledge 或 web`;
    }
    const quote = String(item.quote).trim();
    if ([...quote].length < kLectureQuizMinQuoteChars) {
      return '依据太短，不能当作原文';
    }
    if (!haystack.includes(squash(quote))) {
      return '依据不在工具回包里（不能把模型自己写的句子当成检索结果）';
    }
  }
  return null;
}

/**
 * 只留下**自审通过、且每一条依据都能在工具回包里找到**的题。
 *
 * ⚠️ 这是「按讲义出题可以直接入队」的**全部前提**。四条判据依次是：
 * ① 题干 / 答案非空；② `pass` 为真；③ 至少有一条依据；
 * ④ 每条依据都能在工具回包原文里找到（**长度下限**挡住「到处都能碰上的短片段」）。
 *
 * 被挡下的每一条都进 `dropped` 并**带名字**（「第 N 题」+ 具体理由）。
 *
 * @returns {{admitted: Array<object>, dropped: string[]}}
 */
export function admitLectureDrafts({ drafts, toolTranscript }) {
  const admitted = [];
  const dropped = [];
  const haystack = squash(toolTranscript);
  drafts.forEach((draft, i) => {
    const label = `第 ${i + 1} 题`;
    if (String(draft.stem).trim() === '' || String(draft.answer).trim() === '') {
      dropped.push(`${label}没有题干或答案`);
      return;
    }
    if (!draft.pass) {
      dropped.push(`${label}自审没有通过${String(draft.audit).trim() === '' ? '' : `：${String(draft.audit).trim()}`}`);
      return;
    }
    if (draft.evidence.length === 0) {
      dropped.push(`${label}没有依据`);
      return;
    }
    const bad = badEvidence(draft.evidence, haystack);
    if (bad !== null) {
      dropped.push(`${label}${bad}`);
      return;
    }
    admitted.push(draft);
  });
  return { admitted, dropped };
}

/**
 * 把一条**通过依据核对**的讲义草稿转成题目形状所需的字段。
 *
 * ⚠️ 四件事都在这里定死，且**都照抄 App 的取值**：
 * 1. 块号恒为 `kLectureQuizNoAnchorBlock`（-1）—— 讲义题没有块锚点，
 *    界面据此**不提供回跳**（给一个假块号会让「点回原文」跳到别处且不报错）；
 * 2. 页号 / 秒数恒为 **0**（`lib/state/quiz.dart` 的 `page: 0` / `atSec: 0`）。
 *    ⚠️ **这与硬检查的 `schema` 项冲突**：`schema` 要求 `page >= 1`，
 *    所以一道讲义题若送进 `runHardChecks` 会在 `schema` 上判 fail。
 *    App 侧不会撞上，因为讲义那条路**整条绕过质检链**（它自己的判据是
 *    「依据能对上工具回包原文」，见 `admitLectureDrafts`）。
 *    **本包照抄 0 而不是改成 1**：改成 1 是发明一个 App 没有的取值，
 *    会让两边读同一份数据时对不上。这条冲突如实登记在包 README 里。
 * 3. 依据**逐条**进 `warnings`，前缀 `kLectureQuizBasisPrefix` +
 *    `kind｜quote`（与 App 的拼接方式一致）—— 数据层只认这个前缀，
 *    所以这里漏掉就等于「按讲义」这条路整条失效；
 * 4. 状态由调用方定（`store.saveSelfAudited`），这里**不碰** status。
 *
 * @returns {{blockIndex:number, page:number, atSec:number, warnings:string[], type:string|null,
 *   stem:string, answer:string, choices:Array<{label:string,text:string}>}}
 */
export function lectureDraftToItemFields(draft, { type = null } = {}) {
  const rawType = type ?? draft.type;
  // 认不出的题型 → `null`（调用方**报出来**并跳过，绝不退回默认值）：
  // 把一个不认识的题型静默当成填空题，会让质检对着错的口径说「通过」。
  const resolved = rawType === 'mcq' ? QUIZ_TYPES.mcq
    : rawType === 'cloze' ? QUIZ_TYPES.cloze
      : rawType === 'shortAnswer' ? QUIZ_TYPES.shortAnswer
        : null;

  const warnings = draft.evidence
    .map((e) => `${kLectureQuizBasisPrefix}${e.kind}｜${String(e.quote).trim()}`);
  const audit = String(draft.audit).trim();
  if (audit !== '') warnings.push(`自审：${audit}`);

  return {
    blockIndex: kLectureQuizNoAnchorBlock,
    page: 0,
    atSec: 0,
    warnings,
    type: resolved,
    stem: String(draft.stem).trim(),
    answer: String(draft.answer).trim(),
    choices: draft.choices.map((c) => ({ label: c.label, text: c.text })),
  };
}
