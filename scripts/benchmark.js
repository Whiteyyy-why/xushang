import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { within } from '../src/scanner.js';
const exec=promisify(execFile);
const base=path.resolve('test-results');await mkdir(base,{recursive:true});
const dir=await mkdtemp(path.join(base,'bench-'));const folder=path.join(dir,'repo');await mkdir(folder);
let app;
try {
  for(let i=0;i<1000;i++)await writeFile(path.join(folder,'file-'+i+'.txt'),'Sample file '+i+'\n'.repeat(5));
  await exec('git',['-C',folder,'init','-b','main'],{windowsHide:true});
  app=await createApp({dataDirectory:path.join(dir,'data'),port:0});
  const p=await app.service.addProject({path:folder,name:'1000 files'});
  await app.service.setScope(p.id,{scanMode:'full',scope:[],includeUntracked:true});
  const scanStart=performance.now();await app.service.saveSession(p.id,{title:'Benchmark',next:'Continue',note:'',file:'',line:1});
  await app.service.waitForIdle();
  const initialScanMs=performance.now()-scanStart;
  const backup=await app.service.exportJson();const seed=backup.sessions[0];
  for(let i=1;i<100;i++)backup.sessions.push({...seed,id:randomUUID(),title:'History '+i,createdAt:new Date(Date.now()-i*60000).toISOString()});
  await app.service.importJson(backup);
  await app.close();const boot=performance.now();app=await createApp({dataDirectory:path.join(dir,'data'),port:0});
  const serverRestartMs=performance.now()-boot;
  const samples=[];let bytes;
  for(let i=0;i<20;i++){
    const start=performance.now();
    await fetch(app.origin+'/api/projects',{headers:{'X-Xushang-Client':'1'}}).then(r=>r.json());
    const body=await fetch(app.origin+'/api/projects/'+p.id,{headers:{'X-Xushang-Client':'1'}}).then(r=>r.text());
    bytes=Buffer.byteLength(body);samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);
  const result={fixture:{files:1000,history:100,kind:'local Git repository without a remote'},initialSaveIncludingScanMs:Math.round(initialScanMs),serverRestartMs:Math.round(serverRestartMs),openingApiMedianMs:Math.round(samples[10]),openingApiP95Ms:Math.round(samples[18]),detailResponseKB:Math.round(bytes/1024),note:'Local synthetic fixture; measurements are not a guarantee for every device or repository.'};
  console.log(JSON.stringify(result,null,2));await writeFile('docs/performance.json',JSON.stringify(result,null,2));
}finally{if(app)await app.close();if(within(base,dir)&&dir!==base)await rm(dir,{recursive:true,force:true});}
