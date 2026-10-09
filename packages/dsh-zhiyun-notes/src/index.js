/**
 * **Cordis 插件包装（薄）**：把节笔记领域服务挂到 `ctx.zhiyunNotes`。
 *
 * # 本包不落盘，落盘只有一条路：注入 store
 *
 * 这一层做两件事 —— 拿到一个 store、把 [createSectionNoteService] 建的服务挂上 ctx。
 * 两种拿 store 的方式，优先级从高到低：
 *
 * 1. **`config.store`**（推荐，也是唯一能离线测的）：集成层传进来一个
 *    `{ read(), write(records) }`，或者宿主 domain 的 KV table
 *    （`{ keys(), get(key), put(key,value), delete(key) }` —— `ctx.storageDomain`
 *    的 `KvTable` 正好就是这个形状）。内存实现见
 *    `createMemorySectionNoteStore()`，测试与"先跑起来"都用它。
 * 2. **`ctx.storageDomain`**（宿主存储栈，生产路径）：本包自己
 *    `defineDomain` 声明一个 `zhiyun_notes` 域并 `open` 它。签名是照宿主
 *    0.2.x 的 `lib/types/*.d.ts` 写的（`open(spec) → Domain`、`Domain.table(name) → KvTable`、
 *    `KvTable.get/keys/put/delete`、`Domain.close()`），**不是猜的**；但它在本仓的
 *    离线用例里**没有**被真正跑过（宿主包不在仓库根 node_modules，只能从 profile 里解析）。
 *    所以这条路一旦打不开，本包**抛有名字的 CONFIG 错**并告诉你该传 `config.store`，
 *    而不是静默退化成内存store —— 静默退化等于"笔记本来看还在、重启就没了"。
 *
 * # 为什么不做 `inject: ['storageDomain']`
 *
 * ⚠️ Cordis 的 **真实行为**（拿 `@deepseek-ai/cordis` 跑过，不是读文档推的）：
 * 只要 `storageDomain` 不在本插件的 `inject` 里，读 `ctx.storageDomain`
 * **会直接抛** `cannot get property "storageDomain" without inject` ——
 * 它不是 `undefined`，也没有"有就用、没有就算"的默认。
 * 所以可选宿主服务必须走 `ctx.get('storageDomain')`（返回 `undefined`
 * 表示没挂上，在 `lib/types/reflect.d.ts` 里就是为这件事准备的）。
 *
 * 那为什么不干脆把 `storageDomain` 写进 `inject`？因为声明了就等于
 * "没有宿主存储就不激活"。但节笔记有一半价值（Markdown 与内链
 * **纯函数**、离线可用）跟存储无关：集成层可以直接用 `note.js`，也可以在
 * 有存储时再传 `config.store`。硬依赖会把这条腿砍掉。
 * 所以这里 `inject` 为空数组，明确写着"本插件不要求任何宿主服务"，
 * 需要什么由 `config` 说、由 `ctx.get` 探。
 *
 * @module dsh-zhiyun-notes
 */

import { NoteError } from './errors.js';
import { noteKey } from './note.js';
import { createSectionNoteService } from './store.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'zhiyun-notes';

/**
 * 真正依赖的宿主服务名。
 *
 * ⚠️ **必须**声明 `storageDomain`，这一条是真机验收时改的，理由如下：
 *
 * `storageDomain` 不是挂在本插件所在 ctx 上的普通服务 —— 宿主
 * `dsh-storage-domain` 的 `apply` 是在 `ctx.inject([...backendServices])`
 * 的**子 fiber** 里 `domainCtx.provide('storageDomain', facility)`。
 * Cordis 的 `ctx.get(name)` 只按**本插件的依赖图**解析，所以不声明 inject
 * 时探到的永远是 `undefined`（直读还会抛 `without inject`）——
 * 结果就是：生产 profile 里这个插件每次启动都报 CONFIG 未激活，
 * 而它自己的单测全绿（单测是直接调 `apply` 并注入 config.store 的）。
 *
 * 声明 inject 的代价是「没有宿主存储时不激活」。这是**可接受**的：
 * 纯函数层（note.js 的 key/内链/时间链接）本来就能被集成层直接 import，
 * 不依赖本插件的激活；而需要落盘的那一半，没有存储本来就该如实不激活，
 * 而不是退化成一个「重启就没」的内存假象。
 */
