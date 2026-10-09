import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeSlides, collageRequest, splitCollage } from '../packages/dsh-zhiyun-parser/src/vision.js';
import { LectureParser } from '../packages/dsh-zhiyun-parser/src/parser.js';
import { Transport } from '../packages/dsh-zhiyun-classroom/src/transport.js';
import { lock } from '../scripts/profile.mjs';
import { mountHost, answer, png } from './fixtures/parser/host.mjs';

const body = page => `## 页面文字\n本页概念${page}\n## 页面画面\n本页画面${page}\n## 术语\n本页术语${page}`;
const response = pages => pages.map(page => `# 页 ${page}\n${body(page)}`).join('\n');
function input(pages = [5, 9, 13, 16]) {
  return { context: '分组测试', sourceId: 'fixture:collage',
    slides: pages.map((page, i) => ({ page, createdSec: i * 10, imageBytes: png, mediaType: 'image/png' })),
    subtitles: pages.map((page, i) => ({ startMs: i * 10000 + 100, endMs: i * 10000 + 900, text: `第${page}页原文` })),
  };
}
const isVision = options => options.messages[0].content.some(b => b.type === 'image');
const variable = options => options.messages[0].content[1].text;
function model(options) {
  const v = variable(options);
  if (isVision(options)) {
    const pages = [...v.matchAll(/原课件第 (\d+) 页/g)].map(m => Number(m[1]));
    return pages.length ? response(pages) : body(Number(v.match(/这是第 (\d+) 页/)[1]));
  }
  if (options.messages[0].content[0].text.includes('逐块语音稿清洗器')) return '## 逐块标注\n块 1-1';
  return answer(options);
}
async function withHost(fn, respond = model, version = lock.hostVersions[0]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-collage-test-'));
  let host;
  try { host = await mountHost(version, dir, respond); await fn(host); }
  finally { await host?.dispose(); await rm(dir, { recursive: true, force: true }); }
}

test('collage keeps exact panel pixels, original page IDs and a blank fourth cell', async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff'];
  const images = await Promise.all(colors.map(async (background, i) => ({ page: [5, 9, 16][i], data: await sharp({ create: { width: 20, height: 10, channels: 3, background } }).png().toBuffer() })));
  const collage = await composeSlides(images);
  const meta = await sharp(collage.data).metadata();
  assert.deepEqual([meta.width, meta.height], [40, 100]);
  const pixels = await Promise.all([[0, 40], [20, 40], [0, 90], [20, 90]].map(([left, top]) => sharp(collage.data).extract({ left, top, width: 1, height: 1 }).raw().toBuffer()));
  assert.deepEqual(pixels.map(b => [...b]), [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]);
  const parts = collageRequest('课程', [5, 9, 16]);
  assert.match(parts.variable, /左下：原课件第 16 页/);
  assert.match(parts.variable, /不得抄入/);
});

test('collage rejects oversized images instead of shrinking them', async () => {
  const data = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(composeSlides([1, 2].map(page => ({ page, data }))), { code: 'COLLAGE_SIZE' });
});

test('splitter maps reordered IDs and rejects missing, duplicate or foreign pages', () => {
  assert.deepEqual([...splitCollage(response([9, 5]), [5, 9]).keys()], [9, 5]);
  assert.equal(splitCollage(response([5, 5, 9]), [5, 9]).has(5), false);
  assert.deepEqual([...splitCollage(response([5, 99]), [5, 9]).keys()], []);
  assert.equal(splitCollage(`# 页 5\n## 页面文字\n只有文字`, [5]).size, 0);
  assert.deepEqual([...splitCollage(response([5]), [5, 9]).keys()], [5]);
});

