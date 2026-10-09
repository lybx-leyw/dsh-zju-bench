/**
 * **习坎：按知识树填充讲义正文**（纯函数 + 一次 LLM 调用）。
 *
 * 逐条对齐 App 的 `lib/fusion/lecture_polish.dart`。命名取自校歌《大不自多》：
 * 「习坎示教，始见经纶」—— 把老师课堂上讲的话，按知识树整理成书面讲义。
 *
 * # ★ 为什么是「按树填充」而不是「整份改写」
 *
 * 前两版都卡在同一件事上：把要求写成对**文字**的约束（「长度与原文相当」、
 * 「不要分点」），模型总能找到「保持原样」这个既省力又合规的答案 ——
 * 实测整份只压缩到 99.6%、口语词 9 → 9 一字未改。
 *
 * **限定结构**才堵住它：内容必须分布到树上每个节点的位置上，
 * 一整段照抄**放不进任何一个节点**。
 *
 * # ⚠️ 只做一级加工
 *
 * 用户明确选择「只做一级：习坎」。本包不含第二级终审（那是 `dsh-zhiyun-final-pass`
 * 的活，且跑在宿主 agent 运行时上）。留着不调用就是「新旧并存」，
 * 两条路会在半年内无声漂开。
 *
 * # 失败一律降级，不抛
 *
 * 讲义是派生层，不该让整节解析失败。任何**单点**失败都变成 `failures` 里的一条，
 * 受影响的知识点**保留上一版正文**（= 老师原话）。那是「结构完好但读起来是
 * 录音稿」的讲义 —— 比什么都没有有用得多，而且用户能从告警里知道哪几段是原话。
 *
 * ⛔ 唯一的例外是**取消**：取消是调用方的意志，不是失败，所以抛 `CANCELLED`。
 */

import { LectureError } from './errors.js';
import { judgeWritten, REGISTER } from './register.js';
import { tidySlideHeading } from './tree.js';

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 加工阶段名（进 llm 的 stage 与告警文本）。 */
export const kStage = 'lecture';

/** 中文阶段名（人可读的失败原因里用它，与 App 的告警逐字一致）。 */
export const kStageName = '习坎';

/**
 * 单次请求的**最大知识点数**：默认 1（一个概念一次调用）。
 *
 * App 侧的实测表（8/12/16/24/152 条批量）本来是这个数的依据，但那版契约是
 * 「输出一段 body」，而**本版契约变了**：按树填充 + 每段可选类型名，照抄在
 * 结构上就不合规。所以现在的依据回到工程量与失败隔离半径 —— 一条坏了不牵连别人。
 */
export const kMaxTopicsPerCall = 1;

/**
 * 撰写缓存的结构版本。提示词或块结构变了就改它，旧缓存不会被当成新稿。
 *
 * ⚠️ 本包**不落盘**（缓存由集成层负责），但这个版本号仍然要暴露出去：
 *    集成层拿它当缓存键的一部分，否则换了提示词之后用户看到的还是上一次的正文，
 *    而代码以为已经按新提示词跑过了。
 */
export const kLecturePolishSchema = 4;

/** 单次请求的**最大正文字数**（与 kMaxTopicsPerCall 任一超限就切卷）。 */
export const kMaxLectureCharsPerCall = 12000;

/** 加工的输出预算（token）。关掉思考之后这个预算是真的给正文的。 */
export const kLecturePolishMaxTokens = 32768;

/**
 * **习坎的系统提示词：按树填充**。
 *
 * # 只规定**产物**，不规定**步骤**
 *
 * 用户纠正过：不应该对 LLM 的实践步骤做规定，只需要规定产物符合
 * 「没有明显语气词」「没有课堂指代」等等。写成步骤有三个毛病：
 * 管了不该管的（怎么整理是模型的事）、步骤会打架（「整句删掉闲话」与
 * 「每个节点都要有产出」直接矛盾）、步骤不可验收。
 *
 * # 只写用户要的，不写我的偏好
 *
 * 用户被问「除取消口语外还要写入哪些硬性要求」时只勾了一项：**不得新增原文
 * 没有的内容**。其余（长度上下限、必须成段、术语一致…）全部**不勾**。
 * 所以这里不写 —— 这不是遗漏，是用户明确不要。
 *
 * # ⚠️ 「不要……」句式被实测否过
 *
 * 提示词里每一句「不要……」都可能被读成「那就别动」。所以本提示词不写禁令，
 * 只正面写清「合格的长什么样」。唯一的例外是那条**力度对照** —— 它是全篇
 * 唯一花字数在「力度」上的东西，而力度正是唯一被实测证明会失效的维度。
 *
 * ⚠️ 文本必须与 App 的 `kLectureWrittenSystemPrompt` **逐字节一致**（含开头
 *    那个显式换行）：差 1 字节就不是同一个实验条件，那 40 次生成调用的
 *    对照结论也就不再适用。
 *
 * # 为什么用 `String.raw` + 占位符
 *
 * 提示词里有 `\log` / `\le` 这类**字面反斜杠**（普通模板串会把 `\l` 吃成 `l`，
 * 把一个实验条件改掉），又有一段**行内代码**要用反引号包起来 —— 而反引号
 * 正是模板串的分隔符，写不进去。所以模板里用 `⟦BT⟧` 占位、加载时换回反引号。
 *
 * ⚠️ 这个坑是实测踩出来的：先前用手写字符串拼接绕开反引号，结果**漏掉了 4 个
 *    反引号**（提示词少 4 字符）—— 那正是「逐字节一致」这条纪律要防的事。
 *    现在由 `tests/fixtures/lecture/system-prompt.txt`（从 Dart 源码提取的
 *    冻结契约）逐字节钉住，改错了测试就红。
 */
