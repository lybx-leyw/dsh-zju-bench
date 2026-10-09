/**
 * 节笔记的**形状 + 纯函数**（零宿主、零 UI）。
 *
 * # 规格来源
 *
 * 逐条对齐 Flutter 的 `lib/data/section_note_store.dart`（文件头注释里的取舍
 * 一并照搬），而不是重新发明一套：
 *
 * | Dart | 这里 | 判据 |
 * |---|---|---|
 * | `sectionNoteKey(courseId, sectionId)` | [noteKey] | 就是 `'$courseId/$sectionId'`（不做转义 —— 它同时是持久化键） |
 * | `sectionNoteRoute({...})` | [noteRoute] | `/note?course=$courseId&section=$sectionId`（**原样拼**，不 percent-encode） |
 * | `_mmss(sec)` | [mmss] | 负数当 0；**不**高位补零；小时不进位（3600 → `60:00`） |
 * | `sectionNoteTimeLink({...})` | [timeLink] | `[mm:ss](zy://section/$courseId/$sectionId?t=$atSec)` |
 * | `sectionNotePageLink({...})` | [pageLink] | `[第 $page 页](zy://section/…?page=$page)` |
 * | `sectionNoteAssetLink({id, alt})` | [assetLink] | `![${alt ?? '插图'}](zy-asset://$id)`（`alt: ''` 时是空 alt，**不**回退默认词） |
 * | `parseZySectionUri(raw)` | [parseZySectionUri] | 见下 |
 * | `playerRouteOfZy({...})` | [playerRouteOfZy] | `page>0` 才带 page，`atSec>=0` 才带 t；顺序 page → t |
 *
 * # 三个必须写下来的边界（都拿真实 Dart 跑过，不是猜的）
 *
 * 1. **`mmss` 不补小时位**。截图里 1 小时零 1 秒的时间链接标签是 `61:01`
 *    而不是 `01:01:01`、也不是 `61:1`。所以「超过 1 小时」这条边界在这里
 *    的正确答案是「继续按分钟数走」，不是「进位到小时」。
 * 2. **负数只影响标签，不影响链接里的 `t`**。`atSec: -1` 给出
 *    `[00:00](zy://section/1/2?t=-1)` —— `t=-1` 原样留在 URL 里。
 *    写笔记时不许替用户悄悄改成 0：那会把「点这里跳回 -1 秒」变成另一件事。
 * 3. **`page=0` 照样生成链接**（`[第 0 页](…?page=0)`），只有
 *    [playerRouteOfZy] 在打开播放器那一刻才把 `page<=0` 丢掉。
 *    生成与跳转是**两个**判据，Dart 就是这么写的，不要合并。
 *
 * # `int.tryParse` 的移植口径
 *
 * Dart 的 `int.tryParse`：允许前后空白与 `+/-`，允许 `0x` 十六进制，
 * 拒绝 `1.5` / `1e3` / `1,5`，并在 64 位边界外返回 null。这里按同一张表实现，
 * 但**多一层拒绝**：JS 的 `Number` 只有 53 位安全整数，`±2^63-1` 这类值
 * 在这里会失真。失真比拒绝更糟（会静默给出一个错的秒数），所以超出
 * `Number.MAX_SAFE_INTEGER` 一律当非法 —— 见 [parseIntOrNull]。
 *
 * @module dsh-zhiyun-notes/note
 */

import { NoteError } from './errors.js';

/** 内链 scheme：跳到某一节的播放器位置。 */
export const kZySectionScheme = 'zy://section/';
/** 内链 scheme：指向笔记附件（插图 / 墨迹）。 */
export const kZyAssetScheme = 'zy-asset://';

/** 附件默认 alt（只在 alt 为 null/undefined 时用；`''` 是有意义的空 alt）。 */
const kDefaultAssetAlt = '插图';

/** 笔记索引里没有 `schema` 字段时的假定版本（Dart 的 `kSectionNotesSchema`）。 */
export const kSectionNotesSchema = 1;

/** Dart `int.tryParse` 认的字面量：可选符号 + 十进制或 `0x` 十六进制。 */
const INT_LITERAL = /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

/**
 * Dart `int.tryParse` 的等价物（见文件头「移植口径」）。
 * @param {unknown} raw - 待解析的原始串（非字符串直接当非法）。
 * @returns {number|undefined} 合法时是**安全整数**，否则 `undefined`（对齐 Dart 的 `null`）。
 */
