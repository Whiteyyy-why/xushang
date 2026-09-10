import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openEditor(target, { platform = process.platform, env = process.env, exists = existsSync, run = launch } = {}) {
  const args = target.isFile ? ['--goto', target.path + ':' + target.line] : [target.path];
  const candidates = [];
  if (platform === 'win32') {
    const p = path.win32;
    const bins = (env.PATH || env.Path || '').split(';').map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
    for (const bin of bins) {
      candidates.push(['Cursor', p.join(bin, 'Cursor.exe')]);
      if (exists(p.join(bin, 'cursor.cmd'))) candidates.push(['Cursor', p.resolve(bin, '../../..', 'Cursor.exe')]);
    }
    if (env.LOCALAPPDATA) candidates.push(['Cursor', p.join(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe')]);
    candidates.push(['Cursor', p.join(env.ProgramFiles || 'C:\\Program Files', 'Cursor', 'Cursor.exe')]);
    if (env.LOCALAPPDATA) candidates.push(['VS Code', p.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')]);
    candidates.push(['VS Code', p.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')]);
  } else {
    candidates.push(['Cursor', 'cursor']);
    if (platform === 'darwin') candidates.push(['Cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor']);
    candidates.push(['VS Code', 'code']);
  }
  for (const [editor, command] of candidates) {
    if (platform === 'win32' && !exists(command)) continue;
    try { await run(command, args); return editor; } catch {}
  }
  throw new Error('未找到可启动的 Cursor 或 VS Code。请安装编辑器的命令行入口，或使用“复制位置”手动打开。');
}
