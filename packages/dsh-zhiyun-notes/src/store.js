/**
 * 节笔记的**领域服务**：笔记与附件的读写语义。
 *
 * # 这个文件里唯一重要的一句话
 *
 * **落盘不出现在本包的任何一行里。** 持久化只经由一个注入的窄接口
 * `{ read, write }`（见 [createSectionNoteService] 的 `store` 参数），
 * 由集成层用宿主存储栈实现（`ctx.storage` / `ctx.storageDomain`）。
 * 本包不 `import node:fs`、不写文件、也不读环境变量 —— 有测试钉住这一点。
 *
 * 为什么这么切：Dart 侧的 `SectionNoteStore` 直接 `dart:io` 读写
 * `section_notes.json`，那是因为它自己就是 App 的持久层。搬到 DSH 上，
 * 「文件在哪、怎么原子写」是宿主已经解决的问题（`ctx.storage` /
 * `dsh-atomic-write`），在包里再写一遍就是本仓明令禁止的重复造轮子，
 * 而且会得到一份更脆的副本（Windows 上 rename 的瞬态失败要重试，
 * 宿主那边已经处理过了）。
 *
 * # 读失败与写失败的两种态度
 *
 * - **读**：store 抛错 → 原样往上抛成 [NoteError] `LOAD`。
 *   「读不出来」与「没有笔记」在用户眼里是两件事：前者必须让他看见，
 *   后者可以静默给空。Dart 的 `_readIndex` 对**坏 JSON** 选择当空表
 *  （还特意写了测试保证不删原文件）—— 这里把那条口径留给 store：
 *   store 若判定内容不可用，就返回 `[]`；store 若判定是 I/O 故障，
 *   就抛。本包只负责**不把异常吞掉**。
 * - **写**：先落盘、**成功了**才改内存。反过来的话，写失败后内存里
 *   留着一条永远不会出现在磁盘上的笔记，界面显示"已保存"，
 *   重启就没了 —— 那是最坏的一种错。代价是写失败时列表看起来"没反应"，
 *   这是**有意的**：如实失败胜过撒谎成功。
 *
 * # 附件与笔记分开放（对照 Dart 的真实语义）
 *
 * Dart 里 `SectionNote.assets` 是**笔记记录的字段**（`section_notes.json`），
 * 而图片**字节**落在 `note_assets/<id>.<ext>` 目录里 —— 两者从一开始就是
 * 分开的。所以：
 * - [SectionNoteService.remove] 删笔记时，**附件字节原样保留**。
 *   这正是 Dart 的行为：`_writeIndex` 只重写索引，从不删 `note_assets/` 下的文件
 *   （`addAsset` 之外的任何路径都没有删除动作，`assetFile()` 只是在索引里找）。
 *   附件成了孤儿，但不丢 —— 用户导出旧 markdown 时还找得回来。
 *   真要清理由调用方决定，本包不替它做主。
 * - [SectionNoteService.remove] **不**级联删草稿（`sketchIds`），同理。
 * - [SectionNoteService.removeAsset] 是**本包多给的一个动作**（Dart 没有）：
 *   只摘记录、同样不碰字节。既然加了，就得说清楚它是"摘引用"而不是"删文件"。
 *
 * @module dsh-zhiyun-notes/store
 */

import { NoteError } from './errors.js';
import {
  emptyNote,
  hasContent,
  isUsableId,
  kSectionNotesSchema,
  normalizeNote,
  noteKey,
  noteToJson,
  rewriteForExport,
} from './note.js';

/**
 * 一个**内存** store（测试默认，也是"不落盘也能跑"的兜底）。
 *
 * 它的存在是为了让 `index.js` 在集成层还没接上宿主存储时也能起得来 ——
 * 而不是为了在包里偷偷持久化。
 * @returns {{read: () => Promise<object>, write: (records: object[]) => Promise<void>, writes: number, records: object[]}} store。
 */
export function createMemorySectionNoteStore() {
  let records = [];
  let writes = 0;
  const store = {
    async read() {
      return { schema: kSectionNotesSchema, notes: records };
    },
    async write(next) {
      writes += 1;
      // 存快照而不是引用：调用方之后还持有自己的数组，别让两边共享同一份可变状态。
      records = next.map((note) => structuredClone(note));
    },
    get writes() {
      return writes;
    },
    get records() {
      return records;
    },
  };
  return store;
}

