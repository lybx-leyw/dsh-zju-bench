import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ClassroomSource, ENDPOINTS } from '../packages/dsh-zhiyun-classroom/src/source.js';
import * as models from '../packages/dsh-zhiyun-classroom/src/models.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const fixtureFile = path.join(root, 'tests', 'fixtures', 'classroom', 'sanitized-api.json');
const artifacts = path.join(root, 'artifacts', 'classroom');
await mkdir(artifacts, { recursive: true });
if (args.includes('--capture-live')) {
  const ds = new ClassroomSource({ sessionFile: path.join(root, '.runtime', 'classroom-verify', 'session.dpapi') });
  try {
    if (!(await ds.restoreSession()).authenticated) throw new Error('先运行真实验证建立会话');
    const rawCourses = (await ds.transport.json(`${ENDPOINTS.courses}?nowpage=1&per-page=100&force_mycourse=1`, '课程')).params.result.data;
    let rawLesson, selectedCourse;
    for (const c of rawCourses) {
      const lessons = (await ds.transport.json(`${ENDPOINTS.lessons}?course_id=${c.Id}`, '节次')).result.data;
      rawLesson = lessons.find(l => String(l.status) === '6');
      if (rawLesson) { selectedCourse = c; break; }
    }
    if (!rawLesson) throw new Error('没有可播放样本');
    const ppt = await ds.transport.json(`${ENDPOINTS.slides}?course_id=${selectedCourse.Id}&sub_id=${rawLesson.sub_id}&page=1&per_page=100`, 'PPT');
    const asr = await ds.transport.json(`${ENDPOINTS.subtitles}?sub_id=${rawLesson.sub_id}&format=json`, '字幕');
    const user = await ds.getCurrentUser();
    const schedule = await ds.transport.json(`${ENDPOINTS.schedule}?user_id=${encodeURIComponent(user.id)}&tenant_id=112&start_at=2026-10-05&end_at=2026-10-11`, '课表');
    // Explicit allowlist: no real titles, identities, URLs, text or tokens persist.
    const typedId = (v, n) => typeof v === 'string' ? String(n) : n;
    const encodeLike = (original, v) => typeof original === 'string' ? JSON.stringify(v) : v;
    const keep = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
    const p = models.embedded(selectedCourse.progress) ?? {}, info = models.embedded(selectedCourse.information) ?? {};
    const c = { ...keep(selectedCourse, ['SubjectProgress']), Id: typedId(selectedCourse.Id, 1), Title: '示例课程', Teacher: '示例教师', Thumb: 'https://example.test/cover.jpg', TermName: '示例学期', KkxyName: '示例学院',
      progress: encodeLike(selectedCourse.progress, keep(p, ['subjectProgress', 'learnNum', 'subjectNum'])), information: encodeLike(selectedCourse.information, info.kcdm == null ? {} : { kcdm: 'CODE' }) };
    const content = models.embedded(rawLesson.content) ?? {};
    const safeContent = { api_pass: keep(content.api_pass ?? {}, ['ppt_status', 'qlite_status']),
      save_playback: keep(content.save_playback ?? {}, ['contents_duration']),
      ...(content.playback?.url ? { playback: { url: 'https://example.test/video.mp4' } } : {}),
      ...(content.video_url ? { video_url: 'https://example.test/video-fallback.mp4' } : {}),
      download: { ppt: content.download?.ppt ? { ...(content.download.ppt.file_name ? { file_name: 'example.pptx' } : {}), ...(content.download.ppt.path_name ? { path_name: 'https://example.test/example.pptx' } : {}) } : null },
      file_list: (content.file_list ?? []).map((f, i) => ({ file_type: f.file_type, file_name: `https://example.test/file-${i}`, ...(f.file_path ? { file_path: `/file-${i}` } : {}) })) };
    const l = { ...keep(rawLesson, ['status', 'start_at']), course_id: typedId(rawLesson.course_id, 1), sub_id: typedId(rawLesson.sub_id, 2), title: '示例节次', thumb: 'https://example.test/thumb.jpg', lecturer_name: '示例教师', room: '示例教室', content: encodeLike(rawLesson.content, safeContent) };
    const slides = ppt.list.map((s, i) => { const content = models.embedded(s.content) ?? {}; return { created_sec: s.created_sec, old_id: i + 1, content: encodeLike(s.content, { ...keep(content, ['is_key', 'detecttype']), pptimgurl: `https://example.test/slide-${i}.jpg`, ...(content.pptthumb ? { pptthumb: `https://example.test/thumb-${i}.jpg` } : {}), ...(content.text != null ? { text: `示例页${i + 1}` } : {}) }) }; });
    const subtitles = asr.list.flatMap(s => s.all_content).map((s, i) => ({ ...keep(s, ['BeginSec', 'EndSec']), Text: s.Text?.trim() ? `示例字幕${i + 1}` : '', TransText: s.TransText?.trim() ? `Translation ${i + 1}` : '' }));
    const entries = schedule.result.list.flatMap(d => d.course).map((e, i) => ({ ...keep(e, ['start_at', 'end_at', 'status', 'status_label', 'is_live', 'is_public', 'sub_show']), course_id: typedId(e.course_id, 1), id: typedId(e.id, i + 2), course_title: '示例课程', teacher_name: '示例教师', lecturer_name: '示例教师', room_name: '示例教室' }));
    await mkdir(path.dirname(fixtureFile), { recursive: true });
    await writeFile(fixtureFile, JSON.stringify({ origin: 'live API shape, all identifying values replaced', courses: [c], lessons: [l], slides, subtitles, schedule: entries }, null, 2) + '\n');
    console.log(`已保存脱敏结构样本：${slides.length} 页、${subtitles.length} 句、${entries.length} 条课表`);
  } finally { await ds.dispose(); }
}
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
const flutterRoot = value('--flutter-root') ?? path.resolve(root, '../zhiyun-pro');
const modelPath = path.join(flutterRoot, 'lib/bridge/classroom_models.dart'); await access(modelPath);
const dart = `import 'dart:convert';
import 'dart:io';
import '${pathToFileURL(modelPath).href}';
void main(List<String> args) {
 final f=jsonDecode(File(args[0]).readAsStringSync()) as Map<String,dynamic>;
 Map<String,dynamic> map(dynamic v)=>Map<String,dynamic>.from(v as Map);
 final courses=(f['courses'] as List).map((r){final c=ClassroomCourse.fromApi(map(r));return {'id':c.id.toString(),'title':c.title,'teacher':c.teacher,'thumbUrl':c.thumbUrl,'termName':c.termName,'collegeName':c.collegeName,'courseCode':c.courseCode,'learnedCount':c.learnedCount,'totalCount':c.totalCount,'progress':c.progress};}).toList();
 final lessons=(f['lessons'] as List).map((r){final l=ClassroomVideo.fromApi(map(r));final v=l.resources;return {'id':l.id,'courseId':l.courseId.toString(),'subId':l.subId.toString(),'title':l.title,'startAt':l.startAt,'status':l.status,'videoUrl':l.videoUrl,'thumbUrl':l.thumbUrl,'lecturerName':l.lecturerName,'room':l.room,'resources':v==null?null:{'pptFileName':v.pptFileName,'pptUrl':v.pptUrl,'pptStatus':v.pptStatus,'qliteStatus':v.qliteStatus,'videoUrl':v.videoUrl,'videoDurationNanos':v.videoDurationNanos,'coverUrl':v.coverUrl,'thumbWebpUrl':v.thumbWebpUrl,'files':v.files.map((x)=>{'type':x.type,'url':x.url,'path':x.path}).toList()}};}).toList();
 int page=0;
 final slides=(f['slides'] as List).map((r){final s=ClassroomSlide.fromApi(map(r),++page);return {'page':s.page,'imageUrl':s.imageUrl,'text':s.text,'createdSec':s.createdSec,'thumbUrl':s.thumbUrl,'isKey':s.isKey,'detectType':s.detectType};}).toList();
 final subtitles=(f['subtitles'] as List).map((r){final s=ClassroomSubtitle.fromApi(map(r));return {'startMs':s.startMs,'endMs':s.endMs,'text':s.text,'english':s.english};}).toList();
 final schedule=(f['schedule'] as List).map((r){final e=ClassroomScheduleEntry.fromApi(map(r));return {'courseId':e.courseId.toString(),'subId':e.subId.toString(),'courseTitle':e.courseTitle,'teacherName':e.teacherName,'lecturerName':e.lecturerName,'roomName':e.roomName,'startAt':e.startAt,'endAt':e.endAt,'status':e.status,'statusLabel':e.statusLabel,'isLive':e.isLive,'isPublic':e.isPublic,'subShow':e.subShow};}).toList();
 print(jsonEncode({'courses':courses,'lessons':lessons,'slides':slides,'subtitles':subtitles,'schedule':schedule}));
}`;
const runner = path.join(artifacts, 'model-parity.dart'); await writeFile(runner, dart);
let dartExecutable = process.env.DART_EXECUTABLE ?? 'dart';
if (process.platform === 'win32' && !process.env.DART_EXECUTABLE) {
  const command = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command dart).Source'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', c => out += c); child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('找不到 Dart SDK')));
  });
  dartExecutable = command.endsWith('.bat') ? path.join(path.dirname(command), 'cache', 'dart-sdk', 'bin', 'dart.exe') : command;
  await access(dartExecutable);
}
const expected = await new Promise((resolve, reject) => {
  const child = spawn(dartExecutable, [runner, fixtureFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], error = [];
  // 攒 Buffer 再整体解 UTF-8：逐块 `out += chunk` 会在多字节字符跨块时把它切成替换字符。
  child.stdout.on('data', c => out.push(c)); child.stderr.on('data', c => error.push(c));
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(Buffer.concat(out).toString('utf8'))) : reject(new Error(Buffer.concat(error).toString('utf8'))));
});
const omit = (item, keys) => Object.fromEntries(Object.entries(item).filter(([k]) => !keys.includes(k)));
const actual = { courses: fixture.courses.map(models.course), lessons: fixture.lessons.map(models.lesson).map(l => {
  l = omit(l, ['sourceId', 'isPlayable']); if (l.resources) l.resources = omit(l.resources, ['videoDurationMs']); return l;
}), slides: fixture.slides.map(models.slide).map((s, i) => ({ ...omit(s, ['startMs', 'upstreamId']), page: i + 1 })),
subtitles: fixture.subtitles.map(models.subtitle), schedule: fixture.schedule.map(models.scheduleEntry).map(e => omit(e, ['sourceId', 'startMs', 'endMs'])) };
assert.deepEqual(actual, expected);
if (args.includes('--capture-live')) await writeFile(path.join(path.dirname(fixtureFile), 'dart-models.json'), JSON.stringify(expected, null, 2) + '\n');
await writeFile(path.join(artifacts, 'dart-model-parity.json'), JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(actual).map(([key, values]) => [key, values.length])) }, null, 2) + '\n');
console.log('Dart 与 JS 模型逐字段对照通过。');
