import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transport } from './transport.js';
import { SessionStore } from './session.js';
import { authenticate } from './auth.js';
import { ClassroomError, array, object, shape } from './errors.js';
import * as models from './models.js';
import { download } from './download.js';
export { ClassroomError } from './errors.js';
export { SessionStore } from './session.js';
export { Transport } from './transport.js';

export const ENDPOINTS = Object.freeze({
  courses: 'https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course',
  lessons: 'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue',
  slides: 'https://classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt',
  subtitles: 'https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result',
  schedule: 'https://yjapi.cmc.zju.edu.cn/courseapi/v2/schedule/get-week-schedules',
});
const query = (url, params) => `${url}?${new URLSearchParams(params)}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const loginQueues = new Map();
function rows(value, label, field, parse) {
  return array(value, label, field).map((row, i) => {
    if (!object(row)) throw shape(label, `${field}[${i}]`);
    return parse(row, i + 1);
  });
}
function totalOf(value) {
  for (const name of ['total', 'totalCount', 'total_count', 'total-count']) {
    if (value?.[name] != null && Number.isSafeInteger(Number(value[name])) && Number(value[name]) >= 0) return Number(value[name]);
  }
  return null;
}
function result(items, { complete = true, reason = 'single-response', total = null, pages = 1, ...extra } = {}) {
  return { items, meta: { source: 'zhiyun-classroom', fetchedAt: new Date().toISOString(), complete, reason, total, pages, version: digest(items), ...extra } };
}

export class ClassroomSource {
  constructor({ transport, sessionFile, protect, fetch, log, timeoutMs, maxPages = 20, pageSize = 100 } = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('分页限制须为正整数');
    this.transport = transport ?? new Transport({ session: new SessionStore({ file: sessionFile, protect }), fetch, log, timeoutMs });
    this.maxPages = maxPages; this.pageSize = pageSize; this.ready = this.transport.session.load();
  }
  async restoreSession(options = {}) {
    await this.ready;
    try { await this.listCourses(options); return { authenticated: true, user: await this.getCurrentUser() }; }
    catch (error) { if (error.code === 'SESSION_EXPIRED') return { authenticated: false, user: null }; throw error; }
  }
  async login(credentials, options = {}) {
    await this.ready;
    const account = createHash('sha256').update(String(credentials?.username ?? '')).digest('hex');
    const previous = Promise.allSettled([loginQueues.get(account) ?? Promise.resolve(), this.loginTask ?? Promise.resolve()]);
    const task = previous.then(async () => {
      options.signal?.throwIfAborted();
      await this.transport.session.clear();
      await authenticate(this.transport, credentials, options);
      await this.listCourses(options);
      return { authenticated: true, user: await this.getCurrentUser() };
    });
    loginQueues.set(account, task);
    this.loginTask = task;
    try { return await task; } finally { if (loginQueues.get(account) === task) loginQueues.delete(account); }
  }
  async logout() { await this.ready; this.transport.cancelAll(); await this.transport.session.clear(); }
  async getCurrentUser() {
    await this.ready;
    for (const host of ['interactivemeta.cmc.zju.edu.cn', 'yjapi.cmc.zju.edu.cn', 'education.cmc.zju.edu.cn', 'classroom.zju.edu.cn']) {
      const cookie = (await this.transport.session.jar.getCookies(`https://${host}/`)).find(c => c.key === 'JWTUser');
      if (!cookie) continue;
      try {
        const user = JSON.parse(decodeURIComponent(cookie.value));
        const id = user.sub ?? user.user_id ?? user.id;
        if (id != null) return { id: String(id), name: user.realname ?? user.real_name ?? null };
      } catch { /* User cookie may be malformed; no raw contents in errors. */ }
    }
    return null;
  }
  async listCourses({ signal } = {}) {
    await this.ready;
    const items = [], seen = new Set(), fingerprints = new Set();
    let total = null;
    for (let page = 1; page <= this.maxPages; page++) {
      const data = await this.transport.json(query(ENDPOINTS.courses, { nowpage: page, 'per-page': this.pageSize, force_mycourse: 1 }), '课程', { signal });
      const payload = data.params?.result;
      const raw = array(payload?.data, '课程', 'params.result.data');
      const parsed = rows(raw, '课程', 'data', models.course);
      total = totalOf(payload) ?? totalOf(payload?.pagination) ?? total;
      const fingerprint = digest(parsed.map(c => c.id));
      if (raw.length && fingerprints.has(fingerprint)) return result(items, { complete: total !== null && items.length >= total, reason: 'repeated-page', total, pages: page });
      fingerprints.add(fingerprint);
      for (const item of parsed) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
      if (total !== null && items.length >= total) return result(items, { reason: 'total', total, pages: page });
      if (!raw.length) return result(items, { complete: total === null || items.length >= total, reason: 'empty-page', total, pages: page });
      if (total === null && raw.length < this.pageSize) return result(items, { complete: null, reason: 'short-page-unverified', pages: page });
    }
    return result(items, { complete: false, reason: 'page-limit', total, pages: this.maxPages });
  }
  async listLessons(courseId, { onlyPlayable = true, signal } = {}) {
    await this.ready; courseId = models.id(courseId);
    const data = await this.transport.json(query(ENDPOINTS.lessons, { course_id: courseId }), '节次', { signal });
    const items = rows(data.result?.data, '节次', 'result.data', models.lesson);
    return result(onlyPlayable ? items.filter(l => l.isPlayable) : items);
  }
  async getSlides(courseId, subId, { signal, onProgress } = {}) {
    await this.ready; courseId = models.id(courseId); subId = models.id(subId);
    const items = [], seen = new Set(), fingerprints = new Set(), records = new Set();
    let total = null, received = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const data = await this.transport.json(query(ENDPOINTS.slides, { course_id: courseId, sub_id: subId, page, per_page: this.pageSize }), 'PPT', { signal });
      const raw = array(data.list, 'PPT', 'list'); total = totalOf(data) ?? total;
      const fingerprint = digest(raw);
      if (raw.length && fingerprints.has(fingerprint)) return result(items, { complete: total !== null && received >= total, reason: 'repeated-page', total, pages: page, received });
      fingerprints.add(fingerprint);
      const parsed = rows(raw, 'PPT', 'list', models.slide);
      // Overlapping pages must not count the same upstream record twice toward
      // total, otherwise partial responses could be mislabeled complete.
      raw.forEach((row, index) => records.add(digest([row.old_id ?? row.id ?? null, parsed[index].createdSec, parsed[index].imageUrl])));
      received = records.size;
      for (const item of parsed) {
        // Preserve a repeated image at a different time: these are distinct events.
        const key = `${item.imageUrl}\u0000${item.createdSec}`;
        if (!seen.has(key)) { seen.add(key); items.push({ ...item, page: items.length + 1 }); }
      }
      onProgress?.({ phase: 'slides', completed: received, total });
      if (total !== null && received >= total) return result(items, { reason: 'total', total, pages: page, received });
      if (!raw.length) return result(items, { complete: total === null || received >= total, reason: 'empty-page', total, pages: page, received });
      if (total === null && raw.length < this.pageSize) return result(items, { complete: null, reason: 'short-page-unverified', pages: page, received });
    }
    return result(items, { complete: false, reason: 'page-limit', total, pages: this.maxPages, received });
  }
  async getSubtitles(courseId, subId, { signal, onProgress } = {}) {
    await this.ready; models.id(courseId); subId = models.id(subId);
    const data = await this.transport.json(query(ENDPOINTS.subtitles, { sub_id: subId, format: 'json' }), '字幕', { signal });
    const items = rows(data.list, '字幕', 'list', row => rows(row.all_content, '字幕', 'all_content', models.subtitle))
      .flat().filter(s => s.text).sort((a, b) => a.startMs - b.startMs);
    onProgress?.({ phase: 'subtitles', completed: items.length, total: items.length });
    return result(items);
  }
  async getLessonContent(courseId, subId, options = {}) {
    const [slides, subtitles] = await Promise.all([this.getSlides(courseId, subId, options), this.getSubtitles(courseId, subId, options)]);
    return { sourceId: models.lessonKey(courseId, subId), courseId: String(courseId), subId: String(subId), slides, subtitles,
      slidesProcessingSuspected: subtitles.items.length > 50 && slides.items.length <= 2 };
  }
  async getSchedule({ start = models.shanghaiDate(), end = start, userId, signal } = {}) {
    await this.ready; models.date(start); models.date(end);
    if (end < start) throw new TypeError('结束日期早于开始日期');
    if ((Date.parse(end) - Date.parse(start)) / 86400000 >= 31) throw new TypeError('单次课表窗口不能超过 31 天');
    userId ??= (await this.getCurrentUser())?.id;
    if (!userId) throw new ClassroomError('SESSION_EXPIRED', '会话缺少课表所需用户标识');
    const data = await this.transport.json(query(ENDPOINTS.schedule, { user_id: userId, tenant_id: '112', start_at: start, end_at: end }), '课表', { signal });
    const payload = data.result;
    if (object(payload) && payload.list == null && payload.code != null && /课表/.test(String(payload.msg)) && /空/.test(String(payload.msg))) return result([], { reason: 'explicit-empty' });
    const items = rows(payload?.list, '课表', 'result.list', row => ({ day: models.date(row.day),
      courses: rows(row.course, '课表', 'course', models.scheduleEntry).sort((a, b) => a.startAt - b.startAt) })).sort((a, b) => a.day.localeCompare(b.day));
    return result(items);
  }
  async downloadResource(options) { await this.ready; return download(this.transport, options); }
  async downloadSlides(courseId, subId, { directory, concurrency = 6, signal, onProgress } = {}) {
    if (!path.isAbsolute(directory ?? '')) throw new TypeError('图片目录须为绝对路径');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError('图片并发须为 1–8');
    const slides = await this.getSlides(courseId, subId, { signal });
    const results = new Array(slides.items.length); let cursor = 0, completed = 0;
    const worker = async () => {
      while (cursor < slides.items.length && !signal?.aborted && !this.transport.closed) {
        const index = cursor++, slide = slides.items[index];
        // Fixed safe names with content identity; never use URL-supplied paths.
        const name = `${String(index + 1).padStart(4, '0')}-${digest([slide.imageUrl, slide.createdSec]).slice(0, 12)}.jpg`;
        try { results[index] = { page: slide.page, ok: true, ...await this.downloadResource({ url: slide.imageUrl, destination: path.join(directory, name), signal, maxBytes: 50 * 1024 * 1024 }) }; }
        catch (error) { results[index] = { page: slide.page, ok: false, code: error.code ?? 'DOWNLOAD' }; }
        completed++; onProgress?.({ phase: 'download-slides', completed, total: slides.items.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, slides.items.length) }, worker));
    if (signal?.aborted || this.transport.closed) throw new ClassroomError('CANCELLED', '图片下载已取消');
    return { results, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, sourceMeta: slides.meta };
  }
  async dispose() { this.transport.close(); await this.ready; await this.transport.session.pending; }
}
