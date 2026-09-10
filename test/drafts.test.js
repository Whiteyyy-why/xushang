import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { DraftStore, blankFields } from '../src/drafts.js';
import { emptySnapshot, within } from '../src/scanner.js';
import { createApp } from '../src/server.js';

const base=path.resolve('test-results');
async function fixture(t) {
  await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'draft-test-')),folder=path.join(dir,'project');await mkdir(folder);
  const store=await new Store(path.join(dir,'data')).init(),service=new Service(store);
  t.after(async()=>{await service.close();await store.close();assert(within(base,dir)&&dir!==base);await rm(dir,{recursive:true,force:true});});
  const p=await service.addProject({path:folder});return{dir,folder,store,service,p};
}
const fields={...blankFields(),active:true,title:'日常工作',goal:'推进自动草稿',note:'卡点：关闭窗口后不能丢失输入。',next:'验证隔天恢复。',file:'src/main.js',line:12};
const scene=d=>({title:d.fields.title,goal:d.fields.goal,note:d.fields.note,next:d.fields.next,file:d.fields.file,line:d.fields.line,draftId:d.id,draftRevision:d.revision});

test('草稿自动保存不触发扫描，也不反复追加到历史日志',async t=>{
  const f=await fixture(t);let scans=0;f.service.scanner=async()=>{scans++;return emptySnapshot('complete');};
  const before=(await stat(f.store.journalPath)).size;
  let d=await f.service.getDraft(f.p.id);
  for(let i=0;i<10;i++)d=await f.service.putDraft(f.p.id,{baseRevision:d.revision,fields:{...fields,note:'随手记 '+i},clientId:'client-a',clientSeq:i});
  assert.equal(scans,0);assert.equal((await stat(f.store.journalPath)).size,before);assert.equal(d.fields.note,'随手记 9');
  assert.equal(d.writerId,'client-a');assert.equal(d.writerSeq,9);
});

test('草稿跨重启恢复并按项目隔离',async t=>{
  const f=await fixture(t);const other=path.join(f.dir,'other');await mkdir(other);const p2=await f.service.addProject({path:other});
  await f.service.putDraft(f.p.id,{baseRevision:0,fields});await f.service.putDraft(p2.id,{baseRevision:0,fields:{...fields,note:'另一项目'}});
  await f.service.close();await f.store.close();
  const reopened=await new Store(f.store.directory).init(),service=new Service(reopened);
  assert.equal((await service.getDraft(f.p.id)).fields.note,fields.note);assert.equal((await service.getDraft(p2.id)).fields.note,'另一项目');
  await service.close();await reopened.close();
});

test('过期版本不能覆盖另一窗口的新草稿',async t=>{
  const f=await fixture(t);const initial=await f.service.putDraft(f.p.id,{baseRevision:0,fields});
  const latest=await f.service.putDraft(f.p.id,{baseRevision:initial.revision,fields:{...fields,note:'新窗口修改'}});
  await assert.rejects(f.service.putDraft(f.p.id,{baseRevision:initial.revision,fields}),error=>error.statusCode===409&&error.current.fields.note==='新窗口修改');
  await assert.rejects(f.service.saveSession(f.p.id,scene(initial)),error=>error.statusCode===409);
  assert.equal(f.store.read().sessions.length,0);assert.equal((await f.service.getDraft(f.p.id)).revision,latest.revision);
});

