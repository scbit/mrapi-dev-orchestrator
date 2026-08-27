const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gitFlow = require('../runner/adapters/git-flow');
const { claimNextTask, completeBrainRun, completeRun } = require('../src/services/orchestration');
const { completeVerificationBrainRun, confirmHumanActionReady } = require('../src/services/autopilot');

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
function checkpoint(db, index = 1) { return db.get('roadmaps', 'roadmap_a').milestones[index].human_action_checkpoint; }
function hostValidations(db) { return values(db, 'host_validations'); }
function workCounts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}
function mutationCounts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function gitRepo(t) {
  const git = gitFlow.resolveGitCommand();
  if (!git) {
    t.skip('Git command is not available in this environment.');
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-human-action-repo-'));
  const run = (args) => spawnSync(git, args, { cwd: dir, encoding: 'utf8' });
  assert.equal(run(['init', '-b', 'main']).status, 0);
  assert.equal(run(['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(run(['config', 'user.name', 'MRAPI Test']).status, 0);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'clean\n');
  assert.equal(run(['add', '--', 'tracked.txt']).status, 0);
  assert.equal(run(['commit', '-m', 'initial']).status, 0);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir };
}

function seedProgram(db, overrides = {}) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    default_worker_id: 'W01',
    ...(overrides.project || {})
  });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    proposal_type: 'PLANNER_ROADMAP',
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    milestones: [
      { id: 'm0', title: 'Done', state: 'COMPLETED', order: 1, depends_on: [] },
      { id: 'm1', title: 'Current', state: 'PLANNING', order: 2, depends_on: ['m0'], ...(overrides.milestone || {}) }
    ]
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    state: 'PLANNING',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    autopilot_attempt_count: 7,
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    ...(overrides.mission || {})
  });
  db.set('executors', 'executor_a', {
    id: 'executor_a',
    tenant_id: 'tenant_a',
    worker_ids: ['W01'],
    host_name: 'shadow-test',
    state: 'ONLINE'
  });
  db.set('runs', 'brain_a', {
    id: 'brain_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  });
}

function programOutput(extraSpec = {}) {
  return `<MRAPI_CONTROL>${JSON.stringify({
    requires_execution: true,
    execution_type: 'EXECUTOR',
    task_spec: {
      title: 'Do work',
      objective: 'Do work',
      instructions: 'Apply the bounded change.',
      allowed_files: ['src/services/autopilot.js'],
      required_tests: ['node --test test/autopilot-human-action-resume.test.js'],
      ...extraSpec
    }
  })}</MRAPI_CONTROL>`;
}

function dirtyBeforeExecutionDecision() {
  return '<MRAPI_AUTOPILOT>' + JSON.stringify({
    action: 'NEED_HUMAN_ACTION',
    reason: 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION',
    human_action: {
      checkpoint_type: 'PROGRAM_PREFLIGHT',
      requirement_type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo', repository_identity: 'org/repo' },
      blocker_code: 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION',
      requirement_key: 'MANUAL_HUMAN:repository_dirty'
    },
    execution_spec: null
  }) + '</MRAPI_AUTOPILOT>';
}

async function pauseWith(db, extraSpec) {
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput(extraSpec) });
  assert.equal(out.action, 'NEED_HUMAN_ACTION');
  return checkpoint(db);
}

async function hostValidationScenario(db) {
  seedProgram(db, { project: { local_path: 'C:/trusted/repo' } });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo' }
    }]
  });
  const dispatched = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  const claim = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  return { cp, dispatched, claim };
}

test('missing env var LISTO keeps same checkpoint and creates no work', async () => {
  const old = process.env.MRAPI_LISTO_SECRET;
  delete process.env.MRAPI_LISTO_SECRET;
  try {
    const db = new DB(); seedProgram(db);
    const cp = await pauseWith(db, { required_env_vars: ['MRAPI_LISTO_SECRET'] });
    const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
    assert.equal(out.resumed, false);
    assert.equal(out.checkpoint_id, cp.checkpoint_id);
    assert.equal(checkpoint(db).checkpoint_id, cp.checkpoint_id);
    assert.equal(db.get('missions', 'mission_a').state, 'NEED_HUMAN_ACTION');
    assert.equal(values(db, 'tasks').length, 0);
    assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
  } finally {
    if (old === undefined) delete process.env.MRAPI_LISTO_SECRET;
    else process.env.MRAPI_LISTO_SECRET = old;
  }
});

