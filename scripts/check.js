import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'public', 'test', 'scripts']) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
console.log('JavaScript syntax checks passed.');
