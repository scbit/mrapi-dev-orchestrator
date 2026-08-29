const fs = require('fs');

const file = 'src/routes/project.ui.routes.js';
let s = fs.readFileSync(file, 'utf8');

if (s.includes('PROJECT_EDIT_RUNTIME_UI_V1')) {
  console.log('PROJECT_EDIT_RUNTIME_UI_V1_ALREADY_APPLIED');
  process.exit(0);
}

// 1) Add edit panel after existing projects list panel.
const panelAnchor = `<div class="panel"><h2>Projects existentes</h2><div id="projects"></div></div>`;
const editPanel = `<div class="panel"><h2>Projects existentes</h2><div id="projects"></div></div>
<div class="panel" id="editPanel" style="display:none">
<!-- PROJECT_EDIT_RUNTIME_UI_V1 -->
<h2>Editar Project Runtime</h2>
<input type="hidden" id="editProjectId">
<div class="grid">
<label>Project<input id="editProjectName" disabled></label>
<label>Project ID<input id="editProjectIdDisplay" disabled></label>
<label>GitHub repository<input id="editRepo" placeholder="scbit/mrapi-dev-orchestrator"></label>
<label>Branch<input id="editBranch" value="main"></label>
<label>Host<select id="editHost"><option value="Shadow">Shadow</option></select></label>
<label>Local path en Shadow<input id="editPath" placeholder="C:\\\\Users\\\\Shadow\\\\Documents\\\\GitHub\\\\repo"></label>
</div>
<p>
  <button id="saveEdit">Guardar cambios</button>
  <button id="cancelEdit" type="button" style="margin-left:8px;background:#25344a;color:#edf4ff">Cancelar</button>
</p>
<div id="editStatus" class="status">Seleccioná Editar en un Project.</div>
</div>`;

if (!s.includes(panelAnchor)) {
  throw new Error('PATCH_PATTERN_NOT_FOUND:projects panel');
}
s = s.replace(panelAnchor, editPanel);

// 2) Keep loaded projects in memory.
const statusAnchor = `const statusEl=document.getElementById('status');`;
const statusReplacement = `const statusEl=document.getElementById('status');
let currentProjects=[];`;

if (!s.includes(statusAnchor)) {
  throw new Error('PATCH_PATTERN_NOT_FOUND:status anchor');
}
s = s.replace(statusAnchor, statusReplacement);

// 3) Store project list and render Edit button for every project.
const loadAnchor = `  const [w,p]=await Promise.all([j('/api/workspaces'),j('/api/projects')]);
  const ws=w.items||w||[]; workspace.innerHTML=ws.map(x=>'<option value="'+x.id+'">'+(x.name||x.id)+'</option>').join('');
  projects.innerHTML=(p.items||[]).map(x=>{
    const rt=x.runtime_context||{}; const ready=(x.runtime_binding_state||rt.binding_state||'UNCONFIGURED');
    return '<div style="padding:10px 0;border-bottom:1px solid #263449"><b>'+ (x.name||x.id) +'</b> <span class="'+(ready==='READY'?'ok':'err')+'">'+ready+'</span><br><small>'+x.id+' · '+(x.repository_full_name||'repo missing')+' · '+(rt.repository_path||x.local_path||'path missing')+'</small></div>'
  }).join('')||'<small>No projects</small>';`;

const loadReplacement = `  const [w,p]=await Promise.all([j('/api/workspaces'),j('/api/projects')]);
  const ws=w.items||w||[]; workspace.innerHTML=ws.map(x=>'<option value="'+x.id+'">'+(x.name||x.id)+'</option>').join('');
  currentProjects=p.items||[];
  projects.innerHTML=currentProjects.map(x=>{
    const rt=x.runtime_context||{}; const ready=(x.runtime_binding_state||rt.binding_state||'UNCONFIGURED');
    return '<div style="padding:10px 0;border-bottom:1px solid #263449"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><b>'+ (x.name||x.id) +'</b> <span class="'+(ready==='READY'?'ok':'err')+'">'+ready+'</span><br><small>'+x.id+' · '+(x.repository_full_name||'repo missing')+' · '+(rt.repository_path||x.local_path||'path missing')+'</small></div><button type="button" class="editProjectBtn" data-project-id="'+x.id+'" style="padding:7px 11px">Editar</button></div></div>'
  }).join('')||'<small>No projects</small>';`;

if (!s.includes(loadAnchor)) {
  throw new Error('PATCH_PATTERN_NOT_FOUND:projects render');
}
s = s.replace(loadAnchor, loadReplacement);

// 4) Insert edit handlers before create.onclick.
const createAnchor = `create.onclick=async()=>{try{`;
const editHandlers = `
projects.addEventListener('click',(event)=>{
  const btn=event.target.closest('.editProjectBtn');
  if(!btn)return;
  const id=btn.dataset.projectId;
  const x=currentProjects.find(p=>p.id===id);
  if(!x)return;
  const rt=x.runtime_context||{};
  document.getElementById('editProjectId').value=x.id||'';
  document.getElementById('editProjectIdDisplay').value=x.id||'';
  document.getElementById('editProjectName').value=x.name||x.id||'';
  document.getElementById('editRepo').value=x.repository_full_name||rt.repository_full_name||'';
  document.getElementById('editBranch').value=x.default_branch||rt.default_branch||'main';
  document.getElementById('editHost').value=rt.host_name||x.host_name||'Shadow';
  document.getElementById('editPath').value=rt.repository_path||x.local_path||'';
  document.getElementById('editStatus').textContent='Editando '+(x.name||x.id);
  document.getElementById('editPanel').style.display='block';
  document.getElementById('editPanel').scrollIntoView({behavior:'smooth',block:'start'});
});

document.getElementById('cancelEdit').onclick=()=>{
  document.getElementById('editPanel').style.display='none';
};

document.getElementById('saveEdit').onclick=async()=>{try{
  const id=document.getElementById('editProjectId').value;
  if(!id)throw new Error('PROJECT_ID_REQUIRED');
  const editStatus=document.getElementById('editStatus');
  editStatus.textContent='Guardando runtime...';
  const body={
    repository_full_name:document.getElementById('editRepo').value,
    default_branch:document.getElementById('editBranch').value,
    host_name:document.getElementById('editHost').value,
    repository_path:document.getElementById('editPath').value
  };
  const d=await j('/api/projects/'+encodeURIComponent(id)+'/runtime',{
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const rt=d.runtime_context||{};
  const ready=d.runtime_binding_state||rt.binding_state||'UNCONFIGURED';
  editStatus.innerHTML='<span class="'+(ready==='READY'?'ok':'err')+'">Runtime guardado: '+ready+'</span>';
  await load();
}catch(e){
  document.getElementById('editStatus').innerHTML='<span class="err">'+e.message+'</span>';
}};

`;

if (!s.includes(createAnchor)) {
  throw new Error('PATCH_PATTERN_NOT_FOUND:create handler');
}
s = s.replace(createAnchor, editHandlers + createAnchor);

fs.writeFileSync(file, s, 'utf8');
console.log('PROJECT_EDIT_RUNTIME_UI_V1_OK');