test('env var present resolves checkpoint and resumes same Mission without persisting value', async () => {
  const old = process.env.MRAPI_LISTO_SECRET;
  delete process.env.MRAPI_LISTO_SECRET;
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { required_env_vars: ['MRAPI_LISTO_SECRET'] });
  process.env.MRAPI_LISTO_SECRET = 'must-not-leak';
  try {
    const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
    assert.equal(out.resumed, true);
    assert.equal(out.roadmap_id, 'roadmap_a');
    assert.equal(out.milestone_id, 'm1');
    assert.equal(out.mission_id, 'mission_a');
    assert.equal(checkpoint(db).status, 'RESOLVED');
    assert.equal(JSON.stringify(db.collections).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(out).includes('must-not-leak'), false);
    assert.equal(values(db, 'tasks').length, 1);
  } finally {
    if (old === undefined) delete process.env.MRAPI_LISTO_SECRET;
    else process.env.MRAPI_LISTO_SECRET = old;
  }
});

test('repository local path checkpoint resolves only after structured project path is configured', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { requires_repository: true });
  const fail = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(fail.resumed, false);
  db.set('projects', 'project_a', { runtime_context: { repository_path: 'C:/repo' } }, { merge: true });
  const pass = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(pass.resumed, true);
  assert.equal(values(db, 'tasks').length, 1);
});

test('HOST_LOCAL repository-clean LISTO dispatches one checkpoint-linked validation item', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/trusted/repo', repository_full_name: 'org/repo' } });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo', repository_full_name: 'org/repo' }
    }]
  });
  const before = workCounts(db);
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(out.resumed, false);
  assert.equal(out.state, 'HOST_VALIDATION_PENDING');
  assert.equal(out.roadmap_id, 'roadmap_a');
  assert.equal(out.milestone_id, 'm1');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(out.checkpoint_id, cp.checkpoint_id);
  assert.equal(checkpoint(db).status, 'WAITING_FOR_HUMAN');
  assert.deepEqual(workCounts(db), before);
  assert.equal(hostValidations(db).length, 1);
  assert.equal(hostValidations(db)[0].tenant_id, 'tenant_a');
  assert.equal(hostValidations(db)[0].roadmap_id, 'roadmap_a');
  assert.equal(hostValidations(db)[0].milestone_id, 'm1');
  assert.equal(hostValidations(db)[0].mission_id, 'mission_a');
  assert.equal(hostValidations(db)[0].checkpoint_id, cp.checkpoint_id);
  assert.equal(hostValidations(db)[0].validator, 'git_worktree_clean');
  assert.equal(hostValidations(db)[0].repository_path, 'C:/trusted/repo');

  const replay = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(replay.host_validation_id, out.host_validation_id);
  assert.equal(replay.reused, true);
  assert.equal(hostValidations(db).length, 1);
  assert.deepEqual(workCounts(db), before);
});

test('HOST_LOCAL PASS result resolves checkpoint and resumes same Mission once', async () => {
  const db = new DB();
  const { cp, dispatched, claim } = await hostValidationScenario(db);
  assert.equal(claim.work_type, 'HOST_VALIDATION');
  assert.equal(claim.host_validation.id, dispatched.host_validation_id);
  const before = workCounts(db);
  const missionCount = values(db, 'missions').length;
  const out = await completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: {
      validation_id: claim.host_validation.id,
      checkpoint_id: cp.checkpoint_id,
      validator: 'git_worktree_clean',
      status: 'PASS',
      safe_message: 'Repository worktree is clean.',
      validation_result_id: 'result_pass_1'
    }
  });
  assert.equal(out.resumed, true);
  assert.equal(out.roadmap_id, 'roadmap_a');
  assert.equal(out.milestone_id, 'm1');
  assert.equal(out.mission_id, 'mission_a');
  const resolved = checkpoint(db);
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.roadmap_id, 'roadmap_a');
  assert.equal(resolved.milestone_id, 'm1');
  assert.equal(resolved.mission_id, 'mission_a');
  assert.equal(resolved.checkpoint_id, cp.checkpoint_id);
  assert.equal(resolved.validation_result.validation_id, claim.host_validation.id);
  assert.equal(resolved.validation_result.run_id, claim.run.id);
  assert.equal(resolved.validation_result.result_id, 'result_pass_1');
  assert.equal(db.get('host_validations', claim.host_validation.id).status, 'PASS');
  assert.equal(db.get('runs', claim.run.id).state, 'COMPLETED');
  assert.equal(values(db, 'missions').length, missionCount);
  assert.deepEqual(workCounts(db), { ...before, tasks: before.tasks + 1 });

  const replay = await completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: { validation_result_id: 'result_pass_1' }
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.task_id, out.task_id);
  assert.deepEqual(workCounts(db), { ...before, tasks: before.tasks + 1 });
});