const BACKTICK = '⟦BT⟧';
export const kLectureWrittenSystemPrompt = '\n' + String.raw`你是把大学课堂录音稿整理成**讲义**的编辑。

你拿到一棵知识树：每个节点是一个知识点（标题是课件上的原文），
节点下面是老师讲这个知识点时的口语转录（自动语音识别）。

# 产物要求

把每个节点下的口语整理成该知识点的书面正文。整理后的正文：

- **没有语气词**：呃、嗯、啊、这个、那个、就是说、对吧、我们来看、
  大家、同学们、逻辑上 —— 这些一个都不出现。
- **没有课堂指代**：「上节课那个」「我们刚才说的」「这个东西」这类
  只有坐在教室里才懂的指代不能留；没上过这节课的人也读得懂。
- **正文只写知识**：概念、步骤、例子、理由、结论。读者不看课件也能读懂
  这件事本身。画面怎么画、标题栏、页眉、颜色、箭头、第几页，都不属于正文。
- **是书面陈述句**，不是说话的口气。
- 整个节点**只有**点名、调设备、宣布日期这类纯事务时，
  **一句话说清即可**，不必展开。
  ⚠️ 但只要里面**还有一点知识**（解释、方法、对比、理由），
  就按正常讲解写，**不许**用「本节点为课堂事务性内容」这类概括句收场。

# 忠实

- **不新增**老师没讲的知识、结论、例子、数字。
- 数字、公式、符号、单位、人名**照原话**。专名拿不准时沿用录音里的写法，
  不另造一个术语。句子仍是书面陈述，语气词不留在里面。
- 原话里不确定的（「可能」「大概」「我印象里」），整理后仍保持不确定。
- **原话讲到的知识都要留在正文里**：这个知识点下面老师讲的每个结论、
  每个步骤、每个例子、每个理由、每个考虑过的方案，整理后都要有对应的
  句子 —— 原话里零碎、跳来跳去的同一件事，合并成一段通顺的话，
  但那件事仍要在。可以删的只有口语噪音（语气词、重复、说半句、跑题闲聊）。
  **一句话能不能省，看它有没有讲出「怎么做事 / 为什么」**：
  有就留下（课堂讨论、上机要求、方案对比、作业怎么交，往往都在讲方法
  与取舍），没有才删（「这节课上到这里」「谢谢大家」这类）。
  ⚠️ **不许把整段内容压成一句**：要写成讲解，不是写成摘要。
- 数学写成**能直接读的文字**：不要用 ⟦BT⟧$...$⟦BT⟧ 把公式包起来，也不要写
  ⟦BT⟧\log⟦BT⟧、⟦BT⟧\le⟦BT⟧ 这类反斜杠命令；下标写成「A 的左子树」这样的说法，
  或用普通字符如 ⟦BT⟧B_R⟦BT⟧。

力度对照（照右边这个力度做）：

| 原话 | 整理后 |
|---|---|
| 这是内存的情况，内存足够的情况随机寻址的。但后面呢上节课的最后我们讲的比较熟啊。那更多的是内存不够用了，要用外那外层的一般甚至效率相对比较低。哎，他这个希望这个树的高度不要太高。 | 内存充足时采用随机寻址；内存不足时需用外存，而外存的访问效率较低。为减少外存访问，希望树的高度尽量低。 |

# 分段

一个概念下不同性质的内容分成几块。kind 只能是：
elaboration（讲解）、definition（定义）、procedure（步骤）、example（例题）、note（说明）。
例题写 stem 与 solution。没有对应内容就不输出该块。
整段都是点名、交作业、调设备时，用 note，一句话即可。

# 输出格式（严格遵守）
只输出一个 JSON 对象，不要解释、不要 markdown 代码围栏：

{"c":1,"t":1,"slots":[{"kind":"elaboration","text":"正文"}]}

例题写成 {"kind":"example","stem":"题干","solution":"解答"}。
c / t 是输入里给出的序号。text、stem、solution 为纯文本。
`.replaceAll(BACKTICK, '`');

// ═══════════════════════════════════════════════════════════════
// 护栏（客观可判的那部分）
// ═══════════════════════════════════════════════════════════════

/**
 * **口语词表**（去口语化的客观判据）。
 *
 * ⚠️ 表里只放**书面语里绝不会自然出现**的词。早先版本把「这样的情况」
 *    「是不是」也列了进来 —— 那些都是合法的书面语，读数虚高，
 *    量出来的不是同一件事。
 *
 * ⚠️ 「这个 / 那个」在书面语里也可能合法（「这个定理」），所以它们是
 *    **相对下降**判据的一部分，不是「出现即失败」。
 */
export const kLectureFillerWords = [
  '呃', '嗯', '啊',
  '就是说', '对吧', '对不对', '然后呢',
  '我们来看', '我们讲', '大家', '同学们', '听懂了吗',
  '逻辑上',
  '这个', '那个',
];

/** 成稿里可以整词删掉的语气。不含「这个 / 那个」：书面语里它们可以是正常指示。 */
export const kWrittenStripWords = [
  '我们来看', '听懂了吗', '就是说', '对不对', '然后呢', '对吧',
  '同学们', '各位同学', '呃', '嗯', '啊',
];

/** 加工后口语词命中的**最大保留比例**（相对原话）。这条判据**只报不拦**。 */
export const kPolishMaxFillerKeep = 0.34;

/** 长度上限的比例（相对原稿的**内容字数**）。超上限**会回退**。 */
export const kPolishLengthRatio = 1.6;

/** 长度检查的**常数余量**（内容字）。让判据落在「有没有多出一整句」上。 */
export const kPolishLengthSlack = 60;

/** 长度下限的比例。低于它**只报告、不回退**（三次校准失败换来的结论）。 */
export const kPolishMinLengthRatio = 0.3;

/** 把整理稿里的语气词和整句画面描述拿掉。删完若什么都不剩，调用方保留原文。 */
export function tidyWrittenText(raw) {
  let s = String(raw ?? '').replaceAll('\r\n', '\n');
  for (const w of kWrittenStripWords) s = s.replaceAll(w, '');
  const lines = [];
  for (const line of s.split('\n')) {
    const t = squashWrittenPunct(line.trim());
    if (t.length === 0 || isVisionLine(t)) continue;
    lines.push(t);
  }
  return lines.join('\n').trim();
}

function squashWrittenPunct(s) {
  let t = s.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^[，、；：\s]+/, '');
  t = t.replace(/([，、；])\1+/g, '$1');
  t = t.replace(/([。！？])[，、；]+/g, '$1');
  return t.trim();
}

function isVisionLine(line) {
  const t = String(line ?? '').trim();
  if (t.length === 0) return true;
  if (tidySlideHeading(t) === '') return true;
  return /^(标题栏|窗口标题|右上角|左上角|椭圆|示意图|页眉|页脚)/.test(t);
}

