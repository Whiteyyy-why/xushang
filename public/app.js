const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHtml;
const state = { projects: [], selected: '', detail: null, view: 'desk', dataDirectory: '', notice: '', loading: true, checking: false, checkError: '', generation: 0 };
try { state.selected = localStorage.getItem('xushang-project') || ''; } catch {}
let toastTimer;
async function api(url, body) {
  const response = await fetch('/api' + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Xushang-Client': '1', ...(body === undefined ? {} : {'Content-Type':'application/json'}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作没有完成，请重试。');
  return data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);const el = $('#toast');el.textContent = message;el.classList.toggle('error', error);el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 8000 : 4500);
}
function time(value) { return new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}); }
function fullTime(value) { return new Date(value).toLocaleString('zh-CN', {hour12:false}); }
function icon(name) { return '<svg class="ui-icon" aria-hidden="true"><use href="/icons.svg#' + name + '"></use></svg>'; }
function button(label, action, kind = '', extra = '') {
  const name = {add:'plus',capture:'bookmark',refresh:'refresh',open:'arrow','export-md':'download','export-json':'download',import:'upload'}[action];
  return '<button type="button" class="button ' + kind + '" data-action="' + action + '" ' + extra + '>' + (name ? icon(name) : '') + '<span>' + label.replace(/^[＋↻]\s*|\s*[↗↓→]$/g,'') + '</span></button>';
}
function heading(title, description, actions = '', kicker = 'YOUR NEXT SMALL STEP') {
  return '<div class="page-head"><div><span class="eyebrow">' + kicker + '</span><h1>' + title + '</h1><p>' + description + '</p></div><div class="head-actions">' + actions + '</div></div>';
}
function projectStrip() {
  return '<div class="project-strip" aria-label="选择项目">' + state.projects.map(p => '<button type="button" class="project-tab ' + (p.id === state.selected ? 'active' : '') + '" aria-pressed="' + (p.id === state.selected) + '" data-project="' + e(p.id) + '"><span class="project-mark">' + e(p.name.slice(0,1)) + '</span><span><strong>' + e(p.name) + '</strong><small>' + (p.latest ? time(p.latest.createdAt) : '还没有现场') + ' · ' + p.sessionCount + ' 条记忆</small></span></button>').join('') + '</div>';
}
function empty() {
  return heading('把下一步，留在这里。', '接入第一个项目，就能开始留下工作现场。') +
    '<section class="empty-panel"><div class="empty-symbol" aria-hidden="true"><svg class="ui-icon" aria-hidden="true"><use href="/icons.svg#resume"></use></svg></div><h2>项目可以关掉，思路可以留下。</h2><p>代码、写作、研究资料。选择一个本地文件夹，记下卡点和下一步；再回来时，从这里接上。</p><div class="empty-actions">' +
    button('＋ 接入项目文件夹', 'add', 'primary') + button('先体验一个示例', 'example') +
    '</div><div class="empty-flow">① 接入文件夹 <span>→</span> ② 留下现场 <span>→</span> ③ 下次续上</div></section>';
}
function filesList(items) {
  const labels = { added:'新增', modified:'修改', deleted:'删除', unverified:'待核实', working:'工作区改动' };
  return '<ul class="file-list">' + items.map(f => '<li class="file-row"><span>' + e(f.path) + '</span><span class="file-kind ' + e(f.kind) + '">' + (labels[f.kind] || e(f.kind)) + '</span></li>').join('') + '</ul>';
}
function comparisonPanel(d) {
  const current = d.current, comparison = d.comparison;
  let body = '';
  if (state.checkError) body += '<div class="warning">' + e(state.checkError) + '</div>';
  if (comparison?.branchChanged) body += '<div class="warning">分支已从 ' + e(d.sessions[0].snapshot.git.branch) + ' 切换到 ' + e(current.git.branch) + '。</div>';
  if (comparison?.headChanged) body += '<div class="warning">提交位置已变化，继续前请留意对应代码。</div>';
  if (comparison?.gitUnavailable) body += '<div class="warning">当前 Git 信息不可用，暂时只比较文件。</div>';
  if (comparison?.incomplete || current?.truncated) body += '<div class="warning">扫描不完整：大文件、数量或读取限制影响了结果。未比较的文件不能判定为无变化。</div>';
  if (comparison?.changes.length) {
    body += filesList(comparison.changes.slice(0, 12));
    if (comparison.changes.length > 12) body += '<details><summary>再看 ' + (comparison.changes.length - 12) + ' 个变化</summary>' + filesList(comparison.changes.slice(12)) + '</details>';
  } else if (comparison && !d.stale && !state.checkError) {
    body += '<div class="change-empty"><span class="checkmark" aria-hidden="true"><svg class="ui-icon" aria-hidden="true"><use href="/icons.svg#check"></use></svg></span><p>' + (comparison.incomplete ? '已比较的文件没有变化' : '文件内容还和上次一样') + '</p><small>' + (current?.fileCount ?? 0) + ' 个文件已比较</small></div>';
  } else if (state.checking) {
    body += '<div class="change-empty"><p>正在后台检查变化…</p><small>你可以先看笔记，或继续工作。</small></div>';
  } else if (!d.sessions.length && current && !d.stale) {
    body += '<div class="change-empty"><p>已读取 ' + current.fileCount + ' 个文件</p><small>保存第一个现场后，就可以比较变化。</small></div>';
  } else {
    body += '<div class="change-empty"><p>显示上次保存的信息</p><small>当前变化尚未检查。</small></div>';
  }
  const status = current?.git?.status || [];
  if (status.length) body += '<details><summary>' + status.length + ' 个 Git 工作区改动</summary>' + filesList(status.map(f => ({path:f.path, kind:'working'}))) + '</details>';
  if (current?.warnings?.length) body += '<div class="caption">' + current.warnings.map(e).join('<br>') + '</div>';
  return '<section class="panel"><div class="section-title"><h3>离开之后</h3><span class="badge ' + (state.checking ? 'blue' : '') + '">' + (state.checking ? '后台检查中' : d.stale ? '保存的快照' : '已检查') + '</span></div><div class="branch">' + (current?.git ? icon('branch') + ' ' + e(current.git.branch) : icon('folder') + ' 普通文件夹 · 文件指纹比较') + '</div>' + body + '<div class="caption">' + (current ? '记录时间 ' + e(time(current.scannedAt)) + ' · ' + current.fileCount + ' 个文件' : '检查会在后台执行，不影响查看现场。') + '</div></section>';
}
function desk() {
  if (!state.projects.length) return empty();
  const d = state.detail;
  const head = heading('接着来，思路还在。', '打开的是现场，接上的是你自己。', button(state.checking ? '检查中…' : '↻ 刷新变化', 'refresh', '', state.checking ? 'disabled' : '') + button('＋ 留个现场', 'capture', 'primary', !d ? 'disabled' : ''));
  if (!d) return head + projectStrip() + '<div class="loading">正在读取保存的现场…</div>';
  const s = d.sessions[0];
  const card = s ? '<article class="panel session-panel"><div class="panel-top"><span class="meta">' + e(time(s.createdAt)) + ' 留下的现场</span><span class="badge blue">下一步已就位</span></div><h2>' + e(s.title) + '</h2><p class="note-text">' + e(s.note || '这次没有留下卡点。') + '</p><div class="next-step"><label>下次，先做这个</label><p>' + e(s.next) + '</p></div><div class="session-position">' + e(s.file ? s.file + ':' + s.line : d.project.path) + '</div><div class="panel-actions">' + button('继续这个现场 ↗', 'open', 'primary', 'data-session="' + e(s.id) + '"') + '<button class="text-button" data-action="copy" data-session="' + e(s.id) + '">复制位置</button><button class="text-button" data-nav="memory">回看之前的决定 →</button></div></article>' :
    '<article class="panel"><span class="eyebrow">THE FIRST CHAPTER</span><div class="nosnapshot"><h2>' + e(d.project.name) + '，从这一刻开始。</h2><p>写下现在做到哪里，以及下次先做什么。</p>' + button('留第一个现场 ↗', 'capture', 'primary') + '</div><p class="caption">' + e(d.project.path) + '</p></article>';
  return head + projectStrip() + '<div class="desk-grid">' + card + comparisonPanel(d) + '</div>' +
    (d.sessions.length > 1 ? '<section class="recent-section"><div class="section-title"><h3>之前的几步</h3><button class="text-button" data-nav="memory">查看全部 ' + d.sessions.length + ' 条 →</button></div>' + d.sessions.slice(1,4).map(s => '<div class="recent-row"><div><h3>' + e(s.title) + '</h3><p>' + e(s.next) + '</p></div><time>' + time(s.createdAt) + '</time></div>').join('') + '</section>' : '');
}
function memory() {
  const d = state.detail;
  let html = heading('每一步，都有来处。', '把做过的决定、卡住的地方和下一步串起来。', button('导出 Markdown ↓','export-md'), 'A THREAD OF THOUGHT') + projectStrip();
  if (!d?.sessions.length) return html + '<div class="panel nosnapshot"><h2>还没有留下工作记忆</h2><p>保存一次现场，这里就会多一段可以回看的思路。</p>' + button(state.projects.length ? '留个现场' : '接入项目', state.projects.length ? 'capture' : 'add', 'primary') + '</div>';
  return html + '<div class="timeline">' + d.sessions.map((s, i) => '<article class="memory-card"><div class="memory-time">' + e(fullTime(s.createdAt)) + (i === 0 ? ' · 最近一次' : '') + '</div><div class="panel"><h2>' + e(s.title) + '</h2><div class="next-step"><label>下一步</label><p>' + e(s.next) + '</p></div><div class="session-position">' + e(s.file ? s.file + ':' + s.line : '项目根目录') + '</div><details><summary>卡点、决定和文件摘要</summary><p class="note-text">' + e(s.note || '未填写卡点或决定。') + '</p><p class="caption">' + e(s.snapshot.git ? '⑂ ' + s.snapshot.git.branch : '普通文件夹') + ' · ' + s.snapshot.fileCount + ' 个文件摘要' + (s.snapshot.truncated ? ' · 扫描不完整' : '') + '</p></details><div class="panel-actions">' + button('从这里续上 ↗', 'open', 'small', 'data-session="' + e(s.id) + '"') + '<button class="text-button" data-action="copy" data-session="' + e(s.id) + '">复制位置</button></div></div></article>').join('') + '</div>';
}
function storage() {
  return heading('项目在本地，记忆也在。', 'Git 仓库、普通文件夹，用同一种方式接上。', button('＋ 接入项目', 'add', 'primary'), 'LOCAL BY DESIGN') +
    '<div class="storage-list">' + (state.projects.length ? state.projects.map(p => '<section class="panel storage-project"><div><h3>' + e(p.name) + '</h3><p>' + e(p.path) + '</p></div><div class="button-row"><span class="badge">' + p.sessionCount + ' 条现场</span><button class="button small" data-project="' + e(p.id) + '">打开工作台 →</button></div></section>').join('') : '<section class="panel"><h3>还没有接入项目</h3><p class="caption">你的文件夹不需要上传到任何平台。</p></section>') + '</div>' +
    '<div class="storage-columns"><section class="panel"><h3>把工作记忆带走</h3><p>Markdown 适合阅读；JSON 保留完整记录，可用于恢复。</p><div class="button-row">' + button('Markdown ↓','export-md') + button('JSON 备份 ↓','export-json') + '</div></section><section class="panel"><h3>从备份接着来</h3><p>导入续上的 JSON 备份。已有现场保留，重复记录自动跳过。</p>' + button('导入 JSON 备份','import') + '</section></div>' +
    '<div class="data-path">数据保存位置<code>' + e(state.dataDirectory) + '</code>保存的是工作上下文和文件指纹，不包含源文件正文。</div><p class="caption">打开页面先读本地记录；文件与 Git 检查在后台运行，60 秒内复用结果。手动刷新会重新检查内容。</p>';
}
function render() {
  $('#view-title').textContent = {desk:'工作台',memory:'工作记忆',storage:'接入与存储'}[state.view];
  document.querySelectorAll('.nav-item').forEach(el => { const active = el.dataset.view === state.view;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current'); });
  $('#sidebar-projects').innerHTML = state.projects.map(p => '<button class="project-link ' + (p.id === state.selected ? 'active' : '') + '" data-project="' + e(p.id) + '"><span class="project-mark">' + e(p.name.slice(0,1)) + '</span><span>' + e(p.name) + '</span></button>').join('');
  $('#main').setAttribute('aria-busy',String(state.loading));
  $('#main').innerHTML = (state.notice ? '<div class="warning">' + e(state.notice) + '</div>' : '') + (state.view === 'desk' ? desk() : state.view === 'memory' ? memory() : storage());
}
async function loadProjects() { const data = await api('/projects');state.projects=data.projects;state.dataDirectory=data.dataDirectory;state.notice=data.notice; }
async function selectProject(id, { changeView = true } = {}) {
  state.selected=id;state.detail=null;state.checkError='';state.checking=false;if(changeView)state.view='desk';const generation=++state.generation;
  try { localStorage.setItem('xushang-project',id); } catch {}
  render();
  try {
    const detail=await api('/projects/'+encodeURIComponent(id));
    if(generation!==state.generation)return;
    state.detail=detail;state.loading=false;render();
    if(detail.stale) backgroundCheck(false);
  } catch(error) { if(generation===state.generation){state.loading=false;state.checkError=error.message;$('#main').insertAdjacentHTML('beforeend','<div class="error-panel">'+e(error.message)+'</div>');} }
}
async function backgroundCheck(force) {
  if(!state.selected || state.checking)return;
  const id=state.selected,generation=state.generation;state.checking=true;state.checkError='';render();
  try { const detail=await api('/projects/'+encodeURIComponent(id)+'/refresh',{force});if(generation===state.generation)state.detail=detail; }
  catch(error) { if(generation===state.generation)state.checkError=error.message; }
  finally { if(generation===state.generation){state.checking=false;render();} }
}
function showAdd() { const form=$('#add-form');form.reset();form.querySelector('.form-error').hidden=true;$('#add-dialog').showModal(); }
function showCapture() {
  if(!state.detail)return;
  const form=$('#session-form');form.reset();form.dataset.project=state.selected;form.querySelector('.form-error').hidden=true;
  const latest=state.detail.sessions[0];
  if(latest){form.elements.title.value=latest.title;form.elements.file.value=latest.file;form.elements.line.value=latest.line;}
  $('#project-files').innerHTML=(state.detail.current?.files||[]).slice(0,500).map(f=>'<option value="'+e(f)+'"></option>').join('');
  $('#capture-note').textContent='保存到 '+state.detail.project.name+' · 保存时会检查当前文件内容。';
  $('#session-dialog').showModal();
}
function chosenSession(id) { return state.detail?.sessions.find(s=>s.id===id) || state.detail?.sessions[0]; }
async function download(format) {
  const response=await fetch('/api/export?format='+format,{headers:{'X-Xushang-Client':'1'}});
  if(!response.ok)throw new Error('导出未完成。');
  const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download='xushang-'+new Date().toISOString().slice(0,10)+'.'+format;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('备份已导出。');
}
document.addEventListener('click',async event=>{
  const btn=event.target.closest('button');if(!btn || btn.disabled)return;
  if(btn.classList.contains('close-dialog')){btn.closest('dialog').close();return;}
  if(btn.dataset.view||btn.dataset.nav){state.view=btn.dataset.view||btn.dataset.nav;render();return;}
  if(btn.dataset.project){await selectProject(btn.dataset.project);return;}
  const action=btn.dataset.action;if(!action)return;
  try {
    if(action==='add')showAdd();
    if(action==='capture')showCapture();
    if(action==='refresh')await backgroundCheck(true);
    if(action==='example'){btn.disabled=true;const p=await api('/example',{});await loadProjects();await selectProject(p.id);toast('已创建可修改的本地示例项目。');}
    if(action==='open'){const s=chosenSession(btn.dataset.session);btn.disabled=true;await api('/projects/'+encodeURIComponent(state.selected)+'/open',{file:s?.file||'',line:s?.line||1});toast('已发送到 VS Code。');}
    if(action==='copy'){const s=chosenSession(btn.dataset.session);const position=state.detail.project.path+(s?.file?'/'+s.file+':'+s.line:'');await navigator.clipboard.writeText(position);toast('已复制：'+position);}
    if(action==='export-md')await download('md');
    if(action==='export-json')await download('json');
    if(action==='import')$('#import-file').click();
  }catch(error){toast(error.message,true);}finally{btn.disabled=false;}
});
$('#pick-folder').addEventListener('click',async()=>{
  const btn=$('#pick-folder');btn.disabled=true;btn.textContent='选择中…';
  try{const result=await api('/pick-folder',{});if(result.path)$('#project-path').value=result.path;}
  catch(error){const el=$('#add-form .form-error');el.hidden=false;el.textContent=error.message;}
  finally{btn.disabled=false;btn.textContent='浏览…';}
});
function setFormBusy(form,busy,label){form.querySelectorAll('button').forEach(btn=>btn.disabled=busy);form.dataset.busy=String(busy);const submit=form.querySelector('[type=submit]');if(busy){submit.dataset.label=submit.innerHTML;submit.textContent=label;}else submit.innerHTML=submit.dataset.label||submit.innerHTML;}
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('cancel',event=>{if(dialog.querySelector('form').dataset.busy==='true')event.preventDefault();}));
$('#add-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;setFormBusy(form,true,'正在接入…');form.querySelector('.form-error').hidden=true;
  try{const project=await api('/projects',Object.fromEntries(new FormData(form)));$('#add-dialog').close();await loadProjects();await selectProject(project.id);toast('项目已接入，文件检查会在后台完成。');}
  catch(error){form.querySelector('.form-error').textContent=error.message;form.querySelector('.form-error').hidden=false;}
  finally{setFormBusy(form,false);}
});
$('#session-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,id=form.dataset.project;setFormBusy(form,true,'正在保存现场…');form.querySelector('.form-error').hidden=true;
  try{await api('/projects/'+encodeURIComponent(id)+'/sessions',Object.fromEntries(new FormData(form)));$('#session-dialog').close();await loadProjects();await selectProject(id);toast('现场已保存。放心收工，下次从这里接上。');}
  catch(error){form.querySelector('.form-error').textContent=error.message;form.querySelector('.form-error').hidden=false;}
  finally{setFormBusy(form,false);}
});
$('#import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>32*1024*1024)throw new Error('备份不能超过 32 MB。');const result=await api('/import',JSON.parse(await file.text()));await loadProjects();state.loading=false;render();toast('已导入 '+result.projects+' 个项目、'+result.sessions+' 条现场。');if(!state.selected&&state.projects.length)await selectProject(state.projects[0].id);}
  catch(error){toast(error instanceof SyntaxError?'文件不是有效的 JSON 备份。':error.message,true);}
  finally{event.target.value='';}
});
async function init(){
  try{await loadProjects();state.loading=false;if(!state.projects.some(p=>p.id===state.selected))state.selected=state.projects[0]?.id||'';render();if(state.selected)await selectProject(state.selected,{changeView:false});}
  catch(error){state.loading=false;$('#main').innerHTML='<div class="error-panel">'+e(error.message)+'<p>请确认本地服务仍在运行，然后刷新页面。</p></div>';}
}
init();

