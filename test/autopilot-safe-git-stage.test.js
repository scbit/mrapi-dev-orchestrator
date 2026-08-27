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
      allowed_files: ['src/services/autopilot.js', 'test/autopilot-safe-git-stage.test.js'],
      required_tests: ['node --test test\\autopilot-safe-git-stage.test.js']
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
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'keep.txt'), 'keep\n');
  assert.equal(run(['add', '--', 'a.txt', 'src/keep.txt']).status, 0);
  assert.equal(run(['commit', '-m', 'initial']).status, 0);
  return { git, dir, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function stage(repo, overrides = {}) {
  return gitFlow.runSafeGitStage({
    repoPath: repo.dir,
    gitCommand: repo.git,
    gitPermissions: { allow_commit: true, allow_push: false, allowed_branch: 'main', ...(overrides.gitPermissions || {}) },
    missionId: 'mission_a',
    roadmapId: 'roadmap_a',
    milestoneId: 'm1',
    attempt: 2,
    objective: 'Implement verified change',
    allowedFiles: ['a.txt', 'src/keep.txt', 'renamed.txt', ...(overrides.allowedFiles || [])],
    priorResult: overrides.priorResult || null
  });
}

test('successful Brain COMPLETE queues persisted GIT_STAGE before finalization when Git automation is enabled', async () => {
  const db = new DB(); seedVerified(db, { git: true });
  const out = await completeVerified(db);
  assert.equal(out.action, 'GIT_STAGE');
  assert.equal(milestone(db).state, 'RUNNING');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'GIT_STAGE');
  assert.equal(values(db, 'tasks').filter((task) => task.autopilot_phase === 'GIT_STAGE').length, 1);
  assert.equal(values(db, 'tasks')[1].task_spec.allowed_files.includes('src/services/autopilot.js'), true);
});

test('failed verification decisions never create GIT_STAGE and Git-disabled flow finalizes directly', async () => {
  const retryDb = new DB(); seedVerified(retryDb, { git: true });
  const retry = await completeVerified(retryDb, '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"failed","execution_spec":{"instructions":"fix","allowed_files":["src/services/autopilot.js"],"required_tests":["node --test test/autopilot-safe-git-stage.test.js"]}}</MRAPI_AUTOPILOT>');
  assert.equal(retry.action, 'RETRY');
  assert.equal(values(retryDb, 'tasks').filter((task) => task.autopilot_phase === 'GIT_STAGE').length, 0);

  const directDb = new DB(); seedVerified(directDb, { git: false, autoAdvance: false });
  const direct = await completeVerified(directDb);
  assert.equal(direct.action, 'COMPLETE');
  assert.equal(direct.continuation_state, 'DISABLED');
  assert.equal(milestone(directDb).state, 'COMPLETED');
});

test('GIT_STAGE completion persists SHA/branches and advances exactly once after successful commit-only stage', async () => {
  const db = new DB(); seedVerified(db, { git: true });
  await completeVerified(db);
  const task = values(db, 'tasks').find((item) => item.autopilot_phase === 'GIT_STAGE');
  db.set('runs', 'git_run', {
    id: 'git_run',
    tenant_id: 'tenant_a',
    run_type: 'EXECUTION_RUN',
    state: 'RUNNING',
    mission_id: 'mission_a',
    task_id: task.id,
    worker_id: 'W01',
    autopilot_phase: 'GIT_STAGE'
  });
  const out = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: true,
    output: { git: { classification: 'SUCCESS', reason: 'GIT_PUSH_NOT_ALLOWED', committed: true, pushed: false, commit_sha: 'abc123', branch: 'main', target_branch: 'main', staged_files: ['src/services/autopilot.js'], changed_files: ['src/services/autopilot.js'] } }
  });
  assert.equal(out.action, 'COMPLETE');
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(milestone(db).state, 'COMPLETED');
  assert.equal(milestone(db).git_stage_result.commit_sha, 'abc123');
  assert.equal(values(db, 'missions').length, 2);
  const replay = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: true, commit_sha: 'abc123', branch: 'main', target_branch: 'main' } }
  });
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(values(db, 'missions').length, 2);
});