test('resolved PROGRAM checkpoint without continuation task recovers same Mission and is replay-idempotent', async () => {
  const db = new DB();
  seedProgram(db, {
    project: { local_path: 'C:/trusted/repo', repository_full_name: 'org/repo' },
    milestone: { id: 'm2' },
    mission: { milestone_id: 'm2' }
  });
  db.set('runs', 'brain_a', { milestone_id: 'm2' }, { merge: true });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      name: 'repository_dirty',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo', repository_identity: 'org/repo' }
    }]
  });
  const resolvedCheckpoint = {
    ...cp,
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    human_action_required: true,
    continuation_task_id: null,
    validation_result: {
      ok: true,
      validation_id: 'host_validation_v6',
      run_id: 'host_validation_run_v6',
      result_id: 'host_validation_pass_v6',
      message: 'Repository worktree is clean.'
    }
  };
  db.set('roadmaps', 'roadmap_a', {
    milestones: [
      db.get('roadmaps', 'roadmap_a').milestones[0],
      {
        ...db.get('roadmaps', 'roadmap_a').milestones[1],
        state: 'NEED_HUMAN_ACTION',
        human_action_required: false,
        human_action_checkpoint: resolvedCheckpoint,
        waiting_status: 'RESOLVED'
      }
    ]
  }, { merge: true });
  db.set('missions', 'mission_a', {
    state: 'NEED_HUMAN_ACTION',
    autopilot_phase: 'NEED_HUMAN_ACTION',
    human_action_required: false,
    current_task_id: null,
    human_action_checkpoint: resolvedCheckpoint
  }, { merge: true });
  assert.equal(values(db, 'tasks').length, 0);

  const recovered = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.roadmap_id, 'roadmap_a');
  assert.equal(recovered.milestone_id, 'm2');
  assert.equal(recovered.mission_id, 'mission_a');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(values(db, 'tasks')[0].mission_id, 'mission_a');
  assert.equal(values(db, 'tasks')[0].brain_run_id, 'brain_a');
  assert.equal(values(db, 'tasks')[0].human_action_checkpoint_id, cp.checkpoint_id);
  assert.equal(db.get('missions', 'mission_a').state, 'PLANNING');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'PROGRAM');
  assert.equal(db.get('missions', 'mission_a').human_action_required, false);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'RUNNING');
  assert.equal(checkpoint(db).status, 'RESOLVED');
  assert.equal(checkpoint(db).continuation_task_id, recovered.task_id);

  const afterRecovery = workCounts(db);
  const replay = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(replay.reused, true);
  assert.equal(replay.task_id, recovered.task_id);
  assert.deepEqual(workCounts(db), afterRecovery);
  assert.equal(values(db, 'tasks').length, 1);
});

test('runner next-task recovers resolved PROGRAM checkpoint without continuation task before returning no work', async () => {
  const db = new DB();
  seedProgram(db, { project: { local_path: 'C:/trusted/repo', repository_full_name: 'org/repo' } });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      name: 'repository_dirty',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo', repository_identity: 'org/repo' }
    }]
  });
  const resolvedCheckpoint = {
    ...cp,
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    human_action_required: false,
    brain_run_id: null,
    continuation_task_id: null,
    validation_result: {
      ok: true,
      validation_id: 'host_validation_v7',
      run_id: 'host_validation_run_v7',
      result_id: 'host_validation_pass_v7',
      message: 'Repository worktree is clean.'
    }
  };
  db.set('roadmaps', 'roadmap_a', {
    milestones: [
      db.get('roadmaps', 'roadmap_a').milestones[0],
      {
        ...db.get('roadmaps', 'roadmap_a').milestones[1],
        state: 'RUNNING',
        brain_run_id: null,
        human_action_required: false,
        human_action_checkpoint: resolvedCheckpoint,
        waiting_status: 'RESOLVED'
      }
    ]
  }, { merge: true });
  db.set('missions', 'mission_a', {
    state: 'PLANNING',
    autopilot_phase: 'PROGRAM',
    brain_run_id: null,
    human_action_required: false,
    current_task_id: null,
    human_action_checkpoint: resolvedCheckpoint
  }, { merge: true });
  assert.equal(values(db, 'tasks').length, 0);

  const claimed = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  assert.equal(claimed.run.run_type, 'EXECUTION_RUN');
  assert.equal(claimed.task.mission_id, 'mission_a');
  assert.equal(claimed.task.brain_run_id, 'brain_a');
  assert.equal(claimed.task.human_action_checkpoint_id, cp.checkpoint_id);
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(checkpoint(db).status, 'RESOLVED');
  assert.equal(checkpoint(db).human_action_required, false);
  assert.equal(checkpoint(db).continuation_task_id, claimed.task.id);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'RUNNING');

  db.set('workers', 'W01', { state: 'IDLE', current_mission_id: null, current_task_id: null }, { merge: true });
  db.set('tasks', claimed.task.id, { state: 'QUEUED', phase: 'EXECUTION_PENDING', current_run_id: null, execution_run_id: null, claimed_by_executor_id: null }, { merge: true });
  const beforeReplay = workCounts(db);
  const replay = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  assert.equal(replay.task.id, claimed.task.id);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(workCounts(db).tasks, beforeReplay.tasks);
});

