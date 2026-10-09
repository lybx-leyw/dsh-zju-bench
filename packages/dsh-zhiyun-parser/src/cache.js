import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export class ParserCache {
  constructor(directory) { this.directory = directory; this.memory = new Map(); }
  key(stage, inputs) { return hash(['zhiyun-parser-v1', stage, inputs]); }
  async get(key) {
    if (!this.directory) return this.memory.get(key) ?? null;
    try {
      const record = JSON.parse(await readFile(path.join(this.directory, `${key}.json`), 'utf8'));
      return record.schema === 1 && record.key === key && typeof record.raw === 'string' ? record : null;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async put(key, raw) {
    const record = { schema: 1, key, raw };
    if (!this.directory) { this.memory.set(key, record); return; }
    // 落盘交给宿主的原子替换：它处理了 Windows 上 rename 的瞬态
    // EACCES/EBUSY/EPERM 重试，并自行创建父目录 —— 手写 tmp+rename 只会得到
    // 一份更脆的副本（缓存半截写入会让下一次解析读到坏 JSON）。
    await writeFileAtomic(path.join(this.directory, `${key}.json`), JSON.stringify(record), { mode: 0o600 });
  }
}
export class Limiter {
  constructor(limit = 3) { this.limit = limit; this.active = 0; this.queue = []; }
  async run(task, signal) {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); } };
      const cancel = () => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason); };
      this.queue.push(entry); signal?.addEventListener('abort', cancel, { once: true });
    });
    else this.active++;
    try { signal?.throwIfAborted(); return await task(); }
    finally { const next = this.queue.shift(); if (next) next.resolve(); else this.active--; }
  }
}
