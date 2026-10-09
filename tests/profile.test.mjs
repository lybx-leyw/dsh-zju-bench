import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { initialize, locateHost, root, lock, exists, hostArgs, sourceBundles } from '../scripts/profile.mjs';
import { activePage, matchingPages, beijingDate } from '../packages/dsh-zhiyun-shell/src/model.js';

test('navigation preserves native conversation and ignores foreign panel ids', () => {
  assert.equal(activePage(null), 'ask');
  assert.equal(activePage('zhiyun.today'), 'today');
  assert.equal(activePage('other-plugin'), null);
  assert.deepEqual(matchingPages('规划').map(page => page.id), ['ask']);
  assert.equal(matchingPages('未知页面').length, 0);
});
test('date uses Beijing midnight even when machine timezone differs', () => {
  assert.match(beijingDate(new Date('2026-10-06T16:01:00Z')), /10月7日/);
});
test('profile initialization is isolated, repeatable, and preserves user data and overlays', async () => {
  const parent = path.join(root, '.runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'profile-'));
  const first = await initialize({ home });
  const patch = path.join(first.profile, 'cordis.patch.yml');
  const custom = '# user overlay\n[]\n';
  await writeFile(patch, custom);
  await writeFile(path.join(home, 'user-note.txt'), 'keep my notes');
  const manifest = path.join(first.profile, 'package.json');
  const data = JSON.parse(await readFile(manifest, 'utf8'));
  data.description = 'user customization';
  await writeFile(manifest, JSON.stringify(data));
  await initialize({ home });
  assert.equal(await readFile(patch, 'utf8'), custom);
  assert.equal(await readFile(path.join(home, 'user-note.txt'), 'utf8'), 'keep my notes');
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).description, 'user customization');
  assert.equal(await realpath(path.join(first.profile, 'node_modules', 'dsh-zhiyun-shell')), await realpath(path.join(root, 'packages/dsh-zhiyun-shell')));
  assert.deepEqual(data.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-zhiyun-shell', 'dsh-zhiyun-ui-primitives', 'dsh-zhiyun-classroom', 'dsh-zhiyun-parser', 'dsh-zhiyun-study-core', 'dsh-zhiyun-lecture', 'dsh-zhiyun-final-pass', 'dsh-zhiyun-quiz', 'dsh-zhiyun-notes', 'dsh-zhiyun-knowledge', 'dsh-zhiyun-page-today', 'dsh-zhiyun-page-courses', 'dsh-zhiyun-page-study', 'dsh-zhiyun-page-me']);
  // 每个本仓包都要有 profile 里的目录链接 —— 漏一个的表现是「启动了但那一页空白」。
  for (const name of sourceBundles) {
    assert.equal(await realpath(path.join(first.profile, 'node_modules', name)), await realpath(path.join(root, 'packages', name)), `${name} 缺 profile 链接`);
  }
});
test('foreign profile is refused without overwriting its manifest', async () => {
  const parent = path.join(root, '.runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'foreign-'));
  const dir = path.join(home, 'profiles', lock.profile);
  await mkdir(dir, { recursive: true });
  const original = '{"name":"someone-elses-profile"}';
  await writeFile(path.join(dir, 'package.json'), original);
  await assert.rejects(initialize({ home }), /不属于智云/);
  assert.equal(await readFile(path.join(dir, 'package.json'), 'utf8'), original);
});
test('existing product profile upgrades the parser bundle while preserving overlays', async () => {
  const parent = path.join(root, '.runtime', 'tests'); await mkdir(parent,{recursive:true});
  const home = await mkdtemp(path.join(parent,'parser-upgrade-')); const runtime = await initialize({home});
  const file = path.join(runtime.profile,'package.json'), manifest = JSON.parse(await readFile(file,'utf8'));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b=>!['dsh-zhiyun-parser','dsh-zhiyun-lecture','dsh-zhiyun-final-pass','dsh-zhiyun-quiz','dsh-zhiyun-notes','dsh-zhiyun-knowledge'].includes(b)); manifest.custom = {preserved:true};
  const overlay = path.join(runtime.profile,'cordis.patch.yml'); await writeFile(overlay,'# preserve my routes\n[]\n');
  await writeFile(file,JSON.stringify(manifest)); await initialize({home});
  const upgraded = JSON.parse(await readFile(file,'utf8')); assert.deepEqual(upgraded.custom,manifest.custom);
  assert.deepEqual(upgraded.dsh.profile.bundles,[...manifest.dsh.profile.bundles,'dsh-zhiyun-parser','dsh-zhiyun-lecture','dsh-zhiyun-final-pass','dsh-zhiyun-quiz','dsh-zhiyun-notes','dsh-zhiyun-knowledge']);
  assert.equal(await readFile(overlay,'utf8'),'# preserve my routes\n[]\n');
  assert.equal(await realpath(path.join(runtime.profile,'node_modules/dsh-zhiyun-parser')),await realpath(path.join(root,'packages/dsh-zhiyun-parser')));
  assert.equal(await realpath(path.join(runtime.profile,'node_modules/dsh-zhiyun-lecture')),await realpath(path.join(root,'packages/dsh-zhiyun-lecture')));
  assert.equal(await realpath(path.join(runtime.profile,'node_modules/dsh-zhiyun-final-pass')),await realpath(path.join(root,'packages/dsh-zhiyun-final-pass')));
});

