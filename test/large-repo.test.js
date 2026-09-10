import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { scanDirectory, emptySnapshot, within, compareSnapshots } from '../src/scanner.js';
import { gitRecords } from '../src/git.js';
const exec=promisify(execFile), base=path.resolve('test-results');
async function fixture(t) {
  await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'large-test-')), project=path.join(dir,'repo');await mkdir(project);
  t.after(async()=>{assert(within(base,dir)&&dir!==base);await rm(dir,{recursive:true,force:true});});return {dir,project};
}
const note={title:'大仓库现场',next:'接着检查当前模块。',note:'已保存的想法',file:'',line:1};

test('慢扫描不会阻塞保存；取消后笔记仍持久化且不误标为完成',async t=>{
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init();
  let entered;const started=new Promise(r=>{entered=r;});
  const service=new Service(store,{scanner:async(root,{signal})=>{entered();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}});
  const p=await service.addProject({path:f.project});
  const before=(await stat(store.journalPath)).size,start=performance.now();
  const saved=await service.saveSession(p.id,note);
  assert(performance.now()-start<400);assert.equal(saved.snapshotState,'pending');
  assert((await stat(store.journalPath)).size-before<8000);
  await started;assert.equal((await service.detail(p.id)).sessions[0].next,note.next);
  assert(service.cancel(p.id).cancelled);await service.waitForIdle();
  assert.equal((await service.detail(p.id)).sessions[0].snapshot.state,'cancelled');
  await service.close();await store.close();
  const reopened=await new Store(store.directory).init();
  assert.equal(reopened.read().sessions[0].next,note.next);await reopened.close();
});

test('重启不把未完成检查当作保存时的真实快照',async t=>{
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init(),service=new Service(store);
  const p=await service.addProject({path:f.project});
  await store.appendSession({...note,id:'pending-test',projectId:p.id,createdAt:new Date().toISOString(),snapshot:emptySnapshot()});
  await store.close();const reopened=await new Store(store.directory).init();
  assert.equal(reopened.read().sessions[0].snapshot.state,'interrupted');assert.equal(reopened.read().sessions[0].next,note.next);await reopened.close();
});

test('旧 JSON 迁移保留原文件；增量日志损坏尾部恢复到最后一条完整记录',async t=>{
  const f=await fixture(t),data=path.join(f.dir,'data');await mkdir(data);
  const legacy={version:1,projects:[{id:'old-project',path:f.project,name:'旧项目',createdAt:new Date().toISOString()}],sessions:[]};
  const original=JSON.stringify(legacy);await writeFile(path.join(data,'data.json'),original);
  const store=await new Store(data).init(),service=new Service(store);
  await service.saveSession('old-project',note);await service.waitForIdle();await store.close();
  assert.equal(await readFile(path.join(data,'data.json'),'utf8'),original);
  const size=(await stat(store.journalPath)).size;await appendFile(store.journalPath,'{"incomplete":');
  const reopened=await new Store(data).init();assert.equal(reopened.read().sessions.length,1);
  assert.equal((await stat(store.journalPath)).size,size);assert(reopened.notice.includes('末尾'));await reopened.close();
});

test('完整日志事务的校验失败不会静默丢弃记录',async t=>{
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init();
  await store.close();await appendFile(store.journalPath,'{"sequence":1,"projects":[],"sessions":[],"checksum":"wrong"}\n');
  await assert.rejects(new Store(store.directory).init(),/校验/);
  assert((await readFile(store.journalPath,'utf8')).includes('wrong'));
});

test('Git 失败不回退遍历全仓；优先捕获明确关注的文件',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.project,'.git'));
  await writeFile(path.join(f.project,'focus.txt'),'important');await writeFile(path.join(f.project,'unrelated.txt'),'not in scope');
  const result=await scanDirectory(f.project,{mode:'workset',focus:['focus.txt'],gitReader:async()=>{throw new Error('模拟 Git 失败');}});
  assert(result.truncated);assert.deepEqual(Object.keys(result.files),['focus.txt']);assert(result.warnings.some(s=>s.includes('没有退回')));
});

test('共享时间预算停止 Git；外部取消与超时分别呈现',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.project,'.git'));
  const reader=async(root,args,{signal})=>{
    if(args[0]!=='status')return {records:['main'],truncated:false};
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  const start=performance.now();const result=await scanDirectory(f.project,{gitReader:reader,limits:{durationMs:40}});
  assert(result.truncated);assert(performance.now()-start<700);assert(result.warnings.some(s=>s.includes('时间预算')));
  const controller=new AbortController();controller.abort(new Error('用户停止'));
  await assert.rejects(scanDirectory(f.project,{signal:controller.signal}),/用户停止/);
});

