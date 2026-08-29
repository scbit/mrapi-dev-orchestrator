const fs = require('fs');

const file = 'src/routes/project.ui.routes.js';
let s = fs.readFileSync(file, 'utf8');

if (s.includes('PROJECT_EDIT_RUNTIME_UI_V2')) {
  console.log('PROJECT_EDIT_RUNTIME_UI_REPAIR_V2_ALREADY_APPLIED');
  process.exit(0);
}

// 1) Add edit panel after projects container panel.
if (!s.includes('id="editPanel"')) {
  const rePanel = /(<div class="panel">\s*<h2>Projects existentes<\/h2>\s*<div id="projects"><\/div>\s*<\/div>)/;
  if (!rePanel.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:projects panel');

  const editPanel = `$1
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
<label>Local path en Shadow<input id="editPath" placeholder="C:\\\\Users\\\\Shadow\\\\Documents\\\\GitHub\\\\repo"></label>
</div>
<p>
<button id="saveEdit" type="button">Guardar cambios</button>
<button id="cancelEdit" type="button" style="margin-left:8px;background:#25344a;color:#edf4ff">Cancelar</button>
</p>
<div id="editStatus" class="status">Seleccioná Editar en un Project.</div>
</div>`;
  s = s.replace(rePanel, editPanel);
}

// 2) Add currentProjects storage.
if (!s.includes('let currentProjects=')) {
  const statusRe = /(const\s+statusEl\s*=\s*document\.getElementById\(['"]status['"]\)\s*;?)/;
  if (!statusRe.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:status');
  s = s.replace(statusRe, `$1
let currentProjects=[];`);
}

// 3) Capture p.items after API load.
if (!s.includes('currentProjects=p.items||[];')) {
  const loadRe = /(const\s+\[w,p\]\s*=\s*await\s+Promise\.all\(\[j\('\/api\/workspaces'\),j\('\/api\/projects'\)\]\)\s*;?)/;
  if (!loadRe.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:load projects');
  s = s.replace(loadRe, `$1
  currentProjects=p.items||[];`);
}

// 4) Make rendering use currentProjects instead of p.items, then inject Edit button
// without depending on the exact whole return string.
s = s.replace(/\(p\.items\|\|\[\]\)\.map\(x=>\{/g, 'currentProjects.map(x=>{');

if (!s.includes('class="editProjectBtn"')) {
  // Locate the return line that renders each project and append Edit button before its outer closing div.
  const returnRe = /return\s+'<div style="padding:10px 0;border-bottom:1px solid #263449">'\+\s*\(x\.name\|\|x\.id\)\s*\+'<\/b>[^;]+;/;
  // Fallback: more tolerant line-based replacement.
  const lines = s.split('\n');
  let patched = false;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].includes("return '<div style=\"padding:10px 0;border-bottom:1px solid #263449\"><b>'") &&
      lines[i].includes("x.repository_full_name")
    ) {
      const line = lines[i];
      const end = "</small></div>'";
      if (!line.includes(end)) continue;
      lines[i] = line.replace(
        end,
        `</small><br><button type="button" class="editProjectBtn" data-project-id="'+x.id+'" style="margin-top:8px;padding:7px 11px">Editar</button></div>'`
      );
      patched = true;
      break;
    }
  }
  if (!patched) throw new Error('PATCH_PATTERN_NOT_FOUND:project item render');
  s = lines.join('\n');
}

// 5) Add handlers before create.onclick.
if (!s.includes("saveEdit').onclick")) {
  const createRe = /create\.onclick\s*=\s*async\s*\(\)\s*=>\s*\{try\{/;
  if (!createRe.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:create onclick');

  const handlers = `
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
  s = s.replace(createRe, handlers + 'create.onclick=async()=>{try{');
}

fs.writeFileSync(file, s, 'utf8');
console.log('PROJECT_EDIT_RUNTIME_UI_REPAIR_V2_OK');
