import { readFile } from 'node:fs/promises';
import { ParserError } from './errors.js';
import { ParserCache, Limiter, hash } from './cache.js';
import { templates, anchor, pageGate, glossary, buildCleanSentences, parseBlockDrafts, coverage, parseTags,
  sanitizeOutline, correctionRetryHint, coverageRetryHint } from './core.js';
import { mixRequest, chunkBlocks, tagRequest, outlineRequest } from './prompts.js';
import { transcribeSlides } from './vision.js';
import { normalizeVocabulary, seedVocabulary, ensureVocabularyStore, vocabularyLoadFailure } from './vocabulary.js';
import { normalizeAccel } from './accel.js';
export { HarnessLlm, ParserError } from './llm.js';
export { ParserCache } from './cache.js';

function validateInput(slides, subtitles) {
  if (!Array.isArray(slides) || !Array.isArray(subtitles)) throw new ParserError('INPUT', '解析需要课件与字幕列表');
  const pages = new Set();
  for (const slide of slides) {
    if (!Number.isInteger(slide.page) || slide.page < 1 || pages.has(slide.page)) throw new ParserError('INPUT', '课件页码重复或无效');
    pages.add(slide.page);
    if (slide.createdSec != null && (!Number.isFinite(slide.createdSec) || slide.createdSec < 0)) throw new ParserError('INPUT', '课件时间锚点无效');
  }
  for (const line of subtitles) if (typeof line.text !== 'string' || !Number.isFinite(line.startMs) || !Number.isFinite(line.endMs) || line.startMs < 0 || line.endMs < line.startMs) throw new ParserError('INPUT', '字幕时间区间或文本无效');
}
function assemblePage(lines, page, raw) {
  const clean = buildCleanSentences(lines.map(l => ({ ...l, page })), raw);
  const drafts = parseBlockDrafts(raw, lines.length, clean.bridges, { fallback: false });
  return { ...clean, drafts, coverage: coverage(drafts, lines.length) };
}
function blockOf(sentences, from, to, bridge, page) {
  return { index: 0, sentenceFrom: from, sentenceTo: to, page, sentences, bridge,
    startMs: sentences[0]?.startMs ?? null, endMs: sentences.length ? Math.max(...sentences.map(s => s.endMs)) : null,
    tag: { role: null, facets: [], summary: null } };
}
export function stitch(blocks) {
  const merged = [];
  for (const b of blocks) {
    const previous = merged.at(-1);
    if (previous && previous.sentenceTo + 1 === b.sentenceFrom && previous.sentences.at(-1).page !== b.sentences[0].page
      && previous.sentences.at(-1).page != null && b.sentences[0].page != null && !previous.tag.role && !b.tag.role
      && !/转到|进入|离开/.test(b.bridge) && b.startMs - previous.endMs <= 15000) {
      previous.sentences.push(...b.sentences); previous.sentenceTo = b.sentenceTo; previous.endMs = Math.max(previous.endMs, b.endMs);
    } else merged.push({ ...b, sentences: [...b.sentences] });
  }
  return merged.map((b, index) => ({ ...b, index: index + 1 }));
}
/** 混合解析的重试轮数上限（与 Dart `maxMixParseRounds` 同值）。 */
export const maxMixParseRounds = 3;
/** 标注分卷的补发轮数与退避（与 Dart `tagChunkRetryRounds` / `tagChunkRetryDelay` 同口径）。 */
export const tagChunkRetryRounds = 2;
export const tagChunkRetryDelayMs = 2000;
/** 可被取消的等待（退避用）。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export class LectureParser {
  constructor({ llm, cache = new ParserCache(), concurrency = 3, visionBatchSize = 4, readImage, classroom, vocabularyStore = null, accel = null } = {}) {
    if (!llm?.resolve || !llm?.call || !llm?.image) throw new ParserError('CONFIG', '请注入宿主 LLM 适配器');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new ParserError('CONFIG', '解析并发须为 1–16');
    if (!Number.isInteger(visionBatchSize) || visionBatchSize < 1 || visionBatchSize > 4) throw new ParserError('CONFIG', '课件拼图页数须为 1–4');
    this.llm = llm; this.cache = cache; this.concurrency = concurrency; this.limiter = new Limiter(concurrency);
    this.visionBatchSize = visionBatchSize;
    this.readImage = readImage; this.classroom = classroom; this.controllers = new Set(); this.closed = false;
    // 归一在构造期做一次：写错的档位要在**开跑前**报出来（有名字的失败），
    // 而不是等某一次调用以一个看不懂的协议错误失败。
    const normalized = normalizeAccel(accel);
    this.accelIssues = normalized.issues;
    if ((Object.keys(normalized.stages).length || normalized.escalation) && !llm.acceptsAccel) {
      // 档位在注入的适配器里落点。适配器不认它（没有 `acceptsAccel` 标记）时
      // **如实报出来**：静默忽略会让用户以为降本生效了，而花的钱一分没少。
      this.accelIssues.push('注入的 llm 适配器不接收 accel（档位没有落点）：请注入 HarnessLlm 或让适配器声明 acceptsAccel');
    }
    this.vocabularyStore = ensureVocabularyStore(vocabularyStore);
    this.loadIssues = [];
  }
  /**
   * 取这一节要用的**种子**词表。
   *
   * 加载失败或文件损坏**不许**让解析失败：退回种子，并把原因同时记进
   * `warnings` 与解析器的 `loadIssues` —— 静默当成「这次没有新增词」会让用户
   * 永远查不出为什么词表停止生长（已产出的块仍带着各自的标签名，不受影响）。
   */
  async loadVocabulary(warnings) {
    const seed = seedVocabulary();
    const store = this.vocabularyStore;
    // 逐条去重只针对**本次解析的 warnings**；`loadIssues` 是累积的观察记录，
    // 同一次故障在第二次解析里仍然要如实报出来（否则第二次开始就静默了）。
    const record = reason => { if (warnings.includes(reason)) return; warnings.push(reason); this.loadIssues.push(reason); };
    if (!store) return seed;
    const before = Array.isArray(store.loadIssues) ? store.loadIssues.length : 0;
    try {
      const loaded = await store.load();
      const { vocabulary, issues: loadedIssues } = normalizeVocabulary(loaded);
      for (const reason of loadedIssues) record(reason);
      // 适配器自己观察到的问题也要浮上来（宿主 store 有自己的坏数据日志时）。
      if (Array.isArray(store.loadIssues) && store.loadIssues.length > before) {
        for (const reason of store.loadIssues.slice(before)) if (!this.loadIssues.includes(reason)) record(reason);
      }
      return vocabulary;
    } catch (error) {
      const reason = vocabularyLoadFailure(error);
      if (!this.loadIssues.includes(reason)) record(reason);
      return seed;
    }
  }
  /** 解析结束后写回词表；**只在真的有新增时写一次**（无新增不写，避免每次都动盘）。 */
  async saveVocabulary(vocabulary, added, warnings) {
    if (!this.vocabularyStore || !added.length) return;
    try { await this.vocabularyStore.save(vocabulary); }
    catch (error) {
      // 写盘失败**不是**解析失败：这一节的标签已经打在块上了。但要如实报出来，
      // 否则下次解析词表又回到旧的样子，而没人知道为什么。
      warnings.push(`词表写入失败（${error?.code ?? error?.name ?? 'ERROR'}：${error?.message ?? error}）：本节新增的标签这次没有被记住。`);
    }
  }
  async bytes(slide, signal) {
    if (slide.imageBytes) return { data: Buffer.from(slide.imageBytes), mediaType: slide.mediaType ?? 'image/jpeg' };
    if (this.readImage) return this.readImage(slide, signal);
    if (slide.imagePath) return { data: await readFile(slide.imagePath, { signal }), mediaType: slide.mediaType ?? (/\.png$/i.test(slide.imagePath) ? 'image/png' : 'image/jpeg') };
    if (slide.imageUrl && this.classroom) {
      const opened = await this.classroom.transport.request(slide.imageUrl, { signal, auth: false, stream: true });
      try {
        if (opened.response.status !== 200 || !opened.response.body) throw new ParserError('IMAGE', '课件图片读取失败');
        const chunks = []; let size = 0;
        for await (const chunk of opened.response.body) { size += chunk.length; if (size > 50 * 1024 * 1024) throw new ParserError('IMAGE', '课件图片超过大小限制'); chunks.push(chunk); }
        return { data: Buffer.concat(chunks), mediaType: opened.response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg' };
      } finally { await opened.response.body.cancel().catch(() => {}); opened.release(); }
    }
    throw new ParserError('IMAGE', '这一页没有可读取的图片');
  }
  async request(stage, route, parts, image, signal, events, key, validate = () => true) {
    const cached = await this.cache.get(key);
    if (cached && validate(cached.raw)) { events.push({ stage, cached: true }); return { text: cached.raw, cached: true }; }
    const response = await this.limiter.run(() => this.llm.call({ stage, route, ...parts, image, signal }), signal);
    events.push({ stage, cached: false, usage: response.usage ?? null });
    return { ...response, cached: false };
  }
  async parse({ slides, subtitles, sourceId = null, context = sourceId ?? 'context', signal, onProgress = () => {} } = {}) {
    if (this.closed) throw new ParserError('DISPOSED', '解析器已关闭');
    validateInput(slides, subtitles);
    const controller = new AbortController(); this.controllers.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const events = [], failures = [], warnings = [], results = new Array(slides.length);
    const progress = { faithful: 0, mix: 0, tags: 0 };
    let cursor = 0;
    // 词表状态提到 try 外面：取消路径上也要能把它写回（见 catch）。
    const addedVocabulary = new Set();
    let vocabulary = null;
    try {
      combined.throwIfAborted();
      warnings.push(...this.accelIssues);
      // 种子**先加载**再开跑：它决定提示词里注入的清单，也决定所有分卷共享的
      // 那一份快照（词表在解析中途变化过，就是这个包最怕的静默不一致）。
      const seeded = await this.loadVocabulary(warnings);
      const anchored = anchor(slides, subtitles); warnings.push(...anchored.warnings);
      // No slides still preserves every subtitle without an unnecessary model call.
      const routes = slides.length ? await this.llm.resolve(combined) : null;
      const work = async () => {
        while (cursor < slides.length) {
          combined.throwIfAborted();
          const start = cursor; cursor += this.visionBatchSize;
          const group = slides.slice(start, start + this.visionBatchSize);
          const transcriptions = await transcribeSlides(this, group, routes.vision, context, combined, events, warnings);
          for (const _ of group) onProgress({ phase: 'faithful', done: ++progress.faithful, total: slides.length });
          await Promise.all(group.map(async (slide, offset) => {
            combined.throwIfAborted();
            const i = start + offset, window = anchored.windows[i];
            const { transcription, imageFailure } = transcriptions[offset];
            let mixed;
            if (imageFailure) failures.push({ page: slide.page, stage: 'faithful', code: imageFailure });
            const terms = glossary([{ page: slide.page, ...(transcription ?? { pageText: '', listedTerms: '' }) }], 1, false).terms.map(t => t.text);
            const parts = mixRequest({ page: slide.page, lines: window.lines, fromMs: window.fromMs, toMs: window.toMs, faithfulText: transcription?.raw ?? '', terms, context });
            const key = this.cache.key('mix', [routes.text, parts, window.lines.map(l => [l.startMs, l.endMs, l.text])]);
            let mixedRaw = '', mixFailure = null;
            try {
              // Successful old-policy answers are also valid candidates under
              // the relaxed policy. Revalidate before migrating; never reuse an
              // incomplete answer or invalidate unrelated successful pages.
              const cached = await this.cache.get(key) ?? await this.cache.get(this.cache.key('mix',
                [routes.text, { ...parts, constant: templates.mix }, window.lines.map(l => [l.startMs, l.endMs, l.text])]));
              const cachedAssembly = cached?.raw?.trim() ? assemblePage(window.lines, slide.page, cached.raw) : null;
              if (cachedAssembly && !cachedAssembly.rejected.length && cachedAssembly.coverage.ok) {
                events.push({ stage: 'mix', cached: true }); mixedRaw = cached.raw;
                if (cached.key !== key) await this.cache.put(key, cached.raw);
              } else {
                const send = variable => this.limiter.run(() => this.llm.call({ stage: 'mix', route: routes.text, constant: parts.constant, variable, signal: combined }), combined);
                const first = await send(parts.variable);
                events.push({ stage: 'mix', cached: false, usage: first.usage ?? null });
                mixedRaw = first.text;
                let current = assemblePage(window.lines, slide.page, mixedRaw);
                let previous = null;
                // 纠错被拒与块覆盖违规在**同一个循环**里收敛：它们用的是同一份回包，
                // 分开重试会互相覆盖对方的修正。轮数硬有界 —— 块边界是模型的**判断**，
                // 反复问只会得到同样的划分；到顶后由覆盖兜底成「整页一块」，一句不丢。
                for (let round = 1; round <= maxMixParseRounds && (current.rejected.length || !current.coverage.ok); round++) {
                  const signature = hash([current.rejected, current.drafts]);
                  if (signature === previous) break; previous = signature;
                  const hints = [correctionRetryHint(current.rejected, round), coverageRetryHint(current.coverage, window.lines.length, round)].filter(Boolean);
                  let response;
                  // 重试同样保持「常量在前、变量在后」，否则这一轮的请求前缀与上一轮不同，缓存白费。
                  try { response = await send(`${parts.variable}\n\n──────────────────────────────────────────────\n${hints.join('\n\n')}`); }
                  catch (error) { if (combined.aborted) throw error; mixFailure = error.code ?? 'LLM_FAILED'; break; }
                  events.push({ stage: 'mix', cached: false, retry: round, usage: response.usage ?? null });
                  mixedRaw = response.text;
                  current = assemblePage(window.lines, slide.page, mixedRaw);
                }
                // ★ 只有**收敛**的回包才进缓存：未收敛的页不固化，否则用户点
                //   「重新整理」时那一页会命中缓存、永远修不好（理由见迁移文档）。
                if (!current.rejected.length && current.coverage.ok) await this.cache.put(key, mixedRaw);
              }
            } catch (error) {
              if (combined.aborted || error.code === 'CANCELLED') throw error;
              mixFailure = error.code ?? 'LLM_FAILED';
            }
            mixed = assemblePage(window.lines, slide.page, mixedRaw);
            if (!mixed.coverage.ok) {
              // 覆盖违规 → 用兜底块保住这一页的每一句（宁可「整页一块、未打标」，也不静默丢句）。
              mixFailure ??= 'BLOCK_COVERAGE';
              mixed.drafts = parseBlockDrafts('', mixed.sentences.length, mixed.bridges);
              mixed.coverage = coverage(mixed.drafts, window.lines.length);
              warnings.push(`第 ${slide.page} 页块覆盖失败，已回退为整页一块`);
            }
            if (mixed.rejected.length || !mixed.coverage.ok || mixFailure) {
              mixFailure ??= 'MIX_INCOMPLETE';
              failures.push({ page: slide.page, stage: 'mix', code: mixFailure });
            }
            results[i] = { page: slide.page, createdSec: slide.createdSec ?? null, fromMs: window.fromMs, toMs: window.toMs,
              transcription, gate: pageGate(transcription), ...mixed, raw: mixedRaw, failure: mixFailure ?? imageFailure };
            onProgress({ phase: 'mix', done: ++progress.mix, total: slides.length });
          }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.ceil(slides.length / this.visionBatchSize)) }, work));
      let sentences = [], blocks = [];
      for (const page of results) {
        const offset = sentences.length; sentences.push(...page.sentences);
        for (const draft of page.drafts) {
          const selected = page.sentences.slice(draft.sentenceFrom - 1, draft.sentenceTo);
          if (selected.length) blocks.push(blockOf(selected, offset + draft.sentenceFrom, offset + draft.sentenceTo, draft.bridge, page.page));
        }
      }
      // ★ 未落到任何一页上的字幕**不造块**：它们是老师真说过的话，所以进句子层
      //   （原样保留、不清洗 —— 没有图可以对照纠错）；但它们不属于任何页，
      //   所以进不了块层与标注。与 App 的 `unassignedSentences` 同口径。
      const unassignedSentences = anchored.unassigned.map(line => ({
        startMs: line.startMs, endMs: line.endMs, page: line.page ?? null, text: line.text, correctionDistance: 0,
      }));
      blocks = stitch(blocks);
      vocabulary = structuredClone(seeded);
      const tagFailures = [];
      if (blocks.length && routes) {
        const chunks = chunkBlocks(blocks);
        // 词表快照在开跑前取一次：同一节的所有卷必须从**同一份**清单里选，
        // 否则各卷会各自长出新同义词 —— 而词表是 filter 有稳定键的全部依据。
        const snapshot = structuredClone(vocabulary);
        const sendChunk = async (chunkIndex, attempt) => {
          const chunk = chunks[chunkIndex];
          const parts = tagRequest(chunk, snapshot, context, blocks.length);
          const key = this.cache.key('tags', [routes.text, parts]);
          const valid = raw => {
            const p = parseTags(raw, structuredClone(snapshot)); const indices = p?.tags.map(t => t.index) ?? [];
            return indices.length === chunk.length && new Set(indices).size === chunk.length && chunk.every(b => p.tags.some(t => t.index === b.index && t.role !== null && t.facets !== null && t.summary));
          };
          const cached = await this.cache.get(key);
          if (cached && valid(cached.raw)) {
            events.push({ stage: 'tags', cached: true });
            return { chunkIndex, parsed: parseTags(cached.raw, structuredClone(snapshot)), failure: null };
          }
          const variable = parts.variable + (attempt > 0 ? '\n答题卡不完整，请为本卷每块给出角色、类型数组及概述，块序号必须与材料一致。' : '');
          const response = await this.limiter.run(() => this.llm.call({ stage: 'tags', route: routes.text, constant: parts.constant, variable, signal: combined }), combined);
          events.push({ stage: 'tags', cached: false, usage: response.usage ?? null, ...(attempt > 0 ? { retry: attempt } : {}) });
          const parsed = parseTags(response.text, structuredClone(snapshot));
          if (!valid(response.text)) return { chunkIndex, parsed, failure: 'TAG_COVERAGE' };
          await this.cache.put(key, response.text);
          return { chunkIndex, parsed, failure: null };
        };
        const settled = (chunkIndex, attempt) => sendChunk(chunkIndex, attempt)
          .catch(error => { if (combined.aborted) throw error; return { chunkIndex, parsed: null, failure: error.code ?? 'LLM_FAILED' }; })
          .then(result => {
            if (attempt === 0) { progress.tags++; onProgress({ phase: 'tags', done: progress.tags, total: chunks.length }); }
            return result;
          });
        // 全部卷**并发**发出（并发上限由闸约束；与 App 的 `Future.wait` 同形）。
        let results = await Promise.all(chunks.map((_, index) => settled(index, 0)));
        // 失败的卷**只补发那几卷**，轮数硬有界 + 轮间退避（重试代价随失败数缩小）。
        for (let round = 1; round <= tagChunkRetryRounds; round++) {
          const failed = results.map((result, index) => (result.failure ? index : -1)).filter(index => index >= 0);
          if (!failed.length) break;
          warnings.push(`第 ${round} 轮补发：${failed.length}/${chunks.length} 卷没成功，正在重发。`);
          await delay(tagChunkRetryDelayMs * round, combined);
          const retried = await Promise.all(failed.map(index => settled(index, round)));
          const byIndex = new Map(retried.map(result => [result.chunkIndex, result]));
          results = results.map((result, index) => byIndex.get(index) ?? result);
        }
        for (const result of results) {
          const chunk = chunks[result.chunkIndex];
          // 成功的卷照常收下（**一题坏只扣那一题**），失败的卷记进结构化诊断。
          if (result.failure) {
            tagFailures.push({
              chunkIndex: result.chunkIndex, blockFrom: chunk[0].index, blockTo: chunk.at(-1).index,
              blockIndexes: chunk.map(b => b.index), code: result.failure,
            });
          }
          for (const tag of result.parsed?.tags ?? []) {
            const block = chunk.find(b => b.index === tag.index); if (!block) continue;
            if (tag.role) block.tag.role = tag.role; if (tag.facets !== null && tag.facets !== undefined) block.tag.facets = tag.facets; if (tag.summary) block.tag.summary = tag.summary;
          }
          for (const term of result.parsed?.vocabulary ?? []) {
            if (vocabulary.some(t => t.name === term.name)) continue;
            vocabulary.push(term); addedVocabulary.add(term.name);
          }
        }
      }
      let spine = '', outline = [], outlineFailure = null;
      const summaries = blocks.map(block => ({ index: block.index, summary: (block.tag.summary ?? '').trim() }));
      if (blocks.length && routes && summaries.some(item => item.summary)) {
        const parts = outlineRequest(blocks, context), key = this.cache.key('outline', [routes.text, parts]);
        const parseOutline = raw => {
          const parsed = parseTags(raw);
          if (!parsed) return null;
          // 越界 / 反向 / 重叠的区间逐条剔除并**如实报出**；剩下的照常给。
          const cleaned = sanitizeOutline(parsed.outline, blocks.length);
          return { spine: parsed.spine, outline: cleaned.outline, warnings: cleaned.warnings };
        };
        try {
          const cached = await this.cache.get(key);
          let parsed = cached ? parseOutline(cached.raw) : null;
          if (parsed) events.push({ stage: 'outline', cached: true });
          else {
            const response = await this.limiter.run(() => this.llm.call({ stage: 'outline', route: routes.text, ...parts, signal: combined }), combined);
            events.push({ stage: 'outline', cached: false, usage: response.usage ?? null });
            parsed = parseOutline(response.text);
            if (!parsed) throw new ParserError('OUTLINE_SHAPE', '整节主线的回包不是能认出来的 JSON');
            await this.cache.put(key, response.text);
          }
          spine = parsed.spine; outline = parsed.outline;
          warnings.push(...parsed.warnings);
        } catch (error) { if (combined.aborted) throw error; outlineFailure = error.code ?? 'LLM_FAILED'; }
      } else if (blocks.length && routes) outlineFailure = 'MISSING_SUMMARIES';
      // 底线：一句都不许丢。块只覆盖**页内**句子，未落页的字幕**单列**保留，
      // 两者相加必须等于输入字幕数（与 App 的句子层 / 块层同一口径）。
      if (sentences.length + unassignedSentences.length !== subtitles.length || !coverage(blocks, sentences.length).ok) {
        throw new ParserError('INVARIANT', '解析产物未覆盖全部输入字幕');
      }
      // 未落页的字幕**没有清洗、也没有标注**（它们不属于任何页），所以有它们就
      // 不是「完整产物」—— 如实记成部分完成，而不是把「没打标」说成「就绪」。
      const partial = failures.length || tagFailures.length || outlineFailure || unassignedSentences.length || blocks.some(b => !b.tag.role);
      // 新增标签在**解析结束后写一次**（不是每卷写一次）：同一节的各卷会各自提名新
      // 标签，逐卷写盘会让词表在解析中途变化 —— 而"同一节所有卷从同一份清单里选"
      // 正是 filter 有稳定键的全部依据。无新增就不写（每次都动盘是白花）。
      await this.saveVocabulary(vocabulary, [...addedVocabulary], warnings);
      const output = { schema: 1, sourceId, status: partial ? 'partial' : 'ready', pages: results, sentences, unassignedSentences, blocks, spine, outline,
        glossary: glossary(results.map(p => ({ page: p.page, ...(p.transcription ?? { pageText: '', listedTerms: '' }) }))), vocabulary,
        failedPages: [...new Set(failures.map(f => f.page))], failures, tagFailures, outlineFailure, warnings, calls: events, fetchedAt: new Date().toISOString() };
      output.version = hash([sourceId, sentences, unassignedSentences, blocks.map(b => [b.sentenceFrom,b.sentenceTo,b.tag,b.bridge]), spine, outline]);
      onProgress({ phase: 'done', done: slides.length, total: slides.length }); return output;
    } catch (error) {
      controller.abort();
      const cancelled = signal?.aborted || this.closed || error.code === 'CANCELLED';
      // ★ 已经自己长出来的标签**不因为这一节失败就丢掉**：用户重跑往往正是为了
      //   把失败的那几卷补回来，若重跑时这一份（已经付过钱的）新标签没有落盘，
      //   模型下次得重新提名一次，词表也就白长了。
      //   ⚠️ **取消不算失败**：用户按了停，就不该在磁盘上留下他没收下的东西。
      if (!cancelled && vocabulary && addedVocabulary.size) {
        const saveWarnings = [];
        await this.saveVocabulary(vocabulary, [...addedVocabulary], saveWarnings);
        // 解析已经失败了，警告没有产物可以挂 —— 挂到 error 上，仍然**有名字**。
        if (saveWarnings.length) error.details = { ...(error.details ?? {}), vocabularyWarnings: saveWarnings };
      }
      if (cancelled) throw new ParserError('CANCELLED', '解析已取消');
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  async parseClassroom(courseId, subId, options = {}) {
    if (this.closed) throw new ParserError('DISPOSED', '解析器已关闭');
    if (!this.classroom) throw new ParserError('CONFIG', '未接入智云课堂数据源');
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    try {
    const content = await this.classroom.getLessonContent(courseId, subId, { ...options, signal });
    signal.throwIfAborted();
    if ((content.slides.meta.complete !== true || content.subtitles.meta.complete !== true) && !options.allowPartialSource) throw new ParserError('PARTIAL_SOURCE', '课件或字幕尚未确认收全，请稍后重试');
    const parsed = await this.parse({ ...options, signal, sourceId: content.sourceId, slides: content.slides.items, subtitles: content.subtitles.items });
    parsed.sourceMeta = { slides: content.slides.meta, subtitles: content.subtitles.meta, processingSuspected: content.slidesProcessingSuspected };
    if (content.slidesProcessingSuspected || content.slides.meta.complete !== true || content.subtitles.meta.complete !== true) { parsed.status = 'partial'; parsed.warnings.push('数据源内容可能仍在处理中'); }
    return parsed;
    } catch (error) {
      if (signal.aborted) throw new ParserError('CANCELLED', '解析已取消');
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  dispose() { this.closed = true; for (const c of this.controllers) c.abort(); this.controllers.clear(); }
}