for (const version of lock.hostVersions) test(`DSH ${version}: four pages use one native vision call, preserve per-page provenance and reuse cache`, () => withHost(async host => {
  assert.equal(host.parser.visionBatchSize, 4);
  const progress = [];
  const result = await host.parser.parse({ ...input(), onProgress: event => progress.push(event) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.pages.map(p => [p.page, p.transcription.pageText]), [5, 9, 13, 16].map(p => [p, `本页概念${p}`]));
  assert.deepEqual(result.sentences.map(s => [s.page, s.text, s.startMs]), input().subtitles.map((s, i) => [input().slides[i].page, s.text, s.startMs]));
  const images = host.requests.filter(isVision);
  assert.equal(images.length, 1);
  assert.equal(images[0].messages[0].content.find(b => b.type === 'image').attachment.width, 2);
  assert.deepEqual(progress.filter(p => p.phase === 'faithful').map(p => p.done), [1, 2, 3, 4]);
  for (const request of host.requests.filter(r => !isVision(r))) {
    if (request.messages[0].content[0].text.includes('逐块语音稿清洗器')) {
      const v = variable(request), page = Number(v.match(/本页概念(\d+)/)[1]);
      for (const other of [5, 9, 13, 16].filter(p => p !== page)) assert.ok(!v.includes(`本页概念${other}`), 'only the corresponding panel reaches each mix request');
    }
  }
  const count = host.requests.length;
  const again = await host.parser.parse(input());
  assert.equal(host.requests.length, count);
  assert.equal(again.version, result.version);
  host.parser.visionBatchSize = 1;
  await host.parser.parse(input());
  assert.equal(host.requests.filter(isVision).length, 5, 'single-page rollback does not reuse collage descriptions');
}, model, version));

test('tail pages use a smaller collage, while a lone tail stays single', () => withHost(async host => {
  await host.parser.parse(input([1, 2, 3, 4, 5, 6, 7]));
  assert.equal(host.requests.filter(isVision).length, 2);
  assert.ok(host.requests.filter(isVision).some(r => [...variable(r).matchAll(/原课件第 /g)].length === 3));
  const count = host.requests.filter(isVision).length;
  await host.parser.parse(input([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(host.requests.filter(isVision).length, count + 1);
  assert.match(variable(host.requests.filter(isVision).at(-1)), /这是第 8 页/);
}));

test('legacy HTTP slide addresses reach native collage parsing through HTTPS', () => withHost(async host => {
  const fetched = [];
  const transport = new Transport({ fetch: async url => { fetched.push(url); return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
  host.parser.classroom = { transport };
  try {
    const lesson = input();
    lesson.slides = lesson.slides.map(({ imageBytes, ...slide }) => ({ ...slide, imageUrl: `http://video.cmc.zju.edu.cn/${slide.page}.png?signature=a%2Fb` }));
    const result = await host.parser.parse(lesson);
    assert.equal(result.status, 'ready');
    assert.equal(result.pages.filter(p => p.transcription?.pageText).length, 4);
    assert.deepEqual(result.failedPages, []);
    assert.ok(fetched.every(url => url.startsWith('https://video.cmc.zju.edu.cn/') && url.endsWith('?signature=a%2Fb')));
    assert.equal(host.requests.filter(isVision).length, 1);
  } finally { transport.close(); }
}));

test('incomplete collage supplements only the bad page and retains valid neighbors', () => withHost(async host => {
  const result = await host.parser.parse(input());
  assert.equal(result.status, 'ready');
  const requests = host.requests.filter(isVision);
  assert.equal(requests.length, 2);
  assert.match(variable(requests[1]), /这是第 9 页/);
  assert.match(result.warnings.join('\n'), /页面 9/);
  assert.deepEqual(result.failedPages, []);
  const count = host.requests.length; await host.parser.parse(input()); assert.equal(host.requests.length, count);
}, options => isVision(options) && variable(options).includes('原课件第') ? response([5, 13, 16]) + '\n# 页 9\n## 页面文字\n缺少画面和术语' : model(options)));

test('truncated collage falls back to single calls without caching partial text', () => withHost(async host => {
  const result = await host.parser.parse(input());
  assert.equal(result.status, 'ready');
  assert.equal(host.requests.filter(isVision).length, 5);
  assert.match(result.warnings.join('\n'), /TRUNCATED/);
}, options => isVision(options) && variable(options).includes('原课件第') ? { chunks: [
  { type: 'text-delta', index: 0, text: response([5]) }, { type: 'finish', reason: { kind: 'max-tokens' } },
] } : model(options)));

test('damaged panel keeps all subtitles and allows neighbors to finish', () => withHost(async host => {
  const lesson = input(); lesson.slides[1].imageBytes = Buffer.from('broken image');
  const result = await host.parser.parse(lesson);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failedPages, [9]);
  assert.equal(result.sentences.length, 4);
  assert.ok(result.pages.filter(p => p.page !== 9).every(p => p.transcription));
}));

test('cancelled batch stream does not initiate single-page retries', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  await withHost(async host => {
    const task = host.parser.parse(input());
    const rejected = assert.rejects(task, { code: 'CANCELLED' });
    await started; host.parser.dispose(); await rejected;
    assert.equal(host.requests.length, 1);
    assert.equal(host.parser.limiter.active, 0);
  }, options => { entered(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); });
});

test('batch config validates early', () => {
  const llm = { resolve() {}, call() {}, image() {} };
  for (const visionBatchSize of [0, 5, 1.5]) assert.throws(() => new LectureParser({ llm, visionBatchSize }), { code: 'CONFIG' });
});

test('three concurrent collage requests cover twelve pages and share the global model limit', async () => {
  let entered = 0, notify, release, active = 0, peak = 0;
  const allEntered = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await withHost(async host => {
    const job = host.parser.parse(input(Array.from({ length: 12 }, (_, i) => i + 1)));
    try {
      await allEntered;
      assert.equal(host.requests.length, 3);
      assert.ok(host.requests.every(r => [...variable(r).matchAll(/原课件第 /g)].length === 4));
    } finally { release(); }
    const result = await job;
    assert.equal(result.status, 'ready');
    assert.equal(result.sentences.length, 12);
    assert.equal(peak, 3);
  }, async options => {
    active++; peak = Math.max(peak, active);
    try {
      if (isVision(options)) { if (++entered === 3) notify(); await gate; }
      else await new Promise(resolve => setImmediate(resolve));
      return model(options);
    } finally { active--; }
  });
});

test('one collage still feeds three simultaneous page mixes', async () => {
  let entered = 0, notify, release;
  const started = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await withHost(async host => {
    const task = host.parser.parse(input());
    try {
      await started;
      assert.equal(host.parser.limiter.active, 3);
      assert.equal(host.requests.filter(isVision).length, 1);
    } finally { release(); }
    assert.equal((await task).status, 'ready');
  }, async options => {
    if (options.messages[0].content[0].text.includes('逐块语音稿清洗器')) {
      if (++entered === 3) notify();
      await gate;
    }
    return model(options);
  });
});
