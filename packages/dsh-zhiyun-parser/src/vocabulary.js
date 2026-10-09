import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { templates } from './core.js';
import { ParserError } from './errors.js';

/**
 * 动态词表：**种子不可删**的标签清单 + 它的可注入落盘口子。
 *
 * # 为什么落盘不在这里实现
 *
 * 解析器包对宿主是零依赖的（模型走注入的 llm、图片走注入的 image），词表同理：
 * 这里只定义「读一次 / 写一次」的最小接口和内存实现，具体落到 profile 目录、
 * 设置还是宿主存储由集成层决定 —— 包内一旦自己猜路径，同一条词表就有了两个真源，
 * 而两个真源的分叉是**静默**的（内存里加了、盘上没有）。
 *
 * # 为什么 load() 允许交出「坏的 / 半截的」数据
 *
 * 词表坏掉不该让整节解析失败 —— 已经产出的块仍带着各自的标签名。所以这一层
 * 不抛异常，而是**如实报出哪一条坏了**：调用方把原因同时写进 warnings 与
 * `loadIssues`，而不是把它悄悄当成「这次没有新增词」（后者会让用户永远查不出
 * 为什么词表停止生长）。
 */

/** 种子词表（来自 Dart 导出的冻结契约，永远在词表里）。 */
export function seedVocabulary() {
  return templates.vocabulary.map(term => ({ name: term.name, aliases: [...(term.aliases ?? [])] }));
}

/**
 * 归一词表的任意持久化形态（`null` / JSON 文本 / `{terms}` / 数组）。
 *
 * 坏数据**不抛**：逐条跳过并记进 `issues`，同时把缺失的种子补回来。
 * 种子项永远在（与 Dart `TagVocabulary.fromJson` 同口径）—— 文件被手删或被旧
 * 版本覆盖也要补回来，否则「内置项不可删」这条硬约束会在运行时静默失效。
 *
 * @returns {{vocabulary: Array<{name: string, aliases: string[]}>, issues: string[]}}
 */
export function normalizeVocabulary(value) {
  const issues = [];
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch (error) { return { vocabulary: seedVocabulary(), issues: [`词表不是合法 JSON（${error.message}），已退回种子词表`] }; }
  }
  if (raw === null || raw === undefined) return { vocabulary: seedVocabulary(), issues };
  const rawTerms = Array.isArray(raw) ? raw : Array.isArray(raw.terms) ? raw.terms : null;
  if (!rawTerms) return { vocabulary: seedVocabulary(), issues: ['词表里没有 terms 列表，已退回种子词表'] };
  const terms = [];
  for (const [index, item] of rawTerms.entries()) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name) { issues.push(`词表第 ${index + 1} 项没有可用的 name，已跳过`); continue; }
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.filter(alias => typeof alias === 'string' && alias.trim()).map(alias => alias.trim())
      : [];
    terms.push({ name, aliases });
  }
  const missing = seedVocabulary().filter(seed => !terms.some(term => term.name === seed.name));
  if (missing.length) issues.push(`词表里少了 ${missing.length} 个种子项（${missing.map(term => term.name).join('、')}），已补回`);
  terms.unshift(...missing);
  return { vocabulary: terms, issues };
}

/** 加载失败的原因文案（**只有这一处**：门面记录与解析器警告共用同一句，才去得掉重）。 */
export function vocabularyLoadFailure(error) {
  return `词表加载失败（${error?.code ?? error?.name ?? 'ERROR'}：${error?.message ?? error}）`;
}

/**
 * 把宿主实现的 `{ load, save }` 包成解析器用的 store 形态。
 *
 * `loadIssues` 是一个只读视图：宿主自己报的问题（store 自带的 `loadIssues`）
 * 与本层观察到的问题（load 抛错、坏数据）合在一起，**顺序稳定** ——
 * 调用方可以按长度差取出「这一次解析新产生的原因」，而不必自己解析字符串。
 * 解析器不认识这个门面也能工作（它自己也归一一次），只是少了这条记录通道。
 */
export function createVocabularyStore(store = {}) {
  const { load, save } = store;
  if (typeof load !== 'function' || typeof save !== 'function') throw new ParserError('CONFIG', '词表 store 需要 load() 与 save()');
  const observed = [];
  const facade = {
    ...store,
    async load() {
      let value;
      try { value = await load(); }
      catch (error) {
        observed.push(vocabularyLoadFailure(error));
        throw error;
      }
      // 归一放在门面里、解析器里各做一次：幂等，且宿主自己写的 store 不走门面时
      // 解析器那一遍仍然兜得住（坏数据不会漏进提示词）。
      const { vocabulary, issues } = normalizeVocabulary(value);
      observed.push(...issues);
      return vocabulary;
    },
    save: value => save(value),
  };
  Object.defineProperty(facade, 'loadIssues', {
    enumerable: true,
    get: () => [...(Array.isArray(store.loadIssues) ? store.loadIssues : []), ...observed],
  });
  return facade;
}

/** 没有 `loadIssues` 通道的 store 也要能被观察到加载问题（否则只能静默）。 */
export function ensureVocabularyStore(store) {
  if (store === undefined || store === null) return null;
  return typeof store.loadIssues !== 'undefined' ? store : createVocabularyStore(store);
}

/** 内存词表（测试与「不落盘也能跑」的默认）。 */
export function createMemoryVocabularyStore(initial = null) {
  const { vocabulary: seed, issues } = normalizeVocabulary(initial);
  let saved = seed;
  let saves = 0;
  const store = createVocabularyStore({
    load: async () => saved,
    save: async vocabulary => { saved = vocabulary; saves++; },
    loadIssues: issues,
  });
  Object.defineProperty(store, 'vocabulary', { enumerable: true, get: () => saved });
  Object.defineProperty(store, 'saves', { enumerable: true, get: () => saves });
  return store;
}

/**
 * JSON 文件词表（`<profile>/data/zhiyun-parser/vocabulary.json`）。
 *
 * 落盘**不自己写 tmp+rename**：宿主的 `dsh-atomic-write` 已经处理了 Windows 上
 * rename 的瞬态 EACCES/EBUSY/EPERM 重试，手写一份只会得到更脆的副本。
 * 它是「集成层的示例实现」——宿主换成 `ctx.storage` 时只要满足同一个接口。
 *
 * `readFile` / `writeFile` 可注入（测试不碰磁盘，也不必伪造整个文件系统）。
 */
export function createJsonFileVocabularyStore({ file, readFile: read = defaultRead, writeFile: write = defaultWrite } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new ParserError('CONFIG', '词表文件 store 需要文件路径');
  return createVocabularyStore({
    async load() {
      try { return await read(file); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
    async save(terms) {
      await write(file, JSON.stringify({ v: 1, kind: 'tag_vocabulary', terms }, null, 2));
    },
  });
}

const defaultRead = path => readFile(path, 'utf8');
const defaultWrite = (path, text) => writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 });
