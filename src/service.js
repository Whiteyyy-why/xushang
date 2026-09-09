import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalDirectory, scanDirectory, compareSnapshots, resolveProjectFile, within } from './scanner.js';
import { validateDatabase } from './store.js';

function field(value, name, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${name}${required ? '不能为空，且' : ''}最多 ${max} 字。`);
  return value.trim();
}
const keyPath = input => process.platform === 'win32' ? path.resolve(input).toLowerCase() : path.resolve(input);
export class Service {
  constructor(store, { scanner = scanDirectory } = {}) { this.scanner = scanner; this.store = store; this.scans = new Map(); this.cache = new Map(); }
  project(id) { const p = this.store.query(data => data.projects.find(p => p.id === id)); if (!p) throw new Error('项目不存在。'); return p; }
  async scan(project, { force = false } = {}) {
    const cached = this.cache.get(project.id);
    if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < 60000) return cached;
    if (!this.scans.has(project.id)) {
      const previous = cached || this.store.query(data => data.sessions.filter(s => s.projectId === project.id).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.snapshot);
      const task = this.scanner(project.path, { previous, force, excludePath: within(project.path, this.store.directory) ? this.store.directory : null }).then(result => { this.cache.set(project.id, result);return result; }).finally(() => this.scans.delete(project.id));
      this.scans.set(project.id, task);
    }
    return this.scans.get(project.id);
  }
  async list() {
    const projects = this.store.query(data => data.projects.map(p => {
      const sessions = data.sessions.filter(s => s.projectId === p.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
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
    const { sessions, latestSnapshot } = this.store.query(data => {
      const all = data.sessions.filter(s => s.projectId === id).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return {
        sessions: all.map(s => ({ ...s, snapshot: { ...s.snapshot, git: s.snapshot.git ? { branch: s.snapshot.git.branch, head: s.snapshot.git.head, changeCount: s.snapshot.git.status.length } : null, fileCount: Object.keys(s.snapshot.files).length, files: undefined } })),
        latestSnapshot: all[0]?.snapshot || null
      };
    });
    const cached = this.cache.get(id), current = cached || latestSnapshot;
    const comparison = cached && latestSnapshot ? compareSnapshots(latestSnapshot, cached) : null;
    return { project, sessions, current: current ? { ...current, fileCount: Object.keys(current.files).length, files: Object.keys(current.files) } : null, comparison, stale: !cached || Date.now() - Date.parse(cached.scannedAt) >= 60000, error: null };
  }
  async refresh(id, input = {}) { await this.scan(this.project(id), { force: input.force === true });return this.detail(id); }
  async saveSession(id, input) {
    const project = this.project(id);
    const title = field(input.title, '标题', 150, true), next = field(input.next, '下一步', 3000, true), note = field(input.note, '卡点 / 决定', 6000);
    const file = field(input.file, '文件路径', 4096).replaceAll('\\', '/');
    const line = Number(input.line || 1);
    if (!Number.isInteger(line) || line < 1 || line > 10000000) throw new Error('行号应是 1 到 10000000 之间的整数。');
    if (file) await resolveProjectFile(project.path, file);
    const snapshot = await this.scan(project, { force: true });
    const session = { id: randomUUID(), projectId: id, title, next, note, file, line, createdAt: new Date().toISOString(), snapshot };
    await this.store.mutate(data => { data.sessions.push(session); });
    return { id: session.id, createdAt: session.createdAt, incomplete: snapshot.truncated };
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
      for (const s of db.sessions.filter(s => s.projectId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        lines.push(`### ${s.createdAt} · ${s.title.replace(/[\r\n]/g, ' ')}`, '', `下一步：${s.next}`, '', `卡点 / 决定：${s.note || '未填写'}`, '', `位置：${s.file ? `${s.file}:${s.line}` : '项目根目录'}`, '', `分支：${s.snapshot.git?.branch || '普通文件夹'}`, '', `文件摘要：${Object.keys(s.snapshot.files).length} 个${s.snapshot.truncated ? '（扫描不完整）' : ''}`, '');
      }
    }
    return lines.join('\n');
  }
  async importJson(input) {
    const imported = validateDatabase(input);
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
