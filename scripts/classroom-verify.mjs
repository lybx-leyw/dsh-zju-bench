import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClassroomSource, ClassroomError, ENDPOINTS } from '../packages/dsh-zhiyun-classroom/src/source.js';
import { shanghaiDate } from '../packages/dsh-zhiyun-classroom/src/models.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.log('真实验证需显式 --live；离线验证运行 npm run test:classroom。');
  process.exit(0);
}
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const report = { checkedAt: new Date().toISOString(), mode: 'live', checks: [] };
const source = new ClassroomSource({ sessionFile: path.join(root, '.runtime', 'classroom-verify', 'session.dpapi'),
  log: args.includes('--trace') ? event => console.log(JSON.stringify(event)) : undefined });
const add = (name, value) => { report.checks.push({ name, ...value }); console.log(`${name}: ${JSON.stringify(value)}`); };
try {
  let restored = args.includes('--fresh') ? { authenticated: false } : await source.restoreSession();
  if (!restored.authenticated || args.includes('--fresh')) {
    let username = process.env.ZJU_USER, password = process.env.ZJU_PASS;
    if (!username || !password) {
      const file = option('--credentials-file');
      if (!file) throw new ClassroomError('CREDENTIALS', '使用环境变量或 --credentials-file 指定本机凭据文件');
      const text = await readFile(file, 'utf8');
      const env = {};
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
        if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
      }
      username = env.ZJU_USER; password = env.ZJU_PASS;
    }
    restored = await source.login({ username, password });
    add('login', { ok: restored.authenticated, fresh: true });
  } else add('login', { ok: true, restored: true });
  const courses = await source.listCourses();
  add('courses', { count: courses.items.length, complete: courses.meta.complete, reason: courses.meta.reason, pages: courses.meta.pages });
  if (args.includes('--probe-pagination')) {
    const pages = [];
    for (const page of [1, 2]) pages.push((await source.transport.json(`${ENDPOINTS.courses}?nowpage=${page}&per-page=2&force_mycourse=1`, '分页探测')).params.result);
    add('course-pagination', { counts: pages.map(p => p.data.length), reportedPages: pages.map(p => p.page), reportedSizes: pages.map(p => p['per-page']), total: pages[0].total,
      repeated: JSON.stringify(pages[0].data.map(c => c.Id)) === JSON.stringify(pages[1].data.map(c => c.Id)) });
  }
  let selected = 0;
  for (const course of courses.items) {
    const lessons = await source.listLessons(course.id, { onlyPlayable: false });
    add('lessons', { count: lessons.items.length, playable: lessons.items.filter(l => l.isPlayable).length,
      statuses: [...new Set(lessons.items.map(l => l.status))] });
    const playable = lessons.items.filter(l => l.isPlayable).slice(0, 2);
    for (const lesson of playable) {
      const content = await source.getLessonContent(course.id, lesson.subId);
      add('content', { slides: content.slides.items.length, subtitles: content.subtitles.items.length,
        slidesComplete: content.slides.meta.complete, stopReason: content.slides.meta.reason,
        processingSuspected: content.slidesProcessingSuspected, hasVideo: !!lesson.videoUrl, hasCourseware: !!lesson.resources?.pptUrl });
      if (args.includes('--probe-resources') && selected === 0) {
        for (const [kind, url] of [['video', lesson.videoUrl], ['courseware', lesson.resources?.pptUrl], ['slide', content.slides.items[0]?.imageUrl]]) {
          if (!url) continue;
          const opened = await source.transport.request(url, { auth: false, stream: true, headers: { Range: 'bytes=0-4095' } });
          try {
            const { response } = opened;
            add('resource', { kind, status: response.status, rangeSupported: response.status === 206 && /^bytes 0-/.test(response.headers.get('content-range') ?? ''), contentType: response.headers.get('content-type') });
          } finally { await opened.response.body?.cancel(); opened.release(); }
        }
      }
      selected++;
    }
    if (selected >= 2) break;
  }
  if (!selected) add('content', { skipped: '账号下没有可播放节次' });
  const start = option('--start') ?? shanghaiDate(), end = option('--end') ?? start;
  const schedule = await source.getSchedule({ start, end });
  add('schedule', { start, end, days: schedule.items.length, entries: schedule.items.reduce((n, d) => n + d.courses.length, 0), reason: schedule.meta.reason });
  const emptyDate = option('--check-empty-date');
  if (emptyDate) {
    const empty = await source.getSchedule({ start: emptyDate, end: emptyDate });
    add('schedule-day', { date: emptyDate, days: empty.items.length, entries: empty.items.reduce((n, d) => n + d.courses.length, 0), reason: empty.meta.reason });
  }
  if (args.includes('--logout-at-end')) {
    await source.logout();
    add('logout', { clearedUser: await source.getCurrentUser() === null, authenticated: (await source.restoreSession()).authenticated });
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  const safe = error instanceof ClassroomError ? error.toJSON() : { code: 'VERIFY', message: '验证失败，请检查输入或本机文件' };
  report.failure = safe; console.error(JSON.stringify(safe)); process.exitCode = 1;
} finally {
  await source.dispose().catch(() => {});
  const dir = path.join(root, 'artifacts', 'classroom'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'live-verification.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dir, `live-${report.checkedAt.replaceAll(':', '-')}.json`), JSON.stringify(report, null, 2) + '\n');
}
