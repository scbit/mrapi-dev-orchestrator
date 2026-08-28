const fs = require('fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, text) { fs.writeFileSync(file, text, 'utf8'); }

function ensureContains(file, needle, label) {
  const src = read(file);
  if (!src.includes(needle)) throw new Error(`REQUIRED_CONTEXT_MISSING:${label}:${file}`);
}

function replaceString(file, from, to, label) {
  let src = read(file);
  if (src.includes(to)) {
    console.log('[SKIP already applied]', label);
    return;
  }
  if (!src.includes(from)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  src = src.replace(from, to);
  write(file, src);
  console.log('[PATCHED]', label);
}

function replaceRegex(file, regex, replacement, label, alreadyMarker) {
  let src = read(file);
  if (alreadyMarker && src.includes(alreadyMarker)) {
    console.log('[SKIP already applied]', label);
    return;
  }
  if (!regex.test(src)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  src = src.replace(regex, replacement);
  write(file, src);
  console.log('[PATCHED]', label);
}

// Verify files from V1 exist.
for (const f of [
  'src/services/projectRuntime.js',
  'src/routes/project.ui.routes.js',
  'src/routes/projects.routes.js'
]) {
  if (!fs.existsSync(f)) throw new Error(`V1_FILE_MISSING:${f}`);
}

// app/planner may already be patched by V1. Ensure them; patch only if missing.
replaceString(
  'src/app.js',
  "const { createPlannerUiRouter } = require('./routes/planner.ui.routes');",
  "const { createPlannerUiRouter } = require('./routes/planner.ui.routes');\nconst { createProjectUiRouter } = require('./routes/project.ui.routes');",
  'app import project ui'
);
replaceString(
  'src/app.js',
  "  app.use(createPlannerUiRouter());",
  "  app.use(createPlannerUiRouter());\n  app.use(createProjectUiRouter());",
  'app mount project ui'
);

replaceString(
  'src/routes/planner.routes.js',
  "const { confirmHumanActionReady } = require('../services/autopilot');",
  "const { confirmHumanActionReady } = require('../services/autopilot');\nconst { assertProjectRuntimeReady } = require('../services/projectRuntime');",
  'planner runtime import'
);

replaceRegex(
  'src/routes/planner.routes.js',
  /router\.post\('\/requests',[\s\S]*?try\s*\{\s*(?=const created = await createPlannerRequest)/,
  (m) => m + "      await assertProjectRuntimeReady(db, req.tenantId, req.body?.project_id, req.body?.workspace_id || null);\n      ",
  'planner request runtime guard',
  'await assertProjectRuntimeReady(db, req.tenantId, req.body?.project_id'
);

replaceRegex(
  'src/routes/planner.routes.js',
  /(const roadmapId = req\.params\.roadmapId;\s*)(?=const started = await startPlannerRoadmap)/,
  `$1const roadmapSnap = await db.collection('roadmaps').doc(roadmapId).get();
      if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== req.tenantId) return res.status(404).json({ error: 'PLANNER_ROADMAP_NOT_FOUND' });
      await assertProjectRuntimeReady(db, req.tenantId, roadmapSnap.data().project_id, roadmapSnap.data().workspace_id || null);
      `,
  'roadmap start runtime guard',
  "await assertProjectRuntimeReady(db, req.tenantId, roadmapSnap.data().project_id"
);

// Orchestration: inject project runtime resolution immediately before buildCodexHandoff.
replaceRegex(
  'src/services/orchestration.js',
  /(const brainRun = brainRunSnap\?\.exists \? \{ id: brainRunSnap\.id, \.\.\.brainRunSnap\.data\(\) \} : null;\s*const taskBrainRunId = nullIfUndefined\(task\.brain_run_id\);\s*)(const codexHandoff = buildCodexHandoff\(\{)/,
  `$1if (!task.project_id || task.project_id !== mission.project_id) {
          const error = new Error('PROJECT_RUNTIME_MISMATCH');
          error.retryCandidate = true;
          throw error;
        }

        const projectSnap = await tx.get(db.collection('projects').doc(task.project_id));
        if (!projectSnap.exists || projectSnap.data().tenant_id !== tenantId) {
          const error = new Error('PROJECT_RUNTIME_MISMATCH');
          error.retryCandidate = true;
          throw error;
        }

        const project = projectSnap.data();
        const runtime = project.runtime_context && typeof project.runtime_context === 'object'
          ? project.runtime_context
          : {};
        const projectRepositoryPath = String(
          runtime.repository_path ||
          runtime.local_path ||
          project.repository_path ||
          project.local_path ||
          ''
        ).trim();
        const runtimeState = String(
          runtime.binding_state ||
          project.runtime_binding_state ||
          ''
        ).toUpperCase();

        if (!projectRepositoryPath || !['READY', 'VALIDATED', 'CONFIGURED'].includes(runtimeState)) {
          const error = new Error('PROJECT_RUNTIME_BINDING_NOT_READY');
          error.retryCandidate = true;
          throw error;
        }

        $2`,
  'claim project runtime resolve',
  "const projectRepositoryPath = String("
);

// Replace handoff repositoryPath fallback only inside buildCodexHandoff block.
replaceRegex(
  'src/services/orchestration.js',
  /repositoryPath:\s*options\.repository_path\s*\|\|\s*options\.repositoryPath\s*\|\|\s*process\.env\.MRAPI_REPO_PATH\s*\|\|\s*'LOCAL_REPOSITORY_NOT_PROVIDED'/,
  'repositoryPath: projectRepositoryPath',
  'handoff project repository path',
  'repositoryPath: projectRepositoryPath'
);

// Add runtime mismatch errors to candidate skip list.
replaceRegex(
  'src/services/orchestration.js',
  /('CODEX_HANDOFF_REPOSITORY_PATH_REQUIRED'\s*)(\]\.includes\(error\?\.message\);)/,
  `$1,
      'PROJECT_RUNTIME_MISMATCH',
      'PROJECT_RUNTIME_BINDING_NOT_READY'
    $2`,
  'claim runtime candidate errors',
  "'PROJECT_RUNTIME_MISMATCH'"
);

// Host validation: allow repository root.
replaceRegex(
  'src/services/orchestration.js',
  /(const runnerPath = comparableLocalPath\(options\.repository_path \|\| options\.repositoryPath \|\| process\.env\.MRAPI_REPO_PATH \|\| ''\);)/,
  `$1
  const runnerRoot = comparableLocalPath(options.repository_root || options.repositoryRoot || '');
  const runnerCanAccess = (candidatePath) => {
    const target = comparableLocalPath(candidatePath);
    if (!target) return false;
    if (runnerRoot && (target === runnerRoot || target.startsWith(runnerRoot + '/'))) return true;
    return Boolean(runnerPath && target === runnerPath);
  };`,
  'host validation repository root',
  'const runnerCanAccess = (candidatePath)'
);

replaceRegex(
  'src/services/orchestration.js',
  /\.filter\(\(item\) => runnerPath && comparableLocalPath\(item\.repository_path\) === runnerPath\)/,
  '.filter((item) => runnerCanAccess(item.repository_path))',
  'host validation root candidate filter',
  '.filter((item) => runnerCanAccess(item.repository_path))'
);

replaceRegex(
  'src/services/orchestration.js',
  /if \(!runnerPath \|\| comparableLocalPath\(validation\.repository_path\) !== runnerPath\) \{/,
  'if (!runnerCanAccess(validation.repository_path)) {',
  'host validation root transaction guard',
  'if (!runnerCanAccess(validation.repository_path))'
);

// Runner route forwards root to orchestration claim.
replaceRegex(
  'src/routes/runner.routes.js',
  /(repository_path:\s*req\.body\?\.repository_path \|\| null)(\s*\n\s*\}\);)/,
  `$1,
        repository_root: req.body?.repository_root || null$2`,
  'runner route repository root',
  'repository_root: req.body?.repository_root'
);

// Shadow config.
replaceRegex(
  'runner/lib/config.js',
  /(\s*repoPath:\s*process\.env\.MRAPI_REPO_PATH \|\| path\.join\()/,
  `  repoRoot: process.env.MRAPI_REPO_ROOT || path.join(os.homedir(), 'Documents', 'GitHub'),
$1`,
  'shadow repository root config',
  'repoRoot: process.env.MRAPI_REPO_ROOT'
);

// Shadow local host validation authorization.
replaceRegex(
  'runner/shadow-runner.js',
  /const runnerRepositoryPath = String\(options\.repositoryPath \|\| cfg\.repoPath \|\| ''\)\.trim\(\);\s*if \(!repositoryPath \|\| !runnerRepositoryPath \|\| comparableLocalPath\(repositoryPath\) !== comparableLocalPath\(runnerRepositoryPath\)\) \{/,
  `const runnerRepositoryPath = String(options.repositoryPath || cfg.repoPath || '').trim();
  const runnerRoot = String(options.repositoryRoot || cfg.repoRoot || '').trim();
  const target = comparableLocalPath(repositoryPath);
  const exact = comparableLocalPath(runnerRepositoryPath);
  const root = comparableLocalPath(runnerRoot);
  const authorized = Boolean(
    target &&
    ((root && (target === root || target.startsWith(root + '/'))) || (exact && target === exact))
  );
  if (!authorized) {`,
  'shadow host validation repository root',
  'const authorized = Boolean('
);

replaceRegex(
  'runner/shadow-runner.js',
  /runGitWorktreeCleanHostValidation\(validation,\s*\{\s*repositoryPath:\s*cfg\.repoPath\s*\}\)/,
  'runGitWorktreeCleanHostValidation(validation, { repositoryPath: cfg.repoPath, repositoryRoot: cfg.repoRoot })',
  'shadow pass repository root',
  'repositoryRoot: cfg.repoRoot'
);

replaceRegex(
  'runner/shadow-runner.js',
  /(repository_path:\s*cfg\.repoPath)(\s*\n\s*\}\);)/,
  `$1,
          repository_root: cfg.repoRoot$2`,
  'shadow poll repository root',
  'repository_root: cfg.repoRoot'
);

console.log('MULTI_PROJECT_RUNTIME_REPAIR_V2_OK');
