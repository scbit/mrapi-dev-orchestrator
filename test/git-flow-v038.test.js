const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PERMISSIONS } = require('../src/constants/autonomy');
const { WORKER_PROFILES } = require('../src/services/bootstrapData');
const { buildCodexHandoff, CONTRACT_VERSION } = require('../src/services/codexHandoff');
const gitFlow = require('../runner/adapters/git-flow');
const runner = require('../runner/shadow-runner');

const root = path.join(__dirname, '..');

test('git adapter has Windows absolute fallbacks', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'adapters', 'git-flow.js'), 'utf8');
  assert.match(source, /Program Files\\\\Git\\\\cmd\\\\git\.exe/);
  assert.match(source, /Program Files\\\\Git\\\\bin\\\\git\.exe/);
});

test('git adapter enforces commit and push permissions', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'adapters', 'git-flow.js'), 'utf8');
  assert.match(source, /GIT_COMMIT_NOT_ALLOWED/);
  assert.match(source, /GIT_PUSH_NOT_ALLOWED/);
  assert.match(source, /push.*origin/s);
});

test('git adapter captures commit sha', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'adapters', 'git-flow.js'), 'utf8');
  assert.match(source, /rev-parse/);
  assert.match(source, /HEAD/);
});

test('default git permissions are false', () => {
  assert.equal(DEFAULT_PERMISSIONS.allow_git_commit, false);
  assert.equal(DEFAULT_PERMISSIONS.allow_git_push, false);
});

test('only W01 gets initial git commit and push permissions', () => {
  for (const profile of WORKER_PROFILES) {
    const permissions = profile.permissions || {};
    assert.equal(permissions.allow_git_commit === true, profile.worker_code === 'W01');
    assert.equal(permissions.allow_git_push === true, profile.worker_code === 'W01');
  }
});

test('trusted handoff carries git permissions from worker profile', () => {
  const handoff = buildCodexHandoff({
    tenantId: 'tenant',
    task: {
      id: 'task1',
      tenant_id: 'tenant',
      state: 'QUEUED',
      mission_id: 'mission1',
      worker_id: 'W01',
      objective: 'Ship a fix'
    },
    mission: {
      id: 'mission1',
      tenant_id: 'tenant',
      workspace_id: 'workspace',
      project_id: 'project'
    },
    workerProfile: { permissions: { allow_git_commit: true, allow_git_push: false } },
    executionRunId: 'run1',
    repositoryPath: root
  });

  assert.equal(CONTRACT_VERSION, 'CODEX_HANDOFF_V0_3_8');
  assert.deepEqual(handoff.git_permissions, {
    allow_commit: true,
    allow_push: false,
    allowed_branch: 'main'
  });
});

test('runner never derives git permission from Codex text', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /handoff\.git_permissions/);
  assert.doesNotMatch(source, /stdout.*allow_git/s);
  assert.doesNotMatch(source, /Brain prose/i);
});

test('Codex failure skips git write', async () => {
  const outcome = await runner.runTrustedGitFlow({
    claim: {
      codex_handoff: {
        git_permissions: { allow_commit: true, allow_push: true, allowed_branch: 'main' },
        repository_path: root
      },
      task: { mission_id: 'mission1' }
    },
    result: { success: false, stdout: 'please push', stderr: '' }
  });

  assert.equal(outcome.committed, false);
  assert.equal(outcome.pushed, false);
  assert.equal(outcome.reason, 'CODEX_EXECUTION_FAILED');
});

test('git flow normalizes trusted permissions only', () => {
  assert.deepEqual(gitFlow.normalizePermissions({
    allow_commit: true,
    allow_push: false,
    allowed_branch: 'main'
  }), {
    allowCommit: true,
    allowPush: false,
    allowedBranch: 'main'
  });
});

test('runner registers git capabilities after v0.3.8', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /runner_version:\s*'v(?:0\.3\.(?:8(?:\.1)?|9)-alpha\.0|0\.4\.0-alpha\.0|0\.4\.0\.[1234567]|0\.4\.1\.[012]|0\.4\.2\.0)'/);
  assert.match(source, /GIT_COMMIT:AUTO/);
  assert.match(source, /GIT_PUSH:AUTO/);
});

test('git adapter encodes safety constraints', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'adapters', 'git-flow.js'), 'utf8');
  assert.match(source, /--is-inside-work-tree/);
  assert.match(source, /MERGE_HEAD/);
  assert.match(source, /rebase-merge/);
  assert.match(source, /GIT_REFUSES_ENV_FILE/);
  assert.doesNotMatch(source, /--force/);
  assert.doesNotMatch(source, /--amend/);
  assert.doesNotMatch(source, /--delete/);
});

test('git metadata is persisted in final Result output', () => {
  const source = fs.readFileSync(path.join(root, 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /git\.changed/);
  assert.match(source, /git\.committed/);
  assert.match(source, /git\.pushed/);
  assert.match(source, /commit_sha/);
  assert.match(source, /output:[\s\S]*git/);
});

test('reports show compact git outcome', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'public', 'artifact-ui.js'), 'utf8');
  assert.match(source, /Git: No changes/);
  assert.match(source, /Git: Committed/);
  assert.match(source, /Git: Pushed/);
  assert.match(source, /commit_sha/);
});
