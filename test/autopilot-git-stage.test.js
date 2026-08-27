const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gitFlow = require('../runner/adapters/git-flow');
const runner = require('../runner/shadow-runner');
const {
  completeVerificationBrainRun,
  completeGitStageExecutionRun,
  confirmHumanActionReady
} = require('../src/services/autopilot');

class Snap {
  constructor(id, data, ref = null) { this.id = id; this._data = data; this.ref = ref; this.exists = Boolean(data); }
  data() { return this._data ? { ...this._data } : undefined; }
}
class QuerySnap { constructor(docs) { this.docs = docs; this.empty = docs.length === 0; } }
class Doc {
  constructor(db, c, id) { this.db = db; this.c = c; this.collectionName = c; this.id = id || db.next(c); }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(d, o = {}) { this.db.set(this.c, this.id, d, o); }
  async update(d) { this.db.update(this.c, this.id, d); }
}
class Query {
  constructor(db, c, filters = [], max = null) { this.db = db; this.c = c; this.collectionName = c; this.filters = filters; this.max = max; }
  where(field, op, value) { assert.equal(op, '=='); return new Query(this.db, this.c, [...this.filters, { field, value }], this.max); }
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, d]) => this.filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}
class Coll extends Query { doc(id) { return new Doc(this.db, this.c, id); } }
class Tx {
  constructor() { this.hasWritten = false; }
  async get(x) { if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE'); return x.get(); }
  set(ref, d, o) { this.hasWritten = true; ref.db.set(ref.c || ref.collectionName, ref.id, d, o); }
  update(ref, d) { this.hasWritten = true; ref.db.update(ref.c || ref.collectionName, ref.id, d); }
}
class DB {
  constructor() { this.collections = {}; this.n = {}; }
  collection(c) { if (!this.collections[c]) this.collections[c] = {}; return new Coll(this, c); }
  next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) { if (!this.collections[c]) this.collections[c] = {}; this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d }; }
  update(c, id, d) { if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND'); this.collections[c][id] = { ...this.collections[c][id], ...d }; }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, c) { return Object.values(db.collections[c] || {}); }
function milestone(db, id = 'm1') { return db.get('roadmaps', 'roadmap_a').milestones.find((item) => item.id === id); }

function seedVerified(db, { git = true, autoAdvance = true } = {}) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    local_path: 'C:/repo',
    default_worker_id: 'W01',
    runtime_context: { git_automation_enabled: git }
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    auto_advance: autoAdvance,
    milestones: [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, mission_id: 'mission_a', git_automation_enabled: git },
      { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'] }
    ]
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    state: 'RUNNING',
    autopilot_mode: true,
    autopilot_phase: 'VERIFYING',
    autopilot_attempt_count: 2,
    git_automation_enabled: git,
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    current_task_id: 'program_task'
  });
  db.set('tasks', 'program_task', {
    id: 'program_task',
    tenant_id: 'tenant_a',
    mission_id: 'mission_a',
    state: 'DONE',
    task_spec: {
      objective: 'Implement verified change',
      allowed_files: ['src/services/autopilot.js', 'test/autopilot-git-stage.test.js'],
      required_tests: ['node --test test/autopilot-git-stage.test.js']
    }
  });
  db.set('runs', 'verify_a', {
    id: 'verify_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    autopilot_phase: 'VERIFY_EXECUTION'
  });
}

async function completeVerified(db, text = '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"done"}</MRAPI_AUTOPILOT>') {
  return completeVerificationBrainRun(db, 'tenant_a', 'verify_a', { output_text: text });
}

