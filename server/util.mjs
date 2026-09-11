import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const APP_ROOT = path.resolve(import.meta.dirname, '..');
// Private test harness isolation, never required by normal installation/use.
export const LOCAL = process.env.NODE_ENV==='test'&&process.env.PI_LOOP_TEST_DATA
  ? path.resolve(process.env.PI_LOOP_TEST_DATA) : path.join(APP_ROOT, '.local');
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const ensureDir = p => { fs.mkdirSync(p, { recursive: true }); return p; };
export const readJSON = (p, fallback) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : fallback;
export function atomicWrite(file, bytes) {
  ensureDir(path.dirname(file)); const temp = `${file}.${uid()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (e) { fs.rmSync(temp, { force: true }); throw e; }
}
export const writeJSON = (p, value) => atomicWrite(p, JSON.stringify(value, null, 2));
export class LoopError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
export function checkAbort(signal) { if (signal?.aborted) throw new LoopError('CANCELLED', '任务已停止'); }
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function portablePath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value) || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw new LoopError('INVALID_PATH', '必须使用不含控制字符的工作区内相对路径');
  const parts = value.replaceAll('\\', '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || /[<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw new LoopError('INVALID_PATH', `无效的相对路径: ${value}`);
  return parts.join('/');
}
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new LoopError('CANCELLED'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new LoopError('CANCELLED')); }
  signal?.addEventListener('abort', abort, { once: true });
});
/** FIFO concurrency slots, not token reservations or cross-process locks. */
export class Slots {
  active = 0; peak = 0; queue = [];
  constructor(limit) { this.limit = limit; }
  async acquire(signal) {
    checkAbort(signal);
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: undefined };
      item.abort = () => { this.queue = this.queue.filter(q => q !== item); reject(new LoopError('CANCELLED')); };
      signal?.addEventListener('abort', item.abort, { once: true }); this.queue.push(item);
    });
    // A woken waiter already owns the slot transferred by release().
    else { this.active++; this.peak = Math.max(this.peak, this.active); }
    let released = false;
    return () => { if (released) return; released = true;
      const next = this.queue.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); }
      else this.active--;
    };
  }
  async use(fn, signal) { const release = await this.acquire(signal); try { checkAbort(signal); return await fn(); } finally { release(); } }
}
export function parseObject(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { throw new LoopError('INVALID_MODEL_OUTPUT', '模型未返回约定的 JSON 对象，不能作为已验证结果继续传播'); }
}
