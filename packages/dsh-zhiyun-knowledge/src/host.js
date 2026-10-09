/**
 * 宿主存储栈的解析（本包与宿主之间唯一的接入点）。
 *
 * # 为什么是**运行时解析**，不是 `import { defineDomain } from '@deepseek-ai/…'`
 *
 * 静态 import 会把本包绑死在「仓库根 node_modules 里恰好有宿主包」这个布局上，
 * 而事实不是：宿主包只存在于 `.runtime/dsh-<版本>/node_modules`（本仓的临时安装）
 * 或用户机器上 DSH Desktop 的 `resources/app/node_modules`，由 profile 的链接决定。
 * 同一份源码在两台机器、两个宿主版本上，那个路径都不一样 —— 静态 import 会在
 * 宿主里解析到别的副本、在我们的离线用例里直接 ERR_MODULE_NOT_FOUND。
 *
 * 所以锚点是**宿主自己给的** `profileContext.dir`（profile 目录，Cordis 宿主启动时
 * 注入；它的 node_modules 链正是宿主加载插件的同一条链）。这与仓里
 * `tests/fixtures/study-backend/index.js` 取 `@deepseek-ai/dsh-llm` 的做法同源，
 * 也是「同一件事只有一份实现」这条约束的落点。
 *
 * # 为什么连 zod 也要从域层的入口解析
 *
 * `domainTable` 要的是 zod schema，而校验发生在**域层的读取边界**：schema 必须与
 * 域层用的是同一份 zod，否则依赖两份 zod 的版本/语义恰好一致 —— 那是运气。
 * 做法是 `createRequire(<域层入口>).resolve('zod')`：域层依赖谁，我们就用谁。
 *
 * ⚠️ 本文件不碰文件系统：不读文件、不建目录、不写索引。数据落在哪由
 *    profile 的 `storage-domain` 路由决定（本仓 profile 里是 `backend: json`，
 *    root = `dshHomePath('storages')`）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { KnowledgeError } from './errors.js';

/** 域层包名。只有这一个裸包名需要解析 —— 其余（hub / backend）由 `ctx.storageDomain` 自己带。 */
export const DOMAIN_PACKAGE = '@deepseek-ai/dsh-storage-domain';

/**
 * 从「zod 本体」或「带 `.z` / `.default` 的 zod 命名空间」里认出真正的 zod API 对象。
 *
 * 为什么要认形状而不是按名字取：宿主的 zod 是 CommonJS（`index.cjs`），
 * 经 ESM 动态 import 之后既可能拿到本体，也可能拿到带 `default` 的命名空间 ——
 * 这取决于 Node 的互操作判定，不是本包能规定的。认形状才跨版本稳。
 * @param value 可能是 zod 本体，也可能是命名空间。
 * @returns zod API 对象，或 `null`（形状不对）。
 */
function pickZod(value) {
  for (const candidate of [value, value?.z, value?.default, value?.default?.z]) {
    if (candidate && typeof candidate.strictObject === 'function' && typeof candidate.looseObject === 'function'
      && typeof candidate.enum === 'function' && typeof candidate.array === 'function') return candidate;
  }
  return null;
}

/** 由 profile 目录建一个 CommonJS 解析器；解析链就是宿主加载插件的那一条。 */
function requireFrom(profileDir) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new KnowledgeError('CONFIG', '缺少 profileContext.dir：本包要从 profile 目录解析宿主存储栈（storage-domain 与它依赖的 zod），'
      + '而在离线用例里可以改用 config.storage 直接注入宿主导出的同形状对象');
  }
  try {
    return createRequire(path.join(profileDir, 'package.json'));
  } catch (error) {
    throw new KnowledgeError('CONFIG', `无法以 profile 目录为锚建立模块解析：${profileDir}（${error.message}）`, { cause: error, profileDir });
  }
}

/**
 * 解析宿主存储栈，返回 `defineDomain` / `domainTable` / `z`。
 *
 * @param profileDir profile 目录（`ctx.profileContext.dir`）。
 * @returns `{ defineDomain, domainTable, z, domainEntry, zodEntry }`；`*Entry` 是诊断用的绝对路径。
 * @throws KnowledgeError code=`CONFIG` —— 解析不到或形状不对时**有名字地**失败，
 *         绝不静默退化成「自己写一份」：那正是本包要拆掉的东西。
 */
export async function loadHostStorage(profileDir) {
  const require = requireFrom(profileDir);
  let domainEntry;
  try {
    domainEntry = require.resolve(DOMAIN_PACKAGE);
  } catch (error) {
    throw new KnowledgeError('CONFIG', `profile 目录里解析不到 ${DOMAIN_PACKAGE}：${profileDir}。`
      + '宿主存储栈应由 profile 的 bundle（@deepseek-ai/dsh-base）挂载；缺了它本包没有可用的域存储。', { cause: error, profileDir });
  }
  let domainModule;
  try {
    domainModule = await import(pathToFileURL(domainEntry).href);
  } catch (error) {
    throw new KnowledgeError('CONFIG', `加载 ${DOMAIN_PACKAGE} 失败：${domainEntry}（${error.message}）`, { cause: error, domainEntry });
  }
  const { defineDomain, domainTable } = domainModule;
  if (typeof defineDomain !== 'function' || typeof domainTable !== 'function') {
    throw new KnowledgeError('CONFIG', `${DOMAIN_PACKAGE} 未导出 defineDomain / domainTable（实际导出：${Object.keys(domainModule).join('、') || '空'}）`, { domainEntry });
  }

  let zodEntry;
  try {
    zodEntry = createRequire(domainEntry).resolve('zod');
  } catch (error) {
    throw new KnowledgeError('CONFIG', `从 ${DOMAIN_PACKAGE} 的入口解析 zod 失败：${error.message}`, { cause: error, domainEntry });
  }
  const zodModule = await import(pathToFileURL(zodEntry).href);
  const z = pickZod(zodModule);
  if (z === null) throw new KnowledgeError('CONFIG', `zod（${zodEntry}）的形状不符合预期：找不到 strictObject / looseObject / enum`, { zodEntry });

  return { defineDomain, domainTable, z, domainEntry, zodEntry };
}

/** 校验外部注入的宿主栈（`config.storage`）形状；离线用例与别的嵌入方走这条路。 */
export function assertHostStorage(host, origin) {
  if (host === null || typeof host !== 'object') throw new KnowledgeError('CONFIG', `${origin} 必须是 { defineDomain, domainTable, z }`);
  for (const key of ['defineDomain', 'domainTable']) {
    if (typeof host[key] !== 'function') throw new KnowledgeError('CONFIG', `${origin}.${key} 必须是函数`);
  }
  // `z` 可以是 zod 本体，也可以是 `.z` / `.default.z` 命名空间；认形状，
  // 形状不对就有名字地拒（不许静默退化）。
  if (pickZod(host.z) === null) {
    throw new KnowledgeError('CONFIG', `${origin}.z 不是可用的 zod（需要 strictObject / looseObject / enum）`);
  }
  return host;
}