function gitRepo() {
  const git = gitFlow.resolveGitCommand();
  if (!git) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-git-stage-'));
  const run = (args, options = {}) => spawnSync(git, args, { cwd: dir, encoding: 'utf8', ...options });
  assert.equal(run(['init', '-b', 'main']).status, 0);
  assert.equal(run(['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(run(['config', 'user.name', 'MRAPI Test']).status, 0);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src', 'keep.txt'), 'keep\n');
  assert.equal(run(['add', '--', 'a.txt', 'src/keep.txt']).status, 0);
  assert.equal(run(['commit', '-m', 'initial']).status, 0);
  return { git, dir, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runStage(repo, overrides = {}) {
  return gitFlow.runSafeGitStage({
    repoPath: repo.dir,
    gitCommand: repo.git,
    gitPermissions: { allow_commit: true, allow_push: false, allowed_branch: 'main', ...(overrides.gitPermissions || {}) },
    missionId: 'mission_a',
    roadmapId: 'roadmap_a',
    milestoneId: 'm1',
    attempt: 2,
    objective: 'Implement verified change',
    allowedFiles: overrides.allowedFiles || ['a.txt', 'src/keep.txt'],
    priorResult: overrides.priorResult || null
  });
}

test('required tests failed and Git automation disabled never invoke Git writes', async () => {
  const failed = await runner.runTrustedGitFlow({
    claim: { codex_handoff: { execution_constraints: { autopilot_phase: 'GIT_STAGE' }, repository_path: 'C:/missing', git_permissions: { allow_commit: true, allow_push: true, allowed_branch: 'main' } }, task: { mission_id: 'm' } },
    result: { success: false, required_tests_failed: true }
  });
  assert.equal(failed.reason, 'CODEX_EXECUTION_FAILED');
  assert.equal(failed.committed, false);

  const disabled = await runner.runTrustedGitFlow({
    claim: { codex_handoff: { execution_constraints: { autopilot_phase: 'PROGRAM' }, repository_path: 'C:/missing', git_permissions: { allow_commit: true, allow_push: true, allowed_branch: 'main' } }, task: { mission_id: 'm' } },
    result: { success: true, scope_check: { changed_files: ['a.txt'] } }
  });
  assert.equal(disabled.reason, 'GIT_STAGE_REQUIRED');
  assert.equal(disabled.committed, false);
  assert.equal(disabled.pushed, false);
});

test('Brain COMPLETE queues GIT_STAGE only when Git automation is explicitly enabled', async () => {
  const db = new DB(); seedVerified(db, { git: true });
  const out = await completeVerified(db);
  assert.equal(out.action, 'GIT_STAGE');
  assert.equal(milestone(db).state, 'RUNNING');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'GIT_STAGE');
  assert.equal(values(db, 'tasks').filter((task) => task.autopilot_phase === 'GIT_STAGE').length, 1);

  const retryDb = new DB(); seedVerified(retryDb, { git: true });
  const retry = await completeVerified(retryDb, '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"failed","execution_spec":{"instructions":"fix","allowed_files":["src/services/autopilot.js"],"required_tests":["node --test test/autopilot-git-stage.test.js"]}}</MRAPI_AUTOPILOT>');
  assert.equal(retry.action, 'RETRY');
  assert.equal(values(retryDb, 'tasks').filter((task) => task.autopilot_phase === 'GIT_STAGE').length, 0);

  const directDb = new DB(); seedVerified(directDb, { git: false, autoAdvance: false });
  const direct = await completeVerified(directDb);
  assert.equal(direct.action, 'COMPLETE');
  assert.equal(direct.continuation_state, 'DISABLED');
  assert.equal(milestone(directDb).state, 'COMPLETED');
});

test('safe Git stage exact-path commit, no-op, allowlist, env, staged mismatch and traceability', { skip: !gitFlow.resolveGitCommand() }, () => {
  const repo = gitRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'two\n');
    let out = runStage(repo);
    assert.equal(out.classification, 'SUCCESS');
    assert.equal(out.committed, true);
    assert.equal(out.pushed, false);
    assert.deepEqual(out.changed_files, ['a.txt']);
    assert.deepEqual(out.staged_files, ['a.txt']);
    assert.ok(out.commit_sha);
    const msg = repo.run(['log', '-1', '--pretty=%B']).stdout;
    assert.match(msg, /mission_a/);
    assert.match(msg, /Roadmap: roadmap_a/);
    assert.match(msg, /Milestone: m1/);
    assert.match(msg, /Attempt: 2/);

    out = runStage(repo);
    assert.equal(out.reason, 'NO_CHANGES');
    assert.equal(out.committed, false);

    fs.writeFileSync(path.join(repo.dir, 'evil.txt'), 'bad\n');
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'three\n');
    out = runStage(repo);
    assert.equal(out.classification, 'BLOCKED');
    assert.equal(out.reason, 'GIT_UNAUTHORIZED_DIRTY_PATHS');
    assert.deepEqual(out.unauthorized_files, ['evil.txt']);
    assert.equal(repo.run(['diff', '--cached', '--name-only']).stdout.trim(), '');
    fs.rmSync(path.join(repo.dir, 'evil.txt'));

    fs.writeFileSync(path.join(repo.dir, '.env.local'), 'SECRET=value\n');
    out = runStage(repo, { allowedFiles: ['a.txt', '.env.local'] });
    assert.equal(out.reason, 'GIT_REFUSES_ENV_FILE');
    fs.rmSync(path.join(repo.dir, '.env.local'));

    fs.writeFileSync(path.join(repo.dir, 'secret.txt'), 'staged\n');
    assert.equal(repo.run(['add', '--', 'secret.txt']).status, 0);
    out = runStage(repo, { allowedFiles: ['a.txt'] });
    assert.equal(out.reason, 'GIT_UNAUTHORIZED_STAGED_PATHS');
    assert.equal(out.committed, false);
  } finally {
    repo.cleanup();
  }
});

