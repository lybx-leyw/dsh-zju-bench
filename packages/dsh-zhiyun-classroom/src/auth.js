import { ClassroomError } from './errors.js';
import { AUTH_HOSTS } from './transport.js';

export function rsaEncrypt(plaintext, modulusHex, exponentHex) {
  if (!/^[\da-f]+$/i.test(modulusHex) || !/^[\da-f]+$/i.test(exponentHex)) throw new TypeError('RSA 公钥格式异常');
  const modulus = BigInt(`0x${modulusHex}`), exponent = BigInt(`0x${exponentHex}`);
  if (modulus <= 0n || exponent <= 0n) throw new TypeError('RSA 参数须为正整数');
  const hex = Buffer.from(plaintext, 'utf8').toString('hex');
  let base = (hex ? BigInt(`0x${hex}`) : 0n) % modulus, power = exponent, result = 1n;
  while (power > 0n) { if (power & 1n) result = result * base % modulus; power >>= 1n; base = base * base % modulus; }
  return result.toString(16).padStart(128, '0');
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
}
export function executionToken(html) {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) { const a = attributes(tag); if (a.name === 'execution') return a.value; }
  return null;
}
export function nextLocation(result, url) {
  let next = result.headers.get('location');
  if (!next) for (const tag of result.text.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attributes(tag);
    if (a['http-equiv']?.toLowerCase() === 'refresh') next = a.content?.match(/url\s*=\s*(.+)$/i)?.[1]?.replace(/^["']|["']$/g, '');
    if (next) break;
  }
  if (!next) return null;
  const target = new URL(next.replaceAll('&amp;', '&'), url);
  if (target.protocol === 'http:') target.protocol = 'https:';
  if (target.protocol !== 'https:' || !AUTH_HOSTS.has(target.hostname) || target.username || target.password) throw new ClassroomError('AUTH_REDIRECT', '登录跳转到未支持的站点');
  return target.href;
}
export async function authenticate(transport, { username, password }, { signal } = {}) {
  if (!username || !password) throw new ClassroomError('CREDENTIALS', '请提供浙大账号与密码');
  const base = 'https://zjuam.zju.edu.cn/cas';
  const page = await transport.request(`${base}/login`, { signal });
  const execution = executionToken(page.text);
  if (!execution) throw new ClassroomError('AUTH_SHAPE', '登录页缺少 execution');
  const key = await transport.json(`${base}/v2/getPubKey`, '登录公钥', { signal });
  let encrypted;
  try { encrypted = rsaEncrypt(password, key.modulus, key.exponent); } catch { throw new ClassroomError('AUTH_SHAPE', '登录公钥格式异常'); }
  const body = new URLSearchParams({ username, password: encrypted, execution, _eventId: 'submit', rememberMe: 'true' });
  const login = await transport.request(`${base}/login`, { signal, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const sso = (await transport.session.jar.getCookies(`${base}/login`)).find(c => c.key === 'iPlanetDirectoryPro');
  if (!sso?.value) throw new ClassroomError('AUTH_REJECTED', '登录未成功，请检查凭据或官网验证提示', { status: login.status });
  let url = 'https://tgmedia.cmc.zju.edu.cn/index.php?r=auth%2Flogin&forward=https%3A%2F%2Fclassroom.zju.edu.cn%2F';
  for (let hop = 0; hop < 20; hop++) {
    const result = await transport.request(url, { signal });
    if (result.status >= 400) throw new ClassroomError('AUTH_HTTP', '业务登录请求失败', { status: result.status, hop });
    const next = nextLocation(result, url);
    if (!next) {
      if (new URL(url).hostname !== 'classroom.zju.edu.cn') throw new ClassroomError('AUTH_INCOMPLETE', '智云业务登录未完成', { host: new URL(url).hostname, hop });
      await transport.session.save();
      return;
    }
    url = next;
  }
  throw new ClassroomError('AUTH_LOOP', '登录跳转次数超限');
}