export function parseIntOrNull(raw) {
  if (typeof raw !== 'string') return undefined;
  // Dart 的 int.parse 先 trim；`' 7'` 与 `'7 '` 都算 7。
  const text = raw.trim();
  if (!INT_LITERAL.test(text)) return undefined;
  const hexadecimal = /^[+-]?0[xX]/.test(text);
  let value;
  if (hexadecimal) {
    // Number.parseInt 不认 `0x` 前面的符号，自带符号会得到 NaN，所以自己摘。
    value = Number.parseInt(text.replace(/^[+-]?0[xX]/, ''), 16);
    if (text.startsWith('-')) value = -value;
  } else {
    value = Number.parseInt(text, 10);
  }
  // 这里与 Dart 有意不同：超出安全整数的值在 JS 里已经失真，宁可当非法。
  if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return undefined;
  // `-0` 归一成 `0`：Dart 的 int 没有负零，而 JS 的 `Object.is(-0, 0) === false`
  // 会让 `deepEqual` / 序列化在只有符号不同的值上表现不一致。
  return value === 0 ? 0 : value;
}

/** 两位补零（`mmss` 专用；小时**不**补位，见文件头第 1 条）。 */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 秒 → `mm:ss`（Dart `_mmss`）。
 *
 * 负数当 0；分钟数不上限、不转小时；非法输入（非有限数）走 [NoteError]。
 * @param {number} sec - 秒。
 * @returns {string} `mm:ss`。
 * @throws {import('./errors.js').NoteError} sec 不是有限数时。
 */
export function mmss(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) {
    throw new NoteError('INPUT', `时间链接的秒数必须是有限数，收到 ${String(sec)}`, { field: 'atSec', value: sec });
  }
  // 取整与 Dart 的 `~/`、`%` 同口径：先夹到 0 以上，再按整数分钟切。
  const s = Math.trunc(sec) < 0 ? 0 : Math.trunc(sec);
  return `${pad2(Math.trunc(s / 60))}:${pad2(s % 60)}`;
}

/**
 * 笔记的持久化键（Dart `sectionNoteKey`）。
 *
 * ⚠️ **刻意不做转义、不做长度限制**：Dart 侧它就是 `'$courseId/$sectionId'`，
 * 且这个串会同时落进索引文件与 `zy://section/` 内链。这里若"顺手"把 `/`
 * 编码成 `%2F`，同一节在两边就会得到**两个**键，笔记看起来会丢。
 * @param {string} courseId - 课程 id。
 * @param {string} sectionId - 节 id。
 * @returns {string} `courseId/sectionId`。
 */
export const noteKey = (courseId, sectionId) => `${courseId}/${sectionId}`;

/**
 * 笔记面板的路由（Dart `sectionNoteRoute`）。
 *
 * ⚠️ 与 Dart 一样**原样拼接**：`courseId: 'a b'` 会得到带空格的
 * `/note?course=a b&section=c&d`。这里不做 URL 编码 —— 这个串是给
 * 宿主自身路由用的，编码属于调用方的路由层；在这儿编一次，等调用方再按
 * 自己的规则拼一次，就会出现双重编码（`%20` → `%2520`）。
 * @param {{courseId: string, sectionId: string}} input - 课程与节。
 * @returns {string} `/note?course=…&section=…`。
 */
export const noteRoute = ({ courseId, sectionId }) => `/note?course=${courseId}&section=${sectionId}`;

/**
 * 时间链接（Dart `sectionNoteTimeLink`）。
 * @param {{courseId: string, sectionId: string, atSec: number}} input - 课程、节、秒。
 * @returns {string} `[mm:ss](zy://section/course/section?t=atSec)`。
 * @throws {import('./errors.js').NoteError} atSec 非法时。
 */
export function timeLink({ courseId, sectionId, atSec }) {
  return `[${mmss(atSec)}](${kZySectionScheme}${courseId}/${sectionId}?t=${atSec})`;
}

/**
 * 页码链接（Dart `sectionNotePageLink`）。
 * @param {{courseId: string, sectionId: string, page: number}} input - 课程、节、页。
 * @returns {string} `[第 page 页](zy://section/…?page=page)`（`page` 不做正数校验，见文件头第 3 条）。
 */
