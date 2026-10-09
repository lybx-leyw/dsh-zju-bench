import { mkdir, readFile, writeFile, access, symlink, realpath, lstat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const lock = JSON.parse(await readFile(new URL('../runtime.lock.json', import.meta.url), 'utf8'));
/**
 * 本仓自有的 bundle = `packages/` 下的 `dsh-zhiyun-*` 目录。
 *
 * profile 的目录链接表、产品升级白名单、客户端构建产物检查都从这一份推导 ——
 * 拆包/加包只需要建目录，不再需要在三个地方各补一行（漏一处的表现是启动时
 * 找不到包或静默少推一个 bundle）。
 */
export const sourceBundles = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-zhiyun-'))
  .map(entry => entry.name)
  .sort();
/**
 * 本仓**发布过但已不再提供**的包名（旧名登记表）。
 *
 * 改名/拆包时把旧名加进来：老 profile 里留着旧名的话 Loader 解不开那一行，
 * 整个 profile 起不来（拆包真机上踩过）。这里刻意**不用前缀猜测**：
 * 同前缀但没登记的条目可能来自别的分支或用户自己链进来的包，一律不动。
 */
export const retiredBundles = ['dsh-zhiyun-pro-ui', 'dsh-zhiyun-study'];
export async function exists(file) { try { await access(file); return true; } catch { return false; } }
/** 校验一个候选安装目录：六个宿主包版本一致、在清单内，Cordis 大版本匹配。 */
async function readHost(app) {
  const modules = path.join(app, 'node_modules');
  const supported = lock.hostVersions;
  const seen = new Set();
  for (const name of ['dsh', 'dsh-base', 'dsh-web-app', 'dsh-client-ui-layout', 'dsh-client-ui-slots', 'dsh-client-ui-workspace']) {
    const file = path.join(modules, '@deepseek-ai', name, 'package.json');
    if (!await exists(file)) throw new Error(`找不到 DSH 宿主：${file}。请用 ZHIYUN_DSH_APP_DIR 指向已安装的 resources/app。`);
    const { version } = JSON.parse(await readFile(file, 'utf8'));
    if (!supported.includes(version)) throw new Error(`DSH ${name}=${version}，本工作台验证过的版本是 ${supported.join(' / ')}。请指定匹配宿主，不能混用版本。`);
    seen.add(version);
  }
  // 每个包各自都在清单里还不够：一个目录里混着两个版本同样是坏状态。
  if (seen.size > 1) throw new Error(`宿主包版本不一致（${[...seen].join(' / ')}）—— 同一个安装目录不能混用版本。`);
  const cordis = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/cordis/package.json'), 'utf8'));
  if (Number(cordis.version.split('.')[0]) !== lock.cordisMajor) {
    throw new Error(`Cordis 大版本不匹配：${cordis.version}，本工作台验证的是 ${lock.cordisMajor}.x`);
  }
  return { app, modules, cli: path.join(modules, '@deepseek-ai/dsh/lib/bin.js'), version: [...seen][0] };
}

/**
 * 找到要用的宿主。
 *
 * 候选顺序：`ZHIYUN_DSH_APP_DIR` 指定 → 本机已安装的 DSH Desktop →
 * 本仓库 `.runtime/dsh-<已验证版本>`（新版在前）。
 *
 * 为什么要回退：声明支持的版本一旦变化（例如不再支持已安装的那个 0.1.5），
 * `npm start` 不能因为「机器上恰好装着旧版」就启动失败。回退只发生在**清单内**的
 * 版本上，实际用的是哪个宿主会打印出来，不是隐式魔法。
 */
export async function locateHost(env = process.env) {
  const explicit = env.ZHIYUN_DSH_APP_DIR;
  // 回退顺序由 preferredHostVersion 决定（默认用 latest 那条线，而不是 alpha），
  // 不是一个隐式排序：写清楚了才看得出 `npm start` 会用到哪一份。
  const preferred = lock.preferredHostVersion ?? lock.hostVersions[0];
  const ordered = [preferred, ...lock.hostVersions.filter(version => version !== preferred)];
  const candidates = explicit
    ? [{ app: explicit, why: 'ZHIYUN_DSH_APP_DIR' }]
    : [
        { app: path.join(env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app'), why: '本机已安装的 DSH Desktop' },
        ...ordered.map(version => ({ app: path.join(root, '.runtime', `dsh-${version}`), why: `本仓库临时安装 ${version}` })),
      ];
  const problems = [];
  for (const candidate of candidates) {
    try { return await readHost(candidate.app); }
    catch (error) { problems.push(`${candidate.why}（${candidate.app}）：${error.message}`); }
  }
  throw new Error(`找不到可用的 DSH 宿主：\n- ${problems.join('\n- ')}`);
}

/**
 * 建立 profile 里指向宿主的目录链接。
 *
 * [adopt] 为真时，如果这个链接**是我们自己建的链接**（不是实体目录）却指向别处 ——
 * 宿主换了版本/安装位置 —— 就改指过去。用户自己放在这里的实体目录永远不覆盖，
 * 仍然报错退出。
 */
async function linkDirectory(target, link, { adopt = false } = {}) {
  if (await exists(link)) {
    if (path.resolve(await realpath(link)).toLowerCase() === path.resolve(await realpath(target)).toLowerCase()) return 'same';
    const stats = await lstat(link);
    if (!adopt || !stats.isSymbolicLink()) throw new Error(`已有路径指向其他位置，未覆盖：${link}`);
    await rm(link, { recursive: true, force: true });
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return 'repointed';
  }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return 'created';
}
export async function initialize({ home = path.join(root, '.runtime', 'home'), env = process.env } = {}) {
  const host = await locateHost(env);
  const profile = path.join(home, 'profiles', lock.profile);
  await mkdir(profile, { recursive: true });
  const template = JSON.parse(await readFile(path.join(root, 'profiles', lock.profile, 'package.json'), 'utf8'));
  const manifestFile = path.join(profile, 'package.json');
  if (await exists(manifestFile)) {
    const existing = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (existing.name !== template.name) throw new Error(`已有 profile 不属于智云，未覆盖：${profile}`);
    const bundles = existing.dsh?.profile?.bundles;
    // 产品改名/拆包：profile 里指向**本仓已发布的旧名**的条目必须删掉，否则 Loader
    // 解不开这一行，整个 profile 起不来。只认 `retiredBundles` 登记表：没有登记的
    // 条目（哪怕前缀相同）可能是别的分支或用户自己链进来的包，一律不动。
    const stale = Array.isArray(bundles)
      ? bundles.filter(bundle => retiredBundles.includes(bundle))
      : [];
    let changed = false;
    if (stale.length > 0) {
      existing.dsh.profile.bundles = bundles.filter(bundle => !stale.includes(bundle));
      changed = true;
      console.log(`已从 profile 移除本仓不再提供的 bundle：${stale.join('、')}`);
    }
    for (const bundle of template.dsh.profile.bundles) {
      if (!existing.dsh?.profile?.bundles?.includes(bundle)) {
        // Product upgrade: append our new source bundle to our existing profile.
        // Preserve every user-owned override and all other manifest fields.
        if (!sourceBundles.includes(bundle) || !Array.isArray(existing.dsh?.profile?.bundles)) throw new Error(`profile 缺少 ${bundle}，请检查自己的配置；初始化不会重写配置。`);
        existing.dsh.profile.bundles.push(bundle);
        changed = true;
      }
    }
    if (changed) await writeFile(manifestFile, JSON.stringify(existing, null, 2) + '\n');
  } else {
    await writeFile(manifestFile, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' });
  }
  const patch = path.join(profile, 'cordis.patch.yml');
  if (!await exists(patch)) await writeFile(patch, await readFile(path.join(root, 'profiles', lock.profile, 'cordis.patch.yml')), { flag: 'wx' });
  // 宿主换版本时改指这两条链接（它们由本脚本创建）；用户自己放的实体目录不会被覆盖。
  // 本仓包链接从 `sourceBundles` 推导 —— 拆包后多出的包不需要在这里补行。
  const repointed = [];
  for (const [target, link] of [
    [path.join(host.modules, '@deepseek-ai'), path.join(profile, 'node_modules', '@deepseek-ai')],
    ...sourceBundles.map(name => [path.join(root, 'packages', name), path.join(profile, 'node_modules', name)]),
  ]) {
    if (await linkDirectory(target, link, { adopt: true }) === 'repointed') repointed.push(path.basename(link));
  }
  await mkdir(path.join(home, 'workspace'), { recursive: true });
  return { ...host, home: path.resolve(home), profile, repointed };
}
/**
 * 把 `profile.mjs start` 的额外参数拼成宿主参数表 —— **同名参数只出现一次**。
 *
 * 这里曾经是 `['--no-open', '--port', ZHIYUN_PORT ?? '3091', ...extra]`，于是
 * `npm start -- --port 3081` 会拼出 `--port 3091 --no-open --port 3081`，
 * 而宿主取**前一个** 3091：用户以为起在 3081，实际听的是 3091（那里常已被别的
 * 实例占着，于是表现为「启动了却打不开」，或报 EADDRINUSE 后连 webserver 一起
 * 拖垮十个依赖它的插件）。同名参数出现两次本身就是错的。
 *
 * 端口优先级：显式 `--port` / `--port=` > `ZHIYUN_PORT` > 3091。
 * `--no-open` 同理：调用方已经写了就不再补。
 *
 * @param extra - 传给宿主的额外参数（`process.argv.slice(3)`）。
 * @param envPort - `ZHIYUN_PORT` 的值，可为空。
 * @returns 宿主参数表。
 */
export function hostArgs(extra = [], envPort = undefined) {
  const hasExplicitPort = extra.some(arg => arg === '--port' || arg.startsWith('--port='));
  return [
    ...(extra.includes('--no-open') ? [] : ['--no-open']),
    ...(hasExplicitPort ? [] : ['--port', envPort ?? '3091']),
    ...extra,
  ];
}
export function runHost(runtime, args, { pipe = false } = {}) {
  return spawn(process.execPath, [runtime.cli, '--profile', lock.profile, ...args], {
    cwd: path.join(runtime.home, 'workspace'),
    env: { ...process.env, DSH_HOME: runtime.home },
    windowsHide: true, stdio: pipe ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'check';
    if (!['init', 'check', 'dump', 'start'].includes(command)) throw new Error('用法：profile.mjs init|check|dump|start');
    const runtime = await initialize({ home: process.env.ZHIYUN_DSH_HOME });
    console.log(`智云 Pro · DSH ${runtime.version}\n宿主: ${runtime.app}\nProfile: ${runtime.profile}\n数据: ${runtime.home}`);
    if (runtime.repointed?.length) console.log(`已把 profile 的宿主链接改指到当前安装：${runtime.repointed.join('、')}`);
    if (command === 'start' || command === 'dump') {
      // 只检查**声明了 dsh.client 的包**：它们的宿主半是空壳，少了 lib/client.js
      // 表现为「前端起来了但这一页空白」，比启动失败更难查。
      const missing = [];
      for (const name of sourceBundles) {
        const manifest = JSON.parse(await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8'));
        if (manifest.dsh?.client === undefined) continue;
        if (!await exists(path.join(root, 'packages', name, 'lib/client.js'))) missing.push(name);
      }
      if (missing.length > 0) throw new Error(`请先运行 npm run build（缺客户端产物：${missing.join('、')}）`);
      const extra = process.argv.slice(3);
      const args = command === 'dump' ? ['--dump-config'] : hostArgs(extra, process.env.ZHIYUN_PORT);
      const child = runHost(runtime, args);
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
      process.on('SIGINT', () => child.kill());
      process.on('SIGTERM', () => child.kill());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
