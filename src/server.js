import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { Service } from './service.js';
import { openEditor } from './editor.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const staticFiles = new Set(['index.html', 'styles.css', 'app.js', 'favicon.svg', 'logo.svg', 'icons.svg', 'work.js']);
const MAX_BODY = 32 * 1024 * 1024;
async function readBody(req) {
  let size = 0;const chunks = [];
  if (Number(req.headers['content-length']) > MAX_BODY) throw new Error('请求超过 32 MB 限制。');
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('请求超过 32 MB 限制。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('JSON 内容无法读取。'); }
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });res.end(JSON.stringify(body)); }
function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);child.once('spawn', () => { child.unref();resolve(); });
  });
}
async function pickDirectory() {
  if (process.platform !== 'win32') throw new Error('当前系统请直接粘贴文件夹完整路径。');
  const script = "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择项目文件夹'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }; $dialog.Dispose()";
  const result = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 120000, windowsHide: true, encoding: 'utf8' });
  return { path: result.stdout.replace(/^\uFEFF/, '').trim() };
}
export async function createApp({ dataDirectory = process.env.XUSHANG_DATA_DIR || path.join(root, '.xushang-data'), port = Number(process.env.PORT || 4318), openExternal = openEditor } = {}) {
  const store = await new Store(path.resolve(dataDirectory)).init();const service = new Service(store);
  let origin;let choosingFolder = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');res.setHeader('Cache-Control', 'no-store');res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: '只接受本机应用页面的请求。' });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-xushang-client'] !== '1') return json(res, 403, { error: '请从续上页面执行此操作。' });
        if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, await service.list());
        if (req.method === 'GET' && url.pathname === '/api/export') {
          const markdown = url.searchParams.get('format') === 'md';
          const content=markdown ? await service.exportMarkdown() : JSON.stringify(await service.exportJson(),null,2);
          res.writeHead(200, { 'Content-Type': markdown ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="xushang-backup.${markdown ? 'md' : 'json'}"` });
          return res.end(content);
        }
        const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(sessions|open|refresh|cancel|scope|history|draft))?$/);
        if (req.method === 'GET' && match?.[2] === 'draft') return json(res,200,await service.getDraft(match[1]));
        if (req.method === 'GET' && match?.[2] === 'history') return json(res,200,await service.history(match[1],Number(url.searchParams.get('offset') || 0)));
        if (req.method === 'GET' && match && !match[2]) return json(res, 200, await service.detail(match[1]));
        if (req.method !== 'POST') return json(res, 404, { error: '没有这个接口。' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求。' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效。');
        if (url.pathname === '/api/projects') return json(res, 201, await service.addProject(body));
        if (url.pathname === '/api/example') return json(res, 201, await service.createExample());
        if (url.pathname === '/api/import') return json(res, 200, await service.importJson(body));
        if (url.pathname === '/api/pick-folder') {
          if (choosingFolder) throw new Error('文件夹选择窗口已经打开。');
          choosingFolder = true;try { return json(res, 200, await pickDirectory()); } finally { choosingFolder = false; }
        }
        if (match?.[2] === 'draft') return json(res,200,await service.putDraft(match[1],body));
        if (match?.[2] === 'sessions') return json(res, 201, await service.saveSession(match[1], body));
        if (match?.[2] === 'cancel') return json(res, 200, service.cancel(match[1]));
        if (match?.[2] === 'scope') return json(res, 200, await service.setScope(match[1], body));
        if (match?.[2] === 'refresh') return json(res, 200, await service.refresh(match[1], body));
        if (match?.[2] === 'open') { const target = await service.fileTarget(match[1], body); const editor = await openExternal(target);return json(res, 200, { opened: true, path: target.path, editor }); }
        return json(res, 404, { error: '没有这个接口。' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '不支持此操作。' });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!staticFiles.has(file)) return json(res, 404, { error: '页面不存在。' });
      const content = await readFile(path.join(root, 'public', file));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });res.end(content);
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 400, { error: error.message || '操作未完成，请重试。', ...(error.current ? {current:error.current} : {}) });else res.end(); }
  });
  server.requestTimeout = 150000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject);server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { await store.close();throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, store, service, origin, close: async () => { const stopped = new Promise(resolve => server.close(resolve));server.closeIdleConnections();await service.close();await stopped;await service.waitForIdle();await store.close(); } };
}
async function openBrowser(url) {
  if (process.platform === 'win32') {
    const script = "Start-Process -FilePath '" + url.replaceAll("'", "''") + "'";
    await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  }
  else await spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const launch = async () => {
    if (process.argv.includes('--open')) {
      const url = 'http://127.0.0.1:' + Number(process.env.PORT || 4318);
      try {
        const response = await fetch(url + '/api/projects', { headers: { 'X-Xushang-Client': '1' }, signal: AbortSignal.timeout(600) });
        const data = await response.json();
        if (response.ok && Array.isArray(data.projects) && typeof data.dataDirectory === 'string') {
          await openBrowser(url);console.log('已打开正在运行的续上：' + url);return null;
        }
      } catch {}
    }
    return createApp();
  };
  launch().then(async app => {
    if (!app) return;
    console.log(`\n  续上 · 留下工作现场，接着往前\n\n  ${app.origin}\n  数据：${app.store.directory}\n\n  关闭此窗口会停止服务。\n`);
    let closing = false;
    const shutdown = async () => { if (closing) return;closing = true;await app.close();process.exit(0); };
    process.on('SIGINT', shutdown);process.on('SIGTERM', shutdown);
    if (process.argv.includes('--open')) await openBrowser(app.origin).catch(() => console.log('请在浏览器中打开上方地址。'));
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? '4318 端口已被占用。请关闭已有实例，或设置 PORT 后重新启动。' : error.message);process.exitCode = 1; });
}