test('HOST_LOCAL PASS resolves original PROGRAM Brain Run from trusted provenance when checkpoint lacks brain_run_id', async () => {
  const db = new DB();
  const { cp, claim } = await hostValidationScenario(db);
  const checkpointWithoutBrainRun = { ...checkpoint(db), brain_run_id: null };
  db.set('roadmaps', 'roadmap_a', {
    milestones: [
      db.get('roadmaps', 'roadmap_a').milestones[0],
      {
        ...db.get('roadmaps', 'roadmap_a').milestones[1],
        brain_run_id: null,
        human_action_checkpoint: checkpointWithoutBrainRun
      }
    ]
  }, { merge: true });
  db.set('missions', 'mission_a', {
    brain_run_id: null,
    human_action_checkpoint: checkpointWithoutBrainRun
  }, { merge: true });
  const before = workCounts(db);

  const out = await completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: {
      validation_id: claim.host_validation.id,
      checkpoint_id: cp.checkpoint_id,
      validator: 'git_worktree_clean',
      status: 'PASS',
      safe_message: 'Repository worktree is clean.',
      validation_result_id: 'result_pass_missing_brain'
    }
  });
  assert.equal(out.resumed, true);
  assert.equal(out.brain_run_id, 'brain_a');
  assert.equal(out.roadmap_id, 'roadmap_a');
  assert.equal(out.milestone_id, 'm1');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(values(db, 'tasks').length, before.tasks + 1);
  assert.equal(values(db, 'tasks')[0].mission_id, 'mission_a');
  assert.equal(values(db, 'tasks')[0].brain_run_id, 'brain_a');
  assert.equal(checkpoint(db).status, 'RESOLVED');
  assert.equal(checkpoint(db).brain_run_id, 'brain_a');
  assert.equal(checkpoint(db).continuation_task_id, out.task_id);

  const afterPass = workCounts(db);
  const replay = await completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: { validation_result_id: 'result_pass_missing_brain' }
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.task_id, out.task_id);
  assert.deepEqual(workCounts(db), afterPass);
});

