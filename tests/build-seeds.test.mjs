/**
 * 客户端包的 external 面守卫。
 *
 * 为什么值得一条常驻测试：`external` 漏一项，两种失效都极难第一眼归因 ——
 *   - 漏了本机解得开的词（如 `@deepseek-ai/cordis`）：esbuild **静默**把整包内联，
 *     产出里凭空多出几万字节，运行时插件与宿主各持一个实例。构建不报错。
 *   - 漏了本机解不开的词（如 `@deepseek-ai/dsh-client-ui-slots`）：`Could not resolve`，
 *     构建直接失败。
 * 而且漏掉的往往是宿主种子词 —— 宿主浏览器里明明有，本仓为什么解不开？很容易
 * 被误判成「依赖没装」而去动 package.json，把真正的原因（external 表缺项）越推越远。
 *
 * 这里做两件事：
 *   1. 静态扫：客户端入口可达的源码里，每个裸模块名都必须落在 HOST_SEEDS ∪ 本包
 *      `dsh.client.external` 里；
 *   2. 真实构建（不落盘）取 metafile：产出里不许出现任何本包 src/ 之外的文件。
 *      第 2 条才是真正的牙齿 —— 第 1 条只看名字，第 2 条能看见「到底把谁打进去了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClientPackage, CLIENT_PACKAGES, HOST_SEEDS } from '../scripts/build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 从某个文件出发，跟踪相对 import，收集全部裸模块名。 */
async function bareSpecifiers(entry) {
  const seen = new Set();
  const bare = new Map(); // 裸模块名 -> 首次出现的文件:行
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = await readFile(key, 'utf8');
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /(?:^|\s)(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/.exec(lines[i]);
      if (match === null) continue;
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        queue.push(path.resolve(path.dirname(key), specifier));
      } else if (!specifier.startsWith('node:')) {
        const at = `${path.relative(root, key)}:${i + 1}`;
        if (!bare.has(specifier)) bare.set(specifier, at);
      }
    }
  }
  return bare;
}

test('每个客户端包的裸模块 import 都被 HOST_SEEDS 或本包的 dsh.client.external 覆盖', async () => {
  const failures = [];
  let checked = 0;
  for (const name of CLIENT_PACKAGES) {
    const manifest = JSON.parse(await readFile(`${root}packages/${name}/package.json`, 'utf8'));
    const declared = new Set([...HOST_SEEDS, ...(manifest.dsh?.client?.external ?? [])]);
    const bare = await bareSpecifiers(`${root}packages/${name}/src/client.jsx`);
    for (const [specifier, at] of bare) {
      checked += 1;
      if (!declared.has(specifier)) failures.push(`${name}: ${at} import '${specifier}'，既不是宿主种子词也没写进 dsh.client.external`);
    }
  }
  // 防「一个 import 都没扫到」的假绿：7 个包至少各有一个 react。
  assert.ok(checked >= CLIENT_PACKAGES.length, `只检查了 ${checked} 个裸模块 import，扫描器可能失效`);
  assert.deepEqual(failures, [], `external 面不完整：\n${failures.join('\n')}`);
});

test('本包的 dsh.client.external 声明的每个包都真的被 import 了（没有过期声明）', async () => {
  const stale = [];
  for (const name of CLIENT_PACKAGES) {
    const manifest = JSON.parse(await readFile(`${root}packages/${name}/package.json`, 'utf8'));
    const declared = manifest.dsh?.client?.external ?? [];
    if (declared.length === 0) continue;
    const bare = await bareSpecifiers(`${root}packages/${name}/src/client.jsx`);
    for (const specifier of declared) {
      if (!bare.has(specifier)) stale.push(`${name}: dsh.client.external 声明了 '${specifier}' 但源码里没人 import`);
    }
  }
  assert.deepEqual(stale, [], `external 声明过期：\n${stale.join('\n')}`);
});

test('真实构建（不落盘）的产出里没有任何本包 src/ 之外的文件', async () => {
  for (const name of CLIENT_PACKAGES) {
    const { result } = await buildClientPackage(name, { write: false, metafile: true });
    const inputs = Object.keys(result.metafile.inputs).map((p) => path.resolve(root, p));
    const own = path.resolve(root, 'packages', name, 'src') + path.sep;
    const foreign = inputs.filter((p) => !p.startsWith(own));
    assert.deepEqual(foreign, [], `${name} 的产出内联了外部文件（external 漏项）：\n${foreign.join('\n')}`);
  }
});
