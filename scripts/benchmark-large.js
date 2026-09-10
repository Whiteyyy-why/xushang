import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { within } from '../src/scanner.js';
import { gitRecords } from '../src/git.js';
const exec=promisify(execFile),base=path.resolve('test-results');
const count=Number(process.env.XUSHANG_BENCH_FILES||100000),untracked=Math.floor(count/5);
if(!Number.isInteger(count)||count<1000||count>200000)throw new Error('Use 1000..200000 generated files.');
await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'large-bench-')),repo=path.join(dir,'repo');await mkdir(repo);
const git=(args,input)=>gitRecords(repo,args,{signal:AbortSignal.timeout(120000),input});
let app;
async function generate(parent,total) {
  const groups=Math.ceil(total/1000);await mkdir(parent,{recursive:true});
  for(let i=0;i<groups;i++)await mkdir(path.join(parent,'m'+i));
  let next=0;
  await Promise.all(Array.from({length:24},async()=>{while(next<total){const i=next++;await writeFile(path.join(parent,'m'+Math.floor(i/1000),'file-'+i+'.txt'),'Shared fixture content\n');}}));
}
try {
  console.log('Creating '+count+' tracked fixture files…');await generate(path.join(repo,'src'),count);
  console.log('Building a real Git index through the batch index API…');await git(['init','-b','main']);
  const blob=(await git(['hash-object','-w','--stdin'],'Shared fixture content\n')).records[0];
  const entries=Array.from({length:count},(_,i)=>'100644 '+blob+'\tsrc/m'+Math.floor(i/1000)+'/file-'+i+'.txt\n').join('');
  await git(['update-index','--index-info'],entries);
  const tree=(await git(['write-tree'])).records[0];
  const commit=(await git(['-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit-tree',tree,'-m','fixture'])).records[0];
  await git(['update-ref','refs/heads/main',commit]);
  console.log('Creating '+untracked+' untracked fixture files…');await generate(path.join(repo,'untracked'),untracked);
  await writeFile(path.join(repo,'src','m0','file-0.txt'),'Changed file\n');
  app=await createApp({dataDirectory:path.join(dir,'data'),port:0});
  const p=await app.service.addProject({path:repo,name:'Large Git benchmark'});
  const note={title:'大型仓库现场',next:'继续当前模块',note:'benchmark',file:'src/m0/file-0.txt',line:1};
  const firstStart=performance.now();await app.service.saveSession(p.id,note);const firstSave=performance.now()-firstStart;
  await app.service.waitForIdle();const firstDetail=await app.service.detail(p.id);
  const firstScan=firstDetail.sessions[0].snapshot;
  const backup=await app.service.exportJson(),seed=backup.sessions[0];
  for(let i=1;i<100;i++)backup.sessions.push({...seed,id:randomUUID(),title:'History '+i,createdAt:new Date(Date.now()-i*60000).toISOString()});
  await app.service.importJson(backup);await app.close();
  const cold=performance.now();app=await createApp({dataDirectory:path.join(dir,'data'),port:0});const restart=performance.now()-cold;
  const opening=[],saves=[],saveBytes=[];let responseKB;
  for(let i=0;i<20;i++){
    const t=performance.now();
    await fetch(app.origin+'/api/projects',{headers:{'X-Xushang-Client':'1'}}).then(r=>r.json());
    const body=await fetch(app.origin+'/api/projects/'+p.id,{headers:{'X-Xushang-Client':'1'}}).then(r=>r.text());
    responseKB=Math.round(Buffer.byteLength(body)/1024);opening.push(performance.now()-t);
  }
  await app.service.setScope(p.id,{scanMode:'workset',scope:['src/m0/file-0.txt'],includeUntracked:false});
  console.log('Measuring durable saves and scoped background checks…');
  for(let i=0;i<5;i++){
    const before=(await stat(app.store.journalPath)).size,t=performance.now();
    const response=await fetch(app.origin+'/api/projects/'+p.id+'/sessions',{method:'POST',headers:{'X-Xushang-Client':'1','Content-Type':'application/json'},body:JSON.stringify({...note,title:'Capture '+i})});
    if(!response.ok)throw new Error(await response.text());await response.json();
    saves.push(performance.now()-t);saveBytes.push((await stat(app.store.journalPath)).size-before);
    await app.service.waitForIdle();
  }
  console.log('Checking a branch switch…');await git(['branch','next']);await git(['symbolic-ref','HEAD','refs/heads/next']);
  const changed=await app.service.refresh(p.id,{force:true});
  opening.sort((a,b)=>a-b);saves.sort((a,b)=>a-b);
  const result={
    fixture:{trackedFiles:count,untrackedFiles:untracked,historyBeforeMeasurement:100,realGitIndex:true,indexConstruction:'Git update-index --index-info; cold stat cache; real files present'},
    firstDurableNoteSaveMs:Math.round(firstSave),firstBackgroundScanMs:firstScan.durationMs,firstBackgroundState:firstScan.state,
    capturedFileCount:firstScan.fileCount,scopedBackgroundState:changed.current?.state,scopedBackgroundMs:changed.current?.durationMs,serverRestartMs:Math.round(restart),
    openingApiMedianMs:Math.round(opening[10]),openingApiP95Ms:Math.round(opening[18]),
    durableSaveMedianMs:Math.round(saves[2]),durableSaveMaxMs:Math.round(saves[4]),maxBytesAppendedBeforeSaveResponse:Math.max(...saveBytes),
    detailResponseKB:responseKB,branchChangeDetected:changed.comparison?.branchChanged===true,
    scope:'Initial scan: changed tracked files + focus. Save measurements: explicit src/m0/file-0.txt scope. Untracked enumeration disabled.',
    note:'Synthetic local benchmark, not full-repository content scanning or a guarantee on other hardware.'
  };
  await writeFile('docs/performance-large.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {
  if(app)await app.close();
  console.log('Removing the generated benchmark directory…');
  if(!within(base,dir)||dir===base)throw new Error('Unsafe benchmark cleanup path.');
  await rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:500});
}
