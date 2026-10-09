import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ClassroomSource } from '../packages/dsh-zhiyun-classroom/src/source.js';

test('streaming downloads validate Range, restart ignored Range, keep cancelled partial and refuse overwrites', async () => {
  const bytes = Buffer.from('0123456789'.repeat(1000));
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"v1"' });
      res.write(bytes.subarray(0, 100));
      const timer = setTimeout(() => res.end(bytes.subarray(100)), 5000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    if (req.url === '/ignore') offset = 0;
    res.writeHead(offset ? 206 : 200, { ETag: '"v1"', 'Content-Length': bytes.length - offset,
      ...(offset ? { 'Content-Range': `bytes ${req.url === '/bad' ? offset + 1 : offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    res.end(bytes.subarray(offset));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-download-'));
  const ds = new ClassroomSource();
  const seed = async (destination, url) => {
    await writeFile(`${destination}.part`, bytes.subarray(0, 100));
    const u = new URL(url); const identity = createHash('sha256').update(`${u.origin}${u.pathname}`).digest('hex');
    await writeFile(`${destination}.part.json`, JSON.stringify({ identity, etag: '"v1"' }));
  };
  try {
    for (const endpoint of ['/normal', '/ignore']) {
      const destination = path.join(dir, endpoint.slice(1)); await seed(destination, `${base}${endpoint}`);
      const out = await ds.downloadResource({ url: `${base}${endpoint}`, destination });
      assert.deepEqual(await readFile(destination), bytes); assert.equal(out.resumed, endpoint === '/normal');
      await assert.rejects(ds.downloadResource({ url: `${base}${endpoint}`, destination }), { code: 'FILE_EXISTS' });
    }
    const bad = path.join(dir, 'bad'); await seed(bad, `${base}/bad`);
    await assert.rejects(ds.downloadResource({ url: `${base}/bad`, destination: bad }), { code: 'DOWNLOAD_RANGE' });
    const controller = new AbortController(); const cancelled = path.join(dir, 'cancelled');
    await assert.rejects(ds.downloadResource({ url: `${base}/slow`, destination: cancelled, signal: controller.signal,
      onProgress: () => controller.abort() }), { code: 'CANCELLED' });
    assert.ok((await readFile(`${cancelled}.part`)).length < bytes.length);
    await assert.rejects(ds.downloadResource({ url: `${base}/normal`, destination: path.join(dir, 'too-large'), maxBytes: 1 }), { code: 'DOWNLOAD_SIZE' });
  } finally { await ds.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('batch slide downloads bound concurrency and report per-page failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-slides-'));
  let active = 0, maximum = 0;
  const ds = new ClassroomSource({ fetch: async url => {
    if (new URL(url).pathname.includes('search-ppt')) return new Response(JSON.stringify({ total: 5, list: Array.from({ length: 5 }, (_, i) => ({ created_sec: i, content: { pptimgurl: `https://example.test/${i}.jpg` } })) }));
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return new Response(url.includes('/2.jpg') ? 'missing' : 'image', { status: url.includes('/2.jpg') ? 404 : 200 });
  } });
  try {
    const summary = await ds.downloadSlides(1, 2, { directory: dir, concurrency: 2 });
    assert.equal(summary.succeeded, 4); assert.equal(summary.failed, 1); assert.equal(maximum, 2);
    assert.equal(summary.results[2].code, 'DOWNLOAD_HTTP');
    assert.equal(summary.sourceMeta.complete, true);
  } finally { await ds.dispose(); await rm(dir, { recursive: true, force: true }); }
});
