import sharp from 'sharp';
import { faithful, stripFences } from './core.js';
import { faithfulRequest } from './prompts.js';
import { hash } from './cache.js';
import { ParserError } from './errors.js';

// Stay within the native host's default image pixel budget. Oversized groups
// fall back to originals instead of silently shrinking small formulas/text.
const MAX_PIXELS = 4 * 1024 * 1024;
export const collageVersion = 'faithful-collage-v1';

export function collageRequest(context, pages) {
  const positions = ['左上', '右上', '左下', '右下'];
  return {
    constant: faithfulRequest(context, pages[0]).constant,
    variable: `这张拼图包含 ${pages.length} 张独立课件，来自：${context}\n`
      + pages.map((page, i) => `${positions[i]}：原课件第 ${page} 页`).join('\n')
      + '\n按以上顺序逐页完整执行要求，每页独立描述，不跨格补充、引用或合并内容。空白格不处理。'
      + '\n每格顶部的 P页码 是程序添加的定位标签，不属于课件；不得抄入页面文字、页面画面或术语。'
      + '\n每页严格以独占一行的 # 页 N 开头（N 为上述原课件页码），随后分别输出 ## 页面文字、## 页面画面、## 术语，三项都必须出现，无内容写“无”。'
      + '\n不要添加整组总结。只依据各格可见内容转述，读不清的文字说明读不清，不猜测。',
  };
}

export function splitCollage(raw, pages) {
  const text = stripFences(raw), matches = [...text.matchAll(/^# 页 (\d+)\s*$/gm)];
  const expected = new Set(pages), out = new Map(), duplicate = new Set();
  // An unexpected page ID makes the mapping untrustworthy, even if some of
  // the other page IDs happen to be correct.
  if (matches.some(m => !expected.has(Number(m[1])))) return out;
  for (const [i, match] of matches.entries()) {
    const page = Number(match[1]);
    if (out.has(page)) duplicate.add(page);
    const body = text.slice(match.index + match[0].length, matches[i + 1]?.index ?? text.length).trim();
    const parsed = faithful(body);
    if (parsed.pageText && parsed.pageVisual && parsed.listedTerms) out.set(page, parsed);
    else duplicate.add(page);
  }
  for (const page of duplicate) out.delete(page);
  return out;
}

export async function composeSlides(images, signal) {
  const panels = [];
  for (const image of images) {
    signal?.throwIfAborted();
    const { data, info } = await sharp(image.data, { limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer({ resolveWithObject: true });
    panels.push({ data, width: info.width, height: info.height, page: image.page });
  }
  const width = Math.max(...panels.map(p => p.width));
  const height = Math.max(...panels.map(p => p.height)), labelHeight = 40;
  const columns = 2, rows = Math.ceil(panels.length / columns);
  if (width * columns * (height + labelHeight) * rows > MAX_PIXELS) {
    throw new ParserError('COLLAGE_SIZE', '拼图超过宿主像素预算，改用原图');
  }
  const layers = panels.flatMap((p, i) => {
    const left = i % columns * width, top = Math.floor(i / columns) * (height + labelHeight);
    return [
      { input: Buffer.from(`<svg width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="white"/><text x="12" y="29" font-size="24" fill="black">P${p.page}</text></svg>`), left, top },
      { input: p.data, left, top: top + labelHeight },
    ];
  });
  const data = await sharp({ create: { width: width * columns, height: (height + labelHeight) * rows, channels: 3, background: '#ffffff' } }).composite(layers).removeAlpha().png().toBuffer();
  signal?.throwIfAborted();
  return { data, mediaType: 'image/png' };
}

/** A bounded group keeps both source image memory and request concurrency bounded.
 * Return one result per input page; a damaged image never poisons its neighbors.
 */
export async function transcribeSlides(parser, slides, route, context, signal, events, warnings) {
  const results = new Array(slides.length), pending = [];
  const recordFailure = (index, error) => { results[index] = { transcription: null, imageFailure: error.code ?? 'IMAGE' }; };
  const cancelled = error => { if (signal.aborted || error.code === 'CANCELLED') throw error; };
  for (const [index, slide] of slides.entries()) {
    signal.throwIfAborted();
    try {
      const image = await parser.bytes(slide, signal);
      signal.throwIfAborted();
      const parts = faithfulRequest(context, slide.page);
      const singleKey = parser.cache.key('faithful', [route, hash(image.data), parts]);
      const batchKey = parser.cache.key(collageVersion, [route, hash(image.data), parts]);
      // Preserve already-paid single-page work. Batch results have a separate
      // namespace, so a single-page rollback cannot reuse collage descriptions.
      const single = await parser.cache.get(singleKey);
      const batch = parser.visionBatchSize > 1 ? await parser.cache.get(batchKey) : null;
      const batchParsed = batch?.raw ? faithful(batch.raw) : null;
      const cached = single?.raw?.trim() ? single : batchParsed?.pageText && batchParsed.pageVisual && batchParsed.listedTerms ? batch : null;
      if (cached) {
        results[index] = { transcription: faithful(cached.raw), imageFailure: null };
        events.push({ stage: 'faithful', cached: true, pages: [slide.page], mode: cached === single ? 'single' : 'collage' });
      } else pending.push({ index, page: slide.page, ...image, parts, singleKey, batchKey });
    } catch (error) { cancelled(error); recordFailure(index, error); }
  }
  let remaining = pending;
  if (pending.length > 1) {
    const pages = pending.map(p => p.page);
    try {
      const collage = await composeSlides(pending, signal);
      const attachment = await parser.llm.image(collage.data, collage.mediaType, `pages-${pages.join('-')}.png`);
      const parts = collageRequest(context, pages);
      const response = await parser.limiter.run(() => parser.llm.call({ stage: 'faithful', route, ...parts, image: attachment, signal }), signal);
      events.push({ stage: 'faithful', cached: false, mode: 'collage', pages, usage: response.usage ?? null });
      signal.throwIfAborted();
      const parsed = splitCollage(response.text, pages);
      remaining = [];
      for (const item of pending) {
        const transcription = parsed.get(item.page);
        if (transcription) {
          await parser.cache.put(item.batchKey, transcription.raw);
          results[item.index] = { transcription, imageFailure: null };
        } else remaining.push(item);
      }
      if (remaining.length) warnings.push(`拼图转述缺少完整页面 ${remaining.map(p => p.page).join('、')}，已改用单图补发`);
    } catch (error) {
      cancelled(error);
      // Keep successful pages if a later page's cache write failed.
      remaining = pending.filter(item => !results[item.index]);
      warnings.push(`第 ${pages.join('、')} 页拼图转述失败（${error.code ?? 'IMAGE'}），已改用单图补发`);
      events.push({ stage: 'faithful', cached: false, mode: 'collage', pages, failure: error.code ?? 'IMAGE' });
    }
  }
  for (const item of remaining) {
    signal.throwIfAborted();
    try {
      const attachment = await parser.llm.image(item.data, item.mediaType, `page-${item.page}`);
      const response = await parser.request('faithful', route, item.parts, attachment, signal, events, item.singleKey);
      const transcription = faithful(response.text);
      if (!transcription.raw) throw new ParserError('EMPTY_RESPONSE', '页面转述为空');
      signal.throwIfAborted();
      await parser.cache.put(item.singleKey, transcription.raw);
      results[item.index] = { transcription, imageFailure: null };
    } catch (error) { cancelled(error); recordFailure(item.index, error); }
  }
  return results;
}
