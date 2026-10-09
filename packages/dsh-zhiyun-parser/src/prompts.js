import { templates, formatMs } from './core.js';
import { correctionPrompt } from './correction-policy.js';
export function faithfulRequest(context, page) {
  return { constant: templates.faithful, variable: `这张图来自课件：${context}\n这是第 ${page} 页。\n\n请**只根据这张图本身**完成上面要求的完整转述。\n图片之外的信息（老师说了什么、前后页讲了什么）一律**不在你手上**，也不许推测。` };
}
export function mixRequest({ page, lines, fromMs, toMs, faithfulText = '', terms = [], context = 'context' }) {
  const v = [`这张图来自课件：${context}`];
  if (page != null) v.push(`这是第 ${page} 页。`);
  if (fromMs != null) v.push(`这一页对应老师从 ${formatMs(fromMs)}${toMs == null ? '' : ` 到 ${formatMs(toMs)}`} 的讲解。`);
  if (faithfulText.trim()) v.push('', '──────────────────────────────────────────────', '【这一页的如实转述稿（图上写了什么，逐字抄录 —— "正确写法"的唯一来源）】', faithfulText.trim());
  if (terms.length) v.push('', '──────────────────────────────────────────────', '【术语表（这一页图上抄下的专名。只许用表里的写法改正对应的错字；不许改句子、不许润色、不许把表外的词改成表里的词）】', ...terms.filter(t => t.trim()).map(t => `- ${t.trim()}`));
  v.push('', '──────────────────────────────────────────────', '【老师这段的语音转录（逐条编号；原样，可能有错字）】');
  if (lines.length) v.push(...lines.map((l,i) => `${i+1}. [${formatMs(l.startMs)}]${l.text}`));
  else v.push('（这段没有语音转录：翻页太快，或这一段是静音）');
  return { constant: correctionPrompt(templates.mix), variable: v.join('\n') };
}
export function renderBlock(block) {
  let head = `### 块 ${block.index}`;
  if (block.page != null) head += `（第 ${block.page} 页`;
  if (block.startMs != null) head += `${head.endsWith('页') ? '｜' : '（'}老师时间 ${formatMs(block.startMs)}${block.endMs == null ? '' : `–${formatMs(block.endMs)}`}`;
  if (block.page != null || block.startMs != null) head += '）';
  const lines = [head]; if (block.bridge.trim()) lines.push(`（这一块已补写的衔接：${block.bridge.trim()}）`);
  lines.push(block.sentences.map(s => s.text).join('\n').trim()); return lines;
}
export function chunkBlocks(blocks, size = 24, maxChars = 50000) {
  const chunks = []; let chunk = [], chars = 0;
  for (const block of blocks) {
    const n = renderBlock(block).join('\n').length;
    if (chunk.length && (chunk.length >= size || chars + n > maxChars)) { chunks.push(chunk); chunk = []; chars = 0; }
    chunk.push(block); chars += n;
  }
  if (chunk.length) chunks.push(chunk); return chunks;
}
export function tagRequest(blocks, vocabulary, context, total) {
  return { constant: templates.chunk.replace('@@VOCAB@@', vocabulary.map(t => t.name).join('、')),
    variable: [`【这节课的课件】${context}`, `（整节课共 ${total} 块；这里是其中 ${blocks.length} 块。）`, `【这一卷的块（共 ${blocks.length} 块）】`, ...blocks.flatMap(b => ['', ...renderBlock(b)])].join('\n') };
}
export function outlineRequest(blocks, context) {
  return { constant: templates.outline, variable: [`【这节课】${context}`, `【每块的概述（共 ${blocks.length} 块，按时间顺序）】`, ...blocks.map(b => `${b.index}. ${b.tag.summary?.trim() || '（这一块没有概述）'}`)].join('\n') };
}