async function dirtyResumeScenario({ failCheckpoint2 = false } = {}) {
  const db = new DB();
  seedProgram(db, { project: { local_path: 'C:/trusted/repo', repository_full_name: 'org/repo' } });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
  const cp1 = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      name: 'repository_dirty',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo', repository_identity: 'org/repo' }
    }]
  });
  await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp1.checkpoint_id, { ready: true });
  const cp1Validation = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  const pass1 = await completeRun(db, 'tenant_a', cp1Validation.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: {
      validation_id: cp1Validation.host_validation.id,
      checkpoint_id: cp1.checkpoint_id,
      validator: 'git_worktree_clean',
      status: 'PASS',
      safe_message: 'Repository worktree is clean.',
      validation_result_id: 'cp1_pass'
    }
  });
  assert.equal(pass1.resumed, true);
  assert.equal(pass1.mission_id, 'mission_a');
  assert.equal(checkpoint(db).checkpoint_id, cp1.checkpoint_id);
  assert.equal(checkpoint(db).status, 'RESOLVED');
  const resolvedCp1 = { ...checkpoint(db) };

  const continuationTaskId = pass1.task_id;
  const resumedClaim = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  assert.equal(resumedClaim.task.id, continuationTaskId);
  const failedExecution = await completeRun(db, 'tenant_a', resumedClaim.run.id, {
    success: false,
    summary: 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION',
    error: 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION',
    output: {
      error_code: 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION',
      safe_message: 'Repository worktree is dirty before execution.'
    }
  });
  const verifyRunId = failedExecution.autopilot_verification.verification_run_id;
  const beforeNewCheckpoint = workCounts(db);
  const needHuman = await completeVerificationBrainRun(db, 'tenant_a', verifyRunId, {
    output_text: dirtyBeforeExecutionDecision()
  });
  const cp2 = checkpoint(db);
  assert.equal(needHuman.action, 'NEED_HUMAN_ACTION');
  assert.notEqual(cp2.checkpoint_id, cp1.checkpoint_id);
  assert.equal(cp2.status, 'WAITING_FOR_HUMAN');
  assert.equal(cp2.tenant_id, 'tenant_a');
  assert.equal(cp2.roadmap_id, cp1.roadmap_id);
  assert.equal(cp2.milestone_id, cp1.milestone_id);
  assert.equal(cp2.mission_id, cp1.mission_id);
  assert.equal(cp2.validation_method, 'git_worktree_clean');
  assert.equal(cp2.validation_metadata.repository_path, 'C:/trusted/repo');
  assert.equal(cp2.validation_metadata.repository_identity, 'org/repo');
  assert.equal(cp2.parent_checkpoint_id, cp1.checkpoint_id);
  assert.equal(cp2.generation, 2);
  assert.equal(resolvedCp1.status, 'RESOLVED');

  db.set('runs', 'verify_replay', { ...db.get('runs', verifyRunId), id: 'verify_replay', state: 'RUNNING' });
  const replay = await completeVerificationBrainRun(db, 'tenant_a', 'verify_replay', {
    output_text: dirtyBeforeExecutionDecision()
  });
  assert.equal(replay.checkpoint_id, cp2.checkpoint_id);
  assert.equal(checkpoint(db).checkpoint_id, cp2.checkpoint_id);
  assert.deepEqual(workCounts(db), { ...beforeNewCheckpoint, brainRuns: beforeNewCheckpoint.brainRuns + 1 });

  await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp2.checkpoint_id, { ready: true });
  const cp2Validation = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  const beforeCp2Result = workCounts(db);
  const cp2Result = await completeRun(db, 'tenant_a', cp2Validation.run.id, {
    success: !failCheckpoint2,
    summary: failCheckpoint2 ? 'Repository worktree remains dirty.' : 'Repository worktree is clean.',
    output: {
      validation_id: cp2Validation.host_validation.id,
      checkpoint_id: cp2.checkpoint_id,
      validator: 'git_worktree_clean',
      status: failCheckpoint2 ? 'FAIL' : 'PASS',
      safe_message: failCheckpoint2 ? 'Repository worktree remains dirty.' : 'Repository worktree is clean.',
      validation_result_id: failCheckpoint2 ? 'cp2_fail' : 'cp2_pass'
    }
  });
  return { db, cp1: resolvedCp1, cp2, cp2Result, beforeCp2Result, cp2Validation, continuationTaskId };
}

test('post-resume dirty pre-execution re-arms a new current HOST_LOCAL checkpoint for the same Mission', async () => {
  const { db, cp1, cp2, cp2Result, beforeCp2Result, cp2Validation, continuationTaskId } = await dirtyResumeScenario();
  assert.equal(cp2Result.resumed, true);
  assert.equal(cp2Result.state, 'VERIFYING');
  assert.equal(cp2Result.mission_id, 'mission_a');
  assert.equal(cp2Result.checkpoint_id, cp2.checkpoint_id);
  assert.equal(checkpoint(db).checkpoint_id, cp2.checkpoint_id);
  assert.equal(checkpoint(db).status, 'RESOLVED');
  assert.equal(checkpoint(db).parent_checkpoint_id, cp1.checkpoint_id);
  assert.equal(db.get('missions', 'mission_a').state, 'RUNNING');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'VERIFYING');
  assert.equal(db.get('missions', 'mission_a').current_task_id, continuationTaskId);
  assert.equal(values(db, 'missions').length, 1);
  assert.deepEqual(workCounts(db), beforeCp2Result);

  const replayPass = await completeRun(db, 'tenant_a', cp2Validation.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: { validation_result_id: 'cp2_pass' }
  });
  assert.equal(replayPass.reused, true);
  assert.equal(replayPass.task_id, continuationTaskId);
  assert.deepEqual(workCounts(db), beforeCp2Result);
});

