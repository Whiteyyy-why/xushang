import { spawn } from 'node:child_process';

export function gitRecords(root, args, { signal, maxRecords = 5000, maxBytes = 512 * 1024, env, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('检查已取消。'));
    const child = spawn('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
      windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }
    });
    if(child.stdin){child.stdin.on('error',()=>{});child.stdin.end(input);}
    let records = [], pending = '', bytes = 0, stderr = '', truncated = false, failure = null;
    let stopping = false;
    const stop = () => {
      if (stopping) return;stopping=true;
      if (process.platform === 'win32' && child.pid) {
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());
      } else child.kill();
    };
    const abort = () => { failure = signal.reason || new Error('检查已取消。'); stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (truncated || failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { truncated = true; stop(); return; }
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\0')) !== -1) {
        const record = pending.slice(0, at); pending = pending.slice(at + 1);
        if (records.length >= maxRecords || record.length > 4096) { truncated = true; stop(); break; }
        records.push(record);
      }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.slice(0, 2000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (!truncated && code !== 0) return reject(new Error(stderr.trim() || 'Git 检查未完成。'));
      if (!truncated && pending) { if (records.length >= maxRecords) truncated = true; else records.push(pending.trimEnd()); }
      resolve({ records, truncated });
    });
  });
}

