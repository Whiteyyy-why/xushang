import test from 'node:test';
import assert from 'node:assert/strict';
import { openEditor } from '../src/editor.js';

test('Cursor 自定义安装：从命令行入口定位应用，文件与行号作为独立参数', async () => {
  const calls = [];
  const editor = await openEditor({ isFile: true, path: 'D:\\work space\\a&b.txt', line: 12 }, {
    platform: 'win32', env: { PATH: 'D:\\cursor\\resources\\app\\bin' },
    exists: name => ['D:\\cursor\\resources\\app\\bin\\cursor.cmd', 'D:\\cursor\\Cursor.exe'].includes(name),
    run: async (...args) => calls.push(args),
  });
  assert.equal(editor, 'Cursor');
  assert.deepEqual(calls, [['D:\\cursor\\Cursor.exe', ['--goto', 'D:\\work space\\a&b.txt:12']]]);
});

test('Cursor 不可启动时使用 VS Code，目录不带 goto 参数', async () => {
  const calls = [];
  const editor = await openEditor({ isFile: false, path: '/tmp/work space' }, {
    platform: 'linux', run: async (command, args) => { calls.push([command, args]); if (command === 'cursor') throw new Error('missing'); },
  });
  assert.equal(editor, 'VS Code');
  assert.deepEqual(calls, [['cursor', ['/tmp/work space']], ['code', ['/tmp/work space']]]);
});

test('编辑器缺失时提供复制位置提示', async () => {
  await assert.rejects(openEditor({ isFile: false, path: 'D:\\work' }, {
    platform: 'win32', env: {}, exists: () => false,
  }), /复制位置/);
});
