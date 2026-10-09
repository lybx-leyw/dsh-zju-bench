/**
 * 知识库的域声明（宿主 storage-domain 的规格）。
 *
 * # 一条表：`lectures`
 *
 * 键是 `accountId:courseId:subId` 这个稳定串 —— 账号在**键**里，所以「不同账号的
 * 同名课程节次互不可见」是存储层的性质，不是查询层记得过滤才有的效果。
 *
 * # 为什么 `layout` 用默认的 `single`
 *
 * `per-record` 布局把键当**路径段**（后端硬要求 `[a-zA-Z0-9_-]+`），而本域的键按
 * 规格是 `accountId:courseId:subId`，冒号不在那个集合里 —— 要么改用哈希键（键就不再
 * 可读，且"谁是谁"再也看不出来），要么自己写一层编码（本仓明令禁止的重复造轮子）。
 * `single` 布局下键是文档里的 JSON 字段，任意字符串都行，键就是规格说的那个键。
 *
 * # 为什么顶层 schema 是 loose（`looseObject`）而不是 strict
 *
 * 记录本体是**解析器的产物**：除了本包列出的字段，真实产物还有 `pages` /
 * `glossary` / `failures` / `calls` / `version` 等。用 strict 会把它们判成非法，
 * 等于逼接线层先删数据再入库 —— 知识库不该丢解析器已经算出来的东西。
 * 所以本包只**声明哪些字段必须在**（少一个就是坏记录），不**限定只有哪些字段**。
 *
 * # 为什么 `lecture` 不在 schema 里给 default
 *
 * 「暂未生成时为 null」这条口径由**写入口径**保证：`put()` 显式把 `lecture ?? null`
 * 补齐一次再落盘（见 service.js），于是落盘记录里这个字段**必定存在**。
 * 若改成 schema 的 `.default(null)`，那么宿主在 `open()` 校验时会就地补默认值 ——
 * 落盘内容与读回内容在"重开之后"才出现差异，而那条差异正是本任务要证明不存在的东西。
 */
import { KnowledgeError } from './errors.js';

/** 域（= 后端介质里的单元名）与格式版本。必须匹配宿主的 UNIT_NAME_RE：`/^[a-z][a-z0-9_]*$/`。 */
export const DOMAIN_NAME = 'zhiyun_knowledge';
export const DOMAIN_VERSION = 1;
/** 唯一的表名。 */
export const LECTURES_TABLE = 'lectures';

/** 记录格式代际：与解析器产物里的 `schema: 1` 同源，用于将来识别旧记录。 */
export const RECORD_SCHEMA = 1;

/** 解析器自己用的状态词表（`packages/dsh-zhiyun-parser/src/parser.js` 只产出这两档）。 */
export const LECTURE_STATUSES = ['ready', 'partial'];

/**
 * 身份段的合法形状：非空、不含冒号、不含任何空白、长度有界。
 *
 * ⚠️ 空白要拦**在任何位置**（不只是首尾）：`accountId = '1 2'` 在介质里是一条
 * 合法却永远匹配不上的键 —— 它只会在"为什么这条读不出来"里浪费时间。
 */
const IDENTITY_RE = /^[^\s:]{1,200}$/;

/**
 * 校验并归一一个身份段。
 *
 * 为什么连分隔符都要管：键是 `accountId:courseId:subId` 拼出来的，段里再出现冒号
 * 会让 `('1:2','3')` 与 `('1','2:3')` 撞成同一个键 —— 那是**跨账号串数据**，
 * 不是格式洁癖。宁可在这里有名字地拒绝。
 * @param value 待校验的值。
 * @param field 字段名，用于错误信息。
 * @returns 去掉首尾空白的身份段。
 */
export function identityPart(value, field) {
  if (typeof value !== 'string') throw new KnowledgeError('INPUT', `${field} 必须是字符串，收到 ${typeof value}`);
  const trimmed = value.trim();
  if (!IDENTITY_RE.test(trimmed)) {
    throw new KnowledgeError('INPUT', `${field} 不是合法的身份段（不能为空、不能含冒号或空白、长度不超过 200）：${JSON.stringify(value)}`, { field });
  }
  return trimmed;
}

/** 由身份三元组拼出稳定键。 */
export function keyOf(accountId, courseId, subId) {
  return `${identityPart(accountId, 'accountId')}:${identityPart(courseId, 'courseId')}:${identityPart(subId, 'subId')}`;
}

/**
 * 按宿主给的 zod 构造记录 schema。
 *
 * 必填项 = **本包真正要用的字段**：身份、状态、时间、格式代际，加上句子/块/主线/
 * 词表/警告这些检索与展示的载体。其余原样透传（loose）。
 * @param z 宿主域层依赖的那一份 zod。
 * @returns 记录 schema。
 */
function lectureSchema(z) {
  const sentence = z.looseObject({
    startMs: z.number(),
    endMs: z.number(),
    page: z.number().int().nullable().default(null),
    text: z.string(),
  });
  const block = z.looseObject({
    index: z.number().int(),
    sentenceFrom: z.number().int(),
    sentenceTo: z.number().int(),
    page: z.number().int().nullable().default(null),
    sentences: z.array(sentence),
    bridge: z.string(),
    tag: z.looseObject({
      role: z.string().nullable().default(null),
      facets: z.array(z.string()).nullable().default(null),
      summary: z.string().nullable().default(null),
    }),
  });
  return z.looseObject({
    // 身份三元组：键是它们的函数，所以三者都必须真在记录里。
    accountId: z.string().min(1),
    courseId: z.string().min(1),
    subId: z.string().min(1),
    /** 数据源标识（课堂服务给的 `zhiyun:<orgId>:<courseId>:<subId>`），可能为空。 */
    sourceId: z.string().nullable(),
    status: z.enum(LECTURE_STATUSES),
    fetchedAt: z.string().min(1),
    schema: z.number().int().positive(),
    sentences: z.array(sentence),
    unassignedSentences: z.array(sentence),
    blocks: z.array(block),
    spine: z.string(),
    outline: z.array(z.looseObject({ title: z.string().min(1), from: z.number().int(), to: z.number().int() })),
    vocabulary: z.array(z.looseObject({ name: z.string().min(1), aliases: z.array(z.string()).default([]) })),
    warnings: z.array(z.string()),
    /** 讲义产物：暂未生成为 `null`（写入口径保证这个字段一定在）。 */
    lecture: z.unknown().nullable(),
  });
}

/** 同一份宿主栈重复调用要拿到同一个 spec 对象（表句柄稳定，宿主也按名字单开）。 */
const specCache = new WeakMap();

/**
 * 用宿主存储栈声明的域规格。
 *
 * ⚠️ 这是一条**函数**而不是模块级常量，因为 schema 必须由宿主那一份 zod 构造
 *    （见 host.js：域层在读取边界用它的 schema 校验，两份 zod 各建一套 schema
 *    只是"版本恰好一致"的运气）。
 * @param host `{ defineDomain, domainTable, z }`。
 * @returns 域规格。
 */
export function createLectureSpec(host) {
  const cached = specCache.get(host);
  if (cached !== undefined) return cached;
  const { defineDomain, domainTable, z } = host;
  const spec = defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    // 不声明 global：格式版本已由 `version` 这一个地方说了算，再加一个全局槽
    // 就是把同一件事说两遍（本仓禁止的"同一件事两份实现"），而词表属于解析器包
    // （它自己落在 profile 的 data/zhiyun-parser/ 下），不该在知识库里再存一份。
    tables: { [LECTURES_TABLE]: domainTable(lectureSchema(z)) },
  });
  specCache.set(host, spec);
  return spec;
}
