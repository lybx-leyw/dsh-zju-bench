import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../../../scripts/profile.mjs';
import * as parserPlugin from '../../../packages/dsh-zhiyun-parser/src/index.js';

// A deterministic adapter inside the actual DSH runtime; never a provider HTTP client.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64');
export const lesson = () => ({ sourceId: 'fixture:lesson', context: 'context',
  slides: [{ page: 1, createdSec: 1, imageBytes: png, mediaType: 'image/png' }],
  subtitles: [{ startMs: 1234, endMs: 2000, text: '旧事史' }, { startMs: 2200, endMs: 3100, text: '概率密度函数' }] });
export function answer(options) {
  const constant = options.messages[0].content[0].text;
  const variable = options.messages[0].content[1].text;
  if (constant.includes('完整转述') && options.messages[0].content.some(b => b.type === 'image')) return '## 页面文字\n旧四史，概率密度函数\n## 页面画面\n一张曲线图\n## 术语\n旧四史\n概率密度函数';
  if (constant.includes('逐块语音稿清洗器')) return '## 逐块标注\n1. 正文：旧四史\n块 1-2';
  if (constant.includes('维度标注')) {
    const indices = [...variable.matchAll(/^### 块 (\d+)/gm)].map(m => +m[1]);
    return JSON.stringify({ tags: indices.map(index => ({ index, role: '主线', facets: ['概念'], summary: '概率密度函数' })) });
  }
  const count = +variable.match(/共 (\d+) 块/)?.[1];
  return JSON.stringify({ spine: '概率密度函数的概念', outline: [{ title: '概念', from: 1, to: count }] });
}
export async function mountHost(version, directory, respond = answer, { modalities = ['text', 'image'] } = {}) {
  const modules = path.join(root, '.runtime', `dsh-${version}`, 'node_modules', '@deepseek-ai');
  const load = name => import(pathToFileURL(path.join(modules, name, 'lib/index.js')).href);
  const [{ Context }, { default: LlmRuntime, LlmAdapter }, { default: Attachments }] = await Promise.all([load('cordis'), load('dsh-llm'), load('dsh-attachment-local')]);
  const ctx = new Context(), requests = [];
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Attachments, { dshHome: directory });
    class Adapter extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: modalities }; }
      async *stream(options) {
        requests.push(options); options.signal?.throwIfAborted();
        const result = await respond(options, requests.length);
        if (result?.chunks) { yield* result.chunks; return; }
        yield { type: 'text-delta', index: 0, text: result };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['fixture-provider'], new Adapter());
    ctx.provide('profileContext', { dir: directory });
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' }) });
    ctx.provide('zhiyunClassroom', {});
    const fiber = await ctx.plugin(parserPlugin);
    return { ctx, parser: ctx.get('zhiyunParser'), requests, fiber, dispose: () => ctx.fiber.dispose() };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
