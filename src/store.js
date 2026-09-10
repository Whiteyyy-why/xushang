import { mkdir, readFile, writeFile, rename, open, unlink, truncate } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { normalizeScope } from './scanner.js';

export const emptyDatabase = () => ({ version: 1, projects: [], sessions: [] });
export function validateDatabase(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) throw new Error('这不是受支持的续上备份（需要版本 1）。');
  if (value.projects.length > 200 || value.sessions.length > 10000) throw new Error('备份中的记录数量超过限制。');
  const ids = new Set(), sessionIds = new Set();
  const text = (v, n) => typeof v === 'string' && v.length <= n;
  for (const p of value.projects) {
    if (!p || !text(p.id, 100) || !p.id || ids.has(p.id) || !text(p.name, 100) || !p.name || !text(p.path, 4096) || !path.isAbsolute(p.path) || !text(p.createdAt, 100)) throw new Error('备份中的项目记录无效。');
    normalizeScope(p.scope || []);
    if (p.scanMode !== undefined && !['workset','full'].includes(p.scanMode)) throw new Error('检查模式无效。');
    ids.add(p.id);
  }
  for (const s of value.sessions) {
    if (!s || !text(s.id, 100) || !s.id || sessionIds.has(s.id) || !ids.has(s.projectId) || !text(s.title, 150) || !s.title || !text(s.next, 3000) || !s.next || !text(s.note, 6000) || !text(s.createdAt, 100) || !Number.isFinite(Date.parse(s.createdAt)) || !text(s.file, 4096) || !Number.isInteger(s.line) || s.line < 1 || s.line > 10000000) throw new Error('备份中的现场记录无效。');
    if (path.isAbsolute(s.file) || s.file.split(/[\\/]/).includes('..') || s.file.includes('\0')) throw new Error('备份中的文件位置越出了项目目录。');
    if(s.goal!==undefined && !text(s.goal,3000))throw new Error('工作目标无效。');
    if(s.captureKey !== undefined && (typeof s.captureKey!=='string' || s.captureKey.length>150))throw new Error('保存标识无效。');
    const snap = s.snapshot;
    if (!snap || !snap.files || typeof snap.files !== 'object' || Array.isArray(snap.files) || Object.keys(snap.files).length > 5000 || typeof snap.truncated !== 'boolean') throw new Error('备份中的文件快照无效。');
    for (const [name, f] of Object.entries(snap.files)) {
      if (!name || name.length > 4096 || path.isAbsolute(name) || name.includes('\0') || name.split(/[\\/]/).includes('..') || ['__proto__', 'constructor', 'prototype'].includes(name) || !f || !/^[a-f0-9]{64}$/.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('备份中的文件摘要无效。');
    }
    if (snap.git && (!text(snap.git.branch, 500) || !text(snap.git.head, 100) || !Array.isArray(snap.git.status) || snap.git.status.some(f => !f || !text(f.path, 4096) || !text(f.status, 2)))) throw new Error('备份中的 Git 摘要无效。');
    if (snap.state && !['pending','complete','partial','failed','cancelled','interrupted'].includes(snap.state)) throw new Error('快照状态无效。');
    if (snap.coverage) {
      if (!['pending','full','workset','folder'].includes(snap.coverage.mode)) throw new Error('快照范围无效。');
      normalizeScope(snap.coverage.roots || []);
    }
    if (snap.absent && (!Array.isArray(snap.absent) || snap.absent.length > 5000 || snap.absent.some(n => typeof n !== 'string' || path.isAbsolute(n) || n.split(/[\\/]/).includes('..')))) throw new Error('缺失文件记录无效。');
    sessionIds.add(s.id);
  }
  // Rebuild the supported schema: imported extra fields are never persisted or executed.
  return { version: 1,
    projects: value.projects.map(p => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt, scanMode: p.scanMode || 'workset', scope: p.scope || [], includeUntracked: p.includeUntracked === true })),
    sessions: value.sessions.map(s => ({ id: s.id, projectId: s.projectId, title: s.title, goal:s.goal||'', captureKey:s.captureKey, next: s.next, note: s.note, createdAt: s.createdAt, file: s.file, line: s.line,
      snapshot: { fileCount: Object.keys(s.snapshot.files).length, state: s.snapshot.state || (s.snapshot.truncated ? 'partial' : 'complete'), coverage: s.snapshot.coverage || { mode:'full', roots:[], includeUntracked:true }, absent: s.snapshot.absent || [], durationMs: s.snapshot.durationMs || 0, files: s.snapshot.files, git: s.snapshot.git || null, scannedAt: s.snapshot.scannedAt || s.createdAt, truncated: s.snapshot.truncated, skipped: Number.isSafeInteger(s.snapshot.skipped) ? s.snapshot.skipped : 0, warnings: Array.isArray(s.snapshot.warnings) ? s.snapshot.warnings.filter(x => typeof x === 'string').slice(0, 10) : [], bytes: Number.isSafeInteger(s.snapshot.bytes) ? s.snapshot.bytes : 0 }
    }))
  };
}