test('existing product profile adds the source bundle without replacing user settings', async () => {
  const parent = path.join(root, '.runtime', 'tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'upgrade-')); const runtime = await initialize({ home });
  const file = path.join(runtime.profile, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b => b !== 'dsh-zhiyun-classroom');
  manifest.dsh.profile.bundles.push('my-custom-plugin'); manifest.description = 'keep custom description';
  await writeFile(file, JSON.stringify(manifest));
  const patch = path.join(runtime.profile, 'cordis.patch.yml'); await writeFile(patch, '# custom overrides\n[]\n');
  await initialize({ home });
  const actual = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(actual.description, 'keep custom description');
  assert.deepEqual(actual.dsh.profile.bundles, [...manifest.dsh.profile.bundles, 'dsh-zhiyun-classroom']);
  assert.equal(await readFile(patch, 'utf8'), '# custom overrides\n[]\n');
});
test('改名/拆包后，profile 里指向已不存在的本仓包会被移除', async () => {
  // ⚠️ 这条钉的是拆包真机踩过的坑：`dsh-zhiyun-pro-ui` 改名成 `dsh-zhiyun-shell` 之后，
  //    老 profile 里仍留着旧名 —— Loader 解不开那一行，整个 profile 起不来。
  //    只清 `retiredBundles` 登记表里的旧名，不做前缀猜测：同前缀但没登记的条目
  //    可能来自别的分支或用户自己链进来的包。
  const parent = path.join(root, '.runtime', 'tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'rename-'));
  const runtime = await initialize({ home });
  const file = path.join(runtime.profile, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b => !['dsh-zhiyun-shell', 'dsh-zhiyun-study-core'].includes(b));
  manifest.dsh.profile.bundles.splice(2, 0, 'dsh-zhiyun-pro-ui', 'dsh-zhiyun-study');
  manifest.dsh.profile.bundles.push('my-custom-plugin', 'dsh-zhiyun-not-ours');
  await writeFile(file, JSON.stringify(manifest));
  await initialize({ home });
  const actual = JSON.parse(await readFile(file, 'utf8')).dsh.profile.bundles;
  assert.ok(!actual.includes('dsh-zhiyun-pro-ui'), '旧名必须被移除');
  assert.ok(!actual.includes('dsh-zhiyun-study'), '旧名必须被移除');
  assert.ok(actual.includes('dsh-zhiyun-shell'), '新包要被补上');
  assert.ok(actual.includes('dsh-zhiyun-study-core'), '新包要被补上');
  assert.ok(actual.includes('my-custom-plugin'), '用户自己的插件不许动');
  assert.ok(actual.includes('dsh-zhiyun-not-ours'), '不认识的本仓前缀条目也不许动（可能来自别的分支）');
});

test('unsupported host version fails with an actionable error', async () => {
  const parent = path.join(root, '.runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const app = await mkdtemp(path.join(parent, 'wrong-host-'));
  const dir = path.join(app, 'node_modules', '@deepseek-ai', 'dsh');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), '{"version":"0.9.0"}');
  await assert.rejects(locateHost({ ZHIYUN_DSH_APP_DIR: app }), /不能混用版本/);
});

test('本机已安装版本不受支持时，回退到仓库内已验证的临时安装', async (t) => {
  const parent = path.join(root, '.runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const fallback = path.join(root, '.runtime', `dsh-${lock.preferredHostVersion}`);
  if (!await exists(fallback)) return t.skip(`本机没有 ${fallback}，无法验证回退`);
  // 装一个「不受支持的本机 DSH Desktop」：回退只能落在清单内的版本上，不能拿它凑合。
  const local = await mkdtemp(path.join(parent, 'localappdata-'));
  const app = path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app');
  await mkdir(path.join(app, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(path.join(app, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"version":"0.1.5-rc.2"}');
  const host = await locateHost({ LOCALAPPDATA: local });
  assert.equal(host.version, lock.preferredHostVersion, '回退应落在首选版本上');
  assert.match(host.app, /[\\/]\.runtime[\\/]dsh-/);
});

test('宿主换版本时改指链接，但用户自己的实体目录不覆盖', async (t) => {
  const parent = path.join(root, '.runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const [first, second] = lock.hostVersions.map(version => path.join(root, '.runtime', `dsh-${version}`));
  if (!await exists(first) || !await exists(second)) return t.skip('本机没有两份临时安装，无法验证换宿主');
  const home = await mkdtemp(path.join(parent, 'switch-'));
  assert.equal((await initialize({ home, env: { ZHIYUN_DSH_APP_DIR: first } })).version, lock.hostVersions[0]);
  const switched = await initialize({ home, env: { ZHIYUN_DSH_APP_DIR: second } });
  assert.equal(switched.version, lock.hostVersions[1]);
  assert.ok(switched.repointed.includes('@deepseek-ai'), '换宿主应改指宿主链接');
  // 把那条链接换成用户自己放的实体目录 → 一律不覆盖，直接报错。
  const link = path.join(home, 'profiles', lock.profile, 'node_modules', '@deepseek-ai');
  await rm(link, { recursive: true, force: true });
  await mkdir(link, { recursive: true });
  await assert.rejects(initialize({ home, env: { ZHIYUN_DSH_APP_DIR: first } }), /未覆盖/);
});
test('启动参数里同名参数只出现一次（显式 --port 优先，不再拼出两个）', () => {
  // ⚠️ 这条钉的是一个真机上踩过的坑：`npm start -- --port 3081` 曾拼出
  //    `--port 3091 --no-open --port 3081`，宿主取前一个 3091 —— 用户以为
  //    起在 3081，实际听 3091（常被别的实例占着），表现为「启动了却打不开」。
  const countPorts = args => args.filter(a => a === '--port' || a.startsWith('--port=')).length;
  const countNoOpen = args => args.filter(a => a === '--no-open').length;

  assert.deepEqual(hostArgs(['--port', '3081'], undefined), ['--no-open', '--port', '3081']);
  assert.equal(countPorts(hostArgs(['--port', '3081'], undefined)), 1, '显式 --port 不许再补一个');
  assert.equal(countPorts(hostArgs(['--port=3081'], '3091')), 1);
  assert.deepEqual(hostArgs([], '3081'), ['--no-open', '--port', '3081'], 'ZHIYUN_PORT 生效');
  assert.deepEqual(hostArgs([], undefined), ['--no-open', '--port', '3091'], '都没给时用默认端口');
  // 调用方自己写了 --no-open 时不许再补一个（实测命令行里出现过两个）。
  assert.equal(countNoOpen(hostArgs(['--no-open', '--port', '3081'], undefined)), 1);
  assert.deepEqual(hostArgs(['--no-open', '--port', '3081'], undefined), ['--no-open', '--port', '3081']);
  // 额外参数原样带上，且位置在端口之后。
  assert.deepEqual(hostArgs(['--verbose'], '3081'), ['--no-open', '--port', '3081', '--verbose']);
});