test('staged-file verification mismatch blocks before commit', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-fake-repo-'));
  const commands = [];
  const commandRunner = (_command, args) => {
    commands.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { ok: true, stdout: '.git', stderr: '' };
    if (args[0] === 'branch' && args[1] === '--show-current') return { ok: true, stdout: 'main', stderr: '' };
    if (args[0] === 'status' && args[1] === '--porcelain=v1') return { ok: true, stdout: ' M a.txt\n', stderr: '' };
    if (args[0] === 'add') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'diff' && args[1] === '--cached') return { ok: true, stdout: 'a.txt\nextra.txt\n', stderr: '' };
    if (args[0] === 'commit') return { ok: false, stdout: '', stderr: 'commit must not run' };
    return { ok: true, stdout: '', stderr: '' };
  };
  try {
    fs.mkdirSync(path.join(repoPath, '.git'));
    const out = gitFlow.runSafeGitStage({
      repoPath,
      gitCommand: 'git',
      gitPermissions: { allow_commit: true, allow_push: false, allowed_branch: 'main' },
      missionId: 'mission_a',
      roadmapId: 'roadmap_a',
      milestoneId: 'm1',
      attempt: 2,
      objective: 'Mismatch',
      allowedFiles: ['a.txt', 'extra.txt'],
      commandRunner
    });
    assert.equal(out.reason, 'GIT_STAGED_SCOPE_MISMATCH');
    assert.equal(out.committed, false);
    assert.equal(commands.includes('commit -m MRAPI mission_a: Mismatch'), false);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('wrong branch, merge marker, push success and push-resume remain bounded', { skip: !gitFlow.resolveGitCommand() }, () => {
  const repo = gitRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'branch\n');
    let out = runStage(repo, { gitPermissions: { allow_push: true, allowed_branch: 'release' } });
    assert.equal(out.reason, 'GIT_BRANCH_NOT_ALLOWED');
    assert.equal(out.pushed, false);

    fs.writeFileSync(path.join(repo.dir, '.git', 'MERGE_HEAD'), 'abc\n');
    out = runStage(repo);
    assert.equal(out.reason, 'GIT_UNRESOLVED_MERGE_OR_REBASE');
    fs.rmSync(path.join(repo.dir, '.git', 'MERGE_HEAD'));
  } finally {
    repo.cleanup();
  }

  const remoteRepo = gitRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-git-remote-'));
  try {
    assert.equal(spawnSync(remoteRepo.git, ['init', '--bare'], { cwd: bare, encoding: 'utf8' }).status, 0);
    assert.equal(remoteRepo.run(['remote', 'add', 'origin', bare]).status, 0);
    fs.writeFileSync(path.join(remoteRepo.dir, 'a.txt'), 'push\n');
    const pushed = runStage(remoteRepo, { gitPermissions: { allow_commit: true, allow_push: true, allowed_branch: 'main' } });
    assert.equal(pushed.classification, 'SUCCESS');
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.pushed_sha, pushed.commit_sha);
  } finally {
    remoteRepo.cleanup();
    fs.rmSync(bare, { recursive: true, force: true });
  }

  const resumeRepo = gitRepo();
  const bare2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-git-remote-'));
  try {
    assert.equal(spawnSync(resumeRepo.git, ['init', '--bare'], { cwd: bare2, encoding: 'utf8' }).status, 0);
    assert.equal(resumeRepo.run(['remote', 'add', 'origin', bare2]).status, 0);
    const before = resumeRepo.run(['rev-list', '--count', 'HEAD']).stdout.trim();
    const resumed = runStage(resumeRepo, {
      gitPermissions: { allow_commit: true, allow_push: true, allowed_branch: 'main' },
      priorResult: { classification: 'NEED_HUMAN_ACTION', status: 'NEED_HUMAN_ACTION', committed: true, pushed: false, commit_sha: resumeRepo.run(['rev-parse', 'HEAD']).stdout.trim(), staged_files: ['a.txt'] }
    });
    const after = resumeRepo.run(['rev-list', '--count', 'HEAD']).stdout.trim();
    assert.equal(resumed.pushed, true);
    assert.equal(after, before);
  } finally {
    resumeRepo.cleanup();
    fs.rmSync(bare2, { recursive: true, force: true });
  }
});