test('GIT_STAGE NEED_HUMAN_ACTION checkpoint resumes at GIT_STAGE without secrets or PROGRAM rerun', async () => {
  const db = new DB(); seedVerified(db, { git: true });
  await completeVerified(db);
  const task = values(db, 'tasks').find((item) => item.autopilot_phase === 'GIT_STAGE');
  db.set('runs', 'git_run', { id: 'git_run', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', state: 'RUNNING', mission_id: 'mission_a', task_id: task.id, worker_id: 'W01' });
  const out = await completeGitStageExecutionRun(db, 'tenant_a', 'git_run', {
    success: false,
    output: { git: { classification: 'NEED_HUMAN_ACTION', reason: 'GIT_AUTH', error: 'token ghp_secret must not persist', checkpoint: { checkpoint_type: 'GIT_AUTH', validation_method: 'manual_confirmation' } } }
  });
  assert.equal(out.action, 'NEED_HUMAN_ACTION');
  assert.equal(JSON.stringify(db.collections).includes('ghp_secret'), false);
  const resumed = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', out.checkpoint_id, { ready: true });
  assert.equal(resumed.resume_phase, 'GIT_STAGE');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'GIT_STAGE');
  assert.equal(values(db, 'runs').filter((run) => run.autopilot_phase === 'PROGRAM').length, 0);
});

test('PROGRAM and RETRY paths remain Git-write-free and GIT_STAGE does not invoke Codex programming', async () => {
  const program = await runner.runTrustedGitFlow({
    claim: { codex_handoff: { execution_constraints: { autopilot_phase: 'PROGRAM' }, repository_path: 'C:/repo', git_permissions: { allow_commit: true, allow_push: true } }, task: { mission_id: 'm' } },
    result: { success: true, scope_check: { changed_files: ['a.txt'] } }
  });
  assert.equal(program.committed, false);
  assert.equal(program.reason, 'GIT_STAGE_REQUIRED');
  const retry = runner.validatePreExecutionWorktree({ autopilotPhase: 'RETRY', beforeStatus: { available: true, text: ' M a.txt\n' }, allowedFiles: ['a.txt'] });
  assert.equal(retry.resumed_retry, true);
  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /autopilotPhase === 'GIT_STAGE'[\s\S]*executeGitStageClaim/);
  assert.match(source, /executeGitStageClaim/);
});