/** 送给模型的课件线索：画面描述和界面文字去掉，剩下的行再剥一层版式前缀。 */
export function slideCluesForPolish(lines) {
  const out = [];
  for (const raw of (lines ?? []).slice(0, 12)) {
    const clue = tidySlideHeading(raw);
    if (clue === '' || out.includes(clue)) continue;
    out.push(clue);
  }
  return out;
}

function hitsFiller(s, words) {
  let n = 0;
  for (const w of words) {
    let i = 0;
    for (;;) {
      const j = s.indexOf(w, i);
      if (j < 0) break;
      n++;
      i = j + w.length;
    }
  }
  return n;
}

/**
 * 这一段的口语词**有没有明显下降**。返回 `null` = 通过。
 *
 * ⚠️ 这条判据**只报告，不回退**（实测结论，不是偷懒）：早先版本在命中率高时
 *    保留老师原话，那是错的 —— **原话的口语词比整理结果更多**，
 *    等于「因为它不干净，所以给你一份更脏的」。
 */
export function checkPolishFiller({ source, rewritten } = {}) {
  const src = String(source ?? '').trim();
  const dst = String(rewritten ?? '').trim();
  if (dst.length === 0) return null; // 空值由 checkPolishLength 负责报

  const srcHits = hitsFiller(src, kLectureFillerWords);
  const dstHits = hitsFiller(dst, kLectureFillerWords);
  // 原话本来就没什么口语词（例如一整页纯英文术语）→ 不判。
  if (srcHits === 0) return null;

  const keepLimit = srcHits * kPolishMaxFillerKeep;
  if (dstHits <= keepLimit) return null;
  return `整理后口语词仍有 ${dstHits} 处（原话 ${srcHits} 处，`
    + `允许保留 ${keepLimit.toFixed(1)} 处）—— 这一段基本没被去口语化`;
}

/**
 * **长度上限护栏**：加工后的正文是不是「凭空加了内容」。返回 `null` = 通过。
 *
 * 上限**会回退**，而下限只报告 —— 这个不对称是有依据的：模型**写进**了原稿
 * 没有的东西时，字数变多是客观事实、没有误报空间；而「缩太狠」分不清
 * 「杂音被清掉了」与「知识被丢了」（三轮校准都失败）。
 */
export function checkPolishLength({ source, rewritten } = {}) {
  const src = String(source ?? '').trim();
  const dst = String(rewritten ?? '').trim();
  if (dst.length === 0) return '加工结果是空的';
  const srcN = contentChars(src);
  if (srcN === 0) return null; // 原稿没内容，无从比较

  // 分母用**全部**内容字（扣掉噪音会让上限更松，方向反了）。
  const hi = Math.ceil(srcN * kPolishLengthRatio) + kPolishLengthSlack;
  const dstN = contentChars(dst);
  if (dstN > hi) {
    return `加工后内容 ${dstN} 字，超过原稿 ${srcN} 字的 `
      + `${kPolishLengthRatio.toFixed(1)} 倍 + ${kPolishLengthSlack} 字上限（共 ${hi} 字）`
      + '—— 疑似引入了原稿没有的内容';
  }
  return null;
}

/** **缩水告警**：加工后比原稿短得多（**只报告，不回退**）。 */
export function checkPolishShrink({ source, rewritten } = {}) {
  const src = contentChars(String(source ?? '').trim());
  const dst = contentChars(String(rewritten ?? '').trim());
  if (src === 0 || dst === 0) return null;
  const keep = dst / src;
  if (keep >= kPolishMinLengthRatio) return null;
  return `整理后只剩 ${dst} 字（原稿 ${src} 字，保留了 ${Math.round(keep * 100)}%）`
    + '—— 比通常的压缩狠得多，请看一眼这一段的产出是否完整';
}

/**
 * **产出残缺的硬判据**（能与「缩水」一起触发回退的那一条）。
 *
 * 长度不可靠，但「真丢内容」确实存在：真机见过模型把 `类型：教学安排`
 * 这种**输入的元信息行**当正文回填，那一段的知识被整段丢掉。它的形态很特殊
 * —— **不是「短」，而是「短得不像一段讲解」**。
 *
 * ⚠️ 两条都刻意保守：宁可漏判（产出照常采纳 + 告警），不可误判
 *    （把好的产出退回去）。
 */
export function isBrokenOutput({ source, rewritten } = {}) {
  const dst = String(rewritten ?? '').trim();
  if (dst.length === 0) return true;

  // ① 把输入的元信息行当正文回填了。
  const metaMarkers = ['类型：', '知识点：', '老师讲的话', '课件上的要点', '课件线索'];
  for (const m of metaMarkers) {
    if (dst.length <= 40 && dst.includes(m)) return true;
  }

  // ② 极短 + 原稿成规模 → 明显是残缺。
  const srcN = contentChars(String(source ?? '').trim());
  const dstN = contentChars(dst);
  if (srcN >= 200 && dstN <= 20) return true;
  return false;
}

/**
 * **内容字数**：只数文字，不数标点与空白。
 *
 * 用它而不是 `String.length`：重新断句、加小标题、插换行都会改变原始长度，
 * 而那与「有没有新增内容」是两件事。
 */
export function contentChars(s) {
  let n = 0;
  for (const ch of String(s ?? '')) {
    const r = ch.codePointAt(0);
    if (isWidePunctuation(r)) continue;
    if (r <= 0x20) continue;
    if (r < 0x80 && !isAsciiLetter(r)) continue;
    n++;
  }
  return n;
}

function isAsciiLetter(r) {
  return (r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a);
}

