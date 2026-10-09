import { CookieJar } from 'tough-cookie';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { ClassroomError } from './errors.js';

// Windows user-bound DPAPI: plaintext only travels over anonymous pipes, never
// command arguments, environment variables or a temporary plaintext file.
export async function dpapi(bytes, decrypt = false) {
  if (process.platform !== 'win32') throw new ClassroomError('STORAGE', '持久化会话需要 Windows DPAPI 或自定义保护器');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; try { $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r)) } catch { exit 1 }`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => reject(new ClassroomError('STORAGE', '无法启动会话保护器')));
    child.on('close', code => code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new ClassroomError('STORAGE', '会话保护器失败')));
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

export class SessionStore {
  constructor({ file, protect = dpapi } = {}) {
    this.file = file; this.protect = protect; this.jar = new CookieJar(); this.pending = Promise.resolve(); this.epoch = 0;
  }
  async load() {
    if (!this.file) return;
    let bytes;
    try { bytes = await readFile(this.file); } catch (error) { if (error.code === 'ENOENT') return; throw new ClassroomError('STORAGE', '无法读取会话文件'); }
    try { this.jar = CookieJar.deserializeSync(JSON.parse((await this.protect(bytes, true)).toString('utf8'))); }
    catch { throw new ClassroomError('STORAGE', '会话无法解密或已损坏，请清除后重新登录'); }
  }
  save() {
    if (!this.file) return Promise.resolve();
    const snapshot = JSON.stringify(this.jar.serializeSync());
    const operation = this.pending.catch(() => {}).then(async () => {
      const encrypted = await this.protect(Buffer.from(snapshot));
      // 会话文件写在 Windows 上，手写 `writeFile` + `rename` 会撞上瞬态
      // EACCES/EBUSY/EPERM；用宿主的原子替换（含重试）并钉住 0600。
      // ⚠️ 依旧写**原始二进制**（DPAPI 密文），不改成 base64：
      //    磁盘格式一变，用户已有会话就报废、被迫重新登录。
      await writeFileAtomic(this.file, encrypted, { mode: 0o600, dirMode: 0o700 });
    });
    this.pending = operation;
    return operation;
  }
  async clear() { this.epoch++; await this.jar.removeAllCookies(); await this.save(); }
}