export class Store {
  constructor(directory) {
    this.directory = directory; this.file = path.join(directory, 'checkpoint.json'); this.journalPath = path.join(directory, 'journal.ndjson');
    this.tail = Promise.resolve(); this.notice = ''; this.sequence = 0;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, 'app.lock');
    try { this.lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number((await readFile(lockPath, 'utf8')).trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('数据目录锁无效，请确认没有实例运行后移除 app.lock。');
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('续上已经在运行，请打开原来的浏览器页面。');
      await unlink(lockPath); this.lock = await open(lockPath, 'wx');
    }
    await this.lock.writeFile(String(process.pid));
    try {
      try { this.data = validateDatabase(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) {
        if (error.code === 'ENOENT') {
          const legacy = path.join(this.directory, 'data.json');
          try { this.data = validateDatabase(JSON.parse(await readFile(legacy, 'utf8'))); }
          catch (old) {
            if (old.code === 'ENOENT') this.data = emptyDatabase();
            else {
              this.data = validateDatabase(JSON.parse(await readFile(legacy + '.bak', 'utf8')));
              this.notice = '已从旧版备份恢复记录，原文件保留。';
            }
          }
          // Create a checkpoint once. Legacy data.json is never modified.
          const encoded = JSON.stringify(this.data);
          await writeFile(this.file + '.bak', encoded);
          const temp = this.file + '.tmp';
          const handle = await open(temp, 'w');
          try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
          await rename(temp, this.file);
        } else {
          this.data = validateDatabase(JSON.parse(await readFile(this.file + '.bak', 'utf8')));
          this.notice = '检查点无法读取，已加载备份并重放增量记录。';
        }
      }
      let pending = '', validBytes = 0;
      try {
        for await (const chunk of createReadStream(this.journalPath, { encoding: 'utf8' })) {
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            const { checksum, ...patch } = JSON.parse(line);
            if (patch.sequence !== this.sequence + 1 || checksum !== this.checksum(patch)) throw new Error('增量记录校验失败，原数据已保留。');
            this.apply(this.checkedPatch(patch.projects, patch.sessions));
            this.sequence = patch.sequence; validBytes += Buffer.byteLength(line + '\n');
          }
          if (Buffer.byteLength(pending) > 64 * 1024 * 1024) throw new Error('单条增量记录超过限制。');
        }
        if (pending) {
          await writeFile(this.journalPath + '.partial', pending);
          await truncate(this.journalPath, validBytes);
          this.notice = '上次写入的末尾记录未完成，已保留片段并恢复到最后一次完整保存。';
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A scan cannot represent the previous save time after a process restart.
      for (const session of this.data.sessions) {
        if (session.snapshot.state === 'pending') session.snapshot = { ...session.snapshot, state: 'interrupted', truncated: true, warnings: ['上次文件检查未完成；笔记已保留。'] };
      }
      this.journal = await open(this.journalPath, 'a');
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  checksum(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  read() { return structuredClone(this.data); }
  query(select) { return structuredClone(select(this.data)); }
  checkedPatch(projects, sessions) {
    if (!Array.isArray(projects) || !Array.isArray(sessions)) throw new Error('增量记录格式无效。');
    const mergedProjects = new Map(this.data.projects.map(p => [p.id, p]));
    for (const p of projects) mergedProjects.set(p.id, p);
    const checked = validateDatabase({ version: 1, projects: [...mergedProjects.values()], sessions });
    if (new Set([...this.data.sessions.map(s => s.id), ...sessions.map(s => s.id)]).size > 10000) throw new Error('现场数量超过限制。');
    const ids = new Set(projects.map(p => p.id));
    return { projects: checked.projects.filter(p => ids.has(p.id)), sessions: checked.sessions };
  }
  apply(patch) {
    for (const [key, records] of Object.entries(patch)) {
      const index = new Map(this.data[key].map((item, i) => [item.id, i]));
      for (const item of records) {
        if (index.has(item.id)) this.data[key][index.get(item.id)] = item;
        else { index.set(item.id, this.data[key].length); this.data[key].push(item); }
      }
    }
  }
  async writePatch(projects, sessions) {
    if (this.failure) throw new Error('上次磁盘写入未完成，请重启应用后再保存。');
    const checked = this.checkedPatch(projects, sessions);
    if (!checked.projects.length && !checked.sessions.length) return;
    const patch = { sequence: this.sequence + 1, ...checked };
    const line = JSON.stringify({ ...patch, checksum: this.checksum(patch) }) + '\n';
    try { await this.journal.writeFile(line); await this.journal.sync(); }
    catch (error) { this.failure = error; throw error; }
    this.apply(checked); this.sequence = patch.sequence;
  }
  enqueue(action) {
    const task = this.tail.then(action);
    this.tail = task.catch(() => {});
    return task;
  }
  appendSession(session) { return this.enqueue(async () => {
    const existing=session.captureKey && this.data.sessions.find(s=>s.projectId===session.projectId && s.captureKey===session.captureKey);
    if(existing)return existing.id;
    await this.writePatch([], [session]);return session.id;
  }); }
  updateSnapshot(id, snapshot) {
    return this.enqueue(async () => {
      const session = this.data.sessions.find(s => s.id === id);
      if (session) await this.writePatch([], [{ ...session, snapshot }]);
    });
  }
  async mutate(fn) {
    return this.enqueue(async () => {
      const copy = this.read(), result = await fn(copy), checked = validateDatabase(copy);
      const changed = key => {
        const old = new Map(this.data[key].map(x => [x.id, x]));
        return checked[key].filter(x => !old.has(x.id) || JSON.stringify(old.get(x.id)) !== JSON.stringify(x));
      };
      // Used for small project edits and explicit imports; saves use appendSession.
      await this.writePatch(changed('projects'), changed('sessions'));
      return result;
    });
  }
  async close() {
    await this.tail;
    await this.journal?.close(); this.journal = null;
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(path.join(this.directory, 'app.lock')).catch(() => {}); }
  }
}