test('收工先保存现场并清理对应草稿，不等待后台扫描',async t=>{
  const f=await fixture(t);let entered;const started=new Promise(r=>{entered=r;});
  f.service.scanner=async(root,{signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const d=await f.service.putDraft(f.p.id,{baseRevision:0,fields}),start=performance.now();
  const saved=await f.service.saveSession(f.p.id,scene(d));
  assert(performance.now()-start<300);assert(saved.draftCleared);assert.equal((await f.service.getDraft(f.p.id)).id,null);
  assert.equal(f.store.read().sessions[0].goal,fields.goal);await started;f.service.cancel(f.p.id);await f.service.waitForIdle();
  assert.equal(f.store.read().sessions[0].next,fields.next);
});

test('重复收工不会增加重复记录，也不会清空随后开始的新草稿',async t=>{
  const f=await fixture(t);const d=await f.service.putDraft(f.p.id,{baseRevision:0,fields});
  const [a,b]=await Promise.all([f.service.saveSession(f.p.id,scene(d)),f.service.saveSession(f.p.id,scene(d))]);
  assert.equal(a.id,b.id);assert.equal(f.store.read().sessions.length,1);await f.service.waitForIdle();
  const cleared=await f.service.getDraft(f.p.id),next=await f.service.putDraft(f.p.id,{baseRevision:cleared.revision,fields:{...fields,goal:'新的工作'}});
  const again=await f.service.saveSession(f.p.id,scene(d));assert.equal(again.id,a.id);
  assert.equal((await f.service.getDraft(f.p.id)).id,next.id);assert.equal((await f.service.getDraft(f.p.id)).fields.goal,'新的工作');
});

test('JSON 与 Markdown 包含草稿，导入保留本机正在进行的工作',async t=>{
  const f=await fixture(t);await f.service.putDraft(f.p.id,{baseRevision:0,fields});
  const backup=await f.service.exportJson();assert.equal(backup.drafts.length,1);assert((await f.service.exportMarkdown()).includes('未归档草稿'));
  const store=await new Store(path.join(f.dir,'import-data')).init(),other=new Service(store);
  const restored=await other.importJson(backup);assert.equal(restored.drafts,1);assert.equal((await other.getDraft(f.p.id)).fields.goal,fields.goal);
  const local=await other.getDraft(f.p.id);await other.putDraft(f.p.id,{baseRevision:local.revision,fields:{...fields,goal:'保留本机目标'}});
  const twice=await other.importJson(backup);assert.equal(twice.skippedDrafts,1);assert.equal((await other.getDraft(f.p.id)).fields.goal,'保留本机目标');
  await other.close();await store.close();
});

test('无效草稿备份在导入任何记录前被拒绝；草稿文件名不使用外部路径',async t=>{
  const f=await fixture(t);const backup=await f.service.exportJson();
  backup.drafts=[{projectId:f.p.id,fields:{...fields,file:'../escape'}}];
  await assert.rejects(f.service.importJson(backup),/相对路径/);assert.equal(f.store.read().sessions.length,0);
  const drafts=new DraftStore(path.join(f.dir,'safe'));
  await drafts.put('../../escape',{baseRevision:0,fields});
  assert(within(drafts.directory,drafts.file('../../escape')));
  await drafts.close();
});

test('HTTP 草稿接口返回冲突版本，并支持快速收工与备份',async t=>{
  const f=await fixture(t);const app=await createApp({dataDirectory:path.join(f.dir,'api-data'),port:0});
  t.after(()=>app.close());
  const call=async(route,body)=>{
    const response=await fetch(app.origin+route,{method:body?'POST':'GET',headers:{'X-Xushang-Client':'1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return{status:response.status,data:await response.json()};
  };
  const {data:p}=await call('/api/projects',{path:f.folder});
  const {data:d}=await call('/api/projects/'+p.id+'/draft',{baseRevision:0,fields});
  const conflict=await call('/api/projects/'+p.id+'/draft',{baseRevision:0,fields});
  assert.equal(conflict.status,409);assert.equal(conflict.data.current.revision,d.revision);
  const saved=await call('/api/projects/'+p.id+'/sessions',scene(d));assert.equal(saved.status,201);assert(saved.data.draftCleared);
  assert.equal((await call('/api/projects/'+p.id+'/draft')).data.fields.next,'');
  assert.equal((await call('/api/export')).data.sessions.length,1);
});


test('备份与收工并发时，不漏掉刚从草稿归档的内容',async t=>{
  const f=await fixture(t);const d=await f.service.putDraft(f.p.id,{baseRevision:0,fields});
  const append=f.store.appendSession.bind(f.store);let entered,release;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  f.store.appendSession=async scene=>{entered();await gate;return append(scene);};
  const saving=f.service.saveSession(f.p.id,scene(d));await started;
  const exporting=f.service.exportJson();release();
  const [saved,backup]=await Promise.all([saving,exporting]);
  assert.equal(backup.sessions.find(s=>s.id===saved.id).next,fields.next);
  assert.equal(backup.drafts?.length||0,0);
});
