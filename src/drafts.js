import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeScope } from './scanner.js';

export const blankFields = () => ({ title:'', goal:'', note:'', next:'', file:'', line:1, active:false });
export function draftFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿格式无效。');
  const out=blankFields();
  for (const [key, max] of Object.entries({title:150,goal:3000,note:6000,next:3000,file:4096})) {
    const text=value[key] ?? '';
    if(typeof text!=='string' || text.length>max)throw new Error('草稿内容超过限制或格式无效。');
    out[key]=text;
  }
  out.file=out.file.replaceAll('\\','/');
  if(out.file.trim())normalizeScope([out.file.trim()]);
  out.line=Number(value.line || 1);
  if(!Number.isInteger(out.line)||out.line<1||out.line>10000000)throw new Error('行号无效。');
  out.active=value.active===true;
  return out;
}
export function hasDraft(draft) {
  return Boolean(draft.fields.active || ['title','goal','note','next','file'].some(k=>draft.fields[k].trim()));
}
export class DraftConflict extends Error {
  constructor(current) { super('另一窗口已更新这份草稿。本页输入仍然保留，请选择要继续使用的版本。');this.statusCode=409;this.current=current; }
}
export class DraftStore {
  constructor(directory) { this.directory=path.join(directory,'drafts');this.queues=new Map();this.cache=new Map(); }
  file(id) { return path.join(this.directory,createHash('sha256').update(id).digest('hex')+'.json'); }
  blank(projectId,revision=0) { return {projectId,id:null,revision,updatedAt:null,writerId:null,writerSeq:0,fields:blankFields()}; }
  run(id,action) {
    const previous=this.queues.get(id)||Promise.resolve();
    const next=previous.catch(()=>{}).then(action);
    this.queues.set(id,next);next.finally(()=>{if(this.queues.get(id)===next)this.queues.delete(id);}).catch(()=>{});
    return next;
  }
  async read(id) {
    if(this.cache.has(id))return structuredClone(this.cache.get(id));
    let result;
    try {
      const value=JSON.parse(await readFile(this.file(id),'utf8'));
      if(value.projectId!==id || !Number.isSafeInteger(value.revision) || value.revision<0 || (value.id!==null && typeof value.id!=='string'))throw new Error('草稿文件无效。原文件已保留。');
      result={projectId:id,id:value.id,revision:value.revision,updatedAt:value.updatedAt,writerId:typeof value.writerId==='string'?value.writerId:null,writerSeq:Number.isSafeInteger(value.writerSeq)?value.writerSeq:0,fields:draftFields(value.fields)};
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      result=this.blank(id);
    }
    this.cache.set(id,result);return structuredClone(result);
  }
  get(id) { return this.run(id,()=>this.read(id)); }
  async write(draft) {
    await mkdir(this.directory,{recursive:true});
    const file=this.file(draft.projectId),temp=file+'.'+randomUUID()+'.tmp';
    const handle=await open(temp,'wx');
    try { await handle.writeFile(JSON.stringify(draft));await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp,file); } catch(error) { await unlink(temp).catch(()=>{});throw error; }
    this.cache.set(draft.projectId,structuredClone(draft));
    return structuredClone(draft);
  }
  put(id,input) {
    const fields=draftFields(input.fields);
    if(input.clientId!==undefined && (typeof input.clientId!=='string'||input.clientId.length>80))throw new Error('草稿客户端标识无效。');
    if(input.clientSeq!==undefined && (!Number.isSafeInteger(input.clientSeq)||input.clientSeq<0))throw new Error('草稿序号无效。');
    if(!Number.isSafeInteger(input.baseRevision) || input.baseRevision<0)throw new Error('草稿版本无效。');
    return this.run(id,async()=>{
      const current=await this.read(id);
      if(current.revision!==input.baseRevision)throw new DraftConflict(current);
      const next={projectId:id,id:current.id||randomUUID(),revision:current.revision+1,updatedAt:new Date().toISOString(),writerId:input.clientId||null,writerSeq:input.clientSeq||0,fields};
      return this.write(next);
    });
  }
  complete(id,token,commit) {
    return this.run(id,async()=>{
      const current=await this.read(id);
      if(current.id!==token.draftId || current.revision!==token.draftRevision)throw new DraftConflict(current);
      const result=await commit();
      // Once the scene is durable, a cleanup failure must not turn it into a failed save.
      try {
        const draft=await this.write(this.blank(id,current.revision+1));
        return {...result,draft,draftCleared:true};
      } catch {
        return {...result,draft:current,draftCleared:false,warning:'现场已保存，但草稿暂未清理。请重试保存以完成清理。'};
      }
    });
  }
  async list(projects) {
    const drafts=await Promise.all(projects.map(p=>this.get(p.id)));
    return drafts.filter(hasDraft);
  }
  validateImport(value,projects) {
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>200)throw new Error('备份中的草稿列表无效。');
    const known=new Set(projects.map(p=>p.id)),seen=new Set();
    return value.map(d=>{
      if(!d || !known.has(d.projectId) || seen.has(d.projectId))throw new Error('草稿对应的项目无效或重复。');
      seen.add(d.projectId);return {projectId:d.projectId,fields:draftFields(d.fields)};
    });
  }
  async restore(id,fields) {
    return this.run(id,async()=>{
      const current=await this.read(id);
      if(hasDraft(current))return false;
      await this.write({projectId:id,id:randomUUID(),revision:current.revision+1,updatedAt:new Date().toISOString(),fields:draftFields(fields)});
      return true;
    });
  }
  async close() { await Promise.allSettled([...this.queues.values()]); }
}