test('safe Git stage exact staging, allowlist, env, deletion, staged-content, traceability and idempotency', { skip: !gitFlow.resolveGitCommand() }, () => {
  const repo = gitRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'two\n');
    let out = stage(repo);
    assert.equal(out.classification, 'SUCCESS');
    assert.equal(out.committed, true);
    assert.equal(out.pushed, false);
    assert.equal(out.reason, 'GIT_PUSH_NOT_ALLOWED');
    assert.equal(out.branch, 'main');
    assert.equal(out.target_branch, 'main');
    assert.deepEqual(out.changed_files, ['a.txt']);
    assert.ok(out.commit_sha);
    const msg = repo.run(['log', '-1', '--pretty=%B']).stdout;
    assert.match(msg, /mission_a/);
    assert.match(msg, /Roadmap: roadmap_a/);
    assert.match(msg, /Milestone: m1/);
    assert.match(msg, /Attempt: 2/);

    out = stage(repo, { priorResult: { status: 'SUCCESS', reason: 'NO_CHANGES', changed: false, committed: false, pushed: false, branch: 'main', target_branch: 'main' } });
    assert.equal(out.reason, 'NO_CHANGES');

    fs.writeFileSync(path.join(repo.dir, 'evil.txt'), 'bad\n');
    out = stage(repo);
    assert.equal(out.classification, 'BLOCKED');
    assert.equal(out.reason, 'GIT_UNAUTHORIZED_DIRTY_PATHS');
    assert.deepEqual(out.unauthorized_files, ['evil.txt']);
    assert.equal(repo.run(['diff', '--cached', '--name-only']).stdout.trim(), '');
    fs.rmSync(path.join(repo.dir, 'evil.txt'));

    fs.writeFileSync(path.join(repo.dir, '.env.local'), 'SECRET=value\n');
    out = stage(repo, { allowedFiles: ['.env.local'] });
    assert.equal(out.reason, 'GIT_REFUSES_ENV_FILE');
    fs.rmSync(path.join(repo.dir, '.env.local'));

    fs.rmSync(path.join(repo.dir, 'src', 'keep.txt'));
    out = stage(repo);
    assert.equal(out.classification, 'SUCCESS');
    assert.match(repo.run(['show', '--name-only', '--pretty=', 'HEAD']).stdout, /src\/keep\.txt/);

    fs.writeFileSync(path.join(repo.dir, 'secret.txt'), 'staged\n');
    assert.equal(repo.run(['add', '--', 'secret.txt']).status, 0);
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'three\n');
    out = stage(repo);
    assert.equal(out.reason, 'GIT_UNAUTHORIZED_STAGED_PATHS');
    assert.deepEqual(out.unauthorized_files, ['secret.txt']);
  } finally {
    repo.cleanup();
  }
});

test('rename validation blocks unauthorized source or destination and push policy is bounded', { skip: !gitFlow.resolveGitCommand() }, () => {
  const repo = gitRepo();
  try {
    assert.equal(repo.run(['mv', 'a.txt', 'renamed.txt']).status, 0);
    let out = gitFlow.runSafeGitStage({
      repoPath: repo.dir,
      gitCommand: repo.git,
      gitPermissions: { allow_commit: true, allow_push: false, allowed_branch: 'main' },
      missionId: 'mission_a',
      roadmapId: 'roadmap_a',
      milestoneId: 'm1',
      attempt: 2,
      objective: 'Rename',
      allowedFiles: ['renamed.txt']
    });
    assert.equal(out.reason, 'GIT_UNAUTHORIZED_STAGED_PATHS');
    assert.ok(out.unauthorized_files.includes('a.txt'));

    repo.cleanup();
    const branchRepo = gitRepo();
    fs.writeFileSync(path.join(branchRepo.dir, 'a.txt'), 'branch\n');
    out = gitFlow.runSafeGitStage({
      repoPath: branchRepo.dir,
      gitCommand: branchRepo.git,
      gitPermissions: { allow_commit: true, allow_push: true, allowed_branch: 'release' },
      missionId: 'mission_a',
      roadmapId: 'roadmap_a',
      milestoneId: 'm1',
      attempt: 2,
      objective: 'Branch',
      allowedFiles: ['a.txt']
    });
    assert.equal(out.reason, 'GIT_BRANCH_NOT_ALLOWED');
    branchRepo.cleanup();
    const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'adapters', 'git-flow.js'), 'utf8');
    assert.doesNotMatch(source, /add',\s*'--all|add",\s*"--all|add',\s*'-A|add',\s*'\.'/);
    assert.doesNotMatch(source, /'pull'|'merge'|'rebase'|'checkout'|'switch'|--force/);
    assert.match(source, /'push', 'origin', `HEAD:\$\{branch\}`/);
  } finally {
    repo.cleanup();
  }
});

test('Git failure classifier separates remediable auth from remote divergence', () => {
  assert.deepEqual(gitFlow.classifyGitFailure('git push', 'Authentication failed').action, 'NEED_HUMAN_ACTION');
  assert.equal(gitFlow.classifyGitFailure('git push', 'Permission denied to repository').reason, 'GIT_REMOTE_PERMISSION');
  assert.deepEqual(gitFlow.classifyGitFailure('git push', 'rejected non-fast-forward').action, 'BLOCKED');
});
