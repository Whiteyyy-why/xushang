import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyDatabase = () => ({ version: 1, projects: [], sessions: [] });
export function validateDatabase(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) throw new Error('这不是受支持的续上备份（需要版本 1）。');
  if (value.projects.length > 200 || value.sessions.length > 10000) throw new Error('备份中的记录数量超过限制。');
  const ids = new Set(), sessionIds = new Set();
  const text = (v, n) => typeof v === 'string' && v.length <= n;
  for (const p of value.projects) {
    if (!p || !text(p.id, 100) || !p.id || ids.has(p.id) || !text(p.name, 100) || !p.name || !text(p.path, 4096) || !path.isAbsolute(p.path) || !text(p.createdAt, 100)) throw new Error('备份中的项目记录无效。');
    ids.add(p.id);
  }
  for (const s of value.sessions) {
    if (!s || !text(s.id, 100) || !s.id || sessionIds.has(s.id) || !ids.has(s.projectId) || !text(s.title, 150) || !s.title || !text(s.next, 3000) || !s.next || !text(s.note, 6000) || !text(s.createdAt, 100) || !Number.isFinite(Date.parse(s.createdAt)) || !text(s.file, 4096) || !Number.isInteger(s.line) || s.line < 1 || s.line > 10000000) throw new Error('备份中的现场记录无效。');
    if (path.isAbsolute(s.file) || s.file.split(/[\\/]/).includes('..') || s.file.includes('\0')) throw new Error('备份中的文件位置越出了项目目录。');
    const snap = s.snapshot;
    if (!snap || !snap.files || typeof snap.files !== 'object' || Array.isArray(snap.files) || Object.keys(snap.files).length > 5000 || typeof snap.truncated !== 'boolean') throw new Error('备份中的文件快照无效。');
    for (const [name, f] of Object.entries(snap.files)) {
      if (!name || name.length > 4096 || path.isAbsolute(name) || name.includes('\0') || name.split(/[\\/]/).includes('..') || ['__proto__', 'constructor', 'prototype'].includes(name) || !f || !/^[a-f0-9]{64}$/.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('备份中的文件摘要无效。');
    }
    if (snap.git && (!text(snap.git.branch, 500) || !text(snap.git.head, 100) || !Array.isArray(snap.git.status) || snap.git.status.some(f => !f || !text(f.path, 4096) || !text(f.status, 2)))) throw new Error('备份中的 Git 摘要无效。');
    sessionIds.add(s.id);
  }
  // Rebuild the supported schema: imported extra fields are never persisted or executed.
  return { version: 1,
    projects: value.projects.map(p => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt })),
    sessions: value.sessions.map(s => ({ id: s.id, projectId: s.projectId, title: s.title, next: s.next, note: s.note, createdAt: s.createdAt, file: s.file, line: s.line,
      snapshot: { files: s.snapshot.files, git: s.snapshot.git || null, scannedAt: s.snapshot.scannedAt || s.createdAt, truncated: s.snapshot.truncated, skipped: Number.isSafeInteger(s.snapshot.skipped) ? s.snapshot.skipped : 0, warnings: Array.isArray(s.snapshot.warnings) ? s.snapshot.warnings.filter(x => typeof x === 'string').slice(0, 10) : [], bytes: Number.isSafeInteger(s.snapshot.bytes) ? s.snapshot.bytes : 0 }
    }))
  };
}
export class Store {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'data.json'); this.tail = Promise.resolve(); this.notice = ''; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, 'app.lock');
    try { this.lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch { throw new Error('无法读取数据目录锁。'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('数据目录锁无效，请确认没有续上实例运行后移除 app.lock。');
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('续上已经在运行，请打开原来的浏览器页面。');
      await unlink(lockPath);
      this.lock = await open(lockPath, 'wx');
    }
    await this.lock.writeFile(String(process.pid));
    try {
      this.data = validateDatabase(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') this.data = emptyDatabase();
      else {
        try { this.data = validateDatabase(JSON.parse(await readFile(`${this.file}.bak`, 'utf8'))); this.notice = '主数据文件无法读取，已加载上一次有效备份。请先导出当前数据。'; }
        catch { await this.close(); throw new Error('数据文件和备份无法读取。原文件已保留，请从导出的 JSON 备份恢复。'); }
      }
    }
    return this;
  }
  read() { return structuredClone(this.data); }
  query(select) { return structuredClone(select(this.data)); }
  async mutate(fn) {
    const task = this.tail.then(async () => {
      const copy = this.read();
      const result = await fn(copy);
      const checked = validateDatabase(copy);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify(checked), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try {
        await writeFile(`${this.file}.bak`, JSON.stringify(this.data), 'utf8');
        await rename(temp, this.file);
      } catch (error) { await unlink(temp).catch(() => {}); throw error; }
      this.data = checked;
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async close() {
    await this.tail;
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(path.join(this.directory, 'app.lock')).catch(() => {}); }
  }
}
