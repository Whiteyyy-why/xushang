import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, symlink, utimes, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, validateDatabase } from '../src/store.js';
import { Service } from '../src/service.js';
import { scanDirectory, compareSnapshots, resolveProjectFile, within } from '../src/scanner.js';
import { createApp } from '../src/server.js';
const exec = promisify(execFile);
const base = path.resolve('test-results');
async function fixture(t) {
  await mkdir(base,{recursive:true});
  const dir=await mkdtemp(path.join(base,'case-'));
  t.after(async()=>{assert(within(base,dir) && dir!==base);await rm(dir,{recursive:true,force:true});});
  const project=path.join(dir,'project');await mkdir(project);return {dir,project};
}
async function setup(t, options={}) {
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init();t.after(()=>store.close());
  const service=new Service(store,options);t.after(()=>service.close());const project=await service.addProject({path:f.project,name:'测试项目'});return {...f,store,service,project};
}
const note={title:'整理初始化',next:'先读取 token，再恢复会话。',note:'刷新后会丢失状态。',file:'',line:1};

test('普通文件夹：新增、修改、删除、忽略规则及内容快照',async t=>{
  const {project}=await fixture(t);
  await writeFile(path.join(project,'a.txt'),'before');await writeFile(path.join(project,'deleted.txt'),'old');
  await mkdir(path.join(project,'node_modules'));await writeFile(path.join(project,'node_modules','hidden.txt'),'ignore');
  await writeFile(path.join(project,'.env'),'secret');await writeFile(path.join(project,'.xushangignore'),'private/\n*.scratch\n');
  await mkdir(path.join(project,'private'));await writeFile(path.join(project,'private','memo.txt'),'ignore');
  await writeFile(path.join(project,'temp.scratch'),'ignore');
  const before=await scanDirectory(project);
  assert.equal(before.git,null);assert.equal(before.files['.env'],undefined);assert.equal(before.files['private/memo.txt'],undefined);
  await writeFile(path.join(project,'a.txt'),'after');await rm(path.join(project,'deleted.txt'));await writeFile(path.join(project,'added.txt'),'new');
  const after=await scanDirectory(project);const diff=compareSnapshots(before,after);
  assert.deepEqual(diff.changes.map(x=>[x.path,x.kind]),[['a.txt','modified'],['added.txt','added'],['deleted.txt','deleted']]);
});

test('本地 Git：没有 GitHub 或远程也能读取分支、未提交文件与分支变化',async t=>{
  const {project}=await fixture(t);
  const git=args=>exec('git',['-C',project,...args],{windowsHide:true});
  await git(['init','-b','main']);await writeFile(path.join(project,'a file.txt'),'one');await writeFile(path.join(project,'.gitignore'),'ignored.txt\n');
  await git(['add','.']);await git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
  await writeFile(path.join(project,'a file.txt'),'two');await writeFile(path.join(project,'new file.txt'),'new');await writeFile(path.join(project,'ignored.txt'),'ignored');
  const before=await scanDirectory(project);assert.equal(before.git.branch,'main');assert(before.git.head);assert(before.files['a file.txt']);assert.equal(before.files['ignored.txt'],undefined);
  assert(before.git.status.some(x=>x.path==='new file.txt'));
  await git(['checkout','-b','next']);const after=await scanDirectory(project);assert(compareSnapshots(before,after).branchChanged);
});

test('扫描缓存：自动检查复用未变文件，手动刷新重新读取内容',async t=>{
  const {project}=await fixture(t);const file=path.join(project,'a.txt');await writeFile(file,'same size');
  const first=await scanDirectory(project);const second=await scanDirectory(project,{previous:first});
  assert.equal(second.bytes,0);assert.equal(second.files['a.txt'].hash,first.files['a.txt'].hash);
  const third=await scanDirectory(project,{previous:second,force:true});assert(third.bytes>0);
  await writeFile(file,'new value');const fourth=await scanDirectory(project,{previous:third});assert.notEqual(fourth.files['a.txt'].hash,third.files['a.txt'].hash);
});

test('超限扫描标注不完整，不把未扫描文件误判为删除',async t=>{
  const {project}=await fixture(t);await writeFile(path.join(project,'a.txt'),'1');await writeFile(path.join(project,'b.txt'),'2');
  const before=await scanDirectory(project);const after=await scanDirectory(project,{limits:{files:1}});
  assert(after.truncated);const diff=compareSnapshots(before,after);assert(diff.incomplete);assert.equal(diff.changes[0].kind,'unverified');
  const large=await scanDirectory(project,{limits:{fileBytes:0}});assert(large.truncated);assert.equal(Object.keys(large.files).length,0);
});

