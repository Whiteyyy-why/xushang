import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const source=await readFile(new URL('../public/work.js',import.meta.url),'utf8');
const fields=()=>({title:'',goal:'',note:'',next:'',file:'',line:1,active:false});
function browser(buffer,api) {
  const storage={getItem:k=>buffer.get(k)||null,setItem:(k,v)=>buffer.set(k,v),removeItem:k=>buffer.delete(k)};
  const window={addEventListener(){}};
  const document={querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},hidden:false};
  let timer=0;const timers=new Map();
  runInNewContext(source,{window,document,localStorage:storage,crypto:{randomUUID},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
  return window.createWorkController({api,escapeHtml:String,onChange(){},toast(){}});
}
const project={id:'browser-project',name:'测试项目'};
const initial=()=>({projectId:project.id,id:'draft-1',revision:3,updatedAt:new Date().toISOString(),writerId:'previous-page',writerSeq:1,fields:fields()});

test('未获服务器确认的输入能在新的页面实例中恢复',async()=>{
  const buffer=new Map(),remote=initial();
  const offline=async(url,body)=>{if(body)throw new Error('offline');return structuredClone(remote);};
  const first=browser(buffer,offline);await first.load(project,null);first.change({active:true,goal:'先处理当前模块',note:'最后输入的一句话'});
  await assert.rejects(first.flush(),/offline/);
  assert(buffer.has('xushang-buffer:'+project.id));
  const second=browser(buffer,offline);await second.load(project,null);
  assert.equal(second.fields().note,'最后输入的一句话');assert.equal(second.fields().goal,'先处理当前模块');
  assert.equal(remote.fields.note,'');
});

test('关闭前较早的请求已成功时，仍恢复更晚输入的内容',async()=>{
  const remote=initial(),buffer=new Map();
  remote.revision=4;remote.writerId='same-page';remote.writerSeq=2;remote.fields.note='较早内容';
  buffer.set('xushang-buffer:'+project.id,JSON.stringify({baseRevision:3,writerId:'same-page',writerSeq:3,fields:{...fields(),note:'更晚内容'}}));
  let written;
  const client=browser(buffer,async(url,body)=>{
    if(!body)return structuredClone(remote);
    written=body;return {...remote,revision:5,fields:body.fields,writerId:body.clientId,writerSeq:body.clientSeq};
  });
  await client.load(project,null);assert.equal(client.fields().note,'更晚内容');await client.flush();
  assert.equal(written.baseRevision,4);assert.equal(written.fields.note,'更晚内容');
});

test('另一窗口的更新不会被本页恢复逻辑自动覆盖',async()=>{
  const remote=initial(),buffer=new Map();let writes=0;
  remote.revision=5;remote.writerId='other-page';remote.fields.note='另一窗口';
  buffer.set('xushang-buffer:'+project.id,JSON.stringify({baseRevision:3,writerId:'this-page',writerSeq:2,fields:{...fields(),note:'本页未提交'}}));
  const client=browser(buffer,async(url,body)=>{if(body)writes++;return structuredClone(remote);});
  await client.load(project,null);assert.equal(client.fields().note,'本页未提交');assert(client.status().includes('另一窗口'));
  await assert.rejects(client.flush(),/选择/);assert.equal(writes,0);
  await client.resolve(false);assert.equal(client.fields().note,'另一窗口');
});

test('输入发生在保存请求途中时，串行保存最后的内容',async()=>{
  const buffer=new Map(),remote=initial();let release;const requests=[];
  const client=browser(buffer,async(url,body)=>{
    if(!body)return structuredClone(remote);
    requests.push(body);
    if(requests.length===1)await new Promise(r=>{release=r;});
    return {...remote,revision:body.baseRevision+1,fields:body.fields};
  });
  await client.load(project,null);client.change({note:'第一次'});
  const saving=client.flush();await Promise.resolve();
  client.change({note:'最后一次'});release();await saving;
  assert.equal(requests.length,2);assert.equal(requests[1].fields.note,'最后一次');assert.equal(requests[1].baseRevision,4);
  assert.equal(buffer.has('xushang-buffer:'+project.id),false);
});


test('加载未完成就切换项目时，旧操作不会污染新项目',async()=>{
  for(const action of ['start','finishFields']){
    const buffer=new Map(),other={id:'other-project',name:'另一个项目'};let release;
    const remote=initial(),remoteOther={...initial(),projectId:other.id,fields:{...fields(),goal:'新项目的目标'}};
    const client=browser(buffer,async url=>url.includes('/other-project/')?structuredClone(remoteOther):new Promise(r=>{release=r;}));
    const loading=client.load(project,{next:'旧项目的下一步'}),operation=client[action]();
    await client.load(other,null);release(remote);await loading;const result=await operation;
    assert.equal(client.fields().goal,'新项目的目标');assert.equal(client.fields().active,false);
    if(action==='finishFields')assert.equal(result,null);
  }
});
