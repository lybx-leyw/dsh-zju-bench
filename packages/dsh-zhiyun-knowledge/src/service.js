/**
 * 知识库服务：域存储之上的薄一层语义。
 *
 * # 这一层负责什么、不负责什么
 *
 * 不负责：落盘、原子替换、JSON 序列化、索引。那些**全是宿主存储栈的活**
 * （`ctx.storageDomain` 打开的域 + `json` 后端），本包一行文件读写都没有 ——
 * 这正是本包要替换掉的东西：之前学习面板自己 `writeFileAtomic` 往
 * `results/<sha256>.json` 写，键是哈希（"这份结果属于谁"从盘上看不出来），
 * 也没有任何跨账号/跨课程的检索能力。
 *
 * 负责三件事：
 * ① **身份 → 键**：`accountId:courseId:subId`。账号进键，隔离就是存储层的性质。
 * ② **写入口径**：`put()` 在写之前按宿主 schema 校验，坏记录**有名字地**被拒 ——
 *    不让它落盘、也不让它把整个域卡在下次 `open()` 上。
 * ③ **按课程/关键词读**：`listByCourse` / `search` 只按键前缀取本账号本课程，
 *    再对块正文、块概述、块衔接做**字面**筛选（不是向量检索，也不是 AI 检索）。
 *
 * # 为什么读操作直接读内存而不是重新校验
 *
 * 宿主的域层在 `open()` 时就把每条存下来的记录按同一份 schema 校验过了，
 * 之后的写又只有本服务的 `put()` 这一条路（域句柄独占，宿主对同名域强制单开）。
 * 所以内存里的记录"生来合法"，每次读再 parse 一遍巨型产物只是白烧 CPU。
 * 真正可能失守的那条路 —— 介质被别的东西改坏 —— 由宿主在下次 `open()` 时
 * 以 `invalid-record` 如实报出来（本包不吞这个错，见 index.js）。
 */
import { KnowledgeError } from './errors.js';
import { LECTURES_TABLE, RECORD_SCHEMA, identityPart, keyOf } from './domain.js';

/** 检索命中的字段名（如实说明命中的是**哪一块的哪个字段**，不做无关的"相关度"）。 */
export const MATCH_FIELDS = ['sentence', 'summary', 'bridge'];