export const inject = ['storageDomain'];

/** 宿主 domain 的名字；要过 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`。 */
export const kNotesDomainName = 'zhiyun_notes';
/** domain 里的表名（同上，必须匹配 `UNIT_NAME_RE`）。 */
export const kNotesTableName = 'notes';
/** domain 格式版本（与 Dart 的 `kSectionNotesSchema` 对齐）。 */
export const kNotesDomainVersion = 1;

/**
 * 笔记记录的宿主 schema。
 *
 * 刻意写得**宽**（字段大半可选、`passthrough`）：宿主 domain 在 `open` 时
 * 会拿它校验**磁盘上已有的每一条**，一旦过严，用户昨天还能打开的笔记
 * 今天会因为一个多出来的字段而整个域打不开（`invalid-record` 会让
 * `open` 直接失败，那是"笔记全没了"级别的后果）。
 * 真正需要收紧的地方（缺 courseId/sectionId）由 [normalizeNote] 在
 * 领域层丢弃单条来处理 —— 坏一条不该拖垮整本。
 * @param {object} z - zod 实例（从宿主同一份依赖里取，避免两份 zod 打架）。
 * @returns {object} schema。
 */
function notesSchema(z) {
  const asset = z.object({
    id: z.string(),
    file: z.string(),
    alt: z.string().optional(),
    page: z.number().optional(),
  }).passthrough();
  return z.object({
    courseId: z.string(),
    sectionId: z.string(),
    title: z.string().optional(),
    markdown: z.string().optional(),
    updatedAt: z.string().optional(),
    assets: z.array(asset).optional(),
    // Dart 的字段名是 `sketches`，领域层对外叫 `sketchIds`（见 note.js）。
    sketches: z.array(z.string()).optional(),
  }).passthrough();
}

/**
 * 用宿主 `ctx.storageDomain` 打开笔记域，返回一个 `{read, write}` store。
 *
 * 域的记录**就是** `{read, write}` 这一层：`read()` 走 `table.keys()/get()`
 * （宿主是内存同步读），`write(records)` 走 `table.put()` + 清理多余键。
 * @param {object} facade - `ctx.storageDomain`。
 * @param {(spec: object) => object} defineDomain - 宿主的域声明助手。
 * @param {(schema: object) => object} domainTable - 宿主的表声明助手。
 * @param {object} z - zod 实例。
 * @returns {Promise<{store: object, close: () => Promise<void>}>} store 与释放句柄。
 */
export async function openNotesDomainStore({ facade, defineDomain, domainTable, z }) {
  const spec = defineDomain({
    name: kNotesDomainName,
    version: kNotesDomainVersion,
    tables: { [kNotesTableName]: domainTable(notesSchema(z)) },
  });
  let domain;
  try {
    domain = await facade.open(spec);
  } catch (error) {
    throw new NoteError('CONFIG', `打开宿主存储域 '${kNotesDomainName}' 失败；`
      + '若这个宿主组合里 storage / storage-domain 没挂上，请改成注入 config.store', {
      domain: kNotesDomainName,
    }, { cause: error });
  }
  return {
    store: { read, write },
    async close() {
      // 域的句柄归本插件释放（宿主文档：caller owns the handle）。
      await domain.close();
    },
  };

  async function read() {
    const table = domain.table(kNotesTableName);
    const notes = [];
    for (const key of table.keys()) {
      const value = table.get(key);
      if (value !== undefined) notes.push(value);
    }
    return { schema: kNotesDomainVersion, notes };
  }

  async function write(records) {
    const table = domain.table(kNotesTableName);
    const wanted = new Map();
    for (const note of records) wanted.set(noteKey(note.courseId, note.sectionId), note);
    // 先写后删：中途失败留下的是"多出来的旧记录"（领域层按 courseId/sectionId
    // 去重后以新记录为准），而不是"新的没写上、旧的也删了"。
    for (const [key, note] of wanted) await table.put(key, note);
    for (const key of [...table.keys()]) {
      if (!wanted.has(key)) await table.delete(key);
    }
  }
}