/**
 * 按记录的 store 适配成 `{read, write}`。
 *
 * 集成层若已经在用 `ctx.storageDomain`（宿主 domain 的 `KvTable` 就是
 * `get/put/delete/entries/keys/size` 这套形状），可以直接把这个 `table`
 * 传进来，不必再写一层胶水；想自己注入也只实现这两个方法即可。
 *
 * 记录键用 [noteKey]（`courseId/sectionId`）—— 与 Dart 的索引键同一个，
 * 这样「两边同一节」不会算成两条。
 * @param {{keys: () => Iterable<string>, get: (key: string) => object|undefined, put: (key: string, value: object) => Promise<void>, delete: (key: string) => Promise<boolean>}} table - 按记录的 KV。
 * @returns {{read: () => Promise<object>, write: (records: object[]) => Promise<void>}} store。
 */
export function createTableSectionNoteStore(table) {
  if (table === null || typeof table !== 'object'
    || typeof table.get !== 'function' || typeof table.put !== 'function'
    || typeof table.keys !== 'function') {
    throw new NoteError('CONFIG', '按记录的 store 需要 { keys(), get(key), put(key, value) }', { got: typeof table });
  }
  return {
    async read() {
      const notes = [];
      for (const key of table.keys()) {
        const value = table.get(key);
        if (value !== undefined) notes.push(value);
      }
      return { schema: kSectionNotesSchema, notes };
    },
    async write(records) {
      const wanted = new Map();
      for (const note of records) wanted.set(noteKey(note.courseId, note.sectionId), note);
      // 先写后删：中途失败时磁盘上会是"新旧都在"（读者的规范化会以新记录为准，
      // 因为 write 传的是**全量**列表），而不会出现"旧的没了、新的也没写上"。
      for (const [key, note] of wanted) await table.put(key, note);
      for (const key of [...table.keys()]) {
        if (!wanted.has(key) && typeof table.delete === 'function') await table.delete(key);
      }
    },
  };
}

/** 把两种 store 形状（`{read,write}` 或按记录的 table）统一成 `{read,write}`。 */
function adaptStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new NoteError('CONFIG', '节笔记需要一个注入的 store：{ read(), write(records) } 或按记录的 KV table', { got: typeof store });
  }
  if (typeof store.read === 'function' && typeof store.write === 'function') return store;
  if (typeof store.get === 'function' && typeof store.put === 'function') return createTableSectionNoteStore(store);
  // 宿主 domain 的域对象（`ctx.storageDomain.open()` 的返回值）也认：它自己带 table()。
  if (typeof store.table === 'function') return createTableSectionNoteStore(store.table('notes'));
  throw new NoteError('CONFIG', 'store 既不是 { read(), write(records) } 也不是 { get, put, keys } 的 KV table', {
    keys: Object.keys(store).slice(0, 12),
  });
}

/** 从 store 读出来的东西里取出记录数组（Dart 兼容 `{notes:[…]}` 与裸数组两种）。 */
function recordsFrom(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.notes)) return raw.notes;
  // 读到了别的东西 = 介质坏了。这**不是**"还没有笔记"，所以不返回空表。
  throw new NoteError('LOAD', 'store 读出来的既不是数组也不是 { notes: [...] }', { got: raw === null ? 'null' : typeof raw });
}

/**
 * 建一个节笔记领域服务。
 *
 * @param {object} options - 配置。
 * @param {object} options.store - 注入的持久化接缝（`{read,write}` 或按记录的 KV）。
 * @param {() => Date} [options.now] - 取"现在"的方式，测试可注入固定时钟。
 * @param {(id: string) => string} [options.nextAssetId] - 附件 id 生成（默认按时间戳，见下）。
 * @returns {object} 服务。
 */
