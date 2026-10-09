import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, readFile, writeFile, mkdir, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ClassroomError } from './errors.js';

const sizes = async file => { try { return (await stat(file)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
const activePaths = new Set();

export async function download(transport, { url, destination, signal, onProgress, maxBytes = 0, timeoutMs = 1200000 } = {}) {
  if (!path.isAbsolute(destination ?? '')) throw new TypeError('下载目标须为绝对路径');
  destination = path.resolve(destination);
  const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
  if (activePaths.has(key)) throw new ClassroomError('DOWNLOAD_BUSY', '此文件正在下载');
  activePaths.add(key);
  let opened;
  const partial = `${destination}.part`, metadata = `${partial}.json`;
  try {
    try { await stat(destination); throw new ClassroomError('FILE_EXISTS', '目标文件已存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const target = new URL(url);
    // Stable across signed query renewal, but never persist the signed URL.
    const identity = createHash('sha256').update(`${target.origin}${target.pathname}`).digest('hex');
    let cached;
    try { cached = JSON.parse(await readFile(metadata, 'utf8')); } catch { /* An unverified partial is restarted. */ }
    let offset = cached?.identity === identity && cached?.etag ? await sizes(partial) : 0;
    const headers = offset ? { Range: `bytes=${offset}-`, 'If-Range': cached.etag } : {};
    opened = await transport.request(url, { signal, headers, stream: true, auth: false, timeoutMs });
    const { response } = opened;
    const etag = response.headers.get('etag');
    let total = 0, resumed = false;
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[3]) <= Number(range[2])) throw new ClassroomError('DOWNLOAD_RANGE', '续传范围与本地文件不一致');
      total = Number(range[3]); resumed = offset > 0;
      if (offset && etag && etag !== cached.etag) throw new ClassroomError('DOWNLOAD_CHANGED', '资源已更新，无法续传旧文件');
    } else if (response.status === 200) {
      offset = 0; total = Number(response.headers.get('content-length') ?? 0);
    } else {
      throw new ClassroomError('DOWNLOAD_HTTP', '资源下载请求失败', { status: response.status });
    }
    if (!Number.isSafeInteger(total) || total < 0) throw new ClassroomError('DOWNLOAD_SIZE', '资源长度异常');
    if (maxBytes > 0 && total > maxBytes) throw new ClassroomError('DOWNLOAD_SIZE', '资源超过下载大小限制');
    if (!response.body) throw new ClassroomError('DOWNLOAD_BODY', '下载响应缺少内容');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(metadata, JSON.stringify({ identity, etag: etag?.startsWith('W/') ? null : etag }), { mode: 0o600 });
    let received = offset;
    const progress = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (maxBytes > 0 && received > maxBytes || total > 0 && received > total) return callback(new ClassroomError('DOWNLOAD_SIZE', '下载内容超出预期长度'));
      try { onProgress?.({ phase: 'download', received, total: total || null, resumed }); callback(null, chunk); } catch (error) { callback(error); }
    } });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }), { signal: opened.signal });
    if (total && received !== total) throw new ClassroomError('DOWNLOAD_INCOMPLETE', '资源尚未下载完整');
    // Atomic no-overwrite finalization even if another process creates the file.
    try { await link(partial, destination); } catch (error) { if (error.code === 'EEXIST') throw new ClassroomError('FILE_EXISTS', '目标文件已存在'); throw error; }
    await rm(partial); await rm(metadata, { force: true });
    return { destination, bytes: received, resumed };
  } catch (error) {
    if (error instanceof ClassroomError || error instanceof TypeError) throw error;
    if (opened?.signal.aborted || signal?.aborted) throw new ClassroomError(opened?.signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', '下载已取消或超时');
    throw new ClassroomError('DOWNLOAD_IO', '下载中断，已保留可续传的临时文件');
  } finally {
    if (opened) { await opened.response.body?.cancel().catch(() => {}); opened.release(); }
    activePaths.delete(key);
  }
}