export function pageLink({ courseId, sectionId, page }) {
  return `[第 ${page} 页](${kZySectionScheme}${courseId}/${sectionId}?page=${page})`;
}

/**
 * 附件内链（Dart `sectionNoteAssetLink`）。
 * @param {{id: string, alt?: string|null}} input - 附件 id 与 alt。
 * @returns {string} `![alt](zy-asset://id)`。
 */
export function assetLink({ id, alt }) {
  return `![${alt ?? kDefaultAssetAlt}](${kZyAssetScheme}${id})`;
}

/**
 * 跳到播放器的路由（Dart `playerRouteOfZy`）。
 *
 * 与 [pageLink] 的区别是有意的：链接**生成**时 `page=0` 照样写进去，
 * 而真正**跳转**时 `page<=0` / `atSec<0` 会被丢掉。
 * @param {{courseId: string, sectionId: string, page?: number|null, atSec?: number|null}} input - 课程、节、可选页/秒。
 * @returns {string} `/courses/courseId/section/sectionId[?page=…&t=…]`。
 */
export function playerRouteOfZy({ courseId, sectionId, page, atSec }) {
  const query = [];
  if (page !== undefined && page !== null && page > 0) query.push(`page=${page}`);
  if (atSec !== undefined && atSec !== null && atSec >= 0) query.push(`t=${atSec}`);
  return `/courses/${courseId}/section/${sectionId}${query.length === 0 ? '' : `?${query.join('&')}`}`;
}

/** `decodeURIComponent` 解不开就原样返回（Dart 对坏转义只会抛在少数路径上，模拟不应崩）。 */
function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * 解析 `zy://section/1/2?t=201` / `?page=14`（Dart `parseZySectionUri`）。
 *
 * 返回 `null` 表示「这不是一条能认的节内链」——**不抛异常**：它会在用户
 * 正文里逐条被调用，抛出去就等于「一句话写错，整篇笔记打不开」。
 *
 * 两处与 WHATWG `URL` 的默认行为**有意不同**（都拿 Dart 跑过）：
 * - `zy:` 不是特殊 scheme，`new URL()` 的 `hostname` 保留大小写，而 Dart 的
 *   `Uri.host` 归一成小写 → 这里手动 `toLowerCase()` 对齐（`zy://SECTION/1/2` 要认）。
 * - Dart 的 `queryParameters` 对重复键取**最后一个**，`URLSearchParams.get`
 *   取**第一个** → 这里手动取最后一个（`?t=1&t=2` 是 `t=2`）。
 *
 * @param {unknown} raw - 待解析的串。
 * @returns {{courseId: string, sectionId: string, page: number|null, atSec: number|null}|null}
 *   解析结果；路径段少于两段、scheme/host 不对、串本身不合法时是 `null`。
 */
export function parseZySectionUri(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    // 空串、相对路径（`/courses/1/section/2`）、没有 scheme 的串都落这里。
    return null;
  }
  if (url.protocol !== 'zy:') return null;
  if (url.hostname.toLowerCase() !== 'section') return null;
  // Dart: `uri.pathSegments` 已经丢掉了空段（`zy://section//2` 也认不出两段）。
  const parts = url.pathname.split('/').filter((segment) => segment.length > 0).map(decodePart);
  if (parts.length < 2) return null;
  const lastParam = (name) => url.searchParams.getAll(name).at(-1) ?? '';
  return {
    courseId: parts[0],
    sectionId: parts[1],
    // Dart 的 `int.tryParse(queryParameters['x'] ?? '')`：缺字段与坏值都是 null。
    page: parseIntOrNull(lastParam('page')) ?? null,
    atSec: parseIntOrNull(lastParam('t')) ?? null,
  };
}

/** 与 `parseZySectionUri` 同源的行内链接正则（`g` 全局、`i` 容忍 scheme/host 大小写）。 */
const SECTION_INLINE_RE = /\[([^\]]*)\]\(\s*(zy:\/\/section\/[^)\s]*)\s*\)/gi;
/** `![alt](zy-asset://id)`；`alt` 允许为空。 */
const ASSET_INLINE_RE = /!\[([^\]]*)\]\(\s*(zy-asset:\/\/[^)\s]*)\s*\)/gi;
/** Dart 的 `exportMarkdown` 用这套正则把图片链接换成文件名 / 把节链接降级成纯文本。 */
const SECTION_INLINE_PLAIN_RE = /\[([^\]]+)\]\(zy:\/\/section\/[^)]+\)/g;