export function createSectionNoteService({ store, now = () => new Date(), nextAssetId } = {}) {
  const backend = adaptStore(store);
  let closed = false;
  // 缓存与 Dart 的 `_notes` 同义：read 一次之后全在内存，list/get 不再打 store。
  let cache = null;
  /**
   * 串行化所有读改写。
   *
   * Dart 的 `_locked` 就是为了这件事：两次 `saveMarkdown` 同时进来时，
   * 后一次必须看见前一次的结果，否则会丢一笔（App 里就是"快速打字丢字"）。
   * `list()` 也会经过这条链，避免它在写的中途读到半旧的状态。
   */
  let chain = Promise.resolve();

  const serialized = (action) => {
    const run = chain.then(action, action);
    // 链本身永远不 reject（否则一次失败会让后面所有操作跟着炸），
    // 但**调用方拿到的那一份**照样 reject —— 失败是如实上报的。
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const assertOpen = () => {
    if (closed) throw new NoteError('CLOSED', '节笔记服务已卸载，不能再用');
  };

  const loadFromStore = async () => {
    if (cache !== null) return cache;
    let raw;
    try {
      raw = await backend.read();
    } catch (error) {
      throw new NoteError('LOAD', '读取节笔记失败', {}, { cause: error });
    }
    const notes = [];
    let dropped = 0;
    for (const item of recordsFrom(raw)) {
      const note = normalizeNote(item);
      // 缺 courseId/sectionId 的记录整条丢弃（Dart 同口径）——但要**数得出来**，
      // 让调用方知道"磁盘上有东西我没认"，而不是静默缩小列表。
      if (note === null) dropped += 1;
      else notes.push(note);
    }
    cache = { notes, dropped };
    return cache;
  };

  const persist = async (notes) => {
    const payload = notes.map(noteToJson);
    try {
      await backend.write(payload);
    } catch (error) {
      // 写失败 → 内存**不动**（严格按 Dart 的 _writeIndex 语义：写完才更新 _notes）。
      throw new NoteError('PERSIST', '写入节笔记失败，本次改动未生效', { count: payload.length }, { cause: error });
    }
    cache = { notes: payload.map(normalizeNote), dropped: 0 };
  };

  const requireId = (courseId, sectionId) => {
    if (!isUsableId(courseId) || !isUsableId(sectionId)) {
      throw new NoteError('INPUT', 'courseId / sectionId 必须是可拼进内链的稳定 id', { courseId, sectionId });
    }
  };

  const findIndex = (notes, courseId, sectionId) => {
    const key = noteKey(courseId, sectionId);
    return notes.findIndex((note) => noteKey(note.courseId, note.sectionId) === key);
  };

  const stamp = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new NoteError('INPUT', 'now() 必须给出合法时间', { got: String(value) });
    return date.toISOString();
  };

  /**
   * 附件 id 生成：默认用 `img<毫秒时间戳>`。
   *
   * ⚠️ 与 Dart 有一处**有意收窄**：Dart 用 `microsecondsSinceEpoch`，
   * JS 的 `Date` 只有毫秒。同一毫秒内连加两张图会撞 id，所以这里带一个
   * 自增尾号 `-1`、`-2`…，保证 id 不重复（重复 id 会让
   * `getAsset` 取错图，那是用户看得见的错）。调用方可以整个替换掉这个策略。
   */
  let assetSeq = 0;
  let lastStamp = -1;
  const defaultAssetId = () => {
    // ⚠️ 只调一次 `now()`：调两次的话，"读时间 → 比时间 → 再读时间"之间真实时钟
    //    可能已经跳到下一毫秒，`at === lastStamp` 永远不成立，去重逻辑整个失效
    //    （同一毫秒连加两张图会撞 id）。注入的测试时钟恰好是冻结的，所以这个
    //    bug 在"固定时钟"的用例里看不出来 —— 只在真时钟下才会现形。
    const current = now();
    const date = current instanceof Date ? current : new Date(current);
    const at = date.getTime();
    if (at === lastStamp) assetSeq += 1;
    else {
      lastStamp = at;
      assetSeq = 0;
    }
    return assetSeq === 0 ? `img${at}` : `img${at}-${assetSeq}`;
  };
  const makeAssetId = typeof nextAssetId === 'function' ? nextAssetId : defaultAssetId;

  const service = {
    /**
     * 列出全部笔记（Dart `SectionNoteStore.list`）。
     *
     * Dart 的 provider 层还按 `updatedAt` 倒序排过（`section_notes.dart`），
     * 那是**展示顺序**、属于状态层的活，所以这里保持 Dart store 的口径：
     * 按索引里的原始顺序返回，排序交给调用方。
     * @returns {Promise<object[]>} 笔记列表（副本）。
     */
    list() {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        // 给副本：调用方改返回的数组不该改到缓存（Dart 的 list 也是 List.from）。
        return notes.map((note) => structuredClone(note));
      });
    },

    /**
     * 读一节笔记；没有就是 `null`（Dart `SectionNoteStore.get`）。
     * @param {string} courseId - 课程 id。
     * @param {string} sectionId - 节 id。
     * @returns {Promise<object|null>} 笔记或 `null`。
     */
    get(courseId, sectionId) {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        const index = findIndex(notes, courseId, sectionId);
        return index < 0 ? null : structuredClone(notes[index]);
      });
    },

    /**
     * 读一节笔记，没有就给空笔记（Dart `getOrEmpty`）。**不落盘**。
     * @param {{courseId: string, sectionId: string, title?: string}} input - 课程、节、可选标题。
     * @returns {Promise<object>} 笔记。
     */
    getOrEmpty({ courseId, sectionId, title = '' }) {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        const index = findIndex(notes, courseId, sectionId);
        return index < 0 ? emptyNote({ courseId, sectionId, title }) : structuredClone(notes[index]);
      });
    },

    /**
     * 写一节笔记的正文（Dart `saveMarkdown`）。
     *
     * **同一节是替换而不是追加**，其它节原样保留 —— 这正是索引要按
     * [noteKey] 找位置、而不是无脑 push 的原因。
     * `title` 给了就换，没给就保留原来的（`title: null` 与 `undefined` 等价，
     * 对齐 Dart 的 `title ?? all[i].title`）。
     * @param {{courseId: string, sectionId: string, markdown: string, title?: string|null}} input - 输入。
     * @returns {Promise<object>} 落盘后的笔记。
     */
    put({ courseId, sectionId, markdown, title }) {
      return serialized(async () => {
        assertOpen();
        requireId(courseId, sectionId);
        if (typeof markdown !== 'string') {
          throw new NoteError('INPUT', 'markdown 必须是字符串', { got: typeof markdown });
        }
        const { notes } = await loadFromStore();
        const at = stamp();
        const index = findIndex(notes, courseId, sectionId);
        const next = index < 0
          ? { ...emptyNote({ courseId, sectionId, title: title ?? '' }), markdown, updatedAt: at }
          : { ...notes[index], markdown, title: title ?? notes[index].title, updatedAt: at };
        const updated = index < 0 ? [...notes, next] : notes.map((note, i) => (i === index ? next : note));
        await persist(updated);
        return structuredClone(next);
      });
    },

    /**
     * 删一节笔记（本包提供；Dart 侧只有整表重写，没有单条删除的入口）。
     *
     * 语义见文件头：**只删记录，不动附件字节、不动草稿**。
     * @param {string} courseId - 课程 id。
     * @param {string} sectionId - 节 id。
     * @returns {Promise<boolean>} 原来有这条并删掉了是 `true`，本来就没有是 `false`。
     */
    remove(courseId, sectionId) {
      return serialized(async () => {
        assertOpen();
        requireId(courseId, sectionId);
        const { notes } = await loadFromStore();
        const index = findIndex(notes, courseId, sectionId);
        if (index < 0) return false;
        await persist(notes.filter((_, i) => i !== index));
        return true;
      });
    },

    /**
     * 给一节笔记挂一个附件（Dart `addAsset` 的落盘之外那一半）。
     *
     * ⚠️ 与 Dart 的分工差异（必须说清楚）：Dart 的 `addAsset` 收的是图片
     * **字节**，自己写进 `note_assets/`；本包**不碰字节**，只登记
     * `{id, file, alt, page}` 这条记录，字节由集成层写。所以这里要求调用方
     * 显式给出 `file`（Dart 自己也把它写进记录，只是它自己算出来而已）。
     * 这样切是为了让"文件放哪"这件事继续留在宿主手里。
     * @param {{courseId: string, sectionId: string, id?: string, file: string, alt?: string|null, page?: number|null, title?: string|null}} input - 输入。
     * @returns {Promise<object>} 落盘后的笔记。
     */
    putAsset({ courseId, sectionId, id, file, alt, page, title }) {
      return serialized(async () => {
        assertOpen();
        requireId(courseId, sectionId);
        if (typeof file !== 'string' || file === '') {
          throw new NoteError('INPUT', '附件记录必须带 file（本包不碰字节，只登记它在哪）', { got: typeof file });
        }
        const assetId = id ?? makeAssetId();
        if (typeof assetId !== 'string' || assetId === '') {
          throw new NoteError('INPUT', '附件 id 不能为空', { got: String(assetId) });
        }
        const { notes } = await loadFromStore();
        const index = findIndex(notes, courseId, sectionId);
        const base = index < 0 ? emptyNote({ courseId, sectionId, title: title ?? '' }) : notes[index];
        const asset = { id: assetId, file };
        if (alt !== undefined && alt !== null) asset.alt = String(alt);
        if (page !== undefined && page !== null) asset.page = Number(page);
        const at = stamp();
        const next = {
          ...base,
          title: title ?? base.title,
          // 追加（Dart addAsset 也是 `[...note.assets, asset]`）：同一张图可以挂两次，
          // 因为正文里可能出现两次。这里**不做**去重 —— 去了反而对不上正文。
          assets: [...base.assets, asset],
          updatedAt: at,
        };
        const updated = index < 0 ? [...notes, next] : notes.map((note, i) => (i === index ? next : note));
        await persist(updated);
        return structuredClone(next);
      });
    },

    /**
     * 按附件 id 找它属于哪一节、文件在哪（Dart `assetFile` 的记录那一半）。
     *
     * Dart 返回 `File?`（文件不存在时给 null）；这里返回记录 + `owned` 标志，
     * 把"字节在不在"留给集成层判断 —— 本包看不到文件系统，也就不该假装能判。
     * @param {string} id - 附件 id。
     * @returns {Promise<{courseId: string, sectionId: string, asset: object, owned: false}|null>} 命中或 `null`。
     */
    getAsset(id) {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        for (const note of notes) {
          for (const asset of note.assets) {
            if (asset.id === id) {
              return { courseId: note.courseId, sectionId: note.sectionId, asset: structuredClone(asset), owned: false };
            }
          }
        }
        return null;
      });
    },

    /**
     * 从记录里摘掉一个附件引用（本包新增，见文件头）。**不删字节**。
     * @param {string} id - 附件 id。
     * @returns {Promise<boolean>} 摘掉了是 `true`，本来就没有是 `false`。
     */
    removeAsset(id) {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        let hit = false;
        const updated = notes.map((note) => {
          if (!note.assets.some((asset) => asset.id === id)) return note;
          hit = true;
          return { ...note, assets: note.assets.filter((asset) => asset.id !== id) };
        });
        if (!hit) return false;
        await persist(updated);
        return true;
      });
    },

    /**
     * 导出这一节的 markdown（Dart `exportMarkdown` 的正文改写那一半）。
     *
     * 与 Dart 同样的两条改写（见 [rewriteForExport]），外加把 `files` 里的
     * **附件 id → file** 交回给调用方 —— 由它去读字节（本包不碰文件系统）。
     * @param {{courseId: string, sectionId: string}} input - 课程、节。
     * @returns {Promise<{markdown: string, files: Record<string, string>}>} 正文与附件清单。
     */
    exportMarkdown({ courseId, sectionId }) {
      return serialized(async () => {
        assertOpen();
        const { notes } = await loadFromStore();
        const index = findIndex(notes, courseId, sectionId);
        const note = index < 0 ? emptyNote({ courseId, sectionId }) : notes[index];
        const files = {};
        for (const asset of note.assets) files[asset.id] = asset.file;
        const nameById = new Map(Object.entries(files).map(([id, file]) => [id, exportFileName(file)]));
        return { markdown: rewriteForExport(note.markdown, nameById), files };
      });
    },

    /** 这一节有没有正文（Dart `hasContent`）。 */
    async hasContent(courseId, sectionId) {
      return hasContent(await service.getOrEmpty({ courseId, sectionId }));
    },

    /**
     * 卸载：释放缓存的记录与对 store 的引用。
     *
     * ⚠️ 这里**不替集成层关 store**：store 是注入进来的，它的生命周期
     * （比如宿主 domain 的 `close()`）归提供它的人。本包只放下自己那半边，
     * 免得把别人还要用的句柄一起关掉。
     * @returns {Promise<void>} 完成。
     */
    async dispose() {
      await serialized(async () => {
        closed = true;
        cache = null;
      });
    },

    /** 诊断：本服务是否已卸载。 */
    get closed() {
      return closed;
    },

    /**
     * 诊断：上一次加载时有多少条记录因为缺 id 被丢弃。
     * 数字大于 0 说明介质里有本包认不出的东西 —— 调用方应当去查，不该当没看见。
     */
    get droppedOnLoad() {
      return cache === null ? 0 : cache.dropped;
    },
  };

  return service;
}

/**
 * 导出时附件的文件名（Dart `p.basename(asset.file)`）。
 *
 * 只取最后一段，并把 `\` 也当分隔符 —— Dart 的 `p.basename` 在 Windows 上
 * 认两种分隔符，而 `addAsset` 记录的 `file` 已经把 `\` 换成 `/` 了；
 * 这里两边都兜住，免得导出出一个名叫 `note_assets\img1.png` 的文件。
 * @param {string} file - 记录里的 file 字段。
 * @returns {string} 文件名。
 */
export function exportFileName(file) {
  const parts = String(file).split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
