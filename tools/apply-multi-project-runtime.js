const fs = require('fs');

function replaceOnce(file, from, to, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) {
    if (src.includes(to)) {
      console.log('[SKIP already applied]', label);
      return;
    }
    throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  }
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
  console.log('[PATCHED]', label);
}

// app.js: mount Project setup UI
replaceOnce(
  'src/app.js',
  "const { createPlannerUiRouter } = require('./routes/planner.ui.routes');",
  "const { createPlannerUiRouter } = require('./routes/planner.ui.routes');\nconst { createProjectUiRouter } = require('./routes/project.ui.routes');",
  'app import project ui'
);
replaceOnce(
  'src/app.js',
  "  app.use(createPlannerUiRouter());",
  "  app.use(createPlannerUiRouter());\n  app.use(createProjectUiRouter());",
  'app mount project ui'
);

// planner.routes.js: fail closed before Planner request and before Roadmap start
replaceOnce(
  'src/routes/planner.routes.js',
  "const { confirmHumanActionReady } = require('../services/autopilot');",
  "const { confirmHumanActionReady } = require('../services/autopilot');\nconst { assertProjectRuntimeReady } = require('../services/projectRuntime');",
  'planner runtime import'
);
replaceOnce(
  'src/routes/planner.routes.js',
  "    try {\n      const created = await createPlannerRequest(db, req.tenantId, req.body || {});",
  "    try {\n      await assertProjectRuntimeReady(db, req.tenantId, req.body?.project_id, req.body?.workspace_id || null);\n      const created = await createPlannerRequest(db, req.tenantId, req.body || {});",
  'planner request runtime guard'
);
replaceOnce(
  'src/routes/planner.routes.js',
  "      const roadmapId = req.params.roadmapId;\n      const started = await startPlannerRoadmap(db, req.tenantId, roadmapId, req.body || {});",
  "      const roadmapId = req.params.roadmapId;\n      const roadmapSnap = await db.collection('roadmaps').doc(roadmapId).get();\n      if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== req.tenantId) return res.status(404).json({ error: 'PLANNER_ROADMAP_NOT_FOUND' });\n      await assertProjectRuntimeReady(db, req.tenantId, roadmapSnap.data().project_id, roadmapSnap.data().workspace_id || null);\n      const started = await startPlannerRoadmap(db, req.tenantId, roadmapId, req.body || {});",
  'roadmap start runtime guard'
);

// orchestration.js: repository path comes from Project, never runner default
replaceOnce(
  'src/services/orchestration.js',
  "        const brainRun = brainRunSnap?.exists ? { id: brainRunSnap.id, ...brainRunSnap.data() } : null;\n        const taskBrainRunId = nullIfUndefined(task.brain_run_id);\n        const codexHandoff = buildCodexHandoff({",
  "        const brainRun = brainRunSnap?.exists ? { id: brainRunSnap.id, ...brainRunSnap.data() } : null;\n        const taskBrainRunId = nullIfUndefined(task.brain_run_id);\n        if (!task.project_id || task.project_id !== mission.project_id) {\n          const error = new Error('PROJECT_RUNTIME_MISMATCH'); error.retryCandidate = true; throw error;\n        }\n        const projectSnap = await tx.get(db.collection('projects').doc(task.project_id));\n        if (!projectSnap.exists || projectSnap.data().tenant_id !== tenantId) {\n          const error = new Error('PROJECT_RUNTIME_MISMATCH'); error.retryCandidate = true; throw error;\n        }\n        const project = projectSnap.data();\n        const runtime = project.runtime_context && typeof project.runtime_context === 'object' ? project.runtime_context : {};\n        const projectRepositoryPath = String(runtime.repository_path || runtime.local_path || project.repository_path || project.local_path || '').trim();\n        const runtimeState = String(runtime.binding_state || project.runtime_binding_state || '').toUpperCase();\n        if (!projectRepositoryPath || !['READY','VALIDATED','CONFIGURED'].includes(runtimeState)) {\n          const error = new Error('PROJECT_RUNTIME_BINDING_NOT_READY'); error.retryCandidate = true; throw error;\n        }\n        const codexHandoff = buildCodexHandoff({",
  'claim project runtime resolve'
);
replaceOnce(
  'src/services/orchestration.js',
  "          repositoryPath: options.repository_path ||\n            options.repositoryPath ||\n            process.env.MRAPI_REPO_PATH ||\n            'LOCAL_REPOSITORY_NOT_PROVIDED'",
  "          repositoryPath: projectRepositoryPath",
  'handoff project repository path'
);
replaceOnce(
  'src/services/orchestration.js',
  "      'CODEX_HANDOFF_REPOSITORY_PATH_REQUIRED'\n    ].includes(error?.message);",
  "      'CODEX_HANDOFF_REPOSITORY_PATH_REQUIRED',\n      'PROJECT_RUNTIME_MISMATCH',\n      'PROJECT_RUNTIME_BINDING_NOT_READY'\n    ].includes(error?.message);",
  'claim runtime candidate errors'
);