/** 把 zod 的问题列表压成可读的一行行诊断（错误信息要能直接指出哪个字段坏了）。 */
function describeIssues(issues) {
  return (issues ?? []).map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}：${issue.code}${issue.message ? `（${issue.message}）` : ''}`);
}

/** 摘要：列表里不需要把整份产物（可能几百 KB）拖出来。 */
function summarize(key, record) {
  return {
    key,
    accountId: record.accountId,
    courseId: record.courseId,
    subId: record.subId,
    sourceId: record.sourceId ?? null,
    status: record.status,
    schema: record.schema,
    fetchedAt: record.fetchedAt,
    spine: record.spine,
    hasLecture: record.lecture !== null && record.lecture !== undefined,
    counts: {
      sentences: record.sentences?.length ?? 0,
      unassignedSentences: record.unassignedSentences?.length ?? 0,
      blocks: record.blocks?.length ?? 0,
      outline: record.outline?.length ?? 0,
      vocabulary: record.vocabulary?.length ?? 0,
      warnings: record.warnings?.length ?? 0,
    },
  };
}

/**
 * 知识库服务实现。
 *
 * @param options.domain 已打开的域句柄（由 index.js 通过 `ctx.storageDomain.open(spec)` 拿到）。
 * @param options.spec 域规格（用于取记录 schema 做写入口径校验）。
 */
export function createKnowledgeService({ domain, spec }) {
  const table = domain.table(LECTURES_TABLE);
  const schema = spec.tables[LECTURES_TABLE].valueSchema;
  let closed = false;

  /** 已释放的服务不许再被调用 —— 静默返回空会被误读成"没有数据"。 */
  function assertOpen() {
    if (closed) throw new KnowledgeError('DISPOSED', '知识库服务已随插件卸载，不能再调用');
  }

  /** 键前缀：只取本账号（可选本课程）的记录，**隔离靠键，不靠事后过滤**。 */
  function prefixOf(accountId, courseId) {
    const parts = [identityPart(accountId, 'accountId')];
    if (courseId !== undefined && courseId !== null) parts.push(identityPart(courseId, 'courseId'));
    return `${parts.join(':')}:`;
  }

  /**
   * 核对记录与它的键一致；不一致是坏数据，如实报错而不是当它不存在。
   *
   * 为什么这条检查不能省：读路径都靠**键前缀**定位数据。若记录里的身份与键不符，
   * 前缀就会把别的账号/课程的数据带出来 —— 那正是"账号隔离"的反例。
   * 检查用「键 == 由记录身份重算的键」这一条式子：它同时覆盖三段身份，
   * 比逐个字段比对更不容易漏。
   */
  function assertKeyMatchesRecord(key, record) {
    // 记录里的身份可能本身就不成形（例如被改成了含冒号的串）。那时 `keyOf` 抛的是
    // INPUT（"你给的身份不合法"），但这里的语境是**存储里的数据坏了** ——
    // 归成 CORRUPT 才说得清该去修数据，而不是去修调用参数。
    let recomputed;
    try {
      recomputed = keyOf(record.accountId, record.courseId, record.subId);
    } catch (error) {
      throw new KnowledgeError('CORRUPT', `键 ${key} 上的记录身份不成形（${error.message}）—— 不当作"没有这条"`, { key, cause: error });
    }
    if (key !== recomputed) {
      throw new KnowledgeError('CORRUPT', `记录与它的键不一致（键 ${key}，记录里的身份是 `
        + `${record.accountId}:${record.courseId}:${record.subId}）—— 不当作"没有这条"`, { key });
    }
    return record;
  }

  /** 读出并核对一条记录。 */
  function readAt(key) {
    const record = table.get(key);
    return record === undefined ? undefined : assertKeyMatchesRecord(key, record);
  }

  /** 某条记录参与检索的字段（块正文 / 块概述 / 块衔接）。 */
  function* searchableFragments(record) {
    for (const block of record.blocks ?? []) {
      for (const sentence of block.sentences ?? []) {
        if (typeof sentence.text === 'string' && sentence.text.length) yield { field: 'sentence', blockIndex: block.index, text: sentence.text };
      }
      const summary = block.tag?.summary;
      if (typeof summary === 'string' && summary.length) yield { field: 'summary', blockIndex: block.index, text: summary };
      const bridge = block.bridge;
      if (typeof bridge === 'string' && bridge.length) yield { field: 'bridge', blockIndex: block.index, text: bridge };
    }
  }

  // Handout search is an explicit layer: it must never masquerade as a quote
  // from the final transcript. Anchors point to the original parser blocks.
  function* handoutFragments(record) {
    const chapters = record.lecture?.chapters;
    if (!Array.isArray(chapters)) return;
    for (const [ci, chapter] of chapters.entries()) {
      for (const [ti, topic] of (chapter.topics ?? []).entries()) {
        const location = { field: 'lecture', chapterNo: chapter.no ?? ci + 1, topicNo: ti + 1,
          page: topic.anchor?.page ?? topic.fromPage ?? null, startMs: topic.anchor?.tSec == null ? null : topic.anchor.tSec * 1000,
          sourceBlockIndexes: topic.sourceBlockIndexes ?? topic.blockIndexes ?? [] };
        if (topic.title) yield { ...location, text: topic.title };
        // Passages are the handout's display text, updated by the App-style
        // review merge in the same transaction as its structured blocks.
        for (const passage of topic.passages ?? []) if (typeof passage.text === 'string' && passage.text) yield { ...location, text: passage.text };
      }
    }
  }

  return {
    /** 域与表的诊断信息（集成层可据此确认用的是哪个后端、哪张表）。 */
    get domainName() { return domain.name; },
    get tableName() { return LECTURES_TABLE; },
    get recordSchema() { return RECORD_SCHEMA; },
    get size() { assertOpen(); return table.size; },
    get closed() { return closed; },

    /**
     * 写入（或覆盖）一条记录。
     *
     * 同一把键再次写入是**替换**（宿主 `put` 的语义），不是追加。
     * @param record 解析器产物 + 身份三元组；`lecture` 缺省补 `null`。
     * @returns `{ key, replaced }` —— `replaced` 让调用方能分清"新增"与"覆盖"。
     * @throws KnowledgeError code=`INPUT` 身份不合法；code=`INVALID_RECORD` 记录不过宿主的 schema。
     */
    async put(record) {
      assertOpen();
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new KnowledgeError('INPUT', '记录必须是对象');
      const key = keyOf(record.accountId, record.courseId, record.subId);
      // 身份先从记录里归一：键由**归一后**的值拼出，避免 `' 1'` 与 `'1'` 落成两条。
      const normalized = { ...record, accountId: record.accountId.trim(), courseId: record.courseId.trim(), subId: record.subId.trim() };
      // 「暂未生成讲义时为 null」在**写入口径**落点：落盘的记录里这个字段必定在。
      if (normalized.lecture === undefined) normalized.lecture = null;
      const parsed = schema.safeParse(normalized);
      if (!parsed.success) {
        throw new KnowledgeError('INVALID_RECORD', `记录不符合宿主域 schema，未写入（键 ${key}）：`
          + describeIssues(parsed.error.issues).join('；'), { key, issues: describeIssues(parsed.error.issues) });
      }
      const replaced = table.get(key) !== undefined;
      await table.put(key, parsed.data);
      return { key, replaced };
    },

    /**
     * 读一条记录（完整产物；`lecture` 未生成时为 `null`）。
     * @returns 记录，或 `undefined`（确实没有这条）。
     */
    get({ accountId, courseId, subId } = {}) {
      assertOpen();
      const key = keyOf(accountId, courseId, subId);
      return readAt(key);
    },

    /**
     * 列出一门课下的全部节次（**只可能是这个账号下的**：按键前缀取）。
     * @param options.accountId 账号。
     * @param options.courseId 课程。
     * @param options.full 为真时每条带 `record`（完整产物）；默认只给摘要，避免拖出几百 KB。
     * @returns 摘要数组，按 `subId` 稳定排序。
     */
    listByCourse({ accountId, courseId, full = false } = {}) {
      assertOpen();
      const account = identityPart(accountId, 'accountId');
      const course = identityPart(courseId, 'courseId');
      const prefix = `${account}:${course}:`;
      const out = [];
      for (const [key, record] of table.entries()) {
        // 前缀已保证是本账号本课程；下面这条核对拦住"键与身份不符"的坏数据
        // （不拦的话前缀就会把别的账号的数据带出来）。
        if (!key.startsWith(prefix)) continue;
        assertKeyMatchesRecord(key, record);
        out.push(full ? { ...summarize(key, record), record } : summarize(key, record));
      }
      return out.sort((a, b) => (a.subId < b.subId ? -1 : a.subId > b.subId ? 1 : 0));
    },

    /**
     * **字面**检索：在块正文、块概述、块衔接里找包含 `query` 的片段。
     *
     * ⚠️ 这不是向量检索，也不是 AI 检索：就是 `String.prototype.includes` 的子串匹配
     * （大小写敏感、不切词、不算相关度）。命名与文案都按这件事如实说。
     * @param options.accountId 账号（必填 —— 检索也不许跨账号）。
     * @param options.query 检索词（非空字符串）。
     * @param options.courseId 限定课程；不传则在**本账号**全部课程里找。
     * @param options.layer final（默认，终稿）/ lecture（当前讲义）/ all；来源层不混称。
     * @returns 命中数组；每条给出命中片段（字段名 + 块序号 + 原文）。
     */
    search({ accountId, query, courseId, layer = 'final' } = {}) {
      assertOpen();
      const account = identityPart(accountId, 'accountId');
      if (!['final', 'lecture', 'all'].includes(layer)) throw new KnowledgeError('INPUT', 'layer 必须是 final / lecture / all');
      if (typeof query !== 'string') throw new KnowledgeError('INPUT', 'query 必须是字符串');
      const needle = query.trim();
      // 空检索词不许退化成"返回全部"：那会把"没搜"伪装成"搜到了"。
      if (!needle) throw new KnowledgeError('INPUT', 'query 不能为空（空检索词不会返回全部结果）');
      // 课程限定在**键前缀**里就生效（不是先全取出来再过滤）。
      const course = courseId === undefined || courseId === null ? null : identityPart(courseId, 'courseId');
      const prefix = prefixOf(account, course ?? undefined);
      const hits = [];
      for (const [key, record] of table.entries()) {
        if (!key.startsWith(prefix)) continue;
        assertKeyMatchesRecord(key, record);
        const matches = [];
        const fragments = layer === 'lecture' ? handoutFragments(record) : layer === 'all' ? [...searchableFragments(record), ...handoutFragments(record)] : searchableFragments(record);
        for (const fragment of fragments) {
          if (fragment.text.includes(needle)) matches.push(fragment);
        }
        if (matches.length) {
          hits.push({
            key,
            accountId: record.accountId,
            courseId: record.courseId,
            subId: record.subId,
            sourceId: record.sourceId ?? null,
            status: record.status,
            fetchedAt: record.fetchedAt,
            matches,
          });
        }
      }
      return hits.sort((a, b) => (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1
        : a.subId < b.subId ? -1 : a.subId > b.subId ? 1 : 0));
    },

    /**
     * 删除一条记录。
     * @returns `true` 确实删掉了；`false` 本来就没有（宿主 `delete` 的语义）。
     */
    async remove({ accountId, courseId, subId } = {}) {
      assertOpen();
      const key = keyOf(accountId, courseId, subId);
      return table.delete(key);
    },

    /** 由插件 disposer 调用：先封住入口（此后调用得到 DISPOSED），再让宿主释放域。 */
    async close() {
      closed = true;
    },
  };
}