/**
 * 摘出 markdown 里的所有 `zy://section/…`（普通链接，会有裸 `zy://` 兜底项）。
 * @param {string} markdown - 正文。
 * @returns {Array<object>} 按出现顺序。
 */
function collectSectionLinks(markdown) {
  const found = [];
  SECTION_INLINE_RE.lastIndex = 0;
  for (const match of markdown.matchAll(SECTION_INLINE_RE)) {
    const parsed = parseZySectionUri(match[2]);
    const entry = {
      type: 'section',
      raw: match[0],
      label: match[1],
      start: match.index,
      end: match.index + match[0].length,
      href: match[2],
      ...(parsed === null ? {} : parsed),
    };
    if (parsed === null) {
      entry.code = 'BAD_SECTION_LINK';
      entry.reason = `不是可解析的节内链：${match[2]}`;
    }
    found.push(entry);
  }
  // 兜底：Dart 的 exportMarkdown 是按**裸 scheme 前缀**做 replaceAll 的，
  // 所以 `zy://section/1/2` 这种「没写在 markdown 链接里」的裸串它也认。
  // 这里照样摘出来，好让「导出时会被改写」的那些位置能被如实看到（**不算**坏串）。
  const bare = /zy:\/\/section\/[^\s)]+/g;
  for (const match of markdown.matchAll(bare)) {
    const covered = found.some((entry) => match.index >= entry.start && match.index < entry.end);
    if (covered) continue;
    const parsed = parseZySectionUri(match[0]);
    const entry = {
      type: 'section',
      raw: match[0],
      label: null,
      start: match.index,
      end: match.index + match[0].length,
      href: match[0],
      bare: true,
      ...(parsed === null ? {} : parsed),
    };
    if (parsed === null) {
      entry.code = 'BAD_SECTION_LINK';
      entry.reason = `不是可解析的节内链：${match[0]}`;
    }
    found.push(entry);
  }
  return found;
}

/**
 * 摘出 markdown 里的所有 `zy-asset://…`（图片链接 + 裸串兜底）。
 * @param {string} markdown - 正文。
 * @returns {Array<object>} 按出现顺序。
 */
function collectAssetLinks(markdown) {
  const found = [];
  ASSET_INLINE_RE.lastIndex = 0;
  for (const match of markdown.matchAll(ASSET_INLINE_RE)) {
    const href = match[2];
    const entry = {
      type: 'asset',
      raw: match[0],
      label: match[1],
      start: match.index,
      end: match.index + match[0].length,
      href,
      assetId: href.slice(kZyAssetScheme.length),
    };
    if (entry.assetId === '') {
      entry.code = 'BAD_ASSET_LINK';
      entry.reason = 'zy-asset 链接没有附件 id';
    }
    found.push(entry);
  }
  const bare = /zy-asset:\/\/[^\s)]+/g;
  for (const match of markdown.matchAll(bare)) {
    const covered = found.some((entry) => match.index >= entry.start && match.index < entry.end);
    if (covered) continue;
    const href = match[0];
    const assetId = href.slice(kZyAssetScheme.length);
    const entry = {
      type: 'asset',
      raw: href,
      label: null,
      start: match.index,
      end: match.index + href.length,
      href,
      assetId,
      bare: true,
    };
    if (assetId === '') {
      entry.code = 'BAD_ASSET_LINK';
      entry.reason = 'zy-asset 链接没有附件 id';
    }
    found.push(entry);
  }
  return found;
}

/**
 * 找出正文里所有「内链」——两种 scheme 都认，坏串**如实跳过**而不是抛。
 *
 * 返回项按**出现顺序**排好，并带 `start` / `end`（可用来在编辑器里做高亮或原地替换）。
 * 每一项至少有 `type` / `raw` / `start` / `end` / `href`；能认出来的节链接还带
 * `courseId` / `sectionId` / `page` / `atSec`，附件链接带 `assetId`。
 * **认不出的不是被丢掉，而是标上 `code: 'BAD_SECTION_LINK' | 'BAD_ASSET_LINK'`
 * 与 `reason`** —— 用户正文里写了坏链接，调用方有权知道，不能静默。
 *
 * 还有一些**根本不是内链**的行内内容会被如实报成 `type: 'unknown-inline'`：
 * `[文字](https://…)`、`[文字](/courses/1/section/2)`、`[文字](zy://asset/…)`、
 * 任意 `zy-*://` 串，以及 markdown 里常见的 `![图](本地.png)`。这类不是错误
 * （它们本来就不该跳），只是「这条内链本包处理不了」的诚实交代。
 *
 * @param {unknown} markdown - 正文；非字符串按空串处理。
 * @returns {Array<object>} 内链条目（含坏串与不支持的 scheme）。
 */
