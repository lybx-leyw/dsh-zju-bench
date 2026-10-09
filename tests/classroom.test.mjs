import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClassroomSource, SessionStore, Transport } from '../packages/dsh-zhiyun-classroom/src/source.js';
import { rsaEncrypt, executionToken, nextLocation } from '../packages/dsh-zhiyun-classroom/src/auth.js';
import * as models from '../packages/dsh-zhiyun-classroom/src/models.js';
import { apply } from '../packages/dsh-zhiyun-classroom/src/index.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function source(handler, options = {}) { return new ClassroomSource({ fetch: handler, ...options }); }
const slide = (n, sec = n) => ({ old_id: n, created_sec: sec, content: JSON.stringify({ pptimgurl: `https://example.test/${n}.jpg`, text: '课件', detecttype: 'ppt' }) });
const course = n => ({ Id: n, Title: `课程${n}` });

test('CAS RSA vector and UTF-8 match Dart protocol; execution attribute order and relative refresh', () => {
  assert.equal(rsaEncrypt('A', '10001', '3'), '30bd'.padStart(128, '0'));
  assert.equal(rsaEncrypt('', '10001', '3'), '0'.repeat(128));
  assert.throws(() => rsaEncrypt('x', '0', '3'));
  assert.throws(() => rsaEncrypt('x', '1', '0'));
  assert.equal(executionToken("<input value='secret-token' name='execution'>"), 'secret-token');
  assert.equal(nextLocation({ headers: new Headers(), text: '<meta content="0; URL=/next?a=1&amp;b=2" http-equiv="refresh">' }, 'https://classroom.zju.edu.cn/start'), 'https://classroom.zju.edu.cn/next?a=1&b=2');
  assert.throws(() => nextLocation({ headers: new Headers({ location: 'https://foreign.test/' }), text: '' }, 'https://classroom.zju.edu.cn/'));
});
test('models preserve resource metadata and all time units', () => {
  const c = models.course({ ...course(8), progress: '{"subjectProgress":80,"learnNum":4,"subjectNum":5}', information: '{"kcdm":"ABC"}' });
  assert.equal(c.progress, 0.8); assert.equal(c.courseCode, 'ABC'); assert.equal(c.id, '8');
  const l = models.lesson({ course_id: 8, sub_id: 9, status: 6, content: JSON.stringify({ playback: { url: 'https://example.test/video' },
    save_playback: { contents_duration: 123000000000 }, api_pass: { ppt_status: 'finished' }, file_list: [{ file_type: '0_objpic_wbp_ebp', file_name: 'thumb' }] }) });
  assert.equal(l.resources.videoDurationMs, 123000); assert.equal(l.resources.thumbWebpUrl, 'thumb');
  assert.equal(l.sourceId, 'zhiyun:112:8:9'); assert.equal(l.isPlayable, true); assert.equal(l.resources.pptUrl, null);
  assert.deepEqual(models.subtitle({ BeginSec: '1.2345', EndSec: '2.8', Text: ' 原文 ', TransText: ' English ' }), { startMs: 1235, endMs: 2800, text: '原文', english: 'English' });
  assert.equal(models.slide(slide(1, 10), 1).startMs, 10000);
  assert.equal(models.shanghaiDate(new Date('2026-10-06T16:00:00Z')), '2026-10-07');
  assert.throws(() => models.date('2026-02-31'));
});

