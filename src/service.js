import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalDirectory, scanDirectory, compareSnapshots, resolveProjectFile, within, emptySnapshot, normalizeScope } from './scanner.js';
import { validateDatabase } from './store.js';

function field(value, name, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${name}${required ? '不能为空，且' : ''}最多 ${max} 字。`);
  return value.trim();
}
const keyPath = input => process.platform === 'win32' ? path.resolve(input).toLowerCase() : path.resolve(input);
function summarizeSession(s) {
  return { ...s, snapshot:{ ...s.snapshot, git:s.snapshot.git ? {branch:s.snapshot.git.branch,head:s.snapshot.git.head,changeCount:s.snapshot.git.status.length}:null,
    fileCount:s.snapshot.fileCount ?? Object.keys(s.snapshot.files).length, files:undefined } };
}
export class Service {
  constructor(store, { scanner = scanDirectory } = {}) {
    this.scanner = scanner; this.store = store; this.scans = new Map(); this.cache = new Map();
    this.queue = Promise.resolve(); this.tasks = new Set(); this.closing = false;
  }
  project(id) { const p = this.store.query(data => data.projects.find(p => p.id === id)); if (!p) throw new Error('项目不存在。'); return p; }
  async scan(project, { force = false, captureId = null, focus = [] } = {}) {
    if (this.closing) throw new Error('应用正在关闭。');
    const existing = this.scans.get(project.id);
    if (existing && !force) return existing.promise;
    const cached = this.cache.get(project.id);
    if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < 60000) return cached;
    if (this.tasks.size >= 32) throw new Error('后台检查队列已满，请稍后刷新。');
    existing?.controller.abort(new Error('已由新的检查替代。'));
    const controller = new AbortController(), job = { controller, status:'queued', promise:null };
    const previous = cached || this.store.query(data => data.sessions.filter(s => s.projectId === project.id && ['complete','partial'].includes(s.snapshot.state)).reverse().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).at(0)?.snapshot);
    const activeFile = this.store.query(data => data.sessions.filter(s => s.projectId === project.id).reverse().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).at(0)?.file);
    const task = this.queue.then(async () => {
      controller.signal.throwIfAborted(); job.status = 'running';
      const result = await this.scanner(project.path, { signal:controller.signal, previous, force, mode:project.scanMode || 'workset',
        scope:project.scope || [], includeUntracked:project.includeUntracked === true, focus:[...focus, ...(activeFile ? [activeFile] : [])],
        excludePath:within(project.path, this.store.directory) ? this.store.directory : null });
      controller.signal.throwIfAborted();
      if (captureId) await this.store.updateSnapshot(captureId, result);
      if (!controller.signal.aborted && this.scans.get(project.id) === job) {
        this.cache.delete(project.id);this.cache.set(project.id, result);
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
      }
      return result;
    }).catch(async error => {
      if (captureId) await this.store.updateSnapshot(captureId, emptySnapshot(controller.signal.aborted ? 'cancelled' : 'failed', [error.message]));
      throw error;
    }).finally(() => {
      if (this.scans.get(project.id) === job) this.scans.delete(project.id);
      this.tasks.delete(task);
    });
    job.promise = task; this.scans.set(project.id, job); this.tasks.add(task);
    this.queue = task.catch(() => {});
    return task;
  }
  cancel(id) { const job = this.scans.get(id);job?.controller.abort(new Error('检查已取消，已保存的笔记不受影响。'));return {cancelled:Boolean(job)}; }
  async waitForIdle() { await Promise.allSettled([...this.tasks]); }
  async close() { this.closing = true;for(const id of this.scans.keys())this.cancel(id);await this.waitForIdle(); }
  async setScope(id, input) {
    const mode = input.scanMode || 'workset', scope = normalizeScope(input.scope || []);
    if (!['workset','full'].includes(mode)) throw new Error('检查模式无效。');
    this.project(id);this.cancel(id);this.cache.delete(id);
    await this.store.mutate(data => { const p=data.projects.find(p=>p.id===id);p.scanMode=mode;p.scope=scope;p.includeUntracked=input.includeUntracked===true; });
    return this.detail(id);
  }
  async list() {
    const projects = this.store.query(data => data.projects.map(p => {
      const sessions = data.sessions.filter(s => s.projectId === p.id).reverse().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      const latest = sessions[0];
      return { ...p, sessionCount: sessions.length, latest: latest ? { id: latest.id, title: latest.title, next: latest.next, createdAt: latest.createdAt, git: latest.snapshot.git ? { branch: latest.snapshot.git.branch } : null } : null };
    }));
    return { projects, dataDirectory: this.store.directory, notice: this.store.notice };
  }
  async addProject(input) {
    const directory = await canonicalDirectory(field(input.path, '路径', 4096, true));
    const name = field(input.name || path.basename(directory) || directory, '项目名称', 100, true);
    return this.store.mutate(data => {
      const existing = data.projects.find(p => keyPath(p.path) === keyPath(directory));
      if (existing) return existing;
      const project = { id: randomUUID(), name, path: directory, createdAt: new Date().toISOString() };
      data.projects.push(project);return project;
    });
  }
  async detail(id) {
    const project = this.project(id);
    const { sessions, latestSnapshot, totalSessions } = this.store.query(data => {
      const all = data.sessions.filter(s => s.projectId === id).reverse().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return {
        sessions: all.slice(0,100).map(summarizeSession), totalSessions:all.length,
        latestSnapshot: all[0]?.snapshot || null
      };
    });
    const cached = this.cache.get(id), current = cached || latestSnapshot;
    const comparison = cached && latestSnapshot && ['complete','partial'].includes(latestSnapshot.state) ? compareSnapshots(latestSnapshot, cached) : null;
    return { project, sessions, totalSessions, job: this.scans.has(id) ? {status:this.scans.get(id).status} : latestSnapshot?.state === 'pending' ? {status:'queued'} : null, current: current ? { ...current, fileCount: Object.keys(current.files).length, files: Object.keys(current.files) } : null, comparison, stale: !cached || Date.now() - Date.parse(cached.scannedAt) >= 60000, error: null };
  }
  async history(id, offset = 0) {
    this.project(id);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('历史记录位置无效。');
    return this.store.query(data => {
      const all=data.sessions.filter(s=>s.projectId===id).reverse().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return {sessions:all.slice(offset,offset+100).map(summarizeSession),totalSessions:all.length};
    });
  }
  async refresh(id, input = {}) { await this.scan(this.project(id), { force: input.force === true });return this.detail(id); }
  async saveSession(id, input) {
    const project = this.project(id);
    const title = field(input.title, '标题', 150, true), next = field(input.next, '下一步', 3000, true), note = field(input.note, '卡点 / 决定', 6000);
    const file = field(input.file, '文件路径', 4096).replaceAll('\\', '/');
    const line = Number(input.line || 1);
    if (!Number.isInteger(line) || line < 1 || line > 10000000) throw new Error('行号应是 1 到 10000000 之间的整数。');
    if (file) normalizeScope([file]);
    const snapshot = emptySnapshot();
    const session = { id: randomUUID(), projectId: id, title, next, note, file, line, createdAt: new Date().toISOString(), snapshot };
    await this.store.appendSession(session);
    // Durability is acknowledged before any Git subprocess or file hashing starts.
    let scheduled;
    scheduled = new Promise(resolve => setImmediate(resolve)).then(async () => {
      try { await this.scan(project, { force:true, captureId:session.id, focus:file ? [file] : [] }); }
      catch (error) {
        const pending = this.store.query(data => data.sessions.find(s => s.id === session.id)?.snapshot.state === 'pending');
        if (pending) await this.store.updateSnapshot(session.id, emptySnapshot(this.closing ? 'interrupted' : 'failed', [error.message]));
      }
    }).finally(() => this.tasks.delete(scheduled));
    this.tasks.add(scheduled);scheduled.catch(() => {});
    return { id: session.id, createdAt: session.createdAt, snapshotState:'pending' };
  }
  async fileTarget(id, input) {
    const project = this.project(id);
    const file = field(input.file, '文件路径', 4096);
    const line = Number(input.line || 1);
    if (!Number.isInteger(line) || line < 1 || line > 10000000) throw new Error('行号无效。');
    return { path: await resolveProjectFile(project.path, file), line, isFile: Boolean(file) };
  }
  exportJson() { return this.store.read(); }
  exportMarkdown() {
    const db = this.store.read();
    const lines = ['# 续上 · 工作记忆', '', `导出时间：${new Date().toISOString()}`, ''];
    for (const p of db.projects) {
      lines.push(`## ${p.name.replace(/[\r\n]/g, ' ')}`, '', `项目路径：${p.path}`, '');
      for (const s of db.sessions.filter(s => s.projectId === p.id).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        lines.push(`### ${s.createdAt} · ${s.title.replace(/[\r\n]/g, ' ')}`, '', `下一步：${s.next}`, '', `卡点 / 决定：${s.note || '未填写'}`, '', `位置：${s.file ? `${s.file}:${s.line}` : '项目根目录'}`, '', `分支：${s.snapshot.git?.branch || '普通文件夹'}`, '', `文件摘要：${Object.keys(s.snapshot.files).length} 个${s.snapshot.truncated ? '（扫描不完整）' : ''}`, '');
      }
    }
    return lines.join('\n');
  }
  async importJson(input) {
    const imported = validateDatabase(input);
    for (const s of imported.sessions) if(s.snapshot.state==='pending') s.snapshot={...s.snapshot,state:'interrupted',truncated:true,warnings:['备份中的文件检查未完成；笔记已恢复。']};
    return this.store.mutate(data => {
      const mapping = new Map();let projects = 0, sessions = 0;
      for (const p of imported.projects) {
        let existing = data.projects.find(x => keyPath(x.path) === keyPath(p.path));
        if (!existing) { existing = { ...p, id: data.projects.some(x => x.id === p.id) ? randomUUID() : p.id };data.projects.push(existing);projects++; }
        mapping.set(p.id, existing.id);
      }
      for (const s of imported.sessions) {
        if (data.sessions.some(x => x.id === s.id)) continue;
        data.sessions.push({ ...s, projectId: mapping.get(s.projectId) });sessions++;
      }
      return { projects, sessions };
    });
  }
  async createExample() {
    const directory = path.join(this.store.directory, 'example', 'small-island');
    const db = this.store.read();
    const existing = db.projects.find(p => keyPath(p.path) === keyPath(directory));
    if (existing) return existing;
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(path.join(directory, 'README.md'), '# 小岛 · 续上示例项目\n\n这是可以随意修改的本地示例。\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await writeFile(path.join(directory, 'src', 'auth.js'), 'export async function initAuth() {\n  await restoreSession();\n  const token = readToken();\n  return connect(token);\n}\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const project = await this.addProject({ path: directory, name: '小岛 · 示例项目' });
    // Example lives under the data directory; normal scans exclude the database, not this explicit example root.
    const session = { id: randomUUID(), projectId: project.id, title: '登录流程改造', next: '检查初始化顺序：先读取 token，再恢复会话。', note: '刷新页面之后登录状态丢失，怀疑是初始化顺序。', file: 'src/auth.js', line: 2, createdAt: new Date().toISOString(), snapshot: await scanDirectory(directory) };
    await this.store.mutate(data => { data.sessions.push(session); });
    return project;
  }
}
