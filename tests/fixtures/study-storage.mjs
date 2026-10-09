import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { root, lock } from '../../scripts/profile.mjs';
import * as knowledge from '../../packages/dsh-zhiyun-knowledge/src/index.js';
export async function mountKnowledge(directory) {
  const anchor = path.join(root, '.runtime', `dsh-${lock.preferredHostVersion ?? lock.hostVersions[0]}`);
  const require = createRequire(path.join(anchor, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { default: Storage }, Json, Domain] = await Promise.all(['cordis', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain'].map(load));
  const ctx = new Context();
  await ctx.plugin(Storage); await ctx.plugin(Json, { root: path.join(directory, 'storage') }); await ctx.plugin(Domain, { backend: 'json' });
  ctx.provide('profileContext', { dir: anchor }); await ctx.plugin(knowledge);
  return { service: ctx.get('zhiyunKnowledge'), dispose: () => ctx.fiber.dispose() };
}