test('post-resume dirty pre-execution checkpoint FAIL keeps checkpoint2 waiting and checkpoint1 resolved', async () => {
  const { db, cp1, cp2, cp2Result, beforeCp2Result } = await dirtyResumeScenario({ failCheckpoint2: true });
  assert.equal(cp2Result.resumed, false);
  assert.equal(cp2Result.checkpoint_id, cp2.checkpoint_id);
  assert.equal(checkpoint(db).checkpoint_id, cp2.checkpoint_id);
  assert.equal(checkpoint(db).status, 'WAITING_FOR_HUMAN');
  assert.equal(checkpoint(db).parent_checkpoint_id, cp1.checkpoint_id);
  assert.equal(cp1.status, 'RESOLVED');
  assert.equal(values(db, 'missions').length, 1);
  assert.deepEqual(workCounts(db), beforeCp2Result);
});

test('HOST_LOCAL FAIL result keeps same checkpoint unresolved and creates no business work', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/trusted/repo' } });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree.',
      user_action: 'Commit, stash, or remove local changes, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo' }
    }]
  });
  await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  const claim = await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  const before = workCounts(db);
  const out = await completeRun(db, 'tenant_a', claim.run.id, {
    success: false,
    summary: 'Repository worktree remains dirty.',
    output: {
      validation_id: claim.host_validation.id,
      checkpoint_id: cp.checkpoint_id,
      validator: 'git_worktree_clean',
      status: 'FAIL',
      safe_message: 'Repository worktree remains dirty.',
      diagnostics: { porcelain_line_count: 1 },
      validation_result_id: 'result_fail_1'
    }
  });
  assert.equal(out.resumed, false);
  assert.equal(out.checkpoint_id, cp.checkpoint_id);
  assert.equal(checkpoint(db).checkpoint_id, cp.checkpoint_id);
  assert.equal(checkpoint(db).status, 'WAITING_FOR_HUMAN');
  assert.equal(db.get('missions', 'mission_a').state, 'NEED_HUMAN_ACTION');
  assert.match(out.message, /worktree remains dirty/i);
  assert.match(checkpoint(db).last_validation_message, /worktree remains dirty/i);
  assert.equal(db.get('host_validations', claim.host_validation.id).status, 'FAIL');
  assert.equal(db.get('runs', claim.run.id).state, 'FAILED');
  assert.deepEqual(workCounts(db), before);

  const replay = await completeRun(db, 'tenant_a', claim.run.id, {
    success: false,
    summary: 'Repository worktree remains dirty.',
    output: { validation_result_id: 'result_fail_1' }
  });
  assert.equal(replay.reused, true);
  assert.deepEqual(workCounts(db), before);

  const next = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.notEqual(next.host_validation_id, claim.host_validation.id);
  assert.equal(hostValidations(db).length, 2);
});

test('HOST_LOCAL tenant mismatch and wrong checkpoint result are rejected without mutation', async () => {
  const db = new DB();
  const { cp, claim } = await hostValidationScenario(db);
  const beforeTenantMismatch = JSON.stringify(db.collections);
  await assert.rejects(() => completeRun(db, 'tenant_b', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: { validation_result_id: 'wrong_tenant' }
  }), /RUN_NOT_FOUND/);
  assert.equal(JSON.stringify(db.collections), beforeTenantMismatch);

  const beforeWrongCheckpoint = JSON.stringify(db.collections);
  await assert.rejects(() => completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Repository worktree is clean.',
    output: { checkpoint_id: 'other_checkpoint', validation_result_id: 'wrong_checkpoint' }
  }), /HOST_VALIDATION_RESULT_CHECKPOINT_MISMATCH/);
  assert.equal(JSON.stringify(db.collections), beforeWrongCheckpoint);
});

