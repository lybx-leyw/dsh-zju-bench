import { object, shape } from './errors.js';
import { resourceUrl } from './urls.js';

const str = v => v == null ? '' : String(v);
const optional = v => v == null || v === '' ? null : String(v);
const number = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const integer = v => Math.trunc(number(v));
const bool = v => typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : ['1', 'true', 'yes'].includes(str(v).trim().toLowerCase());
export function embedded(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return object(value) ? value : null;
}
export function id(value, label = '标识') {
  const text = str(value);
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw shape(label, 'id');
  return text;
}
export function lessonKey(courseId, subId, tenant = '112') { return `zhiyun:${tenant}:${courseId}:${subId}`; }
export function course(row) {
  const progress = embedded(row.progress) ?? {};
  const info = embedded(row.information) ?? {};
  let fraction = number(progress.subjectProgress);
  if (!fraction) fraction = number(row.SubjectProgress);
  if (fraction > 1) fraction /= 100;
  return { id: id(row.Id, '课程'), title: str(row.Title), teacher: optional(row.Teacher),
    thumbUrl: optional(row.Thumb), termName: optional(row.TermName), collegeName: optional(row.KkxyName),
    courseCode: optional(info.kcdm), learnedCount: integer(progress.learnNum), totalCount: integer(progress.subjectNum),
    progress: Math.min(1, Math.max(0, fraction)) };
}
export function resources(content) {
  if (!content) return null;
  const files = Array.isArray(content.file_list) ? content.file_list.filter(object).map(f => ({
    type: str(f.file_type), url: str(f.file_name), path: optional(f.file_path),
  })) : [];
  const duration = content.save_playback?.contents_duration;
  if (duration != null && (!Number.isSafeInteger(Number(duration)) || Number(duration) < 0)) throw shape('资源', 'contents_duration');
  return { pptFileName: optional(content.download?.ppt?.file_name), pptUrl: optional(content.download?.ppt?.path_name),
    pptStatus: optional(content.api_pass?.ppt_status), qliteStatus: optional(content.api_pass?.qlite_status),
    videoUrl: optional(content.playback?.url), videoDurationNanos: duration == null ? null : Number(duration),
    videoDurationMs: duration == null ? null : Number(duration) / 1e6,
    coverUrl: files.find(f => /jpg|jpeg/i.test(f.type))?.url ?? null,
    thumbWebpUrl: files.find(f => /webp|wbp/i.test(f.type))?.url ?? null, files };
}
export function lesson(row) {
  const content = embedded(row.content);
  const courseId = id(row.course_id, '节次课程'), subId = id(row.sub_id, '节次');
  return { id: `${courseId}_${subId}`, sourceId: lessonKey(courseId, subId), courseId, subId,
    title: str(row.title), startAt: optional(row.start_at), status: str(row.status), isPlayable: str(row.status) === '6',
    videoUrl: optional(content?.playback?.url ?? content?.video_url), thumbUrl: optional(row.thumb),
    lecturerName: optional(row.lecturer_name), room: optional(row.room), resources: resources(content) };
}
export function slide(row, page) {
  const content = embedded(row.content);
  if (!content || !content.pptimgurl) throw shape('PPT', 'content.pptimgurl');
  const createdSec = integer(row.created_sec);
  return { page, imageUrl: resourceUrl(content.pptimgurl), text: optional(content.text), createdSec,
    startMs: createdSec * 1000, thumbUrl: content.pptthumb ? resourceUrl(content.pptthumb) : null, isKey: content.is_key === true,
    detectType: optional(content.detecttype), upstreamId: optional(row.old_id) };
}
export function subtitle(row) {
  if (row.BeginSec == null || row.EndSec == null || !Number.isFinite(Number(row.BeginSec)) || !Number.isFinite(Number(row.EndSec))) throw shape('字幕', 'BeginSec/EndSec');
  const startMs = Math.round(Number(row.BeginSec) * 1000), endMs = Math.round(Number(row.EndSec) * 1000);
  if (startMs < 0 || endMs < startMs) throw shape('字幕', '时间区间');
  return { startMs, endMs, text: str(row.Text).trim(), english: str(row.TransText).trim() };
}
export function scheduleEntry(row) {
  const courseId = id(row.course_id, '课表课程'), subId = id(row.id ?? row.sub_id, '课表节次');
  return { courseId, subId, sourceId: lessonKey(courseId, subId), courseTitle: str(row.course_title ?? row.title),
    teacherName: optional(row.teacher_name), lecturerName: optional(row.lecturer_name), roomName: optional(row.room_name),
    startAt: integer(row.start_at), endAt: integer(row.end_at), startMs: integer(row.start_at) * 1000, endMs: integer(row.end_at) * 1000,
    status: str(row.status), statusLabel: optional(row.status_label), isLive: bool(row.is_live), isPublic: bool(row.is_public),
    subShow: str(row.sub_show).toLowerCase() === 'yes' };
}
export function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new TypeError('日期须为 YYYY-MM-DD');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new TypeError('日期不存在');
  return value;
}
export function shanghaiDate(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