test('真实 Git 输出按记录数终止；默认工作集不读取干净文件和未跟踪目录',async t=>{
  const f=await fixture(t);const git=args=>exec('git',['-C',f.project,...args],{windowsHide:true});
  await git(['init','-b','main']);
  for(let i=0;i<20;i++)await writeFile(path.join(f.project,'tracked-'+i+'.txt'),'clean');
  await git(['add','.']);await git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
  await mkdir(path.join(f.project,'untracked'));await writeFile(path.join(f.project,'untracked','new.txt'),'new');
  await writeFile(path.join(f.project,'tracked-0.txt'),'changed');
  const listed=await gitRecords(f.project,['ls-files','-z'],{maxRecords:3});assert(listed.truncated);assert.equal(listed.records.length,3);
  const result=await scanDirectory(f.project,{mode:'workset',includeUntracked:false});
  assert.deepEqual(Object.keys(result.files),['tracked-0.txt']);assert.equal(result.coverage.includeUntracked,false);
  const selected=await scanDirectory(f.project,{mode:'workset',scope:['tracked-1.txt']});
  assert.deepEqual(Object.keys(selected.files),['tracked-1.txt']);
});

test('范围变化不误报文件删除，显式确认缺失的文件仍可判定删除',async()=>{
  const hash='a'.repeat(64),before={files:{'a.txt':{hash,size:1}},coverage:{mode:'full'},truncated:false,git:null};
  const after={files:{},coverage:{mode:'workset'},truncated:false,git:null,absent:[]};
  assert.equal(compareSnapshots(before,after).changes[0].kind,'unverified');
  assert.equal(compareSnapshots(before,{...after,absent:['a.txt']}).changes[0].kind,'deleted');
});

test('后台跨项目串行执行，关注配置持久化并拒绝越界',async t=>{
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init();
  let active=0,peak=0;
  const service=new Service(store,{scanner:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;return {...emptySnapshot('complete'),truncated:false};}});
  const p1=await service.addProject({path:f.project});const other=path.join(f.dir,'other');await mkdir(other);const p2=await service.addProject({path:other});
  await Promise.all([service.refresh(p1.id),service.refresh(p2.id)]);assert.equal(peak,1);
  await service.setScope(p1.id,{scanMode:'workset',scope:['src'],includeUntracked:false});
  await assert.rejects(service.setScope(p1.id,{scope:['../escape']}),/相对路径/);
  await service.close();await store.close();
  const reopened=await new Store(store.directory).init();assert.deepEqual(reopened.read().projects[0].scope,['src']);await reopened.close();
});


test('Windows：取消 Git 会终止启动器和它启动的子进程', {skip:process.platform!=='win32'}, async t=>{
  const f=await fixture(t),pidFile=path.join(f.project,'child.pid'),beat=path.join(f.project,'heartbeat.txt');
  await exec('git',['-C',f.project,'init','-b','main'],{windowsHide:true});
  await writeFile(path.join(f.project,'child.cjs'),"const fs=require('node:fs');fs.writeFileSync('child.pid',String(process.pid));setInterval(()=>fs.writeFileSync('heartbeat.txt',String(Date.now())),30);");
  const controller=new AbortController();let pid;
  const running=gitRecords(f.project,['-c','alias.xushang-test=!node child.cjs','xushang-test'],{signal:controller.signal});
  running.catch(()=>{});
  try{
    for(let i=0;i<100;i++){try{pid=Number(await readFile(pidFile,'utf8'));await readFile(beat,'utf8');break;}catch{await new Promise(r=>setTimeout(r,20));}}
    assert(pid,'The real child process should have started.');
    controller.abort(new Error('test cancel'));
    await assert.rejects(Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(new Error('process tree did not stop')),2000))]),/test cancel/);
    const before=await readFile(beat,'utf8');await new Promise(r=>setTimeout(r,150));
    assert.equal(await readFile(beat,'utf8'),before);
    assert.throws(()=>process.kill(pid,0));
  }finally{
    controller.abort();
    if(pid){try{process.kill(pid,0);await exec('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});}catch{}}
  }
});


test('导入未完成快照不会产生永远排队的后台任务',async t=>{
  const f=await fixture(t);const store=await new Store(path.join(f.dir,'data')).init(),service=new Service(store);
  const p=await service.addProject({path:f.project});
  const data={version:1,projects:[p],sessions:[{...note,id:'import-pending',projectId:p.id,createdAt:new Date().toISOString(),snapshot:emptySnapshot()}]};
  await service.importJson(data);const detail=await service.detail(p.id);
  assert.equal(detail.sessions[0].snapshot.state,'interrupted');assert.equal(detail.job,null);
  await service.close();await store.close();
});


test('历史分页保留全部记录，首屏不发送所有旧现场',async t=>{
  const f=await fixture(t),store=await new Store(path.join(f.dir,'data')).init(),service=new Service(store);
  const p=await service.addProject({path:f.project});
  const sessions=Array.from({length:105},(_,i)=>({...note,id:'history-'+i,projectId:p.id,createdAt:new Date(Date.now()-i*1000).toISOString(),snapshot:{...emptySnapshot('complete'),truncated:false,coverage:{mode:'workset',roots:[],includeUntracked:false}}}));
  await service.importJson({version:1,projects:[p],sessions});
  const first=await service.detail(p.id),older=await service.history(p.id,100);
  assert.equal(first.sessions.length,100);assert.equal(first.totalSessions,105);assert.equal(older.sessions.length,5);
  assert.equal(new Set([...first.sessions,...older.sessions].map(s=>s.id)).size,105);
  assert.equal(first.sessions[0].snapshot.files,undefined);
  await service.close();await store.close();
});

