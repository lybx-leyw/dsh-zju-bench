/**
 * **知识树**（纯函数：零 IO / 零网络 / 零模型调用）。
 *
 * 逐条对齐 App 的 `lib/fusion/lecture_tree.dart`。讲义不再是「一堆改写过的
 * 段落」，而是一棵按知识点组织的树：
 *
 * ```text
 * 章（整节梳理的分段）
 *   └ 知识点（PPT 上的标题）      ← 树由本文件用纯算法抽出
 *        └ 正文                    ← 由习坎从相邻块填充（见 polish.js）
 * ```
 *
 * # 为什么树必须来自 PPT，而不是来自 ASR
 *
 * 用户原话：先从 ppt 加工稿里提取出知识/概念/要点标题树，再要求模型按照
 * 知识树的结构补充老师讲解的扩展。这解掉的是一个根本性死结：
 *
 * | 问题 | 为什么以前解不掉 | 有了树之后 |
 * |---|---|---|
 * | 知识点密度 / 组织 | 密度是**全局性质**，逐块改写看不见全局 | 树**先定好**了哪里是一个知识点 |
 * | 口语照抄 | 「改写」时逐字照抄是成本最低的合规答案 | 填树要求答案**分布在指定位置上**，照抄放不进任何一个节点 |
 *
 * # 三条必须守住的纪律（消费方也要读）
 *
 * | # | 纪律 | 落点 |
 * |---|---|---|
 * | 1 | **树不因「这次没讲到」而删节点** | 建树一个节点都不丢；讲到没讲到只是 `topic.isCovered` |
 * | 2 | **树要高信度** | 标题一律来自 PPT 原文，抽不出就留空 —— **不编造** |
 * | 3 | **树要足够详细** | 页级粒度：每个知识点带覆盖的页区间与 PPT 要点行 |
 *
 * ⚠️ 第 1 条是 App 侧**写错过一次**的地方：早先版本把「老师没讲到」的节点
 *    直接删掉（真机 24 个节点、跨 24 页），那是把**阅读产物**的取舍错用到了
 *    **知识地图**上。讲义（阅读产物）只放讲过的节点，那是**投影**，不是删树。
 */

/** 页眉判据：一行要在至少这么多页上出现才算页眉。 */
export const kTreeHeaderMinPages = 3;

/**
 * 页眉判据的第二个条件：出现的页数占比。
 *
 * 为什么是 0.4 而不是更小：真页眉 ≥ 60%，而**一个知识点跨 3 页**是常态。
 * 若门槛压到 25%，一份 12 页的小节里「跨 3 页的标题」就会和页眉一样高频
 * （3/12 = 25%）→ **真标题被当成页眉剔掉**，那几页的知识点直接没了名字。
 */
export const kTreeHeaderPageRatio = 0.4;

/** 页眉判据（第二条路）：按「一套课件」的范围判，取跨度的页数下限。 */
export const kTreeHeaderDeckSpanMin = 11;

/** 见 kTreeHeaderDeckSpanMin：密度下限。真机真页眉最低 78%，最高假页眉 14%。 */
export const kTreeHeaderDeckDensity = 0.6;

/**
 * 页眉判据的第三条：位置。真页眉**永远排在这一页的第一行**。
 *
 * 只看频率时，**重复出现的知识点**会被误判成页眉（老师回头又讲一遍 Alpha，
 * 占 4/8 页 = 50%）→ 那几页丢了标题。而它们的「排第一比例」都是 0%。
 * 值取 0.8：视觉解析偶尔会把页眉抄成第二行，留一点余量。
 */
export const kTreeHeaderFirstLineRatio = 0.8;

/**
 * ★ 页级外壳判据的启用门槛：带页眉的页要占到全节这么多比例，
 * 「这一页是课件页」这条规则才有意义。
 *
 * 若某份课件**根本没有页眉**，把「没有页眉」当外壳判据会让整棵树塌成一个
 * 节点 —— 比不判更糟。所以要求带页眉的页占到 0.3，否则退回逐行过滤。
 */
export const kTreeHeaderRuleMinRatio = 0.3;

/**
 * 界面外壳的标志词：命中就说明这一页是**教师切到了别的软件**，
 * 它上面的「第一行文字」不是知识点标题。
 */
export const kTreeShellWords = [
  // ── 操作系统外壳 ──
  '窗口标题栏', '标题栏', '菜单栏', '工具栏', '功能区', '选项卡',
  '任务栏', '状态栏', '标签栏', '地址栏', '书签栏', '通知栏',
  '开始菜单', '系统托盘', '任务视图', '桌面壁纸', '桌面图标',
  '鼠标指针', '鼠标光标', '登录', '共享',
  // ── 具体软件 ──
  'PowerPoint', 'Excel', 'Word', '浏览器', '正在关机', '温馨提示',
  // ── 文件后缀（截图上的文件名） ──
  '.ppt', '.pptx', '.xlsx', '.docx', '.doc', '.pdf',
];

/**
 * 「弱」外壳词：单独看可能是正经内容，只在**短行**上判为界面文字。
 * 拆出来是为了不误杀「共享内存」「工具栏设计」这类真标题。
 */