// Host validation: runner can advertise a repository root, not only one repo.
replaceOnce(
  'src/services/orchestration.js',
  "  const runnerPath = comparableLocalPath(options.repository_path || options.repositoryPath || process.env.MRAPI_REPO_PATH || '');",
  "  const runnerPath = comparableLocalPath(options.repository_path || options.repositoryPath || process.env.MRAPI_REPO_PATH || '');\n  const runnerRoot = comparableLocalPath(options.repository_root || options.repositoryRoot || '');\n  const runnerCanAccess = (candidatePath) => {\n    const target = comparableLocalPath(candidatePath);\n    if (!target) return false;\n    if (runnerRoot && (target === runnerRoot || target.startsWith(runnerRoot + '/'))) return true;\n    return Boolean(runnerPath && target === runnerPath);\n  };",
  'host validation repository root'
);
replaceOnce(
  'src/services/orchestration.js',
  "    .filter((item) => runnerPath && comparableLocalPath(item.repository_path) === runnerPath)",
  "    .filter((item) => runnerCanAccess(item.repository_path))",
  'host validation root candidate filter'
);
replaceOnce(
  'src/services/orchestration.js',
  "        if (!runnerPath || comparableLocalPath(validation.repository_path) !== runnerPath) {",
  "        if (!runnerCanAccess(validation.repository_path)) {",
  'host validation root transaction guard'
);

// Runner route forwards repository_root.
replaceOnce(
  'src/routes/runner.routes.js',
  "        repository_path: req.body?.repository_path || null\n      });",
  "        repository_path: req.body?.repository_path || null,\n        repository_root: req.body?.repository_root || null\n      });",
  'runner route repository root'
);

// Shadow config: repository root defaults to ~/Documents/GitHub.
replaceOnce(
  'runner/lib/config.js',
  "  repoPath: process.env.MRAPI_REPO_PATH || path.join(\n    os.homedir(), 'Documents', 'GitHub', 'mrapi-dev-orchestrator'\n  ),",
  "  repoRoot: process.env.MRAPI_REPO_ROOT || path.join(os.homedir(), 'Documents', 'GitHub'),\n  repoPath: process.env.MRAPI_REPO_PATH || path.join(\n    os.homedir(), 'Documents', 'GitHub', 'mrapi-dev-orchestrator'\n  ),",
  'shadow repository root config'
);

// Shadow host validation allows any project repo under the configured root.
replaceOnce(
  'runner/shadow-runner.js',
  "  const runnerRepositoryPath = String(options.repositoryPath || cfg.repoPath || '').trim();\n  if (!repositoryPath || !runnerRepositoryPath || comparableLocalPath(repositoryPath) !== comparableLocalPath(runnerRepositoryPath)) {",
  "  const runnerRepositoryPath = String(options.repositoryPath || cfg.repoPath || '').trim();\n  const runnerRoot = String(options.repositoryRoot || cfg.repoRoot || '').trim();\n  const target = comparableLocalPath(repositoryPath);\n  const exact = comparableLocalPath(runnerRepositoryPath);\n  const root = comparableLocalPath(runnerRoot);\n  const authorized = Boolean(target && ((root && (target === root || target.startsWith(root + '/'))) || (exact && target === exact)));\n  if (!authorized) {",
  'shadow host validation repository root'
);
replaceOnce(
  'runner/shadow-runner.js',
  "? runGitWorktreeCleanHostValidation(validation, { repositoryPath: cfg.repoPath })",
  "? runGitWorktreeCleanHostValidation(validation, { repositoryPath: cfg.repoPath, repositoryRoot: cfg.repoRoot })",
  'shadow pass repository root'
);
replaceOnce(
  'runner/shadow-runner.js',
  "          repository_path: cfg.repoPath\n        });",
  "          repository_path: cfg.repoPath,\n          repository_root: cfg.repoRoot\n        });",
  'shadow poll repository root'
);

console.log('MULTI_PROJECT_RUNTIME_PATCH_OK');