test('legacy classroom media URLs upgrade to HTTPS without changing signatures or leaking session cookies', async () => {
  const url = 'http://video.cmc.zju.edu.cn/media/slide.jpg?signature=a%2Fb%2Bc&x=1&x=2';
  const mapped = models.slide({ created_sec: 2, content: { pptimgurl: url, pptthumb: url } }, 1);
  assert.equal(mapped.imageUrl, url.replace('http:', 'https:'));
  assert.equal(mapped.thumbUrl, mapped.imageUrl);
  const session = new SessionStore();
  await session.jar.setCookie('iPlanetDirectoryPro=private; Domain=zju.edu.cn; Path=/; Secure', 'https://zjuam.zju.edu.cn/');
  const seen = [];
  const transport = new Transport({ session, fetch: async (target, options) => { seen.push(target); assert.equal(options.headers.Cookie, undefined); return new Response('image'); } });
  try {
    await transport.request(url);
    assert.deepEqual(seen, [mapped.imageUrl]);
    await assert.rejects(transport.request('http://video.cmc.zju.edu.cn.foreign.test/slide.jpg'), { code: 'URL' });
    await assert.rejects(transport.request('http://foreign.test/slide.jpg'), { code: 'URL' });
    assert.equal(seen.length, 1);
  } finally { transport.close(); }
});
test('mock CAS-to-classroom login keeps SSO on CAS, supports serialization and classifies rejection', async () => {
  let activePosts = 0, maxPosts = 0;
  const events = [];
  const ds = source(async (url, options) => {
    const target = new URL(url); events.push({ host: target.hostname, cookie: options.headers.Cookie ?? '' });
    if (target.pathname === '/cas/v2/getPubKey') return json({ modulus: '10001', exponent: '3' });
    if (options.method === 'POST') {
      activePosts++; maxPosts = Math.max(maxPosts, activePosts);
      assert.equal(options.body.get('execution'), 'token');
      assert.equal(options.body.get('password').length, 128);
      await new Promise(resolve => setTimeout(resolve, 10)); activePosts--;
      return new Response('', { status: 302, headers: { 'Set-Cookie': 'iPlanetDirectoryPro=sso; Domain=zju.edu.cn; Path=/; Secure', location: 'https://zjuam.zju.edu.cn/' } });
    }
    if (target.pathname === '/cas/login') return new Response('<input name="execution" value="token">');
    if (target.hostname === 'tgmedia.cmc.zju.edu.cn' && target.pathname === '/index.php') return new Response('', { status: 302, headers: { location: 'https://zjuam.zju.edu.cn/cas/oauth2.0/authorize' } });
    if (target.pathname === '/cas/oauth2.0/authorize') { assert.match(options.headers.Cookie, /sso/); return new Response('', { status: 302, headers: { location: 'https://tgmedia.cmc.zju.edu.cn/callback' } }); }
    if (target.pathname === '/callback') return new Response('', { status: 302, headers: { 'Set-Cookie': 'JWTUser=%7B%22sub%22%3A%221%22%7D; Domain=cmc.zju.edu.cn; Path=/; Secure', location: 'https://classroom.zju.edu.cn/' } });
    if (target.hostname === 'education.cmc.zju.edu.cn') return json({ params: { result: { total: 1, data: [course(1)] } } });
    return new Response('classroom');
  });
  await Promise.all([ds.login({ username: 'mock-user', password: 'mock-password' }), ds.login({ username: 'mock-user', password: 'mock-password' })]);
  assert.equal(maxPosts, 1); assert.equal((await ds.getCurrentUser()).id, '1');
  assert.ok(events.filter(e => e.host !== 'zjuam.zju.edu.cn').every(e => !e.cookie.includes('iPlanetDirectoryPro')));
  await ds.logout(); assert.equal(await ds.getCurrentUser(), null);
  const rejected = source(url => new URL(url).pathname.includes('getPubKey') ? json({ modulus: '10001', exponent: '3' }) : new Response('<input name="execution" value="token">'));
  await assert.rejects(rejected.login({ username: 'mock-user', password: 'mock-password' }), { code: 'AUTH_REJECTED' });
});
test('courses fetch multiple pages, detect ignored pagination, and report unknown completeness', async () => {
  let requests = 0;
  const ds = source(url => { requests++; const page = Number(new URL(url).searchParams.get('nowpage')); return json({ code: 1000, params: { result: { total: 3, data: page === 1 ? [course(1), course(2)] : [course(3)] } } }); }, { pageSize: 2 });
  const actual = await ds.listCourses(); assert.equal(requests, 2); assert.equal(actual.meta.complete, true); assert.equal(actual.items.length, 3);
  const repeating = await source(() => json({ params: { result: { total: 3, data: [course(1), course(2)] } } }), { pageSize: 2 }).listCourses();
  assert.equal(repeating.meta.complete, false); assert.equal(repeating.meta.reason, 'repeated-page');
  const unknown = await source(() => json({ params: { result: { data: [course(1)] } } })).listCourses();
  assert.equal(unknown.meta.complete, null);
  await assert.rejects(source(() => json({ params: { result: {} } })).listCourses(), { code: 'API_SHAPE' });
});
test('PPT preserves repeated images at distinct timestamps and signals partial/invalid pages', async () => {
  const ds = source(url => { const page = Number(new URL(url).searchParams.get('page')); return json({ total: 3, list: page === 1 ? [slide(1, 1), slide(1, 9)] : [slide(2, 10)] }); }, { pageSize: 2 });
  const actual = await ds.getSlides(1, 2); assert.equal(actual.items.length, 3); assert.equal(actual.meta.complete, true); assert.equal(actual.items[1].startMs, 9000);
  const partial = await source(() => json({ total: 3, list: [slide(1)] }), { maxPages: 1 }).getSlides(1, 2);
  assert.equal(partial.meta.complete, false); assert.equal(partial.meta.reason, 'page-limit');
  const repeated = await source(() => json({ total: 3, list: [slide(1)] })).getSlides(1, 2);
  assert.equal(repeated.meta.complete, false); assert.equal(repeated.meta.reason, 'repeated-page');
  const overlap = await source(url => json({ total: 3, list: Number(new URL(url).searchParams.get('page')) === 1 ? [slide(1), slide(2)] : [slide(2)] })).getSlides(1, 2);
  assert.equal(overlap.meta.complete, false); assert.equal(overlap.items.length, 2);
  await assert.rejects(source(() => json({ list: null })).getSlides(1, 2), { code: 'API_SHAPE' });
});
test('subtitles validate nested shape, preserve intervals, sort, and allow actual empty lists', async () => {
  const actual = await source(() => json({ list: [{ all_content: [{ BeginSec: 2, EndSec: 3, Text: 'B' }, { BeginSec: 0, EndSec: 1, Text: 'A' }] }] })).getSubtitles(1, 2);
  assert.deepEqual(actual.items.map(s => s.text), ['A', 'B']);
  assert.equal((await source(() => json({ list: [] })).getSubtitles(1, 2)).items.length, 0);
  await assert.rejects(source(() => json({ list: [{ wrong: [] }] })).getSubtitles(1, 2), { code: 'API_SHAPE' });
});
test('schedule only accepts explicit empty envelope; validates dates before HTTP', async () => {
  const options = { userId: '1', start: '2026-10-05', end: '2026-10-11' };
  assert.equal((await source(() => json({ success: true, result: { code: 400, msg: '课表为空' } })).getSchedule(options)).meta.reason, 'explicit-empty');
  await assert.rejects(source(() => json({ result: { code: 400, msg: '其他错误' } })).getSchedule(options), { code: 'API_SHAPE' });
  await assert.rejects(source(() => json({ success: false, result: { code: 400, msg: '课表为空' } })).getSchedule(options), { code: 'BUSINESS' });
  let count = 0; const ds = source(() => { count++; return json({}); });
  await assert.rejects(ds.getSchedule({ ...options, start: '2026-02-31' }));
  await assert.rejects(ds.getSchedule({ ...options, end: '2026-10-01' }));
  assert.equal(count, 0);
  const valid = await source(() => json({ result: { code: 400, msg: '课表为空', list: [{ day: '2026-10-05', course: [] }] } })).getSchedule(options);
  assert.equal(valid.items.length, 1);
});
test('transport separates session, service, HTML and network failures; logs exclude bodies and secrets', async () => {
  for (const [response, code] of [[new Response('private-token', { status: 401 }), 'SESSION_EXPIRED'], [new Response('<html>private</html>', { status: 503 }), 'HTTP'], [new Response('<html>private</html>'), 'API_SHAPE'], [new Response('<input name="execution" value="token">'), 'SESSION_EXPIRED']]) {
    const events = []; const ds = source(() => response, { log: event => events.push(event) });
    await assert.rejects(ds.listCourses(), error => error.code === code && !JSON.stringify(error).includes('private'));
    assert.ok(!JSON.stringify(events).includes('private-token'));
  }
  const network = source(() => { throw new Error('password=secret'); });
  await assert.rejects(network.listCourses(), error => error.code === 'NETWORK' && !error.message.includes('secret'));
  const expired = source(() => new Response('', { status: 401 }));
  assert.equal((await expired.restoreSession()).authenticated, false);
  await assert.rejects(network.restoreSession(), { code: 'NETWORK' });
});
test('cookies respect domain/path and never attach SSO to a CDN; disposal cancels active HTTP', async () => {
  const session = new SessionStore();
  await session.jar.setCookie('iPlanetDirectoryPro=secret; Path=/cas; Secure', 'https://zjuam.zju.edu.cn/cas/login');
  let headers;
  const transport = new Transport({ session, fetch: (url, opts) => { headers = opts.headers; return new Response('ok'); } });
  await transport.request('https://cdn.example.test/video'); assert.equal(headers.Cookie, undefined);
  await transport.request('https://classroom.zju.edu.cn/'); assert.equal(headers.Cookie, undefined);
  await transport.request('https://zjuam.zju.edu.cn/cas/login'); assert.match(headers.Cookie, /secret/);
  const waiting = new Transport({ fetch: (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const promise = waiting.json('https://classroom.zju.edu.cn/', '测试'); waiting.close();
  await assert.rejects(promise, { code: 'CANCELLED' });
  await assert.rejects(waiting.request('https://classroom.zju.edu.cn/'), { code: 'DISPOSED' });
});
test('Windows persisted sessions are encrypted, restore correctly and logout removes user cookie', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-session-')); const file = path.join(dir, 'session.dpapi');
  try {
    const session = new SessionStore({ file });
    await session.jar.setCookie('JWTUser=%7B%22sub%22%3A%221%22%7D; Path=/; Secure', 'https://classroom.zju.edu.cn/');
    await session.save(); assert.ok(!(await readFile(file)).includes(Buffer.from('JWTUser')));
    const restored = new SessionStore({ file }); await restored.load();
    assert.equal((await restored.jar.getCookies('https://classroom.zju.edu.cn/')).length, 1);
    await restored.clear(); const cleared = new SessionStore({ file }); await cleared.load();
    assert.equal((await cleared.jar.getCookies('https://classroom.zju.edu.cn/')).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Cordis registers an independent service without logging in and cancels it on unmount', async () => {
  let service, dispose;
  dispose = await apply({ profileContext: { dir: path.join(tmpdir(), `zhiyun-plugin-${Date.now()}`) }, provide: (key, value) => { assert.equal(key, 'zhiyunClassroom'); service = value; } });
  assert.equal(await service.getCurrentUser(), null); await dispose(); assert.equal(service.transport.closed, true);
});