export const kTreeWeakShellWords = [
  '登录', '共享', '选项卡', '工具栏', '标题栏', '状态栏', '地址栏', '窗口',
];

/**
 * 视觉解析写的**版式定位行**（`右上角页眉：`、`幻灯片正文中央：`）。
 * 它们是「这块文字在图的哪个位置」的说明，不是图上的内容。
 *
 * 判据是**两个条件同时成立**：含定位词 **且** 以冒号结尾。
 */
export const kTreeLayoutWords = [
  '右上角', '左上角', '右下角', '左下角', '中上', '中下',
  '幻灯片', '页面', '窗口', '屏幕', '方框', '矩形框', '框内', '正文区',
];

/**
 * **软件窗口的招牌词**：这一页是**别人家软件的截图**，不是课件。
 *
 * 判据只看**这一页的第一行**：窗口标题栏 / 标签栏天然排在最上面。
 * ⚠️ 只看第一行是**刻意的**：真课件页的正文完全可能提到 Excel（老师举例），
 *    那不该把整页判成外壳。只有「开头第一句就是窗口标题栏」才算。
 */
export const kTreeAppWindowWords = [
  // 表单/办公软件的窗口标题
  'Excel', 'PowerPoint', 'Word', 'Acrobat', 'WPS',
  // 浏览器
  'Chrome', 'Edge', 'Firefox', '浏览器',
  // 通讯/会议（老师切出去看消息时会出现）
  '微信', '钉钉', '腾讯会议', 'Zoom', 'Teams',
  // 系统界面
  '资源管理器', '记事本', '画图', '设置', '正在关机',
  // 汉语的窗口部件名（视觉解析抄成 `窗口标题栏：` 时靠它）
  '窗口标题栏', '标题栏', '标签栏', '地址栏', '书签栏',
  '菜单栏', '工具栏', '功能区', '状态栏', '任务栏',
  '窗口控制按钮', '右键快捷菜单', '兼容模式',
  // 文件后缀（截图上的文件名）
  '.ppt', '.pptx', '.xlsx', '.docx', '.doc', '.pdf',
];

/** 课件版式。抽取标题时按这个选择规则，章界不靠它。 */
export const SLIDE_TEMPLATE = Object.freeze({
  header: { value: 'header', label: '有页眉' },
  plain: { value: 'plain', label: '无页眉' },
  shellHeavy: { value: 'shellHeavy', label: '大量非课件画面' },
});

/** 课件版式判定（纯计数，与 Dart 同式）。 */
export function detectSlideTemplate({ pageCount, headerPages, shellPages }) {
  if (pageCount <= 0) return SLIDE_TEMPLATE.plain;
  if (headerPages / pageCount >= kTreeHeaderRuleMinRatio) {
    if (shellPages / pageCount >= 0.25) return SLIDE_TEMPLATE.shellHeavy;
    return SLIDE_TEMPLATE.header;
  }
  return SLIDE_TEMPLATE.plain;
}

/** 课件自己的分节页，用来定章。 */
export function looksLikeSectionDivider(title) {
  const t = String(title ?? '').trim();
  if (t.length === 0) return false;
  if (/^(Chapter|Part)\s+\d+/i.test(t)) return true;
  if (/^第\s*[0-9]+\s*[章节讲部]/.test(t)) return true;
  if (/^第\s*[一二三四五六七八九十百零]+\s*[章节讲部]/.test(t)) return true;
  return false;
}

/**
 * 把一行图上文字清成可比较、可当标题的形态。
 *
 * 清掉 markdown 记号、PPT 自己的装饰前缀（`☞` / `✂`）、项目符号、
 * 以及视觉解析加的定位词（`右上角：` / `标题：`）。
 *
 * ⚠️ **必须循环剥到稳定**，不能只跑一遍：真机第 20 页的
 *    `标题：☞ **Solution 2: …**` 里 `标题：` 在 `☞` 的**前面**，
 *    固定顺序只能剥掉一个 —— 于是那一页的标题带着 `☞`，而相邻页的同一个
 *    标题没有，两者字符串不相等，本该归并成一个知识点的两页被拆成了两个。
 */