function isWidePunctuation(r) {
  const ranges = [
    [0x3000, 0x303f], [0xff00, 0xff0f], [0xff1a, 0xff20], [0xff3b, 0xff40],
    [0xff5b, 0xff65], [0x2010, 0x2027], [0x2030, 0x205e],
  ];
  for (const [lo, hi] of ranges) if (r >= lo && r <= hi) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 块类型
// ═══════════════════════════════════════════════════════════════

/** 讲义块的闭集（wire 与中文名都与 App 的 `LectureBlockKind` 一致）。 */
export const BLOCK_KINDS = Object.freeze([
  { wire: 'elaboration', label: '讲解' },
  { wire: 'definition', label: '定义' },
  { wire: 'procedure', label: '步骤' },
  { wire: 'example', label: '例题' },
  { wire: 'note', label: '说明' },
]);

const BLOCK_ALIAS = {
  概念: 'definition', 法则: 'definition', 公式: 'definition', 定理: 'definition',
  作业: 'note', 教学安排: 'note', 补充: 'note',
  案例: 'elaboration', 讨论: 'elaboration',
  实验: 'procedure',
};

/**
 * 按名字（wire 或中文名）找一个已知块类型；认不出返回 `null`。
 *
 * ⚠️ 返回 `null` **不是错误**：那表示模型用了一个表外的类型名
 *    （「补充」「讨论」「注意」都合理）。但 `parse` 的调用方
 *    （响应解析）**必须拒绝**它 —— 见 `parseLecturePolishResponse`。
 */
export function parseBlockKind(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  for (const k of BLOCK_KINDS) if (k.wire === s || k.label === s) return k;
  const alias = BLOCK_ALIAS[s];
  if (!alias) return null;
  return BLOCK_KINDS.find((k) => k.wire === alias) ?? null;
}

function makeBlock({ kind, text = '', stem = '', solution = '', title = '', map = '' }) {
  return {
    kind,
    text,
    stem,
    solution,
    title,
    map,
    /** 显示名。空则用类型名。 */
    get heading() { return title.trim() !== '' ? title.trim() : kind.label; },
    /** 例题用 stem + solution，其余用 text。 */
    get displayText() {
      if (kind.wire === 'example') {
        return [stem.trim(), solution.trim()].filter((s) => s !== '').join('\n\n');
      }
      return text.trim();
    },
    get isEmpty() { return this.displayText === ''; },
  };
}

// ═══════════════════════════════════════════════════════════════
// 送模型的形状
// ═══════════════════════════════════════════════════════════════

/** 一个待填充的知识点（**只带填充需要的东西**，加工层没有能力破坏结构）。 */
export function makeInput({ chapterNo, topicNo, title = '', pptLines = [], text }) {
  return { chapterNo, topicNo, title, pptLines, text };
}

/** 拼一次请求的**变量段**（一卷的知识点拼在一起）。 */
export function lectureGlossary(inputs) {
  const terms = [];
  const add = (raw) => {
    const s = String(raw ?? '').trim();
    if (s === '' || s.length > 40) return;
    if (terms.includes(s)) return;
    terms.push(s);
  };
  for (const it of inputs) {
    add(it.title);
    for (const line of slideCluesForPolish(it.pptLines)) add(line);
  }
  if (terms.length === 0) return '';
  return `本讲术语：\n${terms.map((t) => `- ${t}`).join('\n')}`;
}

/**
 * 拼请求体的**变量段**。
 *
 * ⚠️ 元信息行必须**不可能被误当成正文**：真机实测模型把 `类型：教学安排`
 *    当正文回填，那一段的内容被整段丢掉。所以现在序号行用 `--- cX tY ---`
 *    包起来（明显是分隔符），PPT 标题与要点用 `#` 前缀标出，
 *    **正文另起一行且不加任何前缀**。
 */
export function buildLecturePolishBody(inputs, { title = '', glossary = '' } = {}) {
  const parts = [];
  if (title.trim() !== '') parts.push(`讲义标题：${title.trim()}`);
  if (glossary.trim() !== '') parts.push(glossary.trim(), '');
  parts.push(`下面是 ${inputs.length} 个知识点，请按约定格式输出 JSON。`, '');

  let lastChapter = -1;
  for (const it of inputs) {
    // 章标题只在换章时打一次 —— 让它看得出章节边界（它要消解「上节课说的那个」）。
    if (it.chapterNo !== lastChapter) {
      if (lastChapter !== -1) parts.push('');
      parts.push(`===== 第 ${it.chapterNo} 章 =====`);
      lastChapter = it.chapterNo;
    }
    parts.push(`--- c${it.chapterNo} t${it.topicNo} ---`);
    if (it.title.trim() !== '') {
      parts.push(`# 知识点：${it.title.trim()}`);
    } else {
      // ⚠️ 不编造标题：PPT 那几页没抽到文字时如实说「课件上没写标题」。
      parts.push('# 知识点：（课件这几页没有文字标题，请从下面老师讲的内容判断）');
    }
    const clues = slideCluesForPolish(it.pptLines);
    if (clues.length > 0) {
      parts.push('## 课件线索（只用来核对术语，不写入正文）：');
      for (const l of clues) parts.push(`- ${l}`);
    }
    parts.push('## 老师讲的话（口语，要整理的就是它）：');
    parts.push(it.text.trim());
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

/**
 * 按概念切请求。默认一个概念一次调用。
 *
 * [maxChars] 与 [maxTopics] 都 ≤ 0 时整份一次送出（「不切」的显式表达）。
 */
export function chunkLectureForPolish(inputs, {
  maxChars = kMaxLectureCharsPerCall,
  maxTopics = kMaxTopicsPerCall,
} = {}) {
  if (inputs.length === 0) return [];
  if (maxChars <= 0 && maxTopics <= 0) return [inputs];

  const out = [];
  let cur = [];
  let curChars = 0;
  for (const it of inputs) {
    const n = it.text.length;
    const tooManyChars = maxChars > 0 && cur.length > 0 && curChars + n > maxChars;
    const tooManyTopics = maxTopics > 0 && cur.length >= maxTopics;
    if (cur.length > 0 && (tooManyChars || tooManyTopics)) {
      out.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(it);
    curChars += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 解析响应
// ═══════════════════════════════════════════════════════════════

/** 去掉整体被 ``` 包住的那种回包（模型最常见的坏习惯）。 */
export function stripFences(raw) {
  let text = String(raw ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

function slotsOf(tRaw) {
  const raw = tRaw.slots;
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = parseBlockKind(item.kind ?? item.label ?? '');
    if (kind === null) {
      throw new LectureError('PARSE', `块类型无法识别：${item.kind ?? item.label}`);
    }
    const block = makeBlock({
      kind,
      text: String(item.text ?? item.body ?? ''),
      stem: String(item.stem ?? ''),
      solution: String(item.solution ?? ''),
      title: typeof item.title === 'string' ? item.title : kind.label,
      map: typeof item.map === 'string' ? item.map : '',
    });
    if (!block.isEmpty) out.push(block);
  }
  return out;
}

function passagesOf(tRaw) {
  const out = [];
  const add = (label, text) => {
    const s = String(text ?? '').trim();
    if (s === '') return;
    out.push({ label: String(label ?? '').trim(), text: s });
  };
  // ① 标准形态：passages 是对象数组（也容忍字符串数组 / paragraphs 这个旧叫法）。
  const rawP = tRaw.passages ?? tRaw.paragraphs;
  if (Array.isArray(rawP)) {
    for (const p of rawP) {
      if (typeof p === 'string') add('', p);
      else if (p !== null && typeof p === 'object' && !Array.isArray(p)) add(p.label, p.text ?? p.body ?? '');
    }
    return out;
  }
  // ② 没有 passages 数组，但有一条纯文本 body / text。
  const single = tRaw.body ?? tRaw.text;
  if (typeof single === 'string') add(tRaw.label, single);
  return out;
}

/**
 * 解析填充响应。
 *
 * # 为什么本函数**抛**而不是回退空列表
 *
 * 「解析失败」与「这一份加工出来的都空」是两件事，混成一句「没有产出」会让
 * 用户以为模型说「没什么可改的」。抛出去由调用方记成**一条带原因的 failure**，
 * 然后**保留上一版正文**。
 *
 * # 宽容度是刻意留的（内容比格式重要）
 *
 * | 坏习惯 | 处置 |
 * |---|---|
 * | 被 ``` 围栏包住 | 剥掉围栏 |
 * | `chapters` 外面还包一层 / 直接给数组 | 找到那一层 |
 * | `passages` 写成字符串数组 | 当成「没有小标题的段落」 |
 * | 段落的键写成 `body` 而不是 `text` | 照收 |
 * | 干脆给一个字符串 `body` | 当成单段 |
 *
 * ⛔ 但**序号必须是数字**：字符串 `"3"` 不宽容。串位会静默改错知识点，
 *    比「这次没产出」严重得多。
 */
export function parseLecturePolishResponse(raw) {
  if (String(raw ?? '').trim() === '') {
    throw new LectureError('PARSE', '模型返回了空内容（不是「没什么可整理的」，是这次没产出）');
  }
  const text = stripFences(raw).trim();

  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new LectureError('PARSE', `响应不是合法 JSON：${error.message}`);
  }

  // 允许外面再包一层（`{"result": {...}}`）。
  let root = decoded;
  if (root !== null && typeof root === 'object' && !Array.isArray(root) && root.chapters === undefined) {
    for (const v of Object.values(root)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.chapters !== undefined) {
        root = v;
        break;
      }
    }
  }
  // 直接给了一个章数组。
  if (Array.isArray(root)) root = { chapters: root };
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new LectureError('PARSE', `响应不是 JSON 对象（拿到 ${Array.isArray(decoded) ? 'array' : typeof decoded}）`);
  }
  // 顶层就是单个 slots 对象（一卷一条时的简写）。
  if (root.chapters === undefined && Array.isArray(root.slots)) {
    root = { chapters: [{ c: typeof root.c === 'number' ? root.c : 1, topics: [root] }] };
  }
  if (!Array.isArray(root.chapters)) throw new LectureError('PARSE', '响应里没有 chapters 数组');

  const out = [];
  for (const chRaw of root.chapters) {
    if (chRaw === null || typeof chRaw !== 'object' || Array.isArray(chRaw)) continue;
    const cNo = chRaw.c;
    if (typeof cNo !== 'number' || !Number.isInteger(cNo)) {
      throw new LectureError('PARSE', `章元素缺少整数序号 c（拿到 ${typeName(cNo)}）`);
    }
    // 容忍 `items` 这个旧叫法：模型可能沿用上一版的键名。
    const rawTopics = chRaw.topics ?? chRaw.items;
    if (!Array.isArray(rawTopics)) continue;
    for (const tRaw of rawTopics) {
      if (tRaw === null || typeof tRaw !== 'object' || Array.isArray(tRaw)) continue;
      const tNo = tRaw.t ?? tRaw.i;
      if (typeof tNo !== 'number' || !Number.isInteger(tNo)) {
        throw new LectureError('PARSE', `第 ${cNo} 章有知识点缺少整数序号 t（拿到 ${typeName(tNo)}）`);
      }
      const blocks = slotsOf(tRaw);
      const passages = blocks === null
        ? passagesOf(tRaw)
        : blocks.map((b) => ({ text: b.displayText, label: b.heading }));
      if (passages.length === 0) {
        throw new LectureError('PARSE', `第 ${cNo} 章第 ${tNo} 个知识点没有产出任何正文`);
      }
      out.push({
        chapterNo: cNo,
        topicNo: tNo,
        passages,
        blocks: blocks ?? [],
        /** 所有段落拼起来（护栏要用）。 */
        get body() { return passages.map((p) => p.text).join('\n\n'); },
      });
    }
  }
  if (out.length === 0) throw new LectureError('PARSE', '响应里一个知识点都没有');
  return out;
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 清洗一个产出：逐段去语气词与画面描述行；清空了就**保留模型原文**（不把知识清成空）。 */
function cleanResult(result) {
  const keepOrClean = (raw) => tidyWrittenText(raw).trim();
  const passages = result.passages
    .map((p) => ({ text: keepOrClean(p.text), label: p.label }))
    .filter((p) => p.text !== '');
  if (passages.length === 0) return result;
  return { ...result, passages };
}

// ═══════════════════════════════════════════════════════════════
// 并发闸
// ═══════════════════════════════════════════════════════════════

/**
 * 并发闸：限制同时打到模型端点上的请求数。
 *
 * ⚠️ 这是**本地 20 行原语**，与 `dsh-zhiyun-parser` 的 `Limiter` 同语义
 *    （排队、异常也释放名额、排队中可取消）。不跨包复用的理由：讲义包必须
 *    零宿主依赖且能单独发布，为了一个信号量去依赖解析器包，会把两个包的
 *    版本拴在一起 —— 而它们本来可以各自演进。
 *
 * 三条语义都是必须的，少一条就出真事故：
 *  - 异常也释放名额：否则一次失败把闸永久堵死（症状是「跑完 30 页之后进度条再也不动」）。
 *  - 排队中可取消：否则用户点了停止，队列里的请求还会照发（白花钱）。
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
    if (this.closed) throw new LectureError('DISPOSED', '讲义加工器已关闭');
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise((resolve, reject) => {
        const entry = {
          resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); },
        };
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
// 对外唯一入口
// ═══════════════════════════════════════════════════════════════

/**
 * 建一个**讲义加工器**。
 *
 * @param {object} options
 * @param {{call: Function}} options.llm 注入的**窄接口**：`call({stage, route,
 *   constant, variable, signal}) → {text, usage}`。本包**不自己发 HTTP**：
 *   联网实现由集成层注入（零宿主依赖的理由见包 README）。
 * @param {number} [options.concurrency=3] 同时最多几个请求在飞（1–16）。
 * @param {string} [options.route] 原样透传给 llm.call 的路由（模型由集成层解析）。
 * @param {number} [options.maxTopics] / [options.maxChars] 切卷上限（默认与 App 同值）。
 */
export function createLectureAssembler({ llm, concurrency = 3, route, maxTopics, maxChars } = {}) {
  if (!llm || typeof llm.call !== 'function') {
    throw new LectureError('CONFIG', '讲义加工需要注入 llm（形如 { call({stage,route,constant,variable,signal}) }）');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new LectureError('CONFIG', '讲义加工并发须为 1–16');
  }
  const limiter = new Limiter(concurrency);
  const controllers = new Set();
  let closed = false;

  /**
   * 按知识树填充讲义正文。
   *
   * @param {object} input
   * @param {object} input.tree `buildLectureTree` 的产物。
   * @param {Array<{index:number,text?:string,summary?:string,page?:number}>} input.blocks
   *   主线块（`role === '主线'`）。筛主线是集成层的活：本包不知道终稿的读模型。
   * @param {string|{title?:string}} [input.context] 讲义标题（提示词里会带上）。
   * @param {AbortSignal} [input.signal] 取消信号 —— 取消**抛** `CANCELLED`，不降级。
   * @param {Function} [input.onProgress] `({phase,done,total,chapterNo,topicNo})`。
   * @returns {Promise<{chapters:Array, failures:string[], calls:Array, warnings:string[]}>}
   */
  async function assemble({ tree, blocks = [], context = '', signal, onProgress } = {}) {
    if (closed) throw new LectureError('DISPOSED', '讲义加工器已关闭');
    if (!tree || !Array.isArray(tree.chapters)) {
      throw new LectureError('INPUT', '讲义加工需要一棵知识树（buildLectureTree 的产物）');
    }
    const title = typeof context === 'string' ? context : String(context?.title ?? '');

    const controller = new AbortController();
    controllers.add(controller);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    const failures = [];
    const warnings = [];
    const calls = [];
    try {
      combined.throwIfAborted();

      // ── ① 树 → 待填充的知识点（正文初值 = 老师原话）────────────────
      const byIndex = new Map((blocks ?? []).map((b) => [b.index, b]));
      const inputs = [];
      let skippedNoBlocks = 0;
      let skippedNoText = 0;
      for (let ci = 0; ci < tree.chapters.length; ci++) {
        const chapter = tree.chapters[ci];
        for (let ti = 0; ti < chapter.topics.length; ti++) {
          const topic = chapter.topics[ti];
          const own = topic.blockIndexes.map((i) => byIndex.get(i)).filter(Boolean);
          // 没讲到 / 没有块的节点不进讲义 —— 讲义是阅读产物，是树的**投影**。
          if (own.length === 0) { skippedNoBlocks++; continue; }
          const { text, missing } = draftBodyOf(own, warnings);
          // 真空才跳过（不是「没整理」，是「没内容」）。
          if (text === '') { skippedNoText++; continue; }
          inputs.push({
            chapterNo: ci + 1,
            topicNo: ti + 1,
            chapterIndex: ci,
            topicIndex: ti,
            title: topic.title,
            pptLines: topic.pptLines ?? [],
            text,
            missing,
          });
        }
      }
      if (skippedNoBlocks > 0) {
        warnings.push(`有 ${skippedNoBlocks} 个知识点本次课没讲到，未进入讲义（树里保留着）`);
      }
      if (skippedNoText > 0) {
        warnings.push(`有 ${skippedNoText} 个知识点没有正文也没有概述，未进入讲义`);
      }

      // ── ② 空输入**一次请求都不发**（本仓对白花钱敏感）────────────
      //
      // ⚠️ 走到这里说明树上没有一个「讲到了且有内容」的知识点 —— 那正是
      //    「这一节还没打标」的正常状态。返回空章节 + 上面那两条如实告警，
      //    而不是发一次注定无用的请求。
      if (inputs.length === 0) {
        return { chapters: [], failures, calls, warnings };
      }

      // ── ③ 习坎：一卷一次调用 ─────────────────────────────────
      const chunks = chunkLectureForPolish(inputs, {
        maxTopics: maxTopics ?? kMaxTopicsPerCall,
        maxChars: maxChars ?? kMaxLectureCharsPerCall,
      });
      const multi = chunks.length > 1;
      const glossary = lectureGlossary(inputs);

      // ⚠️ 并发跑，但**产出的顺序必须是确定的**：每个分卷各自攒自己的
      //    failures / calls，跑完之后按**分卷下标**拼起来。
      //
      //    不这么写的话，`failures` 的次序会随完成顺序漂移 —— 而它是给用户
      //    看的「哪一段没写成稿」，同一份输入每次给出不同次序的告警会让人
      //    以为「这次又出了别的问题」。并发是**吞吐**的手段，不是语义。
      const perChunk = await Promise.all(chunks.map(async (chunk, ci) => {
        combined.throwIfAborted();
        const where = multi ? `（第 ${ci + 1}/${chunks.length} 卷）` : '';
        const fail2 = [];
        const calls2 = [];
        // 只接受**属于本卷**的知识点：模型编一个不存在的章/条号时，
        // 静默收下会污染别卷的正文（那一卷可能还没跑）。
        const source = new Map(chunk.map((it) => [`${it.chapterNo}/${it.topicNo}`, it.text]));
        const body = buildLecturePolishBody(chunk, { title, glossary });

        // ⚠️ 「调用失败」与「调用了但回包读不懂」是**两件事**，calls 与 lastError
        //    分开记：前者是网络/额度，后者是模型跑偏。混成一条会让用户查错方向。
        let raw = '';
        let lastError = null;
        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts && raw.trim() === ''; attempt++) {
          combined.throwIfAborted();
          let text = null;
          try {
            const response = await limiter.run(() => llm.call({
              stage: kStage,
              route,
              constant: kLectureWrittenSystemPrompt,
              variable: body,
              signal: combined,
            }), combined);
            text = response?.text ?? '';
            calls2.push({
              stage: kStage, chapterNo: chunk[0].chapterNo, topicNo: chunk[0].topicNo,
              attempt, ok: true, usage: response?.usage ?? null,
            });
            // 回包干净（能解析、且含本卷的知识点）才认；否则重试一次。
            const parsed = parseLecturePolishResponse(text);
            if (!parsed.some((r) => source.has(`${r.chapterNo}/${r.topicNo}`))) {
              lastError = new LectureError('PARSE', '响应里没有本概念');
              continue;
            }
            raw = text;
            lastError = null;
          } catch (error) {
            if (combined.aborted) throw cancelled();
            if (error instanceof LectureError && error.code === 'CANCELLED') throw error;
            if (error?.name === 'AbortError') throw cancelled();
            lastError = error;
            if (text === null) {
              // 调用本身炸了（没拿到回包）—— 失败要有名字。
              calls2.push({
                stage: kStage, chapterNo: chunk[0].chapterNo, topicNo: chunk[0].topicNo,
                attempt, ok: false, usage: null,
                error: { code: error?.code ?? 'LLM_FAILED', message: errText(error) },
              });
            }
          }
        }
        if (raw.trim() === '') {
          const kind = lastError instanceof LectureError && lastError.code === 'PARSE'
            ? '响应无法解析' : '调用失败';
          fail2.push(`${kStageName}${where}${kind}：${errText(lastError)}`);
        }

        // 解析 + 护栏（结果只往本卷的槽位写）。
        const picked = new Map();
        if (raw.trim() !== '') {
          let parsed;
          try {
            parsed = parseLecturePolishResponse(raw);
          } catch (error) {
            fail2.push(`${kStageName}${where}响应无法解析：${errText(error)}`);
            parsed = [];
          }
          const seen = new Set();
          for (const r of parsed) {
            const key = `${r.chapterNo}/${r.topicNo}`;
            if (!source.has(key)) {
              // 不许静默丢弃（那是它跑偏的信号）。
              fail2.push(`${kStageName}${where}返回了不属于本卷的知识点 ${key}，已忽略`);
              continue;
            }
            if (seen.has(key)) {
              fail2.push(`${kStageName}${where}知识点 ${key} 重复出现，采用了第一条`);
              continue;
            }
            seen.add(key);
            // ── 护栏（四条，只有两条会回退）─────────────────────
            // 判据的分工：涨太多**会回退**（字数变多是客观事实，没有误报空间）；
            // 把标签行回填 / 极短残缺**会回退**（形态明确，不是靠长度猜）；
            // 缩水与口语词**只报告**（★ 长度分不开「杂音」与「知识」，
            // 不可靠的判据不能驱动自动回退）。
            const srcText = source.get(key) ?? '';
            const cleaned = cleanResult(r);
            const tooLong = checkPolishLength({ source: srcText, rewritten: cleaned.body });
            if (tooLong !== null) {
              fail2.push(`${kStageName}${where}知识点 ${key} ${tooLong}（保持老师原话）`);
              continue;
            }
            if (isBrokenOutput({ source: srcText, rewritten: cleaned.body })) {
              fail2.push(`${kStageName}${where}知识点 ${key} `
                + '产出残缺（把输入的标签当正文回填，或短得不成一段）（保持老师原话）');
              continue;
            }
            const shrink = checkPolishShrink({ source: srcText, rewritten: cleaned.body });
            if (shrink !== null) {
              fail2.push(`${kStageName}${where}知识点 ${key} ${shrink}（已采纳，供参考）`);
            }
            const loud = checkPolishFiller({ source: srcText, rewritten: cleaned.body });
            if (loud !== null) {
              fail2.push(`${kStageName}${where}知识点 ${key} ${loud}（已采纳，供参考）`);
            }
            const verdict = judgeWritten({ source: srcText, rewritten: cleaned.body });
            const notes = [...verdict.notes, ...[loud, shrink].filter(Boolean)];
            const register = (verdict.register === REGISTER.written && loud === null)
              ? REGISTER.written : REGISTER.draft;
            if (register !== REGISTER.written && verdict.notes.length > 0) {
              fail2.push(`${kStageName}${where}知识点 ${key} 保持草稿：${verdict.notes.join('、')}`);
            }
            picked.set(key, {
              passages: cleaned.passages,
              blocks: cleaned.blocks,
              register,
              notes,
            });
          }
        }

        // ⚠️ 「没返回」与「返回了但被护栏拦下」是**两件不同的事**，必须分开报。
        //    第一版只报「有 N 个知识点没有返回」—— 而那些其实返回了，
        //    是被长度护栏判失败才没被采纳。用户看到「没有返回」会去怀疑
        //    模型没干活/网络断了，而真正的原因是护栏。
        //
        //    ⚠️ 扫的是**本卷自己的** fail2，不是全局 failures：并发下全局数组里
        //       混着别卷的条目，拿它判「谁被拦下了」会把别卷的知识点算进来。
        const rejected = new Set();
        for (const f of fail2) {
          if (!f.includes('（保持老师原话）')) continue;
          const m = /知识点 (\d+\/\d+)/.exec(f);
          if (m) rejected.add(m[1]);
        }
        const missing = chunk
          .filter((it) => !picked.has(`${it.chapterNo}/${it.topicNo}`)
            && !rejected.has(`${it.chapterNo}/${it.topicNo}`))
          .map((it) => `c${it.chapterNo}t${it.topicNo}`);
        if (missing.length > 0) {
          fail2.push(`${kStageName}${where}有 ${missing.length} 个知识点**没有返回**`
            + `（${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}），`
            + '这些知识点保持老师原话');
        }

        // 写回：命中就换成成稿，其余保持上一版正文（= 老师原话）。
        for (const it of chunk) {
          writeBack(inputs, it, picked.get(`${it.chapterNo}/${it.topicNo}`));
        }
        return { fail2, calls2, chunk };
      }));

      // 按分卷下标拼装（顺序确定，见上面那段注释）。
      for (const r of perChunk) {
        failures.push(...r.fail2);
        calls.push(...r.calls2);
      }
      // 进度**按分卷顺序**报（前缀和），不按完成顺序：并发下完成顺序本来
      // 就不等于输入顺序，拿它当进度会让进度条来回跳。
      let seenTopics = 0;
      for (const r of perChunk) {
        seenTopics += r.chunk.length;
        for (const it of r.chunk) {
          onProgress?.({
            phase: 'polish', done: seenTopics, total: inputs.length,
            chapterNo: it.chapterNo, topicNo: it.topicNo,
          });
        }
      }

      combined.throwIfAborted();
      return { chapters: buildFilledChapters(tree, inputs, blocks), failures, calls, warnings };
    } catch (error) {
      if (error instanceof LectureError) throw error;
      if (combined.aborted || error?.name === 'AbortError') throw cancelled();
      throw error;
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
    assemble,
    dispose,
    /** 只读快照：集成层与测试用它核对并发上限。 */
    get concurrency() { return concurrency; },
    get active() { return limiter.active; },
    get closed() { return closed; },
  };
}

/** 取消：抛而不是降级 —— 取消是调用方的意志，不是「这一节没整理」。 */
function cancelled() {
  return new LectureError('CANCELLED', '讲义加工已取消');
}

function errText(error) {
  if (error === null || error === undefined) return '未知原因';
  return error?.message ?? String(error);
}

/**
 * 一个知识点下所有块的**草稿正文**（= 老师原话，习坎的输入）。
 *
 * # 为什么把多个块拼成一段，而不是一块一段
 *
 * 这正是本版相对上一版的**核心修正**：一块一段会让「同一个知识点讲了 9 个块」
 * 变成 9 张互不相连的卡。现在那 9 个块落在**同一个树节点**上，
 * 天然是同一段正文的素材。块之间空行分隔，让习坎看得见「这里有 9 段话要揉成一段」。
 *
 * ⚠️ 拼接**不做任何去重或取舍**：那是习坎的活。本层只负责「把这一页上老师
 *    讲的话按时间顺序摆好」，任何取舍都会变成**丢内容**。
 */
function draftBodyOf(own, warnings) {
  const parts = [];
  const missing = [];
  for (const b of own) {
    const t = String(b.text ?? '').trim();
    if (t !== '') { parts.push(t); continue; }
    // 正文空但概述有内容 → 用概述（它是「这块在讲什么」的书面表达）。
    const s = String(b.summary ?? '').trim();
    if (s !== '') parts.push(s);
    else missing.push(b.index);
  }
  for (const index of missing) warnings.push(`第 ${index} 块没有正文也没有概述，已跳过`);
  return { text: parts.join('\n\n'), missing };
}

/**
 * 把树摊成**讲义章节**：只含进了讲义的知识点，正文初值 = 老师原话。
 *
 * ⚠️ 每次都从树重建，而不是原地改树：树是**空间性的**课程知识图谱
 *    （后续出题、复习、3D 知识树都建在它上面），讲义是它的一次**投影**。
 *    原地改树 = 把「这次有没有讲到」写回地图，那是 App 侧已经写错过一次的地方。
 */
function buildFilledChapters(tree, inputs, blocks) {
  const byKey = new Map(inputs.map((it) => [`${it.chapterNo}/${it.topicNo}`, it]));
  const blockByIndex = new Map((blocks ?? []).map((b) => [b.index, b]));
  const chapters = [];
  for (let ci = 0; ci < tree.chapters.length; ci++) {
    const chapter = tree.chapters[ci];
    const topics = [];
    for (let ti = 0; ti < chapter.topics.length; ti++) {
      const it = byKey.get(`${ci + 1}/${ti + 1}`);
      if (!it) continue;
      const topic = chapter.topics[ti];
      const own = topic.blockIndexes.map((i) => blockByIndex.get(i)).filter(Boolean);
      const filled = it.filled ?? null;
      topics.push({
        title: topic.title,
        fromPage: topic.fromPage,
        toPage: topic.toPage,
        pptLines: topic.pptLines,
        blockIndexes: topic.blockIndexes,
        sourceBlockIndexes: topic.blockIndexes,
        /** 老师原话（习坎的输入，也是失败时保留的「上一版正文」）。 */
        draft: it.text,
        /** 正文。未填充 / 填充失败时逐字等于 `draft`。 */
        passages: filled ? filled.passages.map((p) => ({ ...p })) : [{ text: it.text, label: '' }],
        blocks: filled ? filled.blocks.map((b) => ({ ...b })) : [],
        register: filled ? filled.register : REGISTER.draft,
        notes: filled ? [...filled.notes] : [],
        /** 这一段的起点锚点（「一键回家」用）：页号 + 秒数。 */
        anchor: {
          page: own[0]?.page ?? topic.fromPage ?? 0,
          tSec: Math.floor((own[0]?.startMs ?? 0) / 1000),
        },
        toString() {
          return `第 ${this.fromPage}–${this.toPage} 页｜${this.title === '' ? '（无名）' : this.title}`;
        },
      });
    }
    if (topics.length === 0) continue;
    const rawTitle = String(chapter.title ?? '').trim();
    chapters.push({
      // ★ 序号**重排**（不沿用树的序）：过滤可能丢掉空章，沿用原序会让目录
      //   出现「一、二、四」这种跳号。
      no: chapters.length + 1,
      title: rawTitle === '' ? `第 ${chapters.length + 1} 部分` : rawTitle,
      slideTitle: rawTitle,
      topics,
      anchor: topics[0].anchor,
    });
  }
  return chapters;
}

/** 把一次产出的结果记到它的输入槽位上（`inputs` 就是被填充的清单）。 */
function writeBack(inputs, it, hit) {
  const slot = inputs.find(
    (x) => x.chapterNo === it.chapterNo && x.topicNo === it.topicNo,
  );
  if (!slot) return;
  if (!hit) {
    // 失败：**保留上一版正文**（= 老师原话），并如实标成没写成稿。
    slot.filled = {
      passages: [{ text: slot.text, label: '' }],
      blocks: [],
      register: REGISTER.failed,
      notes: ['这次没有写成稿'],
    };
    return;
  }
  slot.filled = hit;
}
