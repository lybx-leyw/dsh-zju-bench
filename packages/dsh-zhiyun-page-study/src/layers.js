// 检索的「层」与「档位」注册表 —— 本文件的单一真源。
//
// 语义与 App 的 `lib/data/knowledge_layers.dart` 对齐（那边是 Flutter 侧的唯一真源）：
// 层是可分别寻址的检索单元，档位（QueryMode）决定「候选字段集」。
// 这里只登记 **JS 解析链路真的能供出来的层**；供不出来的层也登记，
// 但标 `available: false` 并写明原因 —— UI 会把它们显示为不可选，
// 这样「App 有、JS 还没有」这件事在界面上是可见的，而不是静默消失。
//
// 层 id 沿用 App 的字符串（`final` / `teacher` / `outline` / …），
// 只有讲义是 JS 侧新增的：App 的「结构化成参考资料」是 N06/E11 那条独立支路，
// JS 没有那条路，JS 的讲义（知识点稿）落在同一个位置上，所以另立 id 并注明来源。

/** 检索档位。order 即 UI 显示顺序。 */
export const QueryMode = {
  tagFilter: {
    id: "tagFilter",
    label: "标签过滤",
    hint: "先用 2×11 维收窄，再在子集里扫",
  },
  titleOnly: {
    id: "titleOnly",
    label: "仅标题匹配概述",
    hint: "只匹配概述与标题层级，不展开正文",
  },
  titleBody: {
    id: "titleBody",
    label: "标题 + 正文匹配",
    hint: "概述与正文一起扫",
  },
};

export const queryModes = [QueryMode.tagFilter, QueryMode.titleOnly, QueryMode.titleBody];

export const defaultQueryMode = QueryMode.titleBody;

/** 档位 id → 档位定义（认不出返回默认档 —— 档位只有三个，没得猜）。 */
export function queryModeOf(id) {
  return queryModes.find((mode) => mode.id === id) ?? defaultQueryMode;
}

/** 层 id 常量（与本文件下方的注册表一一对应，别在别处再写字面量）。 */
export const LayerId = {
  /** 块级终稿：块带 role / facets / summary + 起止时间 + 页号。 */
  finalDoc: "final",
  /** 老师原话的句子层（纠错后正文 + 时间戳；标签取自它所在的块）。 */
  teacher: "teacher",
  /** 整节主线（`result.spine`）。 */
  outline: "outline",
  /** 图上的字（页面层）。 */
  pageText: "pageText",
  /** 页面画面（页面层）。 */
  pageVisual: "pageVisual",
  /** 老师讲解（页面对应）—— JS 解析链路暂无此字段。 */
  explanation: "teacherExplanation",
  /** 术语表（过停用词与频次门槛的专名）。 */
  glossary: "glossary",
  /** 讲义（知识点稿）—— JS 侧对 App「结构化成参考资料」的落点。 */
  lecture: "lecture",
  /** 结构化成参考资料（N06 / E11）—— JS 没有这条支路。 */
  reference: "reference",
  /** 常规 RAG —— 课程级语料，按节口径默认不扫。 */
  rag: "rag",
  /** 其他参考数据 —— 同上。 */
  extra: "extra",
};

/**
 * 层的注册表。
 *
 * `source` 沿用 App 的来源分组（reference / finalDoc / rag / extra），
 * `inDefaultSearch` 决定「不点名时扫不扫」：rag 与 extra 是课程级语料，
 * 与本节同源会造成「找到 N 处」虚高，所以**刻意**不进默认集合。
 */
