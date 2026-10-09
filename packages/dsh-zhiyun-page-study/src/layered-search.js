// 分层检索 —— App `knowledge_store.dart` 的 `search()` 在 JS 侧的对应实现。
//
// 语义逐条对齐 App 侧的 `lib/data/knowledge_store.dart`：
//   ① 档位（`QueryMode`）决定「候选字段集」，不是相关度算法；
//   ② **先筛后扫**：2×11 维（role + facets）先把块收窄，再在子集里扫关键词；
//   ③ **筛了维度就只有块层能出结果** —— 页面层、整节主线、术语表都没有块级标签，
//      放行就是假命中（App 里对应 4 处 `if (hasFilter) return`）；
//   ④ `titleOnly` 只看概述（+ 讲义标题），页面层与正文完全不参与；
//   ⑤ 空查询：无筛选 → 不出结果；有筛选 → 每个通过的块出一条（纯过滤）；
//   ⑥ 匹配是**字面**子串（大小写不敏感、不切词、不算相关度），不是向量检索；
//   ⑦ **筛选只在「标签过滤」档位生效**（App `study_search.dart` 的显式规则）：
//      `KnowledgeStore` 一旦收到 facets/role，就会把没有 2×11 标签的层整段排除，
//      别的档位悄悄带上筛选会让「选了『图上的字』却一条不出」变得无法解释。
//
// 与 App 的差异（JS 链路真实的形状差异，不是语义放水）：
//   · App 的块只带句区间，句子层正文从 `slides.json` 按页序号取；JS 的块**内联**了
//     `sentences[]`，所以老师原话层直接取块内句子，但报**每一句自己那一页**的页号
//     （跨页块里点跳转要落到命中句所在的那一页）。
//   · App 的页面层读 `slides.json` 的 `content.{pageText,pageVisual,teacherExplanation}`；
//     JS 的页记录只有 `transcription`（真实产物里是 `raw` 原文，夹具里已拆好字段），
//     所以这里两种形状都读。
//   · App 的 `reference` 层（N06/E11 结构化成参考资料）在 JS 没有对应支路，
//     本节的书面稿落在 `lecture`（讲义）层；层注册表里 `reference` 标为不可用。

import { LayerId, QueryMode, defaultSearchLayers, layerLabel, layerSpecOf, normalizeFacet, queryModeOf } from './layers.js';

/** 默认结果上限（App 的 `limit = 40`）。 */
export const searchLimit = 40;

const text = (value) => (typeof value === 'string' ? value : '');

/** 字面命中：App 的 `_find` —— 两边都转小写后 `indexOf`，不切词。 */
export function findIn(haystack, needle) {
  if (!haystack || !needle) return null;
  const at = haystack.toLowerCase().indexOf(needle);
  return at < 0 ? null : { matchStart: at, matchEnd: at + needle.length };
}