test('路径边界：拒绝项目外路径与目录链接',async t=>{
  const {dir,project}=await fixture(t);await writeFile(path.join(project,'inside.txt'),'ok');await mkdir(path.join(dir,'outside'));await writeFile(path.join(dir,'outside','secret.txt'),'no');
  await assert.rejects(resolveProjectFile(project,'../outside/secret.txt'),/项目文件夹/);
  await symlink(path.join(dir,'outside'),path.join(project,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveProjectFile(project,'linked/secret.txt'),/外部/);
  const snapshot=await scanDirectory(project);assert.deepEqual(Object.keys(snapshot.files),['inside.txt']);
});

test('保存现场、重启恢复与 JSON/Markdown 往返',async t=>{
  const f=await setup(t);await writeFile(path.join(f.project.path,'hello.txt'),'hello');
  await f.service.saveSession(f.project.id,{...note,file:'hello.txt',line:2});
  await f.service.waitForIdle();
  const exported=f.service.exportJson();assert.equal(exported.sessions.length,1);
  assert(f.service.exportMarkdown().includes('先读取 token'));
  await f.store.close();const reopened=await new Store(f.store.directory).init();t.after(()=>reopened.close());
  const service=new Service(reopened);const detail=await service.detail(f.project.id);
  assert.equal(detail.sessions[0].next,note.next);assert.equal(detail.stale,true);assert.equal(detail.sessions[0].file,'hello.txt');
  const other=await new Store(path.join(f.dir,'other-data')).init();t.after(()=>other.close());const restored=new Service(other);
  assert.deepEqual(await restored.importJson(exported),{projects:1,sessions:1});
  assert.deepEqual(await restored.importJson(exported),{projects:0,sessions:0});
  assert.equal(restored.exportJson().sessions[0].next,note.next);
});

test('无效备份与并发保存不会丢失或覆盖现有记录',async t=>{
  const f=await setup(t);await writeFile(path.join(f.project.path,'a.txt'),'hello');
  await Promise.all(Array.from({length:5},(_,i)=>f.service.saveSession(f.project.id,{...note,title:'现场 '+i})));
  await f.service.waitForIdle();
  assert.equal(f.store.read().sessions.length,5);
  const invalid=f.service.exportJson();invalid.sessions[0].file='../escape';
  await assert.rejects(f.service.importJson(invalid),/越出/);assert.equal(f.store.read().sessions.length,5);
  await assert.rejects(f.service.importJson({version:2}),/版本/);
});

test('数据目录单实例锁与损坏文件备份恢复',async t=>{
  const f=await setup(t);await f.service.saveSession(f.project.id,note);
  await assert.rejects(new Store(f.store.directory).init(),/已经在运行/);
  await f.service.waitForIdle();await f.store.close();await writeFile(f.store.file,'broken');
  const recovered=await new Store(f.store.directory).init();t.after(()=>recovered.close());
  assert(recovered.notice.includes('备份'));assert.equal(recovered.read().projects.length,1);
  assert.equal(await readFile(f.store.file,'utf8'),'broken');
});

test('速度验收：读取现场不等待缓慢扫描，60秒内复用结果',async t=>{
  let release, entered;let calls=0;
  const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  const f=await setup(t,{scanner:async(root,opts)=>{calls++;entered();await gate;return scanDirectory(root,opts);}});
  const pending=f.service.refresh(f.project.id);
  await started;
  const start=performance.now();
  const detail=await Promise.race([f.service.detail(f.project.id),new Promise((_,reject)=>setTimeout(()=>reject(new Error('读取被扫描阻塞')),300))]);
  assert.equal(detail.project.id,f.project.id);assert(performance.now()-start<300);
  release();await pending;await f.service.refresh(f.project.id);assert.equal(calls,1);
  await f.service.refresh(f.project.id,{force:true});assert.equal(calls,2);
});

test('项目文件夹失联时仍能立即查看已保存现场',async t=>{
  const f=await setup(t);await f.service.saveSession(f.project.id,note);
  await f.service.waitForIdle();await rename(f.project.path,path.join(f.dir,'moved'));
  const d=await f.service.detail(f.project.id);assert.equal(d.sessions[0].next,note.next);
  await assert.rejects(f.service.refresh(f.project.id,{force:true}),/移动/);
});

test('HTTP 完整流程、重启、同源校验与编辑器参数',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.project,'file with spaces.txt'),'hello');
  let target;
  let app=await createApp({dataDirectory:path.join(f.dir,'http-data'),port:0,openExternal:async input=>{target=input;}});
  t.after(()=>app.close());
  const request=async(route,body,headers={})=>{
    const res=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers:{'X-Xushang-Client':'1',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,data:await res.json()};
  };
  assert.equal((await fetch(app.origin+'/')).status,200);
  assert.equal((await fetch(app.origin+'/api/projects')).status,403);
  assert.equal((await request('/api/projects',undefined,{Origin:'https://example.invalid'})).status,403);
  const {data:p}=await request('/api/projects',{path:f.project,name:'真实目录'});
  assert.equal((await request('/api/projects/'+p.id+'/sessions',{...note,file:'file with spaces.txt',line:3})).status,201);
  assert.equal((await request('/api/projects/'+p.id+'/open',{file:'file with spaces.txt',line:3})).status,200);
  const history=await request('/api/projects/'+p.id+'/history?offset=1');assert.equal(history.status,200);assert.equal(history.data.sessions.length,0);assert.equal(history.data.totalSessions,1);
  assert.equal(target.path,path.join(f.project,'file with spaces.txt'));assert.equal(target.line,3);
  assert.equal((await request('/api/projects/'+p.id+'/open',{file:'../escape'})).status,400);
  await app.service.waitForIdle();await writeFile(path.join(f.project,'file with spaces.txt'),'changed');
  const refreshed=await request('/api/projects/'+p.id+'/refresh',{force:true});assert.equal(refreshed.data.comparison.changes[0].kind,'modified');
  const backup=await request('/api/export');assert.equal(backup.data.sessions.length,1);
  await app.close();app=await createApp({dataDirectory:path.join(f.dir,'http-data'),port:0});
  assert.equal((await request('/api/projects/'+p.id)).data.sessions[0].title,note.title);
});

test('示例项目是真实本地文件，快照和后台检查一致',async t=>{
  const {dir}=await fixture(t);const store=await new Store(path.join(dir,'data')).init();t.after(()=>store.close());
  const service=new Service(store);const p=await service.createExample();
  const d=await service.refresh(p.id);assert.equal(d.current.fileCount,2);assert.equal(d.comparison.changes.length,0);
  assert.equal((await service.createExample()).id,p.id);assert.equal(service.exportJson().projects.length,1);
});

