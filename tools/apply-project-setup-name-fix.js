const fs = require('fs');

const file = 'src/routes/project.ui.routes.js';
let s = fs.readFileSync(file, 'utf8');

const old = "const body={workspace_id:workspace.value,name:name.value,repository_full_name:repo.value,default_branch:branch.value,host_name:host.value,repository_path:path.value};";
const neu = "const body={workspace_id:document.getElementById('workspace').value,name:document.getElementById('name').value,repository_full_name:document.getElementById('repo').value,default_branch:document.getElementById('branch').value,host_name:document.getElementById('host').value,repository_path:document.getElementById('path').value};";

if (s.includes(neu)) {
  console.log('[SKIP already applied] project setup field binding');
} else {
  if (!s.includes(old)) throw new Error('PATCH_PATTERN_NOT_FOUND:project setup field binding');
  s = s.replace(old, neu);
  fs.writeFileSync(file, s, 'utf8');
  console.log('[PATCHED] project setup field binding');
}

console.log('PROJECT_SETUP_NAME_FIX_OK');