export const layerRegistry = [
  { id: LayerId.finalDoc, label: "终稿（块级）", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.teacher, label: "老师原话（句子层）", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.outline, label: "整节主线", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.pageText, label: "图上的字", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.pageVisual, label: "页面画面", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.glossary, label: "术语表", source: "finalDoc", available: true, inDefaultSearch: true },
  { id: LayerId.lecture, label: "讲义（知识点稿）", source: "reference", available: true, inDefaultSearch: true },
  {
    id: LayerId.explanation,
    label: "老师讲解（页面对应）",
    source: "finalDoc",
    available: false,
    inDefaultSearch: false,
    reason: "App 的融合阶段把老师讲解与课件页做了对应（mix.correspondence），JS 解析链路只保留句子层，没有这一层的数据。",
  },
  {
    id: LayerId.reference,
    label: "参考资料",
    source: "reference",
    available: false,
    inDefaultSearch: false,
    reason: "JS 还没有 N06 / E11 那条结构化成参考资料的支路；本节的书面稿在「讲义（知识点稿）」层。",
  },
  {
    id: LayerId.rag,
    label: "常规 RAG",
    source: "rag",
    available: false,
    inDefaultSearch: false,
    reason: "JS 尚未接入课程级 RAG 语料。",
  },
  {
    id: LayerId.extra,
    label: "其他参考数据",
    source: "extra",
    available: false,
    inDefaultSearch: false,
    reason: "JS 尚未接入其他参考数据。",
  },
];

/** 按 id 取层定义（认不出返回 null —— **不猜**）。 */
export function layerSpecOf(id) {
  return layerRegistry.find((spec) => spec.id === id) ?? null;
}

/** 可以真正出结果的层。 */
export const availableLayers = layerRegistry.filter((spec) => spec.available);

/** 不点名时扫的层集（App 的 defaultSearchLayers 等价物）。 */
export const defaultSearchLayers = new Set(
  layerRegistry.filter((spec) => spec.available && spec.inDefaultSearch).map((spec) => spec.id),
);

/** 全部可寻址层 id（含当前供不出来的）—— 供「层范围」全选与签名用。 */
export const unifiedSearchLayers = new Set(layerRegistry.map((spec) => spec.id));

/** 层集合的稳定签名（排序后拼串）：用于判断「两次检索是否同一口径」。 */
export function layerSignature(layers) {
  return [...layers].sort().join("+");
}

/** 层的中文名；认不出时回落到 id 本身（出处显示不能是空白）。 */
export function layerLabel(id) {
  return layerSpecOf(id)?.label ?? id;
}

/**
 * 2×11 维的第 2 维：11 项内置内容类型。
 * 与 App 的 `SentenceFacet` 同源（`lib/fusion/taxonomy.dart`），
 * 也与解析器 `assets/prompts.json` 的词表名字一致。
 */
export const builtinFacets = [
  { id: "rule", label: "法则" },
  { id: "concept", label: "概念" },
  { id: "caseStudy", label: "案例" },
  { id: "example", label: "例题" },
  { id: "formula", label: "公式" },
  { id: "theorem", label: "定理" },
  { id: "experiment", label: "实验" },
  { id: "story", label: "故事" },
  { id: "thought", label: "思想" },
  { id: "homework", label: "作业" },
  { id: "teachingPlan", label: "教学安排" },
];

/** 2×11 维的第 1 维：主线 / 支线（与解析器的 role 归一结果一致）。 */
export const lineRoles = ["主线", "支线"];

/**
 * 这一节可选的标签：11 项内置（永远显示，和 App 一样）+ 本节真实出现过的标签
 * （来自块上的 facets 与解析产出的 vocabulary，后者含模型 `新增:` 出来的词）。
 */
export function facetOptions(result) {
  const builtin = new Set(builtinFacets.map((facet) => facet.label));
  const seen = [];
  const push = (value) => {
    const label = String(value ?? "").trim();
    if (!label || builtin.has(label) || seen.includes(label)) return;
    seen.push(label);
  };
  for (const block of result?.blocks ?? []) for (const facet of block?.tag?.facets ?? []) push(facet);
  for (const word of result?.vocabulary ?? []) push(typeof word === "string" ? word : word?.name);
  return [...builtinFacets.map((facet) => facet.label), ...seen];
}

/** 标签比较用的规范化：去空白、去掉尾部的「类/型」这类后缀差异不处理，只做 trim。 */
export function normalizeFacet(value) {
  return String(value ?? "").trim();
}
