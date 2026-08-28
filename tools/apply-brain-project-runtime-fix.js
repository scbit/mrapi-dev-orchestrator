const fs = require('fs');

function replaceOnce(file, from, to, label) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(to)) {
    console.log('[SKIP already applied]', label);
    return;
  }
  if (!src.includes(from)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  src = src.replace(from, to);
  fs.writeFileSync(file, src, 'utf8');
  console.log('[PATCHED]', label);
}

function replaceRegex(file, regex, replacement, label, marker) {
  let src = fs.readFileSync(file, 'utf8');
  if (marker && src.includes(marker)) {
    console.log('[SKIP already applied]', label);
    return;
  }
  if (!regex.test(src)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  src = src.replace(regex, replacement);
  fs.writeFileSync(file, src, 'utf8');
  console.log('[PATCHED]', label);
}

// 1) Server: enrich every claimed Brain Run with trusted Project runtime.
replaceRegex(
  'src/routes/brain.routes.js',
  /(\s+if \(!claimed\.objective\) \{\s+await candidate\.ref\.set\([\s\S]*?\s+continue;\s+\}\s+)(\s+return res\.json\(\{ run: claimed \}\);)/,
  `$1
          if (claimed.project_id) {
            const projectRef = db.collection('projects').doc(claimed.project_id);
            const projectSnap = await projectRef.get();

            if (!projectSnap.exists || projectSnap.data().tenant_id !== req.tenantId) {
              await candidate.ref.set({
                brain_adapter_id: null,
                brain_claimed_at: null,
                progress_message: 'Brain Run project runtime could not be resolved; released',
                updated_at: timestamp()
              }, { merge: true });
              return res.status(409).json({ error: 'BRAIN_PROJECT_RUNTIME_NOT_FOUND' });
            }

            const project = projectSnap.data();
            const runtime = project.runtime_context && typeof project.runtime_context === 'object'
              ? project.runtime_context
              : {};
            const repositoryPath = String(
              runtime.repository_path ||
              runtime.local_path ||
              project.repository_path ||
              project.local_path ||
              ''
            ).trim();
            const repositoryFullName = String(
              project.repository_full_name ||
              runtime.repository_full_name ||
              ''
            ).trim();
            const runtimeState = String(
              runtime.binding_state ||
              project.runtime_binding_state ||
              ''
            ).trim().toUpperCase();

            if (!repositoryPath || !repositoryFullName || !['READY', 'VALIDATED', 'CONFIGURED'].includes(runtimeState)) {
              await candidate.ref.set({
                brain_adapter_id: null,
                brain_claimed_at: null,
                progress_message: 'Brain Run project runtime is not READY; released',
                updated_at: timestamp()
              }, { merge: true });
              return res.status(409).json({ error: 'BRAIN_PROJECT_RUNTIME_NOT_READY' });
            }

            claimed = {
              ...claimed,
              repository_path: repositoryPath,
              repository_full_name: repositoryFullName,
              project_runtime: {
                project_id: claimed.project_id,
                repository_path: repositoryPath,
                repository_full_name: repositoryFullName,
                default_branch: project.default_branch || runtime.default_branch || 'main',
                host_name: runtime.host_name || project.host_name || null,
                binding_state: runtimeState
              }
            };

            await candidate.ref.set({
              repository_path: repositoryPath,
              repository_full_name: repositoryFullName,
              project_runtime: claimed.project_runtime,
              updated_at: timestamp()
            }, { merge: true });
          }

$2`,
  'brain claim trusted project runtime',
  'BRAIN_PROJECT_RUNTIME_NOT_READY'
);

// 2) Brain adapter: fail closed and log actual repo for each run.
replaceOnce(
  'brain-adapter/brain-adapter.js',
  "  try {\n    const brain = await runChatGPTWeb({",
  "  try {\n    if (run.project_id && !String(run.repository_path || '').trim()) {\n      throw new Error('BRAIN_PROJECT_RUNTIME_PATH_REQUIRED');\n    }\n    console.log('[BRAIN] project', run.project_id || '(none)');\n    console.log('[BRAIN] repo context', run.repository_path || '(none)');\n    const brain = await runChatGPTWeb({",
  'brain adapter per-run runtime guard'
);

replaceOnce(
  'brain-adapter/brain-adapter.js',
  "  console.log('[BRAIN] repo context', cfg.repoPath);",
  "  console.log('[BRAIN] repo context resolved per Project/Brain Run');",
  'brain startup multi-project log'
);

// 3) Prompt: use run-scoped repository only. No silent fallback to orchestrator repo.
replaceOnce(
  'brain-adapter/lib/prompts.js',
  "function brainPrompt(run, cfg) {\n  const workerId = String(run.worker_id || 'W01').toUpperCase();",
  "function brainPrompt(run, cfg) {\n  const workerId = String(run.worker_id || 'W01').toUpperCase();\n  const repositoryPath = String(run.repository_path || run.project_runtime?.repository_path || '').trim();",
  'prompt repository variable'
);

let prompts = fs.readFileSync('brain-adapter/lib/prompts.js', 'utf8');
const count = (prompts.match(/\$\{cfg\.repoPath\}/g) || []).length;
if (count > 0) {
  prompts = prompts.replace(/\$\{cfg\.repoPath\}/g, '${repositoryPath || "PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE"}');
  fs.writeFileSync('brain-adapter/lib/prompts.js', prompts, 'utf8');
  console.log('[PATCHED] prompt repo references', count);
} else if (prompts.includes('${repositoryPath || "PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE"}')) {
  console.log('[SKIP already applied] prompt repo references');
} else {
  throw new Error('PATCH_PATTERN_NOT_FOUND:prompt repo references:brain-adapter/lib/prompts.js');
}

// 4) Planner prompt explicitly exposes trusted repo to the Brain too.
replaceOnce(
  'brain-adapter/lib/prompts.js',
  "TRUSTED PLANNER CONTEXT\n${plannerContext}\n\nROLE CONTRACT",
  "TRUSTED PLANNER CONTEXT\n${plannerContext}\n\nLOCAL REPOSITORY FOR SELECTED PROJECT\n${repositoryPath || 'PROJECT_RUNTIME_REPOSITORY_NOT_AVAILABLE'}\n\nROLE CONTRACT",
  'planner prompt selected project repository'
);

console.log('BRAIN_PROJECT_RUNTIME_FIX_OK');