/**
 * 装载插件。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 插件配置。
 * @param {object} [config.store] - 注入的持久化接缝（优先）。
 * @param {boolean} [config.domain] - 无 `config.store` 时是否尝试宿主 `ctx.storageDomain`（默认 `true`）。
 * @param {() => Date} [config.now] - 时钟注入（测试）。
 * @param {(id: string) => string} [config.nextAssetId] - 附件 id 生成（测试）。
 * @param {object} [config.loadDomainModule] - 覆盖宿主 domain 模块的加载方式（测试用）。
 * @returns {Promise<() => Promise<void>>} 卸载函数。
 */
export async function apply(ctx, config = {}) {
  let owned = null; // 本插件自己开的域（要与注入的 store 区分开：注入的归别人管）
  let backend = config.store ?? null;

  if (backend === null && config.domain !== false) {
    // 声明了 inject 之后，`ctx.storageDomain` 由 Cordis 保证已就绪；
    // 但集成层仍可用 config.store 覆盖（离线与测试走那条）。
    const facade = ctx.storageDomain;
    if (typeof facade?.open !== 'function') {
      throw new NoteError('CONFIG', '本插件需要一个 store：宿主没有可用的 storageDomain，'
        + '请注入 config.store（例如 createMemorySectionNoteStore()，或宿主 domain 的 KV table）', {
        hasStorageDomain: facade !== undefined,
      });
    }
    // 延迟解析：宿主包**只存在于 profile 的 node_modules 链**里
    // （本仓是 `.runtime/dsh-<版本>/…`，用户机器上是 DSH Desktop 的
    // `resources/app/node_modules`），从本包自己的路径 import 一定
    // `ERR_MODULE_NOT_FOUND` —— 真机验收时就是这么炸的。
    //
    // 锚点必须是**宿主给的** `profileContext.dir`：它的 node_modules 链正是
    // 宿主加载插件的同一条链。这段解析逻辑 `dsh-zhiyun-knowledge` 已经有一份
    // 跑通的实现（`src/host.js`），这里复用它而不是再写一遍 ——
    // 两份实现半年内必然漂开。
    let load = config.loadDomainModule;
    if (typeof load !== 'function') {
      // 动态 import（不是顶层）：这条路径只在真的走宿主存储时才需要，
      // 顶层 import 会让离线环境连 note.js 都用不了。
      load = async () => {
        const { loadHostStorage } = await import('dsh-zhiyun-knowledge/host');
        return loadHostStorage(ctx.profileContext?.dir);
      };
    }
    let parts;
    try {
      parts = await load();
    } catch (error) {
      if (error instanceof NoteError) throw error;
      throw new NoteError('CONFIG', '加载宿主存储域模块失败（@deepseek-ai/dsh-storage-domain / zod）；'
        + '离线或宿主未提供该依赖时请注入 config.store', {}, { cause: error });
    }
    const opened = await openNotesDomainStore({ facade, ...parts });
    backend = opened.store;
    owned = opened;
  }

  const service = createSectionNoteService({
    store: backend,
    now: config.now,
    nextAssetId: config.nextAssetId,
  });

  const removeService = ctx.provide('zhiyunNotes', service);

  return async () => {
    // 顺序：先摘服务、再收自己开的东西。
    // 反过来的话，卸载过程中还在飞的调用会拿到已关闭的 store ——
    // 它拿到的是"存储没了"这种没法解释的错，而真正的原因是插件已经卸载。
    if (typeof removeService === 'function') removeService();
    await service.dispose();
    if (owned !== null) await owned.close();
  };
}
