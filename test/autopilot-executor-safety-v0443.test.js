const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildCodexHandoff, normalizeAllowedFiles } = require('../src/services/codexHandoff');
const { verifyAllowedChanges } = require('../runner/adapters/git-flow');
const { createGitReadOnlyGuard } = require('../runner/adapters/codex-command');
const { buildCodexPrompt } = require('../runner/adapters/codex-desktop-handoff');

test('normalizes bounded allowed_files', () => {
  assert.deepEqual(normalizeAllowedFiles(['./src/a.js', 'src\\b.js', '../bad.js', 'src/a.js']), ['src/a.js', 'src/b.js']);
});

test('autopilot handoff requires allowed_files and disables git outside GIT_STAGE', () => {
  const base = {
    tenantId: 'tenant_a',
    task: {
      id: 'task_1', tenant_id: 'tenant_a', mission_id: 'mission_1', worker_id: 'W01',
      workspace_id: 'workspace_scb', project_id: 'project_scb_development', state: 'QUEUED',
      brain_run_id: 'brain_1',
      brain_output: { task_spec: { objective: 'x', instructions: 'edit exact file', allowed_files: ['src/a.js'] } }
    },
    mission: {
      id: 'mission_1', tenant_id: 'tenant_a', workspace_id: 'workspace_scb', project_id: 'project_scb_development',
      autopilot_mode: true, autopilot_phase: 'PROGRAM'
    },
    brainRun: { id: 'brain_1', tenant_id: 'tenant_a', mission_id: 'mission_1', run_type: 'BRAIN_RUN', state: 'COMPLETED', autopilot_phase: 'PROGRAM' },
    workerProfile: { permissions: { allow_git_commit: true, allow_git_push: true } },
    executor: { id: 'exec_1', host_name: 'Shadow' },
    executionRunId: 'run_1',
    repositoryPath: '/repo'
  };
  const handoff = buildCodexHandoff(base);
  assert.deepEqual(handoff.task_spec.allowed_files, ['src/a.js']);
  assert.equal(handoff.git_permissions.allow_commit, false);
  assert.equal(handoff.git_permissions.allow_push, false);
  assert.equal(handoff.execution_constraints.autopilot_phase, 'PROGRAM');
  assert.throws(() => buildCodexHandoff({
    ...base,
    task: { ...base.task, brain_output: { task_spec: { objective: 'x', instructions: 'edit' } } }
  }), /CODEX_HANDOFF_ALLOWED_FILES_REQUIRED/);
});

test('file scope verifier rejects files outside Brain scope', () => {
  const ok = verifyAllowedChanges(' M src/a.js\n?? test/a.test.js', ['src/a.js', 'test/a.test.js']);
  assert.equal(ok.ok, true);
  const bad = verifyAllowedChanges(' M src/a.js\n M package.json', ['src/a.js']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unauthorized_files, ['package.json']);
});

test('Codex prompt exposes hard file scope and git prohibition', () => {
  const prompt = buildCodexPrompt({
    task: { id: 'task_1', codex_handoff: {
      contract_version: 'X', task_id: 'task_1', execution_run_id: 'run_1', repository_path: '/repo',
      task_spec: { instructions: 'do it', allowed_files: ['src/a.js'] },
      execution_rules: ['Modify only allowed files.', 'Do not run git push.'],
      git_permissions: { allow_commit: false, allow_push: false }
    } },
    executionRun: { id: 'run_1' }, cfg: { repoPath: '/repo' }
  });
  assert.match(prompt, /ALLOWED FILES — HARD SCOPE/);
  assert.match(prompt, /src\/a\.js/);
  assert.match(prompt, /allow_push": false/);
});

test('git guard blocks write/network git commands', { skip: process.platform === 'win32' }, () => {
  const guard = createGitReadOnlyGuard(process.env);
  try {
    const blocked = spawnSync('git', ['push'], { env: guard.env, encoding: 'utf8' });
    assert.equal(blocked.status, 73);
    assert.match(blocked.stderr, /MRAPI_GIT_WRITE_BLOCKED/);
    const read = spawnSync('git', ['--version'], { env: guard.env, encoding: 'utf8' });
    // --version is intentionally not whitelisted: Codex does not need it during execution.
    assert.equal(read.status, 73);
  } finally {
    guard.cleanup();
  }
});
