import { opendir, readFile, stat, lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gitRecords } from './git.js';

const ignoredDirs = new Set(['.git', '.svn', '.hg', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.cache', '.xushang-data', '.xushang']);
const sensitive = /^(\.env(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?)$|\.(pem|key|p12|pfx)$/i;
export const limits = { files: 5000, fileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, durationMs: 5000 };
export const portable = value => value.split(path.sep).join('/');
export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonicalDirectory(input) {
  if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input.trim())) throw new Error('请输入完整的本地文件夹路径。');
  let resolved;
  try { resolved = await realpath(input.trim()); } catch { throw new Error('找不到这个文件夹，请检查路径是否存在。'); }
  if (!(await stat(resolved)).isDirectory()) throw new Error('请选择文件夹，而不是文件。');
  return resolved;
}
export function normalizeScope(input = []) {
  if (!Array.isArray(input) || input.length > 16) throw new Error('最多设置 16 个关注文件或目录。');
  return [...new Set(input.map(value => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('关注路径无效。');
    const s = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    if (!s || s === '.' || path.isAbsolute(s) || s.includes('\0') || s.split('/').includes('..')) throw new Error('关注路径必须是项目内的相对路径。');
    return s;
  }))];
}
function makeIgnore(lines) {
  return lines.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const pattern = line.replace(/^\//, '').replace(/\/$/, '').split('*').map(s => s.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&')).join('.*');
    return new RegExp('(?:^|/)' + pattern + '(?:/|$)');
  });
}
export function emptySnapshot(state = 'pending', warnings = []) {
  return { files: {}, git: null, scannedAt: new Date().toISOString(), truncated: true, skipped: 0, warnings, bytes: 0, state, coverage: { mode: 'pending', roots: [], includeUntracked: false }, absent: [] };
}
export async function scanDirectory(root, options = {}) {
  const cap = { ...limits, ...options.limits }, started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason || new Error('检查已取消。'));
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('检查达到时间预算，已停止。')), cap.durationMs);
  const signal = controller.signal;
  const check = () => { if (signal.aborted) throw signal.reason; };
  const files = Object.create(null), warnings = [], absent = [];
  let visited = 0, directories = 0, skipped = 0, bytes = 0, truncated = false, gitInfo = null, isGit = false;
  const scope = normalizeScope(options.scope || []), mode = options.mode || 'full';
  const includeUntracked = options.includeUntracked ?? (mode === 'full');
  let coverage = { mode, roots: scope, includeUntracked };
  const exclude = options.excludePath ? path.resolve(options.excludePath) : null;
  try {
    check();
    try { await stat(root); } catch { throw new Error('项目文件夹已移动或无法访问。'); }
    const rules = makeIgnore(await readFile(path.join(root, '.xushangignore'), 'utf8').catch(() => ''));
    const inScope = name => !scope.length || scope.some(s => name === s || name.startsWith(s + '/'));
    const ignored = name => name.split('/').some(s => ignoredDirs.has(s) || sensitive.test(s)) || rules.some(r => r.test(name));
    const candidates = new Set();
    const admit = name => { if (candidates.size >= cap.files) { truncated = true; return; } if (name && inScope(name) && !ignored(name)) candidates.add(name); };
    try { await lstat(path.join(root, '.git')); isGit = true; } catch {}
    const command = (args, budget) => (options.gitReader || gitRecords)(root, args, { signal, ...budget });
    for (const name of options.focus || []) await add(name);
    if (isGit) {
      const branch = await command(['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxRecords: 1 }).catch(error => { check(); return { records: ['HEAD (detached)'] }; });
      const head = await command(['rev-parse', '--verify', 'HEAD'], { maxRecords: 1 }).catch(error => { check(); return { records: [''] }; });
      gitInfo = { branch: branch.records[0] || '', head: head.records[0] || '', status: [] };
      const statusResult = await command(['status', '--porcelain=v1', '-z', '--untracked-files=' + (includeUntracked ? 'normal' : 'no'), '--', ...scope], { maxRecords: cap.files });
      truncated ||= statusResult.truncated;
      for (let i = 0; i < statusResult.records.length; i++) {
        const record = statusResult.records[i], code = record.slice(0, 2), name = record.slice(3);
        gitInfo.status.push({ path: name, status: code });
        if (!name.endsWith('/')) admit(name);
        else { warnings.push('未跟踪目录仅列出目录名，未展开：' + name); if(mode==='workset')truncated=true; }
        if (code.includes('R') || code.includes('C')) i++;
      }
      for (const name of options.focus || []) admit(name);
      if (mode === 'workset') {
        if (options.previous?.coverage?.mode === 'workset') for (const name of Object.keys(options.previous.files || {})) admit(name);
        if (scope.length) {
          const selected = await command(['ls-files', '-z', '--cached', ...(includeUntracked ? ['--others', '--exclude-standard'] : []), '--', ...scope], { maxRecords: cap.files });
          truncated ||= selected.truncated; selected.records.forEach(admit);
        }
      } else {
        const listed = await command(['ls-files', '-z', '--cached', ...(includeUntracked ? ['--others', '--exclude-standard'] : []), '--', ...scope], { maxRecords: cap.files });
        truncated ||= listed.truncated; listed.records.forEach(admit);
      }
    } else coverage = { mode: 'folder', roots: scope, includeUntracked: true };
    async function add(relative) {
      check();
      if (Object.hasOwn(files, relative)) return;
      if (visited >= cap.files) { truncated = true; return; }
      if (ignored(relative) || !inScope(relative)) { skipped++; return; }
      const full = path.resolve(root, relative);
      if (!within(root, full) || exclude && within(exclude, full)) { skipped++; return; }
      let handle;
      try {
        const info = await lstat(full); check();
        if (info.isSymbolicLink() || !info.isFile()) { skipped++; return; }
        const actual = await realpath(full); check();
        if (!within(root, actual)) { skipped++; return; }
        visited++;
        if (info.size > cap.fileBytes || bytes + info.size > cap.totalBytes) { truncated = true; skipped++; return; }
        const previous = options.previous?.files?.[relative];
        if (!options.force && previous?.size === info.size && previous.mtimeMs === info.mtimeMs) { files[relative] = { ...previous }; return; }
        handle = await open(full, 'r'); check();
        const buffer = Buffer.alloc(Math.min(cap.fileBytes, cap.totalBytes - bytes, info.size) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); check();
        if (bytesRead > cap.fileBytes || bytes + bytesRead > cap.totalBytes) { truncated = true; skipped++; return; }
        const after = await handle.stat(); bytes += bytesRead;
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || bytesRead !== after.size) { truncated = true; warnings.push('扫描时文件仍在修改：' + relative); return; }
        files[relative] = { hash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'), size: bytesRead, mtimeMs: after.mtimeMs };
      } catch (error) {
        check();
        if (error.code === 'ENOENT') absent.push(relative);
        else { truncated = true; warnings.push('无法读取：' + relative); }
      } finally { await handle?.close(); }
    }
    async function walk(dir, prefix = '') {
      check();
      if (++directories > cap.files || prefix.split('/').length > 80) { truncated = true; return; }
      if (exclude && within(exclude, dir)) return;
      let entries;
      try { entries = await opendir(dir); } catch { truncated = true; return; }
      for await (const item of entries) {
        check();
        if (visited >= cap.files) { truncated = true; return; }
        const name = prefix + item.name;
        if (ignored(name) || item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(path.join(dir, item.name), name + '/');
        else if (item.isFile()) await add(name);
      }
    }
    if (isGit) { for (const name of candidates) await add(name); }
    else if (scope.length) {
      for (const s of scope) {
        check();
        const actual = await resolveProjectFile(root, s);
        if ((await stat(actual)).isDirectory()) await walk(actual, s + '/');
        else await add(s);
      }
    } else await walk(root);
    check();
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('检查已取消。');
    if (!signal.aborted && /已移动/.test(error.message)) throw error;
    truncated = true;
    warnings.push(isGit ? 'Git 检查未完成；已停止，没有退回全目录扫描。' : error.message);
    warnings.push(error.message);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
  return { files, git: gitInfo, scannedAt: new Date().toISOString(), durationMs: Date.now() - started, truncated, skipped, warnings: [...new Set(warnings)].slice(0, 10), bytes, absent, coverage, state: truncated ? 'partial' : 'complete' };
}
export function compareSnapshots(before, after) {
  const changes = [], scopeChanged = JSON.stringify(before.coverage || null) !== JSON.stringify(after.coverage || null);
  const incomplete = Boolean(before.truncated || after.truncated || scopeChanged);
  for (const [name, file] of Object.entries(after.files)) {
    if (!Object.hasOwn(before.files, name)) changes.push({ path: name, kind: before.truncated || scopeChanged ? 'unverified' : 'added' });
    else if (before.files[name].hash !== file.hash) changes.push({ path: name, kind: 'modified' });
  }
  for (const name of Object.keys(before.files)) {
    if (!Object.hasOwn(after.files, name)) changes.push({ path: name, kind: after.absent?.includes(name) ? 'deleted' : after.truncated || scopeChanged ? 'unverified' : 'deleted' });
  }
  return { changes: changes.sort((a,b) => a.path.localeCompare(b.path)), branchChanged: Boolean(before.git && after.git && before.git.branch !== after.git.branch), headChanged: Boolean(before.git && after.git && before.git.head !== after.git.head), gitUnavailable: Boolean(before.git && !after.git), incomplete, scopeChanged };
}
export async function resolveProjectFile(root, relative = '') {
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error('文件路径无效。');
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error('文件必须位于当前项目文件夹内。');
  let actual;
  try { actual = await realpath(target); } catch { throw new Error('文件已移动或不存在，请选择仍然存在的文件。'); }
  if (!within(await realpath(root), actual)) throw new Error('不能打开指向项目外部的链接。');
  return actual;
}
