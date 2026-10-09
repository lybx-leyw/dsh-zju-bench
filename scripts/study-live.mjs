// Explicit live acceptance: genuine classroom data and native DSH LLM/agents.
// Secrets stay in the launching environment and login request, never artifacts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { initialize, runHost, root } from './profile.mjs';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!args.includes('--live')) throw new Error('Use --live --credentials-file <local path> to run paid real-model acceptance.');
const credentialsFile = option('--credentials-file');
if (!credentialsFile) throw new Error('Missing --credentials-file');
const env = Object.fromEntries((await readFile(credentialsFile, 'utf8')).split(/\r?\n/).flatMap(l => {
  const m = l.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/); return m ? [[m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const dir = path.join(root, 'artifacts/study-live'); await mkdir(dir, { recursive: true });
const runtime = await initialize({ home: path.join(root, '.runtime/study-live') });
const endpoint = raw => { const s = raw.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''); return /\/v\d+$/.test(s) ? s : `${s}/v1`; };
const routes = {};
for (const [stage, base, key, model] of [
  ['vision', env.FUSION_BASE_URL, env.FUSION_API_KEY, env.FUSION_VISION_MODEL],
  ['text', env.FUSION_TEXT_BASE_URL || env.FUSION_BASE_URL, env.FUSION_TEXT_API_KEY || env.FUSION_API_KEY, env.FUSION_TEXT_MODEL],
  ['agent', env.ZHIYUN_AGENT_BASE_URL || env.FUSION_BASE_URL, env.ZHIYUN_AGENT_API_KEY || env.FUSION_API_KEY, env.ZHIYUN_AGENT_MODEL || env.FUSION_TEXT_MODEL],
]) {
  if (!base || !key || !model) throw new Error(`Missing ${stage} model configuration`);
  const ref = `ZHIYUN_LIVE_${stage.toUpperCase()}_KEY`; process.env[ref] = key;
  routes[`zhiyun-live-${stage}`] = { api: 'openai-completions', baseURL: endpoint(base), apiKeyEnv: ref,
    models: [{ id: model, input: stage === 'vision' ? ['text', 'image'] : ['text'], contextWindow: 1048576, maxTokens: 32768, reasoningEfforts: { off: null, high: 'high' },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek', supportsReasoningEffort: false } }] };
}
const patch = [
  { id: 'llm-pi-ai', config: { providers: routes } },
  { id: 'agent-default-model', config: { provider: 'zhiyun-live-agent', model: env.ZHIYUN_AGENT_MODEL || env.FUSION_TEXT_MODEL, reasoningEffort: 'off' } },
  { id: 'zhiyun-parser', config: { concurrency: 3, vision: { provider: 'zhiyun-live-vision', model: env.FUSION_VISION_MODEL }, text: { provider: 'zhiyun-live-text', model: env.FUSION_TEXT_MODEL } } },
  { id: 'zhiyun-final-pass', config: { permissionPreset: 'workspace-write', timeoutMs: 1800000 } },
];
await writeFile(path.join(runtime.profile, 'cordis.patch.yml'), yaml.dump(patch));
let server, browser, page, hostLog = '', url;
const report = { at: new Date().toISOString(), hostVersion: runtime.version, checks: [], errors: [] };
const secrets = [env.ZJU_PASS, env.ZJU_USER, ...Object.entries(env).filter(([k]) => /KEY|COOKIE/.test(k)).map(([, v]) => v)].filter(Boolean);
const redact = input => secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), String(input)).replace(/token=[^\s"&]+/g, 'token=[redacted]');
const log = message => console.log(redact(message));
async function rpc(method, payload = {}) {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch('/api/zhiyun-study', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'zhiyun-study', payload: { method, args: payload } }) });
    const body = await response.json(); if (!body.result?.ok) throw new Error(JSON.stringify(body.result?.error ?? { status: response.status })); return body.result.value;
  }, { method, payload });
}
async function settle() {
  for (let i = 0; i < 24; i++) {
    for (const name of ['继续', '稍后配置']) { const b = page.getByRole('button', { name, exact: true }); if (await b.isVisible().catch(() => false) && await b.isEnabled()) await b.click(); }
    await page.waitForTimeout(200);
  }
}
try {
  server = runHost(runtime, ['--no-open', '--port', '0'], { pipe: true });
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host startup timeout')), 60000);
    const consume = data => { hostLog += String(data); const m = hostLog.match(/dsh web: (http:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } };
    server.stdout.on('data', consume); server.stderr.on('data', consume); server.on('error', reject);
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}`)); });
  });
  browser = await chromium.launch({ channel: 'msedge', headless: true }); page = await browser.newPage({ viewport: { width: 1536, height: 1050 } });
  page.on('pageerror', e => report.errors.push(redact(e.message)));
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await settle(); log('Native DSH host started.');
  const state = await rpc('state');
  if (!state.user) await rpc('login', { username: env.ZJU_USER, password: env.ZJU_PASS });
  report.checks.push('Real classroom authentication');
  let selected;
  try { selected = JSON.parse(await readFile(path.join(dir, 'selected.json'), 'utf8')); } catch {}
  if (!selected) {
    const courses = await rpc('courses');
    for (const course of courses.items) {
      const lessons = await rpc('lessons', { courseId: course.id });
      for (const lesson of lessons.items.filter(l => l.isPlayable).slice(0, 3)) {
        const content = await rpc('content', { courseId: course.id, subId: lesson.subId });
        log(`Candidate: ${course.title} / ${lesson.title}: ${content.slides.items.length} pages, ${content.subtitles.items.length} subtitles`);
        if (content.slides.meta.complete && content.subtitles.meta.complete && content.slides.items.length >= 4 && content.slides.items.length <= 65 && content.subtitles.items.length >= 50) { selected = { course, lesson }; break; }
      }
      if (selected) break;
    }
    if (!selected) throw new Error('No complete suitable lesson found');
    await writeFile(path.join(dir, 'selected.json'), JSON.stringify(selected, null, 2));
  }
  const key = { courseId: selected.course.id, subId: selected.lesson.subId };
  const content = await rpc('content', key);
  report.lesson = { title: selected.course.title + ' · ' + selected.lesson.title, pages: content.slides.items.length, subtitles: content.subtitles.items.length, complete: content.slides.meta.complete && content.subtitles.meta.complete };
  log(`Selected FULL lesson: ${JSON.stringify(report.lesson)}`);
  let result = (await rpc('result', key)).result;
  if (!result || args.includes('--reparse') || result.status !== 'ready') {
    await rpc('start', { ...key, context: report.lesson.title });
    let previous = '';
    for (;;) {
      const status = await rpc('result', { ...key, includeResult: false });
      const progress = JSON.stringify(status.job?.progress);
      if (progress !== previous) { log(progress); previous = progress; }
      if (status.job?.state !== 'running') { if (status.job?.state === 'failed') throw new Error(JSON.stringify(status.job.error)); break; }
      await page.waitForTimeout(1500);
    }
    result = (await rpc('result', key)).result;
  }
  await writeFile(path.join(dir, 'final-transcript.json'), JSON.stringify(result, null, 2));
  report.transcript = { status: result.status, sentences: result.sentences.length, unassigned: result.unassignedSentences.length, blocks: result.blocks.length, failedPages: result.failedPages, tagFailures: result.tagFailures, outlineFailure: result.outlineFailure };
  log(`Final transcript: ${JSON.stringify(report.transcript)}`);
  if (result.status !== 'ready') throw new Error('Parser did not converge');
  if (result.sentences.length + result.unassignedSentences.length !== content.subtitles.items.length) throw new Error('Subtitle coverage mismatch');
  report.checks.push('Full lesson transcript saved in knowledge domain; no subtitle truncation');
  if (option('--stage') === 'parse') { report.ok = true; }
  else {
    if (!result.lecture || args.includes('--regenerate')) { log('Generating handout with native host LLM…'); await rpc('lecture', { ...key, context: report.lesson.title }); }
    result = (await rpc('result', key)).result;
    if (!result.lecture.review) await writeFile(path.join(dir, 'lecture-before-review.json'), JSON.stringify(result.lecture, null, 2));
    const sourceBefore = JSON.stringify([result.pages, result.sentences, result.blocks]);
    if (option('--stage') !== 'lecture' && (!result.lecture.review || args.includes('--review'))) { log('Reviewing handout with native DSH agents/subagents…'); await rpc('final-pass', key); }
    result = (await rpc('result', key)).result;
    if (JSON.stringify([result.pages, result.sentences, result.blocks]) !== sourceBefore) throw new Error('Handout processing modified final transcript');
    await writeFile(path.join(dir, 'lecture.json'), JSON.stringify(result.lecture, null, 2));
    report.handout = { chapters: result.lecture.chapters.length, topics: result.lecture.chapters.flatMap(c => c.topics).length, failures: result.lecture.failures, reviewed: !!result.lecture.review, reviewUnchanged: result.lecture.review?.unchanged };
    log(`Handout: ${JSON.stringify(report.handout)}`);
    const restoredRevision = result.lecture.revision;
    const topic = result.lecture.chapters.flatMap(c => c.topics)[0];
    const hits = await rpc('search', { courseId: key.courseId, query: topic.title, layer: 'lecture' });
    if (!hits.some(h => h.subId === key.subId && h.matches.some(m => m.field === 'lecture'))) throw new Error('Persisted handout search failed');
    await page.reload({ waitUntil: 'domcontentloaded' }); await settle();
    if ((await rpc('result', key)).result.lecture.revision !== restoredRevision) throw new Error('Reload changed handout revision');
    report.checks.push('Current persisted handout searchable independently; reload retains reviewed revision');
    const nav = name => page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name, exact: true });
    await nav('学习').click();
    await page.locator('.zs-course-toggle').filter({ hasText: selected.course.title }).first().click();
    await page.getByRole('button', { name: new RegExp(selected.lesson.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).last().click();
    await page.getByRole('tab', { name: '讲义', exact: true }).click();
    await page.locator('.zs-handout-topic').first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(dir, 'handout.png'), fullPage: true });
    await page.locator('.zs-source-anchor').first().click(); await page.locator('.zs-block').first().waitFor();
    await page.screenshot({ path: path.join(dir, 'final-transcript.png'), fullPage: true });
    report.checks.push('Rendered structured handout; source jump opens independent final transcript; reload restores domain data');
    report.ok = report.errors.length === 0;
  }
} catch (error) {
  report.ok = false; report.failure = redact(error.message); log(`FAIL ${report.failure}`); process.exitCode = 1;
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(dir, 'host.log'), redact(hostLog));
  await browser?.close(); if (server && !server.killed) server.kill();
}