export function parseInlineLinks(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return [];
  const links = [...collectSectionLinks(markdown), ...collectAssetLinks(markdown)]
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // 剩下的 `[label](target)` 通用形状：上面两条专用正则没认下来的，在这里如实归类。
  const generic = /(!?)\[([^\]]*)\]\(\s*([^)\s]*)\s*\)/g;
  const claimed = links.map((entry) => [entry.start, entry.end]);
  const overlaps = (start, end) => claimed.some(([s, e]) => start < e && end > s);
  const extra = [];
  for (const match of markdown.matchAll(generic)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    const target = match[3];
    let code = 'UNSUPPORTED_SCHEME';
    let reason = `本包只认 ${kZySectionScheme} 与 ${kZyAssetScheme}`;
    if (target === '') {
      code = 'EMPTY_TARGET';
      reason = '链接目标为空';
    } else if (/^z[ya]-/.test(target) || /^zy:/.test(target)) {
      // 长得像自家 scheme 但不是（`zy://asset/…`、`zy-ink://…` 等）。
      code = 'BAD_SCHEME_SHAPE';
      reason = `形如内链但不是已知 scheme：${target}`;
    }
    extra.push({
      type: 'unknown-inline',
      raw: match[0],
      label: match[2],
      image: match[1] === '!',
      start: match.index,
      end: match.index + match[0].length,
      href: target,
      code,
      reason,
    });
  }
  return [...links, ...extra].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * 把 `exportMarkdown`（Dart `SectionNoteStore.exportMarkdown`）的正文改写规则拆出来。
 *
 * 原文只有两句 `replaceAll`，但它们是**用户能看到内容变化**的地方，
 * 单独成函数才能被钉住：
 * - `zy-asset://<id>` → 该附件的文件名（`img123.png`）；
 * - `[text](zy://section/…)` → 只剩 `text`（内链在导出的 .md 里没地方可跳）。
 *
 * ⚠️ 附件**没有**对应文件时：Dart 保留原样的 `zy-asset://id` 不动（`continue` 掉了），
 * 这里照做 —— 宁可留个指向不存在的内链，也不要把用户正文里那段静默删掉。
 * @param {string} markdown - 正文。
 * @param {Map<string, string>|Record<string, string>} [fileNameById] - 附件 id → 文件名。
 * @returns {string} 改写后的正文。
 */
export function rewriteForExport(markdown, fileNameById = {}) {
  if (typeof markdown !== 'string' || markdown === '') return '';
  const lookup = fileNameById instanceof Map ? fileNameById : new Map(Object.entries(fileNameById));
  let out = markdown;
  for (const [id, name] of lookup) {
    out = out.split(`${kZyAssetScheme}${id}`).join(name);
  }
  return out.replace(SECTION_INLINE_PLAIN_RE, (_match, label) => label);
}

/** 一条笔记的必要字段；缺 courseId / sectionId 的**整条丢弃**（对齐 Dart `SectionNote.fromJson`）。 */
const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 「id 名」是否可用（课程 id / 节 id）。
 *
 * 之所以收紧：这两个值会被拼进 `zy://section/<courseId>/<sectionId>?t=…`
 * 这类内链，一旦带 `/`、`?`、`#` 或空白，链接就会**悄悄指向别处**——
 * 那种错在界面上看不出来，只会在点开时跳错节。宁可在这里拒绝。
 * @param {unknown} value - 待检值。
 * @returns {boolean} 是否可用。
 */
export function isUsableId(value) {
  return typeof value === 'string' && NOTE_ID.test(value);
}

/**
 * 笔记正文里是否有东西（Dart `SectionNote.hasContent`）。
 *
 * ⚠️ 判据是 `trim()` 之后非空 —— 只敲了几个空格 / 换行不算写过。
 * 「有没有内容」和「记录在不在」是两件事：`getOrEmpty` 会给出
 * `hasContent === false` 的记录，而它同样值得被记住（用户可能只是先建了节笔记）。
 * @param {{markdown?: string}} note - 笔记记录。
 * @returns {boolean} 是否有正文。
 */
