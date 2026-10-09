// Explicit live acceptance through the production workbench RPC. Credentials
// and model routing remain in the native host; no direct provider client.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { root } from './profile.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (!args.includes('--live')) throw Error('Use --live to authorize real parsing/model calls.');
const courseId = option('--course'), subId = option('--lesson');
if (![courseId, subId].every(v => /^\d+$/.test(v ?? ''))) throw Error('Provide --course and --lesson');
const context = option('--context', `${courseId} · ${subId}`);
const dir = path.resolve(option('--output', path.join(root, 'artifacts/study-recovery', `${courseId}-${subId}`)));
await fs.mkdir(dir, { recursive: true });
const log = await fs.readFile(option('--startup-log', path.join(root, '.runtime/physics-recovery-3081.log')), 'utf8');
const url = [...log.matchAll(/dsh web: (http:\/\/\S+)/g)].at(-1)?.[1];
if (!url) throw Error('Native host startup URL unavailable');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const started = Date.now();
const report = { courseId, subId, context, at: new Date().toISOString() };
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: '主要页面' }).waitFor({ timeout: 30000 });
  const rpc = async (method, extra = {}) => {
    const envelope = await page.evaluate(async ({ method, args }) => {
      const response = await fetch('/api/zhiyun-study', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'zhiyun-study', payload: { method, args } }), signal: AbortSignal.timeout(900000) });
      if (!response.ok) throw Error(`Study HTTP ${response.status}`);
      return response.json();
    }, { method, args: { courseId, subId, ...extra } });
    if (!envelope.result?.ok) throw Object.assign(Error(envelope.result?.error?.message ?? 'Study RPC failed'), { code: envelope.result?.error?.code });
    return envelope.result.value;
  };
  const state = await rpc('state');
  if (state.jobs?.length) throw Error('Workbench has an active parsing job; not replacing it');
  const previous = await rpc('result');
  const backup = `before-${Date.now()}.json`;
  await fs.writeFile(path.join(dir, backup), JSON.stringify(previous, null, 2));
  report.backup = backup;
  const job = await rpc('start', { context });
  console.log(JSON.stringify({ state: job.state, progress: job.progress }));
  let last = '';
  for (;;) {
    if (Date.now() - started > 1200000) throw Error('Live verification timed out; inspect the workbench job');
    const current = await rpc('result', { includeResult: false });
    const signature = JSON.stringify(current.job);
    if (signature !== last) { last = signature; console.log(JSON.stringify({ state: current.job?.state, progress: current.job?.progress, elapsedSeconds: Math.round((Date.now() - started) / 1000) })); }
    if (current.job?.state !== 'running') {
      if (!['ready', 'partial'].includes(current.job?.state)) throw Object.assign(Error(current.job?.error?.message ?? 'Parsing stopped'), { code: current.job?.error?.code });
      break;
    }
    await page.waitForTimeout(2000);
  }
  const { result } = await rpc('result');
  await fs.writeFile(path.join(dir, 'parsed.json'), JSON.stringify(result, null, 2));
  report.parsed = { status: result.status, pages: result.pages.length, transcribed: result.pages.filter(p => p.transcription).length,
    pageText: result.pages.filter(p => p.transcription?.pageText?.trim()).length, blocks: result.blocks.length,
    failures: result.failures, tagFailures: result.tagFailures, outlineFailure: result.outlineFailure,
    visionRequests: result.calls.filter(c => c.stage === 'faithful' && !c.cached).length,
    collageRequests: result.calls.filter(c => c.stage === 'faithful' && c.mode === 'collage' && !c.cached).length };
  console.log(JSON.stringify({ parsed: report.parsed }));
  if (report.parsed.transcribed !== report.parsed.pages) throw Error('Some slide descriptions still failed');
  if (args.includes('--generate-handout')) {
    console.log(JSON.stringify({ phase: 'handout', elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    const lecture = await rpc('lecture', { context });
    await fs.writeFile(path.join(dir, 'handout.json'), JSON.stringify(lecture, null, 2));
    report.lecture = { chapters: lecture.chapters.length, topics: lecture.chapters.reduce((n, c) => n + c.topics.length, 0), failures: lecture.failures, warnings: lecture.warnings };
    if (!report.lecture.topics) throw Error('No handout topics generated');
    console.log(JSON.stringify({ lecture: report.lecture }));
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = { code: error.code ?? 'RECOVERY', message: String(error.message).replace(/token=[^\s]+/g, 'token=[redacted]') };
  console.error(JSON.stringify(report.error)); process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - started;
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
