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
</main><script>
const statusEl=document.getElementById('status');
async function j(url,opt){const r=await fetch(url,opt);const t=await r.text();let d={};try{d=t?JSON.parse(t):{}}catch{}if(!r.ok)throw new Error(d.error||t||('HTTP '+r.status));return d}
async function load(){
  const [w,p]=await Promise.all([j('/api/workspaces'),j('/api/projects')]);
  const ws=w.items||w||[]; workspace.innerHTML=ws.map(x=>'<option value="'+x.id+'">'+(x.name||x.id)+'</option>').join('');
  projects.innerHTML=(p.items||[]).map(x=>{
    const rt=x.runtime_context||{}; const ready=(x.runtime_binding_state||rt.binding_state||'UNCONFIGURED');
    return '<div style="padding:10px 0;border-bottom:1px solid #263449"><b>'+ (x.name||x.id) +'</b> <span class="'+(ready==='READY'?'ok':'err')+'">'+ready+'</span><br><small>'+x.id+' · '+(x.repository_full_name||'repo missing')+' · '+(rt.repository_path||x.local_path||'path missing')+'</small></div>'
  }).join('')||'<small>No projects</small>';
  statusEl.textContent='Listo.';
}
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