export function cleanLine(raw) {
  let s = String(raw ?? '').trim();
  if (s.length === 0) return '';
  // 代码围栏、表格分隔行（`|---|---|`）不是内容。
  if (s.startsWith('```')) return '';
  if (/^\|?[\s\-:|]+\|?$/.test(s)) return '';

  // 剥到稳定（每轮至多剥掉一层前缀；上限防病态输入打死循环）。
  for (let round = 0; round < 8; round++) {
    const before = s;
    // markdown 记号：`**粗**` `_斜_` `` `码` ``
    s = s.replace(/\*\*|__|`|~~/g, '');
    // ⚠️ 这里必须用**替换串**而不是拼接：Dart 的 `replaceAll` 不解析 `$1`，
    //    真机上 `_Relevance_` 被清成了 `$1$2elevance_`，那个假标题直接进了树。
    s = s.replace(/(^|\s)[*_](\S)/g, '$1$2');
    // 落单的强调记号：只清**贴着空白或串首尾**的那些 —— 词中间的 `_` 可能是
    // 正经内容（`train_test_split`），不动它。
    s = s.replace(/(^|\s)[*_]+/g, '$1');
    s = s.replace(/[*_]+(\s|$)/g, '$1');
    // 视觉解析的定位词：位置词与部件词**任意顺序**，中间可夹一层括号说明。
    // ⚠️ 仍然**要求以冒号收尾** —— `页面置换算法` 含「页面」却没有冒号，不许动它。
    s = s.replace(
      /^(?:(?:右上角|左上角|右下角|左下角|中上|中下|中部|中央|页面中央|页面顶部|页面底部|顶部|底部|左侧|右侧|幻灯片|页眉|页脚|标题|小标题|标题栏|标题行|窗口|屏幕|方框|矩形框|框内|正文区|树状图|示意图|文字|内容|页码)\s*(?:[（(][^）)]{0,60}[）)])?\s*){1,3}[：:]\s*/,
      '',
    );
    // PPT 装饰前缀与项目符号。
    // ⛔ 这里**不剥** `【Example】` 这类成对方头括号：它们是 PPT 上真实的标题形态。
    s = s.replace(/^[☞✂·•▪◦●○◆◇■□★☆→>\-–—+*]+\s*/, '');
    // 有序列表前缀（`1. ` / `2) `）—— 它是版式，不是标题的一部分。
    s = s.replace(/^\d+[.)、]\s*/, '');
    // 收敛空白（图上常有多余空格）。
    s = s.replace(/[ \t\u3000]+/g, ' ').trim();
    // 省略号统一：视觉解析对同一个标题有时抄成 `......`、有时抄成 `……`。
    // 不统一的话「相同标题」比较不相等，同一个知识点会被切成两个。
    s = s.replace(/\.{3,}|…+/g, '……');
    if (s === before) break;
  }
  return s;
}

/** 课件上的一行收成还能当证据的短句。 */
export function tidySlideHeading(raw) {
  const s = cleanLine(raw);
  if (s.length === 0 || isNoise(s)) return '';
  return s;
}

/**
 * **纯记号行**：这一行只有数学/变量记号，没有词。
 *
 * 图上那些带标签的字母（`$k_1$`）标注的是节点/边的名字，视觉解析把它们逐行
 * 抄了出来，于是**第一个**记号被当成标题，目录里就会出现一个叫 `$k_1$` 的知识点。
 *
 * ⚠️ 不能按「含 `$` 就丢」—— `【Definition】 The balance factor $BF(node) = …`
 *    这种真标题里有记号，丢了它整页就没名字了。
 */
export function looksLikeNotationOnly(line) {
  let s = String(line ?? '').trim();
  if (s.length === 0) return true;
  // ★ 整行就是一条公式 ⇒ 那是页面中央的大公式，不是标题。
  if (/^\$\$[^$]*\$\$$/.test(s)) return true;
  if (/^\$[^$]*\$$/.test(s)) return true;
  s = s.replace(/\$[^$]{0,80}\$/g, '');
  // ⚠️ 这一行**逐字复刻** Dart 的 `RegExp(r'\[a-zA-Z]+')`，包括它写错的那部分。
  //
  //    在 Dart 里 `\[` 是**转义后的字面左括号**，所以这条正则匹配的是
  //    「`[` + 若干 ASCII 字母」，而作者的注释写的是「反斜杠命令（`\le` / `\mathrm`）」
  //    —— **代码与注释说的不是同一件事**。
  //
  //    移植时我「顺手修正」成 `\\[a-zA-Z]+`（真去匹配反斜杠命令），差分测试当场
  //    抓出来了：`\le 5` / `$x$\le` 这类行在 Dart 里**保留**、在我的版本里被判成
  //    纯记号丢掉。那会让一行真内容从要点里消失 —— 正是「不许自己发明算法」要防的事。
  //
  //    ⛔ 所以这里**故意保留** Dart 的写法（JS 里 `\[` 同样是字面左括号，语义等价）。
  //       要改它必须先去 App 侧改，并把那条注释与代码对齐 —— 那是跨仓的行为变更，
  //       不是移植该顺手做的事。等 App 修了，这里再跟着改。
  s = s.replace(/\[a-zA-Z]+/g, '');
  // 剩下的：只允许单个字母/数字/下标记号/空白/常见运算符与括号
  return /^[\sA-Za-z0-9_^{}\().,\-+=<>/|*…]*\$?$/.test(s) && !/[A-Za-z]{2,}/.test(s);
}

/**
 * **示意图的逐项说明**：在多讲「图长什么样」，不是在讲知识。
 *
 * ⚠️ 判据要**窄**：只认「位置/颜色/形状 + 图形名词 + 冒号」这种描述形态，
 *    否则会误杀 `Number of rotations` / `A balanced tree` 这类真内容。
 */
export function looksLikeDiagramNote(line) {
  const t = String(line ?? '').trim();
  if (t.length === 0) return false;
  const shapes = '(椭圆|方框|矩形|矩形框|箭头|连线|圆圈|曲线|虚线|树状图|示意图)';
  if (new RegExp(`${shapes}[^：:]{0,12}[：:]`).test(t)) return true;
  if (/^(根|叶|父|子|中间)?节点[^。]{0,20}(内文字|标注|上方|下方)/.test(t)) return true;
  if (/^(从|由)[^。]{0,20}(引出|连出|指向)/.test(t)) return true;
  if (/^(旋转指示|颜色说明|图例|示意图|树状图|左侧|右侧|上方|下方)[：:]/.test(t)) return true;
  if (/^(蓝色|红色|绿色|黄色|橙色|黑色|灰色|紫色)(粗|细)?(箭头|文字|线条|圆圈|框|曲线|虚线)/.test(t)) return true;
  return false;
}

/**
 * **这一页是不是别人家软件的截图**（见 kTreeAppWindowWords）。
 *
 * 只看**第一行**，且用「含」而不是「等于」：视觉解析抄出来的标题栏前后还会
 * 带它自己的说明（`**窗口标题栏**：Pre安排.xlsx - Excel  登录`）。
 */
export function looksLikeAppWindowPage(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const head = String(lines[0] ?? '').trim();
  if (head.length === 0) return false;
  for (const w of kTreeAppWindowWords) if (head.includes(w)) return true;
  return false;
}

/**
 * 一行能不能当标题 / 要点。
 *
 * 丢四类：纯页码、界面外壳文字、视觉解析的版式定位行、纯记号/图示说明。
 */
export function isNoise(line) {
  const t = String(line ?? '').trim();
  if (t.length === 0) return true;
  // 纯记号（`$k_1$` / `$A$`）与示意图说明 —— 都不是「内容」。
  if (looksLikeNotationOnly(t)) return true;
  if (looksLikeDiagramNote(t)) return true;
  // 纯数字（页码）或 `12 / 106` 这类页码形态。
  if (/^[\d\s/\-–—.]+$/.test(t)) return true;
  // 纯钟点 / 日期：录屏界面上叠加的**时间戳**，不是 PPT 内容。
  // 真机 P3 整页只有 `13:22` 与 `2026/9/15`，于是 `13:22` 成了 16 个块的知识点的名字。
  if (/^\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?$/.test(t)) return true;
  if (/^\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?$/.test(t)) return true;
  // 太短且不像标题：单个字符（项目符号残渣）。
  if (t.length <= 1) return true;
  // 整行就是「没有可见文字」的如实说明 —— 视觉解析的元语句，不是内容。
  if (/^[（(\[【]?(无|空|整页|这一页)/.test(t) && /(无可见文字|无任何可见文字|无|空|纯黑)/.test(t)) return true;

  // ── 界面外壳 ──
  for (const w of kTreeShellWords) {
    if (t.includes(w)) {
      // 「弱」外壳词只在短行上算数：`登录`/`共享`/`工具栏` 本身可能是正经
      // 内容的一部分（「共享内存」「工具栏设计」）。
      if (kTreeWeakShellWords.includes(w) && t.length > 20) continue;
      return true;
    }
  }

  // ── 版式定位行（`右上角页眉：` / `幻灯片正文中央：`）──
  // 两个条件**同时**成立才算：含定位词 且 以冒号收尾。单独一个都会误杀。
  if (/[：:]\s*$/.test(t)) {
    for (const w of kTreeLayoutWords) if (t.includes(w)) return true;
  }
  return false;
}

/**
 * **这一行是被判据「明确否决」的吗**（而不是「只是缺乏正面证据」）。
 *
 * ⚠️ 拆出来是因为封面页兜底需要的是**第二类**（缺乏正面证据）。兜底的逻辑
 *    天生是反的：通用判据认得出就不兜、认不出才兜 —— 用 `!looksLikeTitle`
 *    当条件等于把「判据明确判成正文的行」也放进了候选池（App 侧被独立复核
 *    抓出来的 bug：P1 的半句话 `Returns relevant documents but` 一度成了标题）。
 */
export function isRejectedAsTitle(line) {
  const s = String(line ?? '');
  // 表格行、代码行不是标题。
  if (s.includes('|')) return true;
  if (looksLikeNotationOnly(s)) return true;
  if (looksLikeDiagramNote(s)) return true;
  if (/^(while|if|for|return|Get|Insert|Write)\b/.test(s)) return true;
  // 半句话：以虚词、连词收尾 → 它是被切断的正文。
  // ⚠️ 中英文**必须分开判**：合成一条正则时英文那支漏了词边界，于是
  //    `Generator` 被 `or$` 命中，`Index Generator` 这个真标题整段丢了名字。
  if (/[的了和与或但而是就在有都也还把被对从]\s*$/.test(s)) return true;
  if (/\b(and|or|but|the|of|to|in|is|are|that|which|with|for)\s*$/i.test(s)) return true;
  // 句子收尾标点 → 是正文句，不是标题。
  if (/[。！？；]\s*$/.test(s)) return true;
  // 以冒号收尾的短行 → 视觉解析加的**版式标签**。
  // ⚠️ 只拦**全角**冒号：PPT 上真标题的编号形态用的是半角（`Discussion 4:`）。
  if (/[：]\s*$/.test(s)) return true;
  // 太长的不像标题。阈值取 90 而不是更小：真机踩到的 71 字真标题卡在 60 上
  // 被判成正文，于是整整 5 页丢了自己的知识点。
  if (s.length > 90) return true;
  return false;
}

/**
 * 一行像不像「这一页的标题」。
 *
 * 三条正面证据（有其一即可）：在别的页也出现过（标题会跨页重复）、
 * 匹配 PPT 标题的常见形态、这一页其余行都很长只有它是短行。
 *
 * ⚠️ 判不出来时返回 `false`（**留空**）而不是 `true`（编一个标题）。
 *    留空的代价是合并；编错的代价是**知识树本身错了** —— 后者更贵。
 */
export function looksLikeTitle(line, samePageLines, pageCountOf) {
  if (isRejectedAsTitle(line)) return false;
  // 1. 在别的页也出现过 —— 标题会跨页重复。
  if ((pageCountOf?.get(line) ?? 0) >= 2) return true;
  // 2. PPT 标题的常见形态：编号前缀。
  if (/^(Solution|Discussion|Definition|Example|Theorem|Proof|Lemma|Exercise|Problem|Algorithm|Chapter|Part)\b/i.test(line)) return true;
  // 3. 这一页**其余行都很长**（正文/代码），只有它是短行 → 它是标题。
  //    反过来，如果这一页还有别的同样短的行（`Index` / `Term`），那是一组
  //    平级的标注文字，谁也不比谁更像标题 —— 那就留空。
  const others = (samePageLines ?? []).filter((l) => l !== line && !l.includes('|'));
  if (others.length === 0 && line.length <= 30) return true;
  const shortOthers = others.filter((l) => l.length <= 30).length;
  if (line.length <= 30 && shortOthers === 0) return true;
  return false;
}

/**
 * **一个知识点属于哪一段**（outline 的分段下标）。口径是**多数块**。
 *
 * 返回 `null` 有两种含义，调用方都要能接受：这个知识点一个块都没有
 * （本次课没讲到）⇒ 归当前章；它的块都不在任何分段区间里 ⇒ 同上。
 *
 * ⛔ 本函数只回答「归哪一段」，**从不切开一个知识点**。
 */
export function segmentOfTopic(blockIndexes, segOfBlock) {
  if (!blockIndexes?.length || !segOfBlock?.size) return null;
  const votes = new Map();
  for (const b of blockIndexes) {
    const s = segOfBlock.get(b);
    if (s !== undefined) votes.set(s, (votes.get(s) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  let bestSeg = votes.keys().next().value;
  let bestN = -1;
  for (const [key, value] of votes) {
    if (value > bestN) { bestN = value; bestSeg = key; }
  }
  return bestSeg;
}

function makeTopic(title, fromPage, toPage, pptLines, blockIndexes) {
  return {
    title,
    fromPage,
    toPage,
    pptLines,
    blockIndexes,
    /** 本次课老师讲到了这个知识点（它下面有主线块）。 */
    get isCovered() { return blockIndexes.length > 0; },
    /** 只含标题、不含 PPT 要点的节点（一个孤零零的名字）。 */
    get titleOnly() { return pptLines.length === 0; },
    toString() {
      return `第 ${fromPage}–${toPage} 页｜${title === '' ? '（无名）' : title}`
        + `（${blockIndexes.length} 块${blockIndexes.length > 0 ? '' : '，本次课未讲'}）`;
    },
  };
}

function makeChapter(title, topics) {
  return {
    title,
    topics,
    /** 本章覆盖的主线块数。 */
    get blockCount() { return topics.reduce((a, t) => a + t.blockIndexes.length, 0); },
    toString() { return `${title}（${topics.length} 个知识点 / ${this.blockCount} 块）`; },
  };
}

function makeTree(chapters, warnings, uncoveredBlocks) {
  const tree = {
    chapters,
    warnings,
    uncoveredBlocks,
    /** 知识点总数（**含本次课没讲到的**）。 */
    get topicCount() { return chapters.reduce((a, c) => a + c.topics.length, 0); },
    /** 本次课讲到了的知识点数（讲义里会出现的那些）。 */
    get coveredTopicCount() {
      return chapters.reduce((a, c) => a + c.topics.filter((t) => t.isCovered).length, 0);
    },
    /** 树覆盖的主线块数。 */
    get blockCount() { return chapters.reduce((a, c) => a + c.blockCount, 0); },
    /**
     * 每个块序号 → 它所属的知识点（**全函数**）。
     *
     * ★ 这是「不遗漏」的构造性落点。返回 `Array` 而不是单个值，是为了让
     *   「一个块落在两个节点」这种**不该发生**的事在类型上可见。
     */
    get assignments() {
      const m = new Map();
      for (const c of chapters) {
        for (const t of c.topics) {
          for (const i of t.blockIndexes) {
            if (!m.has(i)) m.set(i, []);
            m.get(i).push(t);
          }
        }
      }
      return m;
    },
    toString() {
      return `知识树：${chapters.length} 章 / ${this.topicCount} 个知识点`
        + `（本次课讲到 ${this.coveredTopicCount} 个）/ ${this.blockCount} 块`;
    },
  };
  return tree;
}

/**
 * 从逐页文字 + 主线块建一棵知识树（**纯函数、零模型、可离线复现**）。
 *
 * @param {object} input
 * @param {Array<{page:number,text:string}>} input.slides 逐页的「图上文字」。
 *   `slides.json` 的 `content.pageText`。`pages` 是等价别名（与 Dart 同名）。
 * @param {Array<{index:number,page:number}>} input.blocks 主线块（只要序号与页号）。
 * @param {Array<{title:string,from:number,to:number}>} [input.outline] 整节梳理的
 *   分段，`from`/`to` 是**块序号**，用来定**章**这一级；为空时退回「整棵树只有一章」。
 */
export function buildLectureTree({ slides, pages, blocks, outline = [] } = {}) {
  const source = slides ?? pages ?? [];
  const warnings = [];

  // ── ① 逐页切成干净的行 ─────────────────────────────────────
  const rawLines = new Map();
  for (const p of source) {
    const ls = [];
    for (const line of String(p?.text ?? '').split('\n')) {
      const c = cleanLine(line);
      if (c.length > 0) ls.push(c);
    }
    rawLines.set(p.page, ls);
  }
  const realPages = [...rawLines.keys()].sort((a, b) => a - b);
  if (realPages.length === 0) return makeTree([], [], new Set());

  // 行 → 出现的页数（页眉判据要用）。
  const pageCountOf = new Map();
  for (const pg of realPages) {
    for (const l of new Set(rawLines.get(pg))) {
      pageCountOf.set(l, (pageCountOf.get(l) ?? 0) + 1);
    }
  }

  // ── ② 页眉 = 高频 **且** 总在第一行 ───────────────────────
  //
  // 页眉之所以要专门识别：它是**每页都会出现的第一行**，不剔掉的话每页的
  // 「标题」都会是它，整棵树退化成一个节点。
  const firstUsableOf = new Map();
  for (const pg of realPages) {
    for (const l of rawLines.get(pg)) {
      if (isNoise(l)) continue;
      firstUsableOf.set(pg, l);
      break;
    }
  }

  const headers = new Set();
  for (const [line, count] of pageCountOf) {
    if (count < kTreeHeaderMinPages) continue;
    const pagesOf = realPages.filter((pg) => rawLines.get(pg).includes(line));
    const firstCount = pagesOf.filter((pg) => firstUsableOf.get(pg) === line).length;
    if (firstCount / pagesOf.length < kTreeHeaderFirstLineRatio) continue;
    // 规模判据：**两条路，满足其一即可**。
    //   ① 占全篇够大 —— 单套课件的常态；
    //   ② 在**自己那一段区间**里够密 —— 一节里拼了两套课件时，每条页眉都盖不住全篇。
    const coversWholeDeck = count >= realPages.length * kTreeHeaderPageRatio;
    let coversOneDeck = false;
    if (!coversWholeDeck) {
      const lo = pagesOf.reduce((a, b) => (a < b ? a : b));
      const hi = pagesOf.reduce((a, b) => (a > b ? a : b));
      const span = hi - lo + 1;
      coversOneDeck = span >= kTreeHeaderDeckSpanMin && (count / span) >= kTreeHeaderDeckDensity;
    }
    if (!coversWholeDeck && !coversOneDeck) continue;
    headers.add(line);
  }

  // ── ③ 每页取标题 + 其余要点行 ──────────────────────────────
  const headerPages = new Set(realPages.filter((pg) => rawLines.get(pg).some((l) => headers.has(l))));
  const headerRuleOn = headerPages.size >= realPages.length * kTreeHeaderRuleMinRatio;
  if (!headerRuleOn) {
    // ⚠️ 这条告警在**两种**情况下都要报：「有页眉但没过门槛」与「一个页眉都
    //    没识别出来」。两种的风险是同一个 —— 抽出的标题可能混入界面文字。
    warnings.push(headers.size === 0
      ? '这份课件里没有识别出页眉（每页顶部没有重复的那一行），'
        + '无法按「有没有页眉」判课件页，已退回逐行过滤 —— '
        + '抽出的标题可能混入教师切到别的软件时的界面文字'
      : `只有 ${headerPages.size}/${realPages.length} 页带页眉，`
        + '不足以按「页眉」判课件页，已退回逐行过滤 —— '
        + '抽出的标题可能混入教师切到别的软件时的界面文字');
  }

  const headOf = new Map();
  const restOf = new Map();
  let shellPages = 0;
  for (const pg of realPages) {
    const lines = rawLines.get(pg);
    const usable = lines.filter((l) => !headers.has(l) && !isNoise(l));
    // 页级判据：**这一页是别人家软件的截图** → 不产出标题、也不贡献要点行
    //（它上面的讲解内容仍由块层按页区间收录）。
    const isShell = looksLikeAppWindowPage(lines);
    if (isShell || usable.length === 0) {
      if (lines.length > 0) shellPages++;
      headOf.set(pg, '');
      restOf.set(pg, []);
      continue;
    }
    // ★ 「第一行可用文字」**不一定是标题**：真机上第 28 页的表头 `Doc　　Text`、
    //   第 30 页的版式标签、第 75 页的正文句都排在第一行，但它们是**正文**。
    //   认成标题的症状是同一个知识点被切成好几个，名字还是半句话。
    const cand = usable[0];
    if (looksLikeTitle(cand, usable, pageCountOf)) {
      headOf.set(pg, cand);
      restOf.set(pg, usable.slice(1));
    } else {
      headOf.set(pg, '');
      restOf.set(pg, usable);
    }
  }

  // ── ★ ③b 开课段的**封面页**兜底 ────────────────────────────
  //
  // ③ 那条「认不出标题就留空」有个代价：课件**开头**那几页（课程名 / 教材 /
  // 评分办法）本来就没有「每页重复的标题行」，于是整段无名。
  //
  // 四条**同时**成立才生效（少一条就退化成「编标题」，违反纪律 2）：
  //   1. 只在**开头这一段无名页**里找；2. 候选页**不是软件截图页**；
  //   3. 该行用 `isRejectedAsTitle` 判**不是正文**；4. 该行**没有被本节其它页
  //   用作标题**；外加「这一页带了页眉就跳过」（它的第一行是页眉下的正文）。
  //
  // ⚠️ 顺序：必须在**所有页扫完之后**做（第 4 条要用到全节的标题集合）。
  const usedTitles = new Set([...headOf.values()].filter((v) => v.length > 0));
  for (const pg of realPages) {
    // 走到第一个**已有标题**的页就停：那之后不是开头段了。
    if (headOf.get(pg) !== '') break;
    if (looksLikeAppWindowPage(rawLines.get(pg))) continue;
    if (rawLines.get(pg).some((l) => headers.has(l))) continue;
    const cands = rawLines.get(pg).filter((l) => !isNoise(l));
    if (cands.length === 0) continue;
    const l = cands[0];
    // ⛔ **不是** `looksLikeTitle` —— 那会把「判据已明确否决的行」也捡起来。
    if (isRejectedAsTitle(l)) break;
    if (usedTitles.has(l)) break;
    headOf.set(pg, l);
    restOf.set(pg, cands.slice(1));
    usedTitles.add(l);
    break;
  }

  // ── ④ 连续同名 → 一个知识点节点 ────────────────────────────
  //
  // ⚠️ 只归并**相邻**的页。同一个标题在远处再次出现（老师回头又讲了一遍）
  //    是两个节点，不是同一个 —— 它们在讲义里就该出现在两个位置。
  //
  // 三种「没标题」要分开处理，混为一谈会切错知识点：
  //   课件页但没认出标题 → 并进上一段（多半是上一个知识点的续表）；
  //   界面截图页 → **自成一段**（并进去是错的归属）；
  //   第一页就没标题 → 自成一段（没有「上一段」可并）。
  const segs = [];
  for (const pg of realPages) {
    const h = headOf.get(pg);
    const isSlidePage = !looksLikeAppWindowPage(rawLines.get(pg));
    if (segs.length === 0) {
      segs.push({ title: h, fromPage: pg, toPage: pg, lines: [...restOf.get(pg)] });
      continue;
    }
    const last = segs[segs.length - 1];
    const sameTitle = h !== '' && last.title === h;
    const continuation = h === '' && last.title === '';
    const unnamedContinue = h === '' && isSlidePage && last.title !== '';
    if (sameTitle || continuation || unnamedContinue) {
      last.toPage = pg;
      last.lines.push(...restOf.get(pg));
      continue;
    }
    segs.push({ title: h, fromPage: pg, toPage: pg, lines: [...restOf.get(pg)] });
  }
  if (shellPages > 0) {
    warnings.push(`有 ${shellPages} 页是教师切到别的软件时的界面截图`
      + '（Excel 排期表 / 浏览器 / 关机画面等），这些页没有 PPT 标题，'
      + '其讲解内容仍按无名知识点收录');
  }

  // ── ⑤ 把主线块挂到节点上 ──────────────────────────────────
  //
  // ★ 挂载判据是**页码**：节点覆盖 [fromPage, toPage]，块落在区间里就属于它。
  const sorted = [...(blocks ?? [])].sort((a, b) => a.index - b.index);
  const byPage = new Map();
  for (const b of sorted) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b.index);
  }

  const nodes = [];
  for (const s of segs) {
    const idx = [];
    for (let p = s.fromPage; p <= s.toPage; p++) {
      const hit = byPage.get(p);
      if (hit) idx.push(...hit);
    }
    // 标题为空（整段都没有可用 PPT 标题）时**不编造**标题。
    nodes.push({ seg: s, blocks: idx });
  }

  // 页码落在所有分片之外（页号缺失、越界）的块 → 附到最近的节点。
  //
  // ⚠️ 这一段是**必要的**：块的页号来自终稿，而 `slides.json` 可能缺页。
  //    不兜底的话那些块**会凭空消失**，而症状是「讲义比视频少了一段」，
  //    用户无从发现 —— 那是本仓库明令禁止的。
  const placed = new Set(nodes.flatMap((n) => n.blocks));
  const orphans = sorted.filter((b) => !placed.has(b.index)).map((b) => b.index);
  if (orphans.length > 0) {
    if (nodes.length === 0) nodes.push({ seg: { title: '', fromPage: 0, toPage: 0, lines: [] }, blocks: [] });
    const firstPage = new Map(sorted.map((b) => [b.index, b.page]));
    for (const oi of orphans) {
      const op = firstPage.get(oi) ?? 0;
      let best = nodes[0];
      let bestD = 1 << 30;
      for (const n of nodes) {
        const d = op < n.seg.fromPage
          ? n.seg.fromPage - op
          : (op > n.seg.toPage ? op - n.seg.toPage : 0);
        if (d < bestD) { bestD = d; best = n; }
      }
      best.blocks.push(oi);
    }
    warnings.push(`有 ${orphans.length} 个主线块的页号不在课件页范围里，`
      + '已按页序附到最接近的知识点');
  }

  // ── ⑥ 一个节点都不丢 ────────────────────────────────────
  //
  // ★ 这里曾经是「丢掉一句都没讲的节点」。**那是错的**：知识树是空间性的
  //   课程知识图谱，不是一次性的阅读产物。真机那一节有 24 个节点因为
  //   「本次课没讲到」被删掉 —— 而那 24 页的结构再也回不来了。
  const kept = nodes;

  const notCovered = kept.filter((n) => n.blocks.length === 0).length;
  if (notCovered > 0) {
    warnings.push(`课件上有 ${notCovered} 个知识点的页，本次课没讲到`
      + '（树里保留着，讲义只列讲过的那些）');
  }

  // ── ⑦ 章：优先课件分节页，其次**整节梳理的语义分段** ────────
  //
  // ★ 为什么必须有第二条：真机课件**大多没有**「第N章」这种页 —— 实测三节里
  //   两节切出 1 章、20 个知识点全平铺在一章里，而同一批数据里 `outline`
  //   已经算好了 16 段语义分段。传进来却只用于一条告警，是接口与实现不一致。
  //
  // ★ 铁律 1 不破：分段**不切开概念** —— 一个知识点挂在多段上时按**多数块**
  //   归段（segmentOfTopic），绝不把一个知识点劈成两半。
  const template = detectSlideTemplate({
    pageCount: realPages.length,
    headerPages: headerPages.size,
    shellPages,
  });
  warnings.push(`课件形态：${template.label}`);

  // 块序号 → 分段下标（`outline` 的 `from`/`to` 是**块序号**，不是页号）。
  const segOfBlock = new Map();
  for (let i = 0; i < outline.length; i++) {
    const s = outline[i];
    if (s.from > s.to) continue;
    for (let b = s.from; b <= s.to; b++) segOfBlock.set(b, i);
  }
  // ★ 两条种子谁优先：**课件自己的分节页优先**。课件上明写着「第1章」时，
  //   那是课程自己的结构，比整节梳理（模型对录音的分段）更权威。
  const deckHasDividers = kept.some((n) => looksLikeSectionDivider(n.seg.title.trim()));
  const outlineUsable = segOfBlock.size > 0 && !deckHasDividers;

  const chapters = [];
  let chapterTitle = '';
  let bucket = [];
  let chapterSeg = -2; // -2 = 还没起章；-1 = 由分节页起的章
  const flush = () => {
    if (bucket.length === 0) return;
    chapters.push(makeChapter(chapterTitle, [...bucket]));
    bucket = [];
  };

  for (const n of kept) {
    const topic = topicOf(n, warnings);
    if (looksLikeSectionDivider(topic.title)) {
      // 种子 1：课件上明写着「第N章」——那是课程自己的结构，最优先。
      flush();
      chapterTitle = topic.title;
      chapterSeg = -1;
    } else if (outlineUsable) {
      const seg = segmentOfTopic(topic.blockIndexes, segOfBlock);
      if (seg !== null && seg !== chapterSeg) {
        // 种子 2：整节梳理说这里换了一段 ⇒ 起新章。
        flush();
        chapterTitle = outline[seg].title;
        chapterSeg = seg;
      }
    }
    bucket.push(topic);
  }
  flush();

  if (outlineUsable) {
    let cross = 0;
    for (const n of kept) {
      const ids = new Set();
      for (const b of n.blocks) {
        const id = segOfBlock.get(b);
        if (id !== undefined) ids.add(id);
      }
      if (ids.size > 1) cross++;
    }
    if (cross > 0) warnings.push(`有 ${cross} 个概念的口述跨过了分段边界，概念保持完整`);
  }

  // ── ⑧ 不遗漏：算出来，而不是感觉 ──────────────────────────
  const covered = new Set(chapters.flatMap((c) => c.topics.flatMap((t) => t.blockIndexes)));
  const uncovered = new Set(sorted.filter((b) => !covered.has(b.index)).map((b) => b.index));
  if (uncovered.size > 0) {
    // 走到这里说明上面的兜底漏了 —— 如实报出来，不静默。
    warnings.push(`有 ${uncovered.size} 个主线块没有落到任何知识点上`
      + '（这是建树的缺陷，请报出来）');
  }

  return makeTree(chapters, warnings, uncovered);
}

/** 把一个中间态节点收成一个知识点（标题为空时如实告警，**不编造**）。 */
function topicOf(n, warnings) {
  const t = n.seg.title.trim();
  if (t.length === 0) {
    // ⚠️ 不编造标题：叫「未命名」也比假装知道它叫什么好。
    warnings.push(`第 ${n.seg.fromPage}–${n.seg.toPage} 页没有可用的 PPT 标题`
      + '（图上没有文字，或全是界面外壳），这些块的知识点没有名字');
  }
  return makeTopic(t, n.seg.fromPage, n.seg.toPage, Object.freeze([...n.seg.lines]), Object.freeze([...n.blocks]));
}