/** `## 小节名` 切段（与解析器 `core.js` 的 `sections()` 同款语法）。 */
export function splitSections(raw) {
  const out = {};
  let title = null;
  let lines = [];
  const flush = () => { if (title) out[title] = lines.join('\n').trim(); };
  for (const line of text(raw).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const match = line.match(/^#{1,3}\s*(.+?)\s*$/);
    if (match) { flush(); title = match[1].trim(); lines = []; } else lines.push(line);
  }
  flush();
  return out;
}

/**
 * 页面层的三个字段。
 * 真实产物只存 `transcription.raw`（内含 `## 页面文字` / `## 页面画面` 原文），
 * 夹具与 schema 走 `transcription.pageText` / `pageVisual`，两种都读。
 */
export function pageFields(page) {
  const transcription = page?.transcription ?? {};
  const parts = typeof transcription.raw === 'string' && transcription.raw ? splitSections(transcription.raw) : {};
  return {
    pageText: text(transcription.pageText).trim() || text(page?.pageText).trim() || text(parts['页面文字']),
    pageVisual: text(transcription.pageVisual).trim() || text(page?.pageVisual).trim()
      || text(parts['页面画面']) || text(parts['页面画面与图形']) || text(parts['版面与图形']),
    explanation: text(transcription.teacherExplanation).trim() || text(page?.teacherExplanation).trim(),
  };
}

/** 术语表词条：`glossary.terms` 与 `glossary.extracted` 两种形状都认。 */
export function glossaryTerms(result) {
  const glossary = result?.glossary;
  if (!glossary) return [];
  const out = [];
  const push = (value) => {
    const label = typeof value === 'string' ? value : text(value?.text ?? value?.name);
    const term = label.trim();
    if (term) out.push({ term, pages: Array.isArray(value?.pages) ? value.pages : [], count: value?.count ?? null });
  };
  for (const term of Array.isArray(glossary.terms) ? glossary.terms : []) push(term);
  if (!out.length) for (const term of Array.isArray(glossary.extracted) ? glossary.extracted : []) push(term);
  return out;
}

/** 讲义（知识点稿）的正文块：`topic.blocks` 或 `topic.passages`。 */
export function lectureBlocks(topic) {
  if (Array.isArray(topic?.blocks) && topic.blocks.length) return topic.blocks;
  return (Array.isArray(topic?.passages) ? topic.passages : []).map((passage) => ({ text: passage?.text ?? '', kind: passage?.label ?? null }));
}

/** 讲义正文块里可用于匹配的文本（例题看题干与解答）。 */
function lectureBlockText(block) {
  return [block?.stem, block?.solution, block?.text, block?.displayText].map(text).filter(Boolean).join('\n');
}

/** 命中的预览：把长文本裁到命中点前后各一段（页面层可能整页几百字）。 */
function previewOf(hit, span = 60) {
  const value = text(hit.text);
  if (!Number.isFinite(hit.matchStart)) return value.length > span * 2 ? `${value.slice(0, span * 2)}…` : value;
  const from = Math.max(0, hit.matchStart - span);
  const to = Math.min(value.length, hit.matchEnd + span);
  return `${from > 0 ? '…' : ''}${value.slice(from, to)}${to < value.length ? '…' : ''}`;
}

/**
 * 一节课的分层检索。纯函数：不碰网络、不碰宿主，输入就是产物。
 *
 * @param result 解析终稿（知识库记录 / `state.result`）。
 * @param options.query 检索词；可空（配合维度做纯过滤）。
 * @param options.mode 档位 id（`tagFilter` / `titleOnly` / `titleBody`）。
 * @param options.role 主支线的单值筛选（`主线` / `支线` / 空）；**只在标签过滤档位生效**。
 * @param options.facets 2×11 维第 2 维的多选（任一命中即可，与 App 的 `any` 一致）；同上只在标签过滤档位生效。
 * @param options.layers 参与检索的层 id 集合；不传用 `defaultSearchLayers`。
 * @param options.limit 结果上限（**每个分支各自截止**，与 App 的 `out.length >= limit` 一致）。
 * @returns `{ hits, counts, omitted, layers, mode, hasFilter, filtersActive, empty }`
 */
export function searchLesson(result, options = {}) {
  const {
    query = '',
    mode = QueryMode.titleBody.id,
    role = '',
    facets = [],
    layers = defaultSearchLayers,
    limit = searchLimit,
  } = options;

  const spec = queryModeOf(mode);
  const needle = text(query).trim().toLowerCase();
  const wanted = layers instanceof Set ? layers : new Set(layers ?? []);
  // ★ 筛选只在标签过滤档位生效（App `study_search.dart` 的 tagMode 规则）。
  const tagMode = spec.id === QueryMode.tagFilter.id;
  const wantedFacets = new Set(tagMode ? (facets ?? []).map(normalizeFacet).filter(Boolean) : []);
  const wantedRole = tagMode ? text(role).trim() : '';
  const hasFilter = wantedFacets.size > 0 || Boolean(wantedRole);
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
  const hits = [];
  const counts = {};
  const push = (hit) => {
    const shifted = { ...hit, preview: previewOf(hit) };
    hits.push(shifted);
    counts[shifted.layer] = (counts[shifted.layer] ?? 0) + 1;
    return shifted;
  };
  // 每个分支各自截止：App 里 5 个命中函数各返回一个 `out`，各自 break。
  const branch = () => ({ start: hits.length });
  const branchFull = (bucket) => hits.length - bucket.start >= limit;

  // 空查询 + 无筛选：App 直接返回空（「空检索词不会返回全部结果」）。
  if (!needle && !hasFilter) {
    return { hits: [], counts, omitted: 0, layers: [...wanted], mode: spec.id, hasFilter, filtersActive: tagMode && hasFilter, empty: true };
  }

  // ── ① 块层与句子层 ──
  if (wanted.has(LayerId.finalDoc) || wanted.has(LayerId.teacher)) {
    const bucket = branch();
    for (const block of blocks) {
      if (branchFull(bucket)) break;
      const tag = block?.tag ?? {};
      const blockFacets = (Array.isArray(tag.facets) ? tag.facets : []).map(normalizeFacet);
      // ★ 先筛后扫：过 2×11 维（App `_blockAndSentenceHits` 开头两段）。
      if (wantedRole && tag.role !== wantedRole) continue;
      if (wantedFacets.size && !blockFacets.some((facet) => wantedFacets.has(facet))) continue;

      const summary = text(tag.summary);
      const summaryHit = needle ? findIn(summary, needle) : null;
      const sentences = Array.isArray(block?.sentences) ? block.sentences : [];
      const pages = [...new Set(sentences.map((sentence) => sentence?.page).filter((value) => value != null))];
      const head = {
        blockIndex: block.index,
        page: block.page ?? null,
        pages,
        atSec: Number.isFinite(block.startMs) ? Math.floor(block.startMs / 1000) : null,
        role: tag.role ?? null,
        facets: blockFacets,
      };

      // ① titleOnly：只有概述命中才出（正文完全不参与）。
      if (spec.id === QueryMode.titleOnly.id) {
        if (!summaryHit || !wanted.has(LayerId.finalDoc)) continue;
        push({ ...head, id: `final:${block.index}`, layer: LayerId.finalDoc, text: summary, summary, ...summaryHit });
        continue;
      }

      // ② 空查询 + 有筛选：纯过滤，每个候选块出一条（App 的「块级片段」）。
      if (!needle) {
        if (!wanted.has(LayerId.finalDoc)) continue;
        push({
          ...head, id: `final:${block.index}`, layer: LayerId.finalDoc,
          text: summary || sentences.map((sentence) => text(sentence?.text)).join(' '),
          summary: summary || null,
        });
        continue;
      }

      // ③ titleBody / tagFilter + 关键词：先在块覆盖的句子里找（老师原话层）。
      let sentenceHit = false;
      if (wanted.has(LayerId.teacher)) {
        for (const sentence of sentences) {
          if (branchFull(bucket)) break;
          const body = text(sentence?.text);
          const found = findIn(body, needle);
          if (!found) continue;
          sentenceHit = true;
          push({
            ...head, id: `teacher:${block.index}:${sentence?.startMs ?? ''}`, layer: LayerId.teacher,
            // ★ 报这一句自己那一页（跨页块里点跳转要落到命中句所在的页）。
            page: sentence?.page ?? block.page ?? null,
            atSec: Number.isFinite(sentence?.startMs) ? Math.floor(sentence.startMs / 1000) : null,
            text: body, summary: summary || null, ...found,
          });
        }
      }
      // 正文一句都没命中、但概述命中了 → 概述是这一块的语义摘要，如实出一条（App：「不丢」）。
      if (!sentenceHit && summaryHit && wanted.has(LayerId.finalDoc)) {
        push({ ...head, id: `final:${block.index}`, layer: LayerId.finalDoc, text: summary, summary, ...summaryHit });
      }
    }
  }

  // ── ② 页面层与整节主线 ──
  // ★ 筛了维度就整段排除：页面层与主线没有块级标签（App 的 `if (hasFilter) return out;`）。
  if (!hasFilter && needle) {
    const bucket = branch();
    if (wanted.has(LayerId.outline)) {
      const spine = text(result?.spine).trim();
      const found = findIn(spine, needle);
      if (found) push({ id: 'outline:0', layer: LayerId.outline, page: null, atSec: null, text: spine, ...found });
    }
    // titleOnly **不看页面层**：页面层是正文性质的内容（App 的同名早返回）。
    const pages = spec.id === QueryMode.titleOnly.id ? [] : (Array.isArray(result?.pages) ? result.pages : []);
    for (const page of pages) {
      if (branchFull(bucket)) break;
      // 融合纠错失败的页是半成品，不入检索（可复核、可重试，只是不当候选）。
      if (page?.failure != null) continue;
      const fields = pageFields(page);
      // 判别门：判成界面截图的页，只有「画面描述」不进检索（图上的字保留）。
      const gated = page?.gate?.filtered === true;
      const atSec = Number.isFinite(page?.fromMs) ? Math.floor(page.fromMs / 1000) : null;
      for (const [layer, value] of [[LayerId.pageText, fields.pageText], [LayerId.pageVisual, fields.pageVisual], [LayerId.explanation, fields.explanation]]) {
        if (branchFull(bucket)) break;
        if (!wanted.has(layer)) continue;
        if (layer === LayerId.pageVisual && gated) continue;
        const body = text(value).trim();
        if (!body) continue;
        const found = findIn(body, needle);
        if (!found) continue;
        push({ id: `${layer}:${page?.page ?? ''}`, layer, page: page?.page ?? null, atSec, text: body, ...found });
      }
    }
  }

  // ── ③ 术语表 ──
  // 术语没有 2×11 标签，也不做空查询（App 的 `_glossaryHits` 三连早返回）。
  if (!hasFilter && needle && wanted.has(LayerId.glossary)) {
    const bucket = branch();
    for (const term of glossaryTerms(result)) {
      if (branchFull(bucket)) break;
      const found = findIn(term.term, needle);
      if (!found) continue;
      push({
        id: `glossary:${term.term}`, layer: LayerId.glossary,
        page: term.pages.length ? term.pages[0] : null, pages: term.pages, atSec: null,
        text: term.term, ...found,
      });
    }
  }

  // ── ④ 讲义（App `reference` 层在 JS 的落点）──
  if (!hasFilter && needle && wanted.has(LayerId.lecture)) {
    const bucket = branch();
    const chapters = Array.isArray(result?.lecture?.chapters) ? result.lecture.chapters : [];
    for (const [ci, chapter] of chapters.entries()) {
      for (const [ti, topic] of (Array.isArray(chapter?.topics) ? chapter.topics : []).entries()) {
        if (branchFull(bucket)) break;
        const anchor = topic?.anchor ?? {};
        const base = {
          layer: LayerId.lecture, chapterNo: chapter?.no ?? ci + 1, topicNo: topic?.no ?? ti + 1,
          page: topic?.fromPage ?? anchor?.page ?? null, pages: topic?.toPage ? [topic.toPage] : [],
          atSec: Number.isFinite(anchor?.tSec) ? anchor.tSec : null,
          sourceBlockIndexes: topic?.sourceBlockIndexes ?? topic?.blockIndexes ?? [],
        };
        // titleOnly → 只匹配标题（App `_referenceHits` 的 titleOnly 分支）。
        const title = text(topic?.title).trim();
        const titleHit = findIn(title, needle);
        if (titleHit) {
          push({ id: `lecture:${ci}:${ti}`, ...base, text: title, ...titleHit });
          if (spec.id === QueryMode.titleOnly.id) continue;
        } else if (spec.id === QueryMode.titleOnly.id) continue;
        for (const [bi, block] of lectureBlocks(topic).entries()) {
          if (branchFull(bucket)) break;
          const body = lectureBlockText(block);
          const found = findIn(body, needle);
          if (!found) continue;
          push({ id: `lecture:${ci}:${ti}:${bi}`, ...base, text: body, ...found });
        }
      }
    }
  }

  const omitted = hits.length > limit ? hits.length - limit : 0;
  return {
    hits: omitted ? hits.slice(0, limit) : hits,
    counts,
    omitted,
    layers: [...wanted],
    mode: spec.id,
    hasFilter,
    filtersActive: tagMode && hasFilter,
    empty: false,
  };
}

/**
 * 命中落在哪些块上（只含块层：终稿概述与老师原话）。
 *
 * 正文只渲染被命中的块：页面层、主线、术语表、讲义的命中没有块号，它们出现在
 * 结果面板里，正文列表不该因为「有一条页面命中」就把整节展开。
 */
export function hitBlockIndexes(outcome) {
  const out = new Set();
  for (const hit of outcome?.hits ?? []) if (hit.blockIndex != null) out.add(hit.blockIndex);
  return out;
}

/**
 * 本节现有内容的目录计数：高级检索面板拿它当 chip 微标。
 *
 * 与检索无关，量的是「这一节里这一层/这一维有多少条」——
 * 所以它不随关键词、档位、层范围变化。0 条的 chip 在 UI 上虚化且不可点：
 * 点下去只会得到「没有命中」，那是假反馈。
 */
export function lessonCatalog(result) {
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
  const layers = {};
  layers[LayerId.finalDoc] = blocks.length;
  layers[LayerId.teacher] = blocks.reduce((sum, block) => sum + (Array.isArray(block?.sentences) ? block.sentences.length : 0), 0);
  // 主线层扫的是 `result.spine` 一整段，所以「有几条」就是有/没有。
  layers[LayerId.outline] = text(result?.spine).trim() ? 1 : 0;
  let pageText = 0, pageVisual = 0;
  for (const page of Array.isArray(result?.pages) ? result.pages : []) {
    const fields = pageFields(page);
    if (fields.pageText) pageText += 1;
    if (fields.pageVisual) pageVisual += 1;
  }
  layers[LayerId.pageText] = pageText;
  layers[LayerId.pageVisual] = pageVisual;
  layers[LayerId.glossary] = glossaryTerms(result).length;
  layers[LayerId.lecture] = (Array.isArray(result?.lecture?.chapters) ? result.lecture.chapters : [])
    .reduce((sum, chapter) => sum + (Array.isArray(chapter?.topics) ? chapter.topics.length : 0), 0);

  const facets = {};
  const roles = {};
  for (const block of blocks) {
    for (const facet of new Set((Array.isArray(block?.tag?.facets) ? block.tag.facets : []).map(normalizeFacet))) {
      if (facet) facets[facet] = (facets[facet] ?? 0) + 1;
    }
    const role = normalizeFacet(block?.tag?.role);
    if (role) roles[role] = (roles[role] ?? 0) + 1;
  }
  return { layers, facets, roles };
}

/** 检索口径的一句话说明（UI 用它解释「为什么这次只有这些层出结果」）。 */
export function searchNote(outcome) {
  const spec = queryModeOf(outcome.mode);
  if (outcome.empty) return '输入检索词，或用「标签过滤」档位配合 2×11 维筛出内容。';
  const parts = [spec.hint];
  if (outcome.filtersActive) parts.push('已按维度收窄 —— 只有块层能出结果（页面层、主线、术语表没有块级标签）。');
  else if (outcome.hasFilter) parts.push('筛选只在「标签过滤」档位生效，本次未参与。');
  const layers = [...new Set(outcome.hits.map((hit) => hit.layer))];
  parts.push(layers.length ? layers.map((layer) => `${layerLabel(layer)} ${outcome.counts[layer] ?? 0}`).join(' · ') : '没有命中');
  const unavailable = outcome.layers.map(layerSpecOf).filter((entry) => entry && !entry.available);
  if (unavailable.length) parts.push(`未接入：${unavailable.map((entry) => entry.label).join('、')}`);
  return parts.join(' · ');
}