export function hasContent(note) {
  return typeof note?.markdown === 'string' && note.markdown.trim() !== '';
}

/**
 * 空笔记（Dart `getOrEmpty` 的另一半）：没有记录时给一个**不落盘**的初值。
 *
 * `updatedAt` 用纪元 0 而不是"现在"：它表示「从来没有存过」，
 * 界面据此可以把「新建但没写过」和「写过又清空」区分开。
 * @param {{courseId: string, sectionId: string, title?: string}} input - 课程、节、可选标题。
 * @returns {object} 笔记记录。
 */
export function emptyNote({ courseId, sectionId, title = '' }) {
  return {
    courseId,
    sectionId,
    title,
    markdown: '',
    updatedAt: new Date(0).toISOString(),
    assets: [],
    sketchIds: [],
  };
}

/** 附件记录：`{id, file, alt?, page?}`；无 id 或无 file 的**整条丢弃**（对齐 Dart）。 */
function normalizeAsset(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
  const file = raw.file === undefined || raw.file === null ? '' : String(raw.file);
  if (id === '' || file === '') return null;
  const asset = { id, file };
  if (raw.alt !== undefined && raw.alt !== null) asset.alt = String(raw.alt);
  if (raw.page !== undefined && raw.page !== null) asset.page = Number(raw.page);
  return asset;
}

/**
 * 把一条持久化记录收敛成笔记形状（Dart `SectionNote.fromJson`）。
 *
 * 三条与 Dart 一致的口径：
 * - `courseId` / `sectionId` 任一为空 → 返回 `null`，调用方**丢弃这一条**；
 * - `updatedAt` 解不出来 → 纪元 0（不是"现在"，见 [emptyNote]）；
 * - `assets` / `sketches` 里的坏项逐条丢弃，但**不**因此丢掉整条笔记。
 * @param {unknown} raw - 持久化里读出来的一条。
 * @returns {object|null} 笔记记录，或 `null`（该条不可用）。
 */
export function normalizeNote(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const courseId = raw.courseId === undefined || raw.courseId === null ? '' : String(raw.courseId);
  const sectionId = raw.sectionId === undefined || raw.sectionId === null ? '' : String(raw.sectionId);
  if (courseId === '' || sectionId === '') return null;
  const parsedAt = Date.parse(String(raw.updatedAt ?? ''));
  const assets = [];
  for (const item of Array.isArray(raw.assets) ? raw.assets : []) {
    const asset = normalizeAsset(item);
    if (asset !== null) assets.push(asset);
  }
  const sketchIds = [];
  for (const item of Array.isArray(raw.sketches) ? raw.sketches : []) {
    if (typeof item === 'string' && item !== '') sketchIds.push(item);
  }
  return {
    courseId,
    sectionId,
    title: raw.title === undefined || raw.title === null ? '' : String(raw.title),
    markdown: raw.markdown === undefined || raw.markdown === null ? '' : String(raw.markdown),
    updatedAt: Number.isNaN(parsedAt) ? new Date(0).toISOString() : new Date(parsedAt).toISOString(),
    assets,
    sketchIds,
  };
}

/**
 * 笔记形状的 JSON 视图（Dart `SectionNote.toJson`）。
 *
 * 空 `assets` / `sketches` **不写出去**（Dart 的 `if (...isNotEmpty)`），
 * 让索引文件里只出现真有内容的字段。`updatedAt` 统一成 ISO 串。
 * @param {object} note - 笔记记录。
 * @returns {object} 可序列化对象。
 */
export function noteToJson(note) {
  const out = {
    courseId: note.courseId,
    sectionId: note.sectionId,
    title: note.title,
    markdown: note.markdown,
    updatedAt: note.updatedAt,
  };
  if (note.assets.length > 0) {
    out.assets = note.assets.map((asset) => {
      const item = { id: asset.id, file: asset.file };
      if (asset.alt !== undefined && asset.alt !== null && asset.alt !== '') item.alt = asset.alt;
      if (asset.page !== undefined && asset.page !== null) item.page = asset.page;
      return item;
    });
  }
  if (note.sketchIds.length > 0) out.sketches = [...note.sketchIds];
  return out;
}
