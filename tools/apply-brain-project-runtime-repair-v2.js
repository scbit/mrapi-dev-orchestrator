const fs = require('fs');

function read(file){ return fs.readFileSync(file,'utf8'); }
function write(file,s){ fs.writeFileSync(file,s,'utf8'); }

function replaceRegex(file, regex, replacement, label, marker) {
  let s = read(file);
  if (marker && s.includes(marker)) {
    console.log('[SKIP already applied]', label);
    return;
  }
  if (!regex.test(s)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  s = s.replace(regex, replacement);
  write(file, s);
  console.log('[PATCHED]', label);
}

// brain.routes.js may already be patched by V1. Verify only.
const brainRoutes = read('src/routes/brain.routes.js');
if (!brainRoutes.includes('BRAIN_PROJECT_RUNTIME_NOT_READY')) {
  throw new Error('BRAIN_ROUTES_RUNTIME_PATCH_MISSING');
}
console.log('[OK] brain routes project runtime already present');

// brain-adapter.js: inject per-run runtime guard before runChatGPTWeb.
replaceRegex(
  'brain-adapter/brain-adapter.js',
  /(\s+try\s*\{\s*)(const brain = await runChatGPTWeb\(\{)/,
  `$1if (run.project_id && !String(run.repository_path || run.project_runtime?.repository_path || '').trim()) {
      throw new Error('BRAIN_PROJECT_RUNTIME_PATH_REQUIRED');
    }
    console.log('[BRAIN] project', run.project_id || '(none)');
    console.log('[BRAIN] repo context', run.repository_path || run.project_runtime?.repository_path || '(none)');
    $2`,
  'brain adapter per-run runtime guard',
  'BRAIN_PROJECT_RUNTIME_PATH_REQUIRED'
);

// Replace startup fixed repo log with multi-project wording.
replaceRegex(
  'brain-adapter/brain-adapter.js',
  /console\.log\('\[BRAIN\] repo context',\s*cfg\.repoPath\);/,
  "console.log('[BRAIN] repo context resolved per Project/Brain Run');",
  'brain startup multi-project log',
  'repo context resolved per Project/Brain Run'
);

// prompts.js: define repositoryPath once.
replaceRegex(
  'brain-adapter/lib/prompts.js',
  /(function brainPrompt\(run,\s*cfg\)\s*\{\s*const workerId = String\(run\.worker_id \|\| 'W01'\)\.toUpperCase\(\);)/,
  `$1
  const repositoryPath = String(
    run.repository_path ||
    run.project_runtime?.repository_path ||
    ''
  ).trim();`,
  'prompt repository variable',
  'run.project_runtime?.repository_path'
);

// Replace all cfg.repoPath prompt interpolations.
let p = read('brain-adapter/lib/prompts.js');
if (p.includes('${cfg.repoPath}')) {
  p = p.replace(/\$\{cfg\.repoPath\}/g, '${repositoryPath || "PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE"}');
  write('brain-adapter/lib/prompts.js', p);
  console.log('[PATCHED] prompt repo references');
} else if (p.includes('PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE')) {
  console.log('[SKIP already applied] prompt repo references');
} else {
  throw new Error('PATCH_PATTERN_NOT_FOUND:prompt repo references:brain-adapter/lib/prompts.js');
}

// Planner mode must explicitly show selected Project repo.
replaceRegex(
  'brain-adapter/lib/prompts.js',
  /(TRUSTED PLANNER CONTEXT\s*\n\$\{plannerContext\}\s*\n)(\s*ROLE CONTRACT)/,
  `$1
LOCAL REPOSITORY FOR SELECTED PROJECT
\${repositoryPath || 'PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE'}

$2`,
  'planner prompt selected project repository',
  'LOCAL REPOSITORY FOR SELECTED PROJECT'
);

console.log('BRAIN_PROJECT_RUNTIME_REPAIR_V2_OK');
