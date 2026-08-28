const fs=require('fs');

function patchFile(file, from, to, label){
  let s=fs.readFileSync(file,'utf8');
  if(s.includes(to)){ console.log('[SKIP already applied]',label); return; }
  if(!s.includes(from)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  s=s.replace(from,to);
  fs.writeFileSync(file,s,'utf8');
  console.log('[PATCHED]',label);
}

patchFile(
  'src/public/app.js',
  "if (projectsContextNav) projectsContextNav.addEventListener('click', () => { window.location.href = '/roadmap.html#project-context'; });",
  "if (projectsContextNav) projectsContextNav.addEventListener('click', () => { window.location.href = '/projects/setup'; });",
  'Projects nav -> Runtime Binding'
);

patchFile(
  'src/routes/planner.ui.routes.js',
  '<a href="/">Control Room</a>',
  '<div style="display:flex;gap:14px"><a href="/projects/setup">Projects</a><a href="/">Control Room</a></div>',
  'Planner topbar Projects link'
);

console.log('PROJECTS_NAV_FIX_OK');