test('HOST_LOCAL rejects wrong validation, run linkage, and continuity identity before mutation', async () => {
  {
    const db = new DB();
    const { claim } = await hostValidationScenario(db);
    const before = JSON.stringify(db.collections);
    await assert.rejects(() => completeRun(db, 'tenant_a', claim.run.id, {
      success: true,
      summary: 'Repository worktree is clean.',
      output: { validation_id: 'other_validation', validation_result_id: 'wrong_validation' }
    }), /HOST_VALIDATION_RESULT_ID_MISMATCH/);
    assert.equal(JSON.stringify(db.collections), before);
  }

  {
    const db = new DB();
    const { claim } = await hostValidationScenario(db);
    const beforeCounts = mutationCounts(db);
    const beforeRoadmap = JSON.stringify(db.get('roadmaps', 'roadmap_a'));
    const beforeMission = JSON.stringify(db.get('missions', 'mission_a'));
    db.set('runs', claim.run.id, { host_validation_id: 'other_validation' }, { merge: true });
    await assert.rejects(() => completeRun(db, 'tenant_a', claim.run.id, {
      success: true,
      summary: 'Repository worktree is clean.',
      output: { validation_result_id: 'wrong_run_link' }
    }), /HOST_VALIDATION_NOT_FOUND|HOST_VALIDATION_RUN_PROVENANCE_INVALID/);
    assert.deepEqual(mutationCounts(db), beforeCounts);
    assert.equal(JSON.stringify(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
    assert.equal(JSON.stringify(db.get('missions', 'mission_a')), beforeMission);
  }

  for (const [field, error] of [
    ['mission_id', /MISSION_NOT_FOUND|HOST_VALIDATION_CHECKPOINT_PROVENANCE_INVALID/],
    ['roadmap_id', /ROADMAP_NOT_FOUND|HOST_VALIDATION_CHECKPOINT_PROVENANCE_INVALID/],
    ['milestone_id', /HOST_VALIDATION_RUN_PROVENANCE_INVALID|HOST_VALIDATION_CHECKPOINT_PROVENANCE_INVALID/]
  ]) {
    const db = new DB();
    const { claim } = await hostValidationScenario(db);
    const beforeCounts = mutationCounts(db);
    const beforeRoadmap = JSON.stringify(db.get('roadmaps', 'roadmap_a'));
    const beforeMission = JSON.stringify(db.get('missions', 'mission_a'));
    db.set('host_validations', claim.host_validation.id, { [field]: `wrong_${field}` }, { merge: true });
    await assert.rejects(() => completeRun(db, 'tenant_a', claim.run.id, {
      success: true,
      summary: 'Repository worktree is clean.',
      output: { validation_result_id: `wrong_${field}` }
    }), error);
    assert.deepEqual(mutationCounts(db), beforeCounts);
    assert.equal(JSON.stringify(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
    assert.equal(JSON.stringify(db.get('missions', 'mission_a')), beforeMission);
  }
});

test('HOST_LOCAL pending and running LISTO calls reuse the same validation item', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/trusted/repo' } });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree.',
      user_action: 'Clean it.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo' }
    }]
  });
  const first = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  const second = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(second.host_validation_id, first.host_validation_id);
  await claimNextTask(db, 'tenant_a', 'executor_a', { repository_path: 'C:/trusted/repo' });
  const third = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(third.host_validation_id, first.host_validation_id);
  assert.equal(hostValidations(db).length, 1);
});

test('manual confirmation resolves only when persisted validator allows it', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { prerequisites: [{ type: 'MANUAL_HUMAN', human_action_request: 'Confirm', user_action: 'Confirm', action_location: 'operator', validation_method: 'manual_confirmation' }] });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(out.resumed, true);
  assert.equal(checkpoint(db).status, 'RESOLVED');
});

test('request validator substitution cannot replace persisted HOST_LOCAL validator', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/trusted/repo' } });
  const cp = await pauseWith(db, {
    prerequisites: [{
      type: 'MANUAL_HUMAN',
      human_action_request: 'Clean the repository worktree.',
      user_action: 'Clean it.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/trusted/repo' }
    }]
  });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, {
    ready: true,
    validation_method: 'manual_confirmation',
    validator: 'manual_confirmation'
  });
  assert.equal(out.resumed, false);
  assert.equal(out.state, 'HOST_VALIDATION_PENDING');
  assert.equal(checkpoint(db).status, 'WAITING_FOR_HUMAN');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(hostValidations(db)[0].validator, 'git_worktree_clean');
});

test('manual deploy remains unresolved because deployment identity validation is not implemented', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { prerequisites: [{ type: 'MANUAL_DEPLOY', human_action_request: 'Deploy', user_action: 'Deploy manually', action_location: 'Cloud Run', validation_method: 'manual_confirmation' }] });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(out.resumed, false);
  assert.match(out.message, /Deployment identity validation is not implemented/);
  assert.equal(checkpoint(db).status, 'WAITING_FOR_HUMAN');
  assert.equal(values(db, 'tasks').length, 0);
});

