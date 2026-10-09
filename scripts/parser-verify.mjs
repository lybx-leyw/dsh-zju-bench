import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { root, lock } from './profile.mjs';
import { mountHost, lesson } from '../tests/fixtures/parser/host.mjs';

// Offline acceptance: actual host services, deterministic provider, synthetic content.
const report = [];
for (const version of lock.hostVersions) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-parser-verify-')); let host;
  try {
    host = await mountHost(version, dir);
    const output = await host.parser.parse(lesson());
    assert.equal(output.status, 'ready'); assert.equal(output.sentences.length, 2);
    assert.equal(output.sentences[0].text, '旧四史'); assert.equal(output.sentences[0].startMs, 1234);
    const calls = host.requests.length;
    const cached = await host.parser.parse(lesson()); assert.equal(host.requests.length, calls); assert.equal(cached.version, output.version);
    const artifacts = path.join(root, 'artifacts/parser'); await mkdir(artifacts, {recursive:true});
    await writeFile(path.join(artifacts, `lesson-${version}.json`), JSON.stringify(output,null,2)+'\n');
    report.push({hostVersion:version,provider:'deterministic-fixture',status:output.status,sentences:output.sentences.length,blocks:output.blocks.length,calls,cacheReused:true,realModelQualityVerified:false});
  } finally {await host?.dispose();await rm(dir,{recursive:true,force:true});}
}
await writeFile(path.join(root,'artifacts/parser/verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