test('Git failures pause or block without leaking credentials or auto-advancing', async () => {
  assert.equal(gitFlow.classifyGitFailure('git push', 'Authentication failed').reason, 'GIT_AUTH');
  assert.equal(gitFlow.classifyGitFailure('git push', 'Permission denied to repository').reason, 'GIT_REMOTE_PERMISSION');
  assert.equal(gitFlow.classifyGitFailure('git push', 'rejected non-fast-forward').reason, 'GIT_REMOTE_DIVERGED');

  const db = new DB(); seedVerified(db, { git: true });
  await completeVerified(db);
  const task = values(db, 'tasks').find((item) => item.autopilot_phase === 'GIT_STAGE');
  db.set('runs', 'git_run', { id: 'git_run', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', state: 'RUNNING', mission_id: 'mission_a', task_id: task.id, worker_id: 'W01' });
  const paused = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: false,
    output: { git: { classification: 'NEED_HUMAN_ACTION', reason: 'GIT_AUTH', committed: true, pushed: false, commit_sha: 'abc123', error: 'token ghp_secret', checkpoint: { checkpoint_type: 'GIT_AUTH', validation_method: 'manual_confirmation' } } }
  });
  assert.equal(paused.action, 'NEED_HUMAN_ACTION');
  assert.equal(milestone(db).state, 'NEED_HUMAN_ACTION');
  assert.equal(JSON.stringify(db.collections).includes('ghp_secret'), false);
  assert.equal(paused.human_action_checkpoint.paused_from_phase, 'GIT_STAGE');
  assert.equal(paused.human_action_checkpoint.validation_metadata.commit_sha, 'abc123');

  const resumed = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', paused.checkpoint_id, { ready: true });
  assert.equal(resumed.resume_phase, 'GIT_STAGE');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'GIT_STAGE');
  assert.equal(values(db, 'missions').length, 1);

  db.set('runs', 'blocked_run', { id: 'blocked_run', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', state: 'RUNNING', mission_id: 'mission_a', task_id: task.id, worker_id: 'W01' });
  const blocked = await completeGitStageExecutionRun(db, 'tenant_a', 'blocked_run', {
    success: false,
    output: { git: { classification: 'BLOCKED', reason: 'GIT_UNAUTHORIZED_DIRTY_PATHS', unauthorized_files: ['outside.js'] } }
  });
  assert.equal(blocked.action, 'BLOCKED');
  assert.equal(milestone(db).state, 'BLOCKED');
});

test('successful Git-stage persistence is idempotent, tenant-scoped, and resumes completion ordering', async () => {
  const db = new DB(); seedVerified(db, { git: true });
  await completeVerified(db);
  const task = values(db, 'tasks').find((item) => item.autopilot_phase === 'GIT_STAGE');
  db.set('runs', 'git_run', { id: 'git_run', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', state: 'RUNNING', mission_id: 'mission_a', task_id: task.id, worker_id: 'W01', autopilot_phase: 'GIT_STAGE' });

  await assert.rejects(
    () => completeGitStageExecutionRun(db, 'tenant_b', 'git_run', { success: true }),
    /RUN_NOT_FOUND/
  );

  const out = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: false, reason: 'GIT_PUSH_NOT_ALLOWED', commit_sha: 'abc123', branch: 'main', target_branch: 'main', allowed_files: ['src/services/autopilot.js'], changed_files: ['src/services/autopilot.js'], staged_files: ['src/services/autopilot.js'], mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', attempt: 2 } }
  });
  assert.equal(out.action, 'COMPLETE');
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(milestone(db).git_stage_result.commit_sha, 'abc123');
  assert.equal(values(db, 'missions').length, 2);

  const replay = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: true, commit_sha: 'abc123', branch: 'main', target_branch: 'main' } }
  });
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(values(db, 'missions').length, 2);
});

test('PROGRAM/RETRY remain write-forbidden and Autopilot safe path has no broad staging or recovery commands', () => {
  assert.throws(() => runner.validatePreExecutionWorktree({
    autopilotPhase: 'RETRY',
    beforeStatus: { available: true, text: ' M old.js\n' },
    allowedFiles: ['current.js']
  }), /AUTOPILOT_REPO_DIRTY_OUTSIDE_RETRY_SCOPE/);

  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'adapters', 'git-flow.js'), 'utf8');
  assert.doesNotMatch(source, /git add --all|git add -A|git add \./);
  assert.doesNotMatch(source, /run\(command, \['(?:pull|fetch|merge|checkout|switch|reset|restore|stash)'/);
  assert.match(source, /commandRunner\(command, \['add', '--', \.\.\.changedAllowedFiles\]/);
});