test('unsupported checkpoint type fails closed as unresolved NEED_HUMAN_ACTION', async () => {
  const db = new DB(); seedProgram(db);
  await pauseWith(db, { prerequisites: [{ type: 'MANUAL_HUMAN', human_action_request: 'Confirm', user_action: 'Confirm', action_location: 'operator', validation_method: 'manual_confirmation' }] });
  const cp = { ...checkpoint(db), status: 'WAITING_FOR_HUMAN', waiting_status: 'WAITING_FOR_HUMAN', requirement_type: 'UNKNOWN_KIND', checkpoint_type: 'UNKNOWN_KIND' };
  db.set('roadmaps', 'roadmap_a', { milestones: [{ ...db.get('roadmaps', 'roadmap_a').milestones[0] }, { ...db.get('roadmaps', 'roadmap_a').milestones[1], human_action_checkpoint: cp }] }, { merge: true });
  db.set('missions', 'mission_a', { human_action_checkpoint: cp }, { merge: true });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(out.resumed, false);
  assert.equal(db.get('missions', 'mission_a').state, 'NEED_HUMAN_ACTION');
});

test('replayed LISTO after success reuses the same continuation task and preserves audit fields', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { requires_repository: true });
  db.set('projects', 'project_a', { local_path: 'C:/repo' }, { merge: true });
  const first = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  const afterFirst = {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
  const second = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(first.task_id, second.task_id);
  assert.deepEqual({
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  }, afterFirst);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(checkpoint(db).status, 'RESOLVED');
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[0].state, 'COMPLETED');
  assert.equal(db.get('missions', 'mission_a').autopilot_attempt_count, 7);
});

test('cross-tenant LISTO is denied without persistence mutation', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { requires_repository: true });
  const before = JSON.stringify(db.collections);
  await assert.rejects(() => confirmHumanActionReady(db, 'tenant_b', 'roadmap_a', cp.checkpoint_id, { ready: true }), /PLANNER_PROPOSAL_NOT_FOUND/);
  assert.equal(JSON.stringify(db.collections), before);
});

test('stale and malformed checkpoint provenance cannot resume work', async () => {
  const staleDb = new DB(); seedProgram(staleDb);
  const cp = await pauseWith(staleDb, { requires_repository: true });
  const roadmap = staleDb.get('roadmaps', 'roadmap_a');
  const stale = { ...cp, checkpoint_id: 'old_checkpoint', requirement_type: 'MANUAL_HUMAN', validation_method: 'manual_confirmation' };
  staleDb.set('roadmaps', 'roadmap_a', { milestones: [roadmap.milestones[1], { ...roadmap.milestones[0], human_action_required: true, human_action_checkpoint: stale }] }, { merge: true });
  await assert.rejects(() => confirmHumanActionReady(staleDb, 'tenant_a', 'roadmap_a', 'old_checkpoint', { ready: true }), /HUMAN_ACTION_CHECKPOINT_STALE/);

  const malformedDb = new DB(); seedProgram(malformedDb);
  const bad = await pauseWith(malformedDb, { requires_repository: true });
  malformedDb.set('roadmaps', 'roadmap_a', {
    milestones: [malformedDb.get('roadmaps', 'roadmap_a').milestones[0], {
      ...malformedDb.get('roadmaps', 'roadmap_a').milestones[1],
      human_action_checkpoint: { ...bad, mission_id: 'other_mission' }
    }]
  }, { merge: true });
  await assert.rejects(() => confirmHumanActionReady(malformedDb, 'tenant_a', 'roadmap_a', bad.checkpoint_id, { ready: true }), /HUMAN_ACTION_CHECKPOINT_NOT_FOUND|PROVENANCE_INVALID/);
  assert.equal(values(malformedDb, 'tasks').length, 0);
});

test('VERIFY_EXECUTION-origin Human Action resumes verification without rerunning executor work or completing milestone', async () => {
  const db = new DB();
  seedProgram(db, { milestone: { state: 'VERIFYING' }, mission: { state: 'RUNNING', autopilot_phase: 'VERIFYING', current_task_id: 'task_done' } });
  db.set('tasks', 'task_done', { id: 'task_done', tenant_id: 'tenant_a', mission_id: 'mission_a', brain_run_id: 'brain_a', state: 'DONE', phase: 'COMPLETED' });
  db.set('runs', 'verify_a', { id: 'verify_a', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const valid = await completeVerificationBrainRun(db, 'tenant_a', 'verify_a', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"NEED_HUMAN_ACTION","reason":"needs approval","human_action":{"human_action_request":"Approve access","user_action":"Grant access","action_location":"settings","validation_method":"manual_confirmation","requirement_type":"MANUAL_HUMAN"},"execution_spec":null}</MRAPI_AUTOPILOT>'
  });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', valid.checkpoint_id, { ready: true });
  assert.equal(out.resumed, true);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'VERIFYING');
  assert.equal(db.get('missions', 'mission_a').autopilot_phase, 'VERIFYING');
  assert.equal(values(db, 'tasks').length, 1);
  assert.notEqual(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'COMPLETED');
});
