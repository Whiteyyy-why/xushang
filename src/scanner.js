import { readdir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ignoredDirs = new Set(['.git', '.svn', '.hg', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.cache', '.xushang-data', '.xushang']);
const sensitive = /^(\.env(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?)$|\.(pem|key|p12|pfx)$/i;
export const limits = { files: 5000, fileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };
export const portable = value => value.split(path.sep).join('/');
export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonicalDirectory(input) {
  if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input.trim())) throw new Error('请输入完整的本地文件夹路径。');
  let resolved;
  try { resolved = await realpath(input.trim()); } catch { throw new Error('找不到这个文件夹，请检查路径是否存在。'); }
  if (!(await stat(resolved)).isDirectory()) throw new Error('请选择文件夹，而不是文件。');
  return resolved;
}
async function git(root, args) {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}
function makeIgnore(lines) {
  // Deliberately small contract: relative paths, directory prefixes and * wildcards; no negation.
  return lines.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const raw = line.replace(/^\//, '').replace(/\/$/, '');
    const pattern = raw.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`(?:^|/)${pattern}(?:/|$)`);
  });
}
export async function scanDirectory(root, options = {}) {
  const cap = { ...limits, ...options.limits };
  const files = Object.create(null), warnings = [];
  let skipped = 0, visited = 0, bytes = 0, directories = 0, truncated = false, gitInfo = null, candidates = null;
  const rules = makeIgnore(await readFile(path.join(root, '.xushangignore'), 'utf8').catch(() => ''));
  const exclude = options.excludePath ? path.resolve(options.excludePath) : null;
  try { await stat(root); } catch { throw new Error('项目文件夹已移动或无法访问。请在“接入与存储”中重新接入。'); }
  const isIgnored = name => name.split('/').some(piece => ignoredDirs.has(piece) || sensitive.test(piece)) || rules.some(rule => rule.test(name));
  try {
    await lstat(path.join(root, '.git'));
    const [branch, head, statusText, list] = await Promise.all([
      git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'HEAD (detached)'),
      git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    ]);
    const status = [];
    const entries = statusText.split('\0');
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) continue;
      const code = entries[i].slice(0, 2), name = entries[i].slice(3);
      status.push({ path: name, status: code });
      if (code.includes('R') || code.includes('C')) i++;
    }
    gitInfo = { branch: branch.trim(), head: head.trim(), status };
    candidates = [...new Set(list.split('\0').filter(Boolean))].sort();
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push('Git 信息暂时不可用，本次使用文件快照。');
  }
  async function add(relative) {
    if (visited >= cap.files) { truncated = true; return; }
    if (isIgnored(relative)) { skipped++; return; }
    const full = path.resolve(root, relative);
    if (!within(root, full) || (exclude && within(exclude, full))) { skipped++; return; }
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink() || !info.isFile()) { skipped++; return; }
      const actual = await realpath(full);
      if (!within(root, actual)) { skipped++; return; }
      visited++;
      const previous = options.previous?.files?.[relative];
      if (!options.force && previous?.size === info.size && previous.mtimeMs === info.mtimeMs) {
        files[relative] = { hash: previous.hash, size: info.size, mtimeMs: info.mtimeMs }; return;
      }
      if (info.size > cap.fileBytes || bytes + info.size > cap.totalBytes) { skipped++; truncated = true; return; }
      const contents = await readFile(full);
      bytes += contents.length;
      const after = await stat(full);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) { warnings.push(`扫描时文件仍在修改：${relative}`); truncated = true; return; }
      files[relative] = { hash: createHash('sha256').update(contents).digest('hex'), size: contents.length, mtimeMs: after.mtimeMs };
    } catch (error) {
      if (error.code !== 'ENOENT') { skipped++; truncated = true; warnings.push(`无法读取：${relative}`); }
    }
  }
  async function walk(dir, prefix = '') {
    directories++;
    if (directories > cap.files || prefix.split('/').length > 80) { truncated = true; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { warnings.push(`无法访问：${prefix || '.'}`); truncated = true; return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= cap.files) { truncated = true; return; }
      const relative = prefix + entry.name;
      if (isIgnored(relative) || entry.isSymbolicLink()) { skipped++; continue; }
      const full = path.join(dir, entry.name);
      if (exclude && within(exclude, full)) { skipped++; continue; }
      if (entry.isDirectory()) await walk(full, `${relative}/`);
      else if (entry.isFile()) await add(relative);
    }
  }
  if (candidates) { for (const name of candidates) { if (visited >= cap.files) { truncated = true; break; } await add(name); } }
  else await walk(root);
  return { files, git: gitInfo, scannedAt: new Date().toISOString(), truncated, skipped, warnings: warnings.slice(0, 10), bytes };
}
export function compareSnapshots(before, after) {
  const changes = [];
  for (const [name, file] of Object.entries(after.files)) {
    if (!Object.hasOwn(before.files, name)) changes.push({ path: name, kind: before.truncated ? 'unverified' : 'added' });
    else if (before.files[name].hash !== file.hash) changes.push({ path: name, kind: 'modified' });
  }
  for (const name of Object.keys(before.files)) {
    if (!Object.hasOwn(after.files, name)) changes.push({ path: name, kind: after.truncated ? 'unverified' : 'deleted' });
  }
  return {
    changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
    branchChanged: Boolean(before.git && after.git && before.git.branch !== after.git.branch),
    headChanged: Boolean(before.git && after.git && before.git.head !== after.git.head),
    gitUnavailable: Boolean(before.git && !after.git),
    incomplete: Boolean(before.truncated || after.truncated)
  };
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
