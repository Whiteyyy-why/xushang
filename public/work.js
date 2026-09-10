window.createWorkController=function({api,escapeHtml:e,onChange,toast}) {
  const contexts=new Map(),clientId=crypto.randomUUID();
  let currentId='';
  const defaults=()=>({title:'',goal:'',note:'',next:'',file:'',line:1,active:false});
  const key=id=>'xushang-buffer:'+id;
  const content=c=>Boolean(c?.id || c?.dirty || c?.fields.active);
  const readBuffer=id=>{try{const b=JSON.parse(localStorage.getItem(key(id)));return b&&b.fields&&Number.isSafeInteger(b.baseRevision)?b:null;}catch{return null;}};
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function writeBuffer(c) {
    try{localStorage.setItem(key(c.project.id),JSON.stringify({fields:c.fields,baseRevision:c.revision,writerId:clientId,writerSeq:c.seq,updatedAt:Date.now()}));}
    catch{c.bufferError='浏览器暂存不可用，请等待本机保存确认后关闭。';}
  }
  function clearBuffer(c) {
    try{
      const b=readBuffer(c.project.id);
      if(!b || b.writerId===clientId || equal(b.fields,c.fields))localStorage.removeItem(key(c.project.id));
    }catch{}
  }
  function status(c) {
    if(!c?.loaded)return '正在恢复草稿…';
    if(c.conflict)return '检测到另一窗口的修改';
    if(c.error)return '暂存于浏览器 · 本机保存未成功';
    if(c.dirty || c.inflight)return '正在保存草稿…';
    return c.updatedAt ? '草稿已保存到本机 '+new Date(c.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '输入后自动保存草稿';
  }
  function refreshStatus(c) {
    if(currentId!==c.project.id)return;
    const location=document.querySelector('.focus-location summary');if(location)location.textContent='工作位置'+(c.fields.file?' · '+c.fields.file:'（选填）');
    document.querySelectorAll('[data-draft-status]').forEach(el=>{const label=status(c);if(el.textContent!==label)el.textContent=label;el.classList.toggle('draft-warning',Boolean(c.error||c.conflict));});
    document.querySelectorAll('[data-draft-error]').forEach(el=>{el.textContent=c.bufferError || (!c.conflict&&c.error ? c.error : '');el.hidden=!el.textContent;});
    document.querySelectorAll('[data-draft-conflict]').forEach(box=>box.innerHTML=c.conflict?'<p>另一窗口已有更新。本页输入仍在，选择要接着用的版本。</p><p>已保存版本：'+e((c.conflict.fields.note||c.conflict.fields.goal||c.conflict.fields.next||c.conflict.fields.title||'空草稿').slice(0,160))+'</p><button type="button" class="button small" data-action="keep-draft">保留本页输入</button> <button type="button" class="button small" data-action="remote-draft">加载已保存版本</button>':'');
  }
  function adopt(c,remote) {
    c.id=remote.id;c.revision=remote.revision;c.fields={...defaults(),...remote.fields};
    c.updatedAt=remote.updatedAt;c.dirty=false;c.conflict=null;c.error='';c.loaded=true;
  }
  async function flush(c=contexts.get(currentId)) {
    if(!c)return;
    clearTimeout(c.timer);
    if(c.ready)await c.ready;
    if(c.inflight){await c.inflight;if(c.dirty)return flush(c);return;}
    if(c.conflict)throw new Error('请先选择要保留的草稿版本。');
    if(c.error&&!c.dirty&&c.id){c.dirty=true;c.seq++;writeBuffer(c);}
    if(!c.dirty)return;
    const sequence=c.seq,fields={...c.fields},base=c.revision;
    c.error='';
    c.inflight=api('/projects/'+encodeURIComponent(c.project.id)+'/draft',{baseRevision:base,fields,clientId,clientSeq:sequence},{keepalive:true})
      .then(remote=>{
        c.id=remote.id;c.revision=remote.revision;c.updatedAt=remote.updatedAt;
        if(c.seq===sequence){c.dirty=false;c.bufferError='';clearBuffer(c);}else writeBuffer(c);
      }).catch(error=>{
        c.error=error.message;
        if(error.status===409&&error.current)c.conflict=error.current;
        writeBuffer(c);throw error;
      }).finally(()=>{c.inflight=null;refreshStatus(c);});
    refreshStatus(c);
    await c.inflight;
    if(c.dirty)return flush(c);
  }
  function change(patch,id=currentId) {
    const c=contexts.get(id);if(!c)return;
    c.fields={...c.fields,...patch};c.seq++;c.dirty=true;writeBuffer(c);
    clearTimeout(c.timer);c.timer=setTimeout(()=>flush(c).catch(()=>{}),650);refreshStatus(c);
  }
  function load(project,latest) {
    currentId=project.id;
    let c=contexts.get(project.id);
    if(c?.loaded){
      c.latest=latest;
      if(c.dirty||c.inflight||c.conflict){refreshStatus(c);return Promise.resolve(c);}
      let updated=false;
      c.ready=api('/projects/'+encodeURIComponent(project.id)+'/draft').then(remote=>{
        if(!c.dirty&&!c.inflight&&remote.revision!==c.revision){adopt(c,remote);updated=true;}
      }).catch(error=>{c.error=error.message;}).finally(()=>{c.ready=null;if(updated&&currentId===project.id)onChange(true);refreshStatus(c);});
      return c.ready;
    }
    const b=readBuffer(project.id);
    c={project,latest,fields:defaults(),id:null,revision:0,seq:0,dirty:false,loaded:false,error:'',conflict:null,inflight:null};
    contexts.set(project.id,c);
    c.ready=api('/projects/'+encodeURIComponent(project.id)+'/draft').then(remote=>{
      adopt(c,remote);
      if(b) {
        if(equal(b.fields,remote.fields) || (remote.writerId===b.writerId && remote.writerSeq>=b.writerSeq)) {
          try{localStorage.removeItem(key(project.id));}catch{}
        }else if(remote.revision===b.baseRevision || (remote.writerId===b.writerId && remote.writerSeq<b.writerSeq)) {
          c.fields={...defaults(),...b.fields};c.dirty=true;c.seq++;writeBuffer(c);
        }else{c.fields={...defaults(),...b.fields};c.dirty=true;c.conflict=remote;}
      }
    }).catch(error=>{
      c.loaded=true;c.error=error.message;
      if(b){c.fields={...defaults(),...b.fields};c.revision=b.baseRevision;c.dirty=true;c.seq++;writeBuffer(c);}
    }).finally(()=>{
      c.ready=null;
      if(currentId===project.id){onChange(true);refreshStatus(c);}
      if(c.dirty&&!c.conflict)c.timer=setTimeout(()=>flush(c).catch(()=>{}),650);
    });
    return c.ready;
  }
  function seed() {
    const c=contexts.get(currentId);
    if(c&&!content(c))c.fields={...defaults(),title:c.latest?.title||'',file:c.latest?.file||'',line:c.latest?.line||1};
    return c;
  }
  async function start() {
    const c=contexts.get(currentId);if(!c)return;
    if(c.ready)await c.ready;
    if(currentId!==c.project.id)return;
    seed();
    const goal=c.fields.goal||c.latest?.next||'';
    change({active:true,goal});onChange(true);
    const input=document.querySelector('[data-work-field="goal"]');input?.focus();
    flush(c).catch(()=>{});
  }
  function active() { const c=contexts.get(currentId);return Boolean(c?.loaded&&c.fields.active); }
  function banner() {
    const c=contexts.get(currentId);
    if(!c?.loaded || !content(c) || c.fields.active)return '';
    return '<section class="draft-banner"><div><span class="eyebrow">未收工的草稿</span><p>'+e(c.fields.goal||c.fields.next||c.fields.title||'上次输入的内容已保留')+'</p><span data-draft-status aria-live="polite">'+e(status(c))+'</span></div><div class="button-row"><button class="button primary" data-action="focus">接着写</button><button class="button" data-action="capture">直接收工</button></div></section>';
  }
  function panel() {
    const c=contexts.get(currentId);if(!active())return '';
    const f=c.fields;
    return '<section class="panel focus-workspace" id="focus-workspace" data-project="'+e(c.project.id)+'">'+
      '<div class="panel-top"><span class="badge blue">专注工作</span><button class="text-button" data-action="leave-focus">返回工作台</button></div>'+
      '<label class="focus-label" for="work-goal">现在，先推进这一步</label><textarea id="work-goal" data-work-field="goal" rows="2" maxlength="3000" placeholder="写一句当前目标，或从上次的下一步接上。">'+e(f.goal)+'</textarea>'+
      '<label class="focus-label" for="work-note">随手记</label><textarea id="work-note" data-work-field="note" rows="5" maxlength="6000" placeholder="卡在哪里、试过什么、刚做的决定。想到就记。">'+e(f.note)+'</textarea>'+
      '<details class="focus-location"><summary>工作位置'+(f.file?' · '+e(f.file):'（选填）')+'</summary><div class="form-columns"><label>相对文件路径<input aria-label="工作文件" data-work-field="file" value="'+e(f.file)+'" maxlength="4096"></label><label>行号<input aria-label="工作行号" data-work-field="line" type="number" min="1" max="10000000" value="'+e(f.line)+'"></label></div></details>'+
      '<div class="focus-save-row"><span data-draft-status aria-live="polite">'+e(status(c))+'</span><button class="text-button" data-action="retry-draft">立即保存草稿</button></div>'+
      '<p class="form-error" data-draft-error hidden></p><div class="draft-conflict" data-draft-conflict></div>'+
      '<div class="panel-actions"><button class="button" data-action="focus-open">打开工作位置 ↗</button><button class="text-button" data-action="focus-copy">复制位置</button><span class="caption">收工时，只需再留一句下一步。</span></div></section>';
  }
  async function finishFields() {
    const c=contexts.get(currentId);if(!c)return null;
    if(c.ready)await c.ready;if(currentId!==c.project.id)return null;seed();return { ...c.fields };
  }
  async function finish(input,id=currentId) {
    const c=contexts.get(id);if(!c)throw new Error('草稿尚未加载。');
    if(c.ready)await c.ready;
    change({...input,line:Number(input.line||1)},id);await flush(c);
    const result=await api('/projects/'+encodeURIComponent(id)+'/sessions',{...input,goal:c.fields.goal,draftId:c.id,draftRevision:c.revision});
    if(result.draftCleared===false){c.error=result.warning;refreshStatus(c);throw new Error(result.warning);}
    adopt(c,result.draft);clearBuffer(c);return result;
  }
  function leaving() {
    change({active:false});flush().catch(()=>{});onChange(true);
  }
  async function resolve(keep) {
    const c=contexts.get(currentId);if(!c?.conflict)return;
    const remote=c.conflict;
    if(keep){c.revision=remote.revision;c.id=remote.id;c.conflict=null;c.error='';c.dirty=true;c.seq++;writeBuffer(c);await flush(c);}
    else{adopt(c,remote);try{localStorage.removeItem(key(currentId));}catch{}}
    onChange(true);refreshStatus(c);
  }
  document.addEventListener('input',event=>{
    const field=event.target.dataset.workField;if(!field)return;
    change({[field]:field==='line'?Number(event.target.value||1):event.target.value});
  });
  window.addEventListener('pagehide',()=>{for(const c of contexts.values())if(c.dirty)flush(c).catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)for(const c of contexts.values())if(c.dirty)flush(c).catch(()=>{});});
  return {select:id=>{currentId=id;},load,active,banner,panel,start,leaving,flush,flushAll:async()=>{for(const c of contexts.values())if(c.dirty||c.inflight){try{await flush(c);}catch(error){throw new Error(c.project.name+'：'+error.message);}}},change,finishFields,finish,resolve,refreshStatus:()=>{const c=contexts.get(currentId);if(c)refreshStatus(c);},
    fields:()=>({...contexts.get(currentId)?.fields}),project:()=>contexts.get(currentId)?.project,hasDraft:()=>content(contexts.get(currentId)),status:()=>status(contexts.get(currentId))};
};
