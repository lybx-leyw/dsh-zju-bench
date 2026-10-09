import path from 'node:path';
import { LectureParser, HarnessLlm, ParserCache } from './parser.js';
import { createJsonFileVocabularyStore } from './vocabulary.js';
export const name = 'zhiyun-parser';
export const inject = ['llm', 'attachments', 'agentDefaultModel', 'profileContext', 'zhiyunClassroom'];
export async function apply(ctx, config = {}) {
  const llm = new HarnessLlm({ llm: ctx.llm, attachments: ctx.attachments,
    selection: () => ctx.agentDefaultModel.currentSelection(), routes: { vision: config.vision, text: config.text }, timeoutMs: config.timeoutMs,
    // 加速档位在适配器里落点：它是**请求形状**的一部分，和消息构造同源才好审。
    accel: config.accel });
  // 词表落到 profile 目录是**集成层的决定**，包内只提供接口：解析器不认识路径。
  // 已有 store 实例（程序化挂载、别的持久化后端）时优先用它。
  const injected = config.vocabularyStore;
  const vocabularyStore = injected && typeof injected.load === 'function' && typeof injected.save === 'function'
    ? injected
    : createJsonFileVocabularyStore({ file: path.join(ctx.profileContext.dir, 'data/zhiyun-parser/vocabulary.json') });
  const parser = new LectureParser({ llm, concurrency: config.concurrency ?? 3, classroom: ctx.zhiyunClassroom, vocabularyStore,
    visionBatchSize: config.visionBatchSize ?? 4,
    cache: new ParserCache(path.join(ctx.profileContext.dir, 'data/zhiyun-parser/cache')) });
  ctx.provide('zhiyunParser', parser);
  return () => parser.dispose();
}
