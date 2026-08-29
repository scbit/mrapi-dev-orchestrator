const express = require('express');

function html() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Projects - MRAPI DEV</title>
<style>
body{font-family:Inter,system-ui;background:#07101d;color:#edf4ff;margin:0}.shell{max-width:920px;margin:auto;padding:28px 18px}
a{color:#b9d4ff}.panel{background:#0d192a;border:1px solid #263449;border-radius:14px;padding:18px;margin:16px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:flex;flex-direction:column;gap:6px;color:#9eb0c7;font-size:12px}
input,select,textarea{background:#081220;color:#edf4ff;border:1px solid #33445e;border-radius:9px;padding:10px}
button{background:#dceaff;color:#07101d;border:0;border-radius:9px;padding:11px 15px;font-weight:800;cursor:pointer}
.status{padding:12px;border-radius:9px;background:#101d2f;color:#b7c8dc}.ok{color:#9bf0c8}.err{color:#ffb4b9}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
</style></head><body><main class="shell">
<div><a href="/planner">← Planner</a></div>
<h1>Projects / Runtime Binding</h1>
<p>Creá el Project una vez. Planner, Roadmap, Mission, Task y Shadow conservarán este project_id.</p>
<div class="panel">
<h2>Nuevo Project</h2>
<div class="grid">
<label>Workspace<select id="workspace"></select></label>
<label>Nombre<input id="name" placeholder="SUPERVISOR SCB"></label>
<label>GitHub repository<input id="repo" placeholder="scbit/mrapi-scb-supervisor"></label>
<label>Branch<input id="branch" value="main"></label>
<label>Host<select id="host"><option value="Shadow">Shadow</option></select></label>
<label>Local path en Shadow<input id="path" placeholder="C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-scb-supervisor"></label>
</div>
<p><button id="create">Crear Project</button></p>
<div id="status" class="status">Cargando workspaces...</div>
</div>
<div class="panel"><h2>Projects existentes</h2><div id="projects"></div></div>
<div class="panel" id="editPanel" style="display:none">
<!-- PROJECT_EDIT_RUNTIME_UI_V2 -->
<h2>Editar Project Runtime</h2>
<input type="hidden" id="editProjectId">
<div class="grid">
<label>Project<input id="editProjectName" disabled></label>
<label>Project ID<input id="editProjectIdDisplay" disabled></label>
<label>GitHub repository<input id="editRepo" placeholder="scbit/mrapi-dev-orchestrator"></label>
<label>Branch<input id="editBranch" value="main"></label>
<label>Host<select id="editHost"><option value="Shadow">Shadow</option></select></label>
<label>Local path en Shadow<input id="editPath" placeholder="C:\\Users\\Shadow\\Documents\\GitHub\\repo"></label>
</div>
<p>
<button id="saveEdit" type="button">Guardar cambios</button>
<button id="cancelEdit" type="button" style="margin-left:8px;background:#25344a;color:#edf4ff">Cancelar</button>
</p>
<div id="editStatus" class="status">Seleccioná Editar en un Project.</div>
</div>
</main><script>
const statusEl=document.getElementById('status');
let currentProjects=[];
async function j(url,opt){const r=await fetch(url,opt);const t=await r.text();let d={};try{d=t?JSON.parse(t):{}}catch{}if(!r.ok)throw new Error(d.error||t||('HTTP '+r.status));return d}
async function load(){
  const [w,p]=await Promise.all([j('/api/workspaces'),j('/api/projects')]);
  currentProjects=p.items||[];
  const ws=w.items||w||[]; workspace.innerHTML=ws.map(x=>'<option value="'+x.id+'">'+(x.name||x.id)+'</option>').join('');
  projects.innerHTML=currentProjects.map(x=>{
    const rt=x.runtime_context||{}; const ready=(x.runtime_binding_state||rt.binding_state||'UNCONFIGURED');
    return '<div style="padding:10px 0;border-bottom:1px solid #263449"><b>'+ (x.name||x.id) +'</b> <span class="'+(ready==='READY'?'ok':'err')+'">'+ready+'</span><br><small>'+x.id+' · '+(x.repository_full_name||'repo missing')+' · '+(rt.repository_path||x.local_path||'path missing')+'</small><br><button type="button" class="editProjectBtn" data-project-id="'+x.id+'" style="margin-top:8px;padding:7px 11px">Editar</button></div>'
  }).join('')||'<small>No projects</small>';
  statusEl.textContent='Listo.';
}

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

create.onclick=async()=>{try{
  statusEl.textContent='Creando...';
  const body={workspace_id:document.getElementById('workspace').value,name:document.getElementById('name').value,repository_full_name:document.getElementById('repo').value,default_branch:document.getElementById('branch').value,host_name:document.getElementById('host').value,repository_path:document.getElementById('path').value};
  const d=await j('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  statusEl.innerHTML='<span class="ok">Project creado: '+d.id+'. Ya aparece en el selector del Planner.</span>'; await load();
}catch(e){statusEl.innerHTML='<span class="err">'+e.message+'</span>'}}
load().catch(e=>statusEl.innerHTML='<span class="err">'+e.message+'</span>');
</script></body></html>`;
}
function createProjectUiRouter(){const r=express.Router();r.get('/projects/setup',(_req,res)=>res.type('html').send(html()));return r}
module.exports={createProjectUiRouter};
