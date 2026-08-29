const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  completeVerificationBrainRun,
  completeGitStageExecutionRun,
  continueRoadmapAfterComplete
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
  constructor({ onSet = null } = {}) { this.collections = {}; this.n = {}; this.onSet = onSet; }
  collection(c) { if (!this.collections[c]) this.collections[c] = {}; return new Coll(this, c); }
  next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) {
    if (!this.collections[c]) this.collections[c] = {};
    const prior = this.collections[c][id] || {};
    this.collections[c][id] = o.merge ? { ...prior, ...d } : { ...d };
    this.onSet?.(c, id, d, o, this);
  }
  update(c, id, d) { if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND'); this.set(c, id, d, { merge: true }); }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, c) { return Object.values(db.collections[c] || {}); }
function brainRuns(db, phase = null) {
  return values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN' && (!phase || run.autopilot_phase === phase));
}
function tasks(db, phase = null) {
  return values(db, 'tasks').filter((task) => !phase || task.autopilot_phase === phase);
}
function milestone(db, id, roadmapId = 'roadmap_a') {
  return db.get('roadmaps', roadmapId).milestones.find((item) => item.id === id);
}

function seed(db, {
  roadmap = {},
  mission = {},
  run = {},
  project = {},
  milestones = null,
  tenant = 'tenant_a',
  git = false
} = {}) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: tenant,
    workspace_id: 'workspace_a',
    local_path: 'C:/repo',
    default_worker_id: 'W01',
    runtime_context: { git_automation_enabled: git },
    ...project
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: tenant, state: 'IDLE' });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: tenant,
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    auto_advance: true,
    milestones: milestones || [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
      { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'] }
    ],
    ...roadmap
  });
  db.set('missions', 'mission_m1', {
    id: 'mission_m1',
    tenant_id: tenant,
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    state: 'RUNNING',
    autopilot_mode: true,
    autopilot_phase: 'VERIFYING',
    autopilot_attempt_count: 1,
    autopilot_max_attempts: 3,
    git_automation_enabled: git,
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    current_task_id: git ? 'program_task' : null,
    ...mission
  });
  if (git) {
    db.set('tasks', 'program_task', {
      id: 'program_task',
      tenant_id: tenant,
      mission_id: 'mission_m1',
      state: 'DONE',
      task_spec: {
        objective: 'Verified work',
        allowed_files: ['src/services/autopilot.js'],
        required_tests: ['node --test test/autopilot-completion-trigger-v2.test.js']
      }
    });
  }
  db.set('runs', 'verify_m1', {
    id: 'verify_m1',
    tenant_id: tenant,
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_m1',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    autopilot_phase: 'VERIFY_EXECUTION',
    ...run
  });
}

function decision(action, extra = {}) {
  return `<MRAPI_AUTOPILOT>${JSON.stringify({ action, reason: 'test', ...extra })}</MRAPI_AUTOPILOT>`;
}

async function complete(db, action = 'COMPLETE') {
  return completeVerificationBrainRun(db, 'tenant_a', 'verify_m1', { output_text: decision(action, action === 'RETRY' ? {
      execution_spec: {
        instructions: 'fix',
        allowed_files: ['src/services/autopilot.js'],
        required_tests: ['node --test test/autopilot-completion-trigger-v2.test.js'],
        success_criteria: ['required test passes'],
        stop_conditions: ['do not deploy']
      }
  } : {}) });
}

async function finishGit(db, runId = 'git_run') {
  return completeGitStageExecutionRun(db, 'tenant_a', runId, {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: false, commit_sha: 'abc123' } }
  });
}

test('A. persisted trusted COMPLETE with auto_advance=true starts exactly one next eligible milestone', async () => {
  const db = new DB(); seed(db);
  const out = await complete(db);
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(milestone(db, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, 'm2').state, 'PLANNING');
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(brainRuns(db, 'PROGRAM').length, 1);
});

test('B. autopilot_enabled=true alias enables continuation when auto_advance is undefined', async () => {
  const db = new DB(); seed(db, { roadmap: { auto_advance: undefined, autopilot_enabled: true } });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(values(db, 'missions').length, 2);
});

test('C. COMPLETE is persisted before next milestone Mission creation is attempted', async () => {
  const observations = [];
  const db = new DB({ onSet(c, id, d, o, store) {
    if (c === 'missions' && id !== 'mission_m1') {
      observations.push(milestone(store, 'm1')?.state);
    }
  } });
  seed(db);
  await complete(db);
  assert.ok(observations.length >= 1);
  assert.ok(observations.every((state) => state === 'COMPLETED'));
});

test('D. continuation helper delegates next work creation through startNextRoadmapMilestone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/services/autopilot.js'), 'utf8');
  const helper = source.slice(
    source.indexOf('async function continueRoadmapAfterComplete'),
    source.indexOf('function milestoneWithHumanAction')
  );
  assert.match(helper, /await startNextRoadmapMilestone\(/);
  assert.doesNotMatch(helper, /tx\.set\(missionRef/);
  assert.doesNotMatch(helper, /tx\.set\(runRef/);
});

test('E. disabled Autopilot persists COMPLETE but creates no next Mission, Run, or Task', async () => {
  const db = new DB(); seed(db, { roadmap: { auto_advance: false, autopilot_enabled: true } });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'DISABLED');
  assert.equal(milestone(db, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, 'm2').state, 'PENDING');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(brainRuns(db, 'PROGRAM').length, 0);
  assert.equal(tasks(db).length, 0);
});

test('F/G/H. RETRY, BLOCKED, and NEED_HUMAN_ACTION create no next milestone work', async () => {
  for (const action of ['RETRY', 'BLOCKED', 'NEED_HUMAN_ACTION']) {
    const db = new DB(); seed(db);
    const extra = action === 'RETRY' ? {
      execution_spec: {
        instructions: 'fix',
        allowed_files: ['src/services/autopilot.js'],
        required_tests: ['node --test test/autopilot-completion-trigger-v2.test.js'],
        success_criteria: ['required test passes'],
        stop_conditions: ['do not deploy']
      }
    } : action === 'NEED_HUMAN_ACTION' ? {
      human_action: {
        human_action_request: 'Do manual step',
        user_action: 'Confirm step',
        action_location: 'repo',
        validation_method: 'manual_confirmation'
      }
    } : {};
    const out = await completeVerificationBrainRun(db, 'tenant_a', 'verify_m1', { output_text: decision(action, extra) });
    assert.equal(out.action, action);
    assert.equal(milestone(db, 'm2').state, 'PENDING');
    assert.equal(values(db, 'missions').length, 1);
    assert.equal(brainRuns(db, 'PROGRAM').length, 0);
  }
});

test('I/J/L. Git-stage required milestones advance only after successful Git stage and replay is idempotent', async () => {
  const db = new DB(); seed(db, { git: true });
  const verified = await complete(db);
  assert.equal(verified.action, 'GIT_STAGE');
  assert.equal(verified.continuation_state, 'GIT_STAGE_PENDING');
  assert.equal(milestone(db, 'm2').state, 'PENDING');
  assert.equal(values(db, 'missions').length, 1);

  const task = tasks(db, 'GIT_STAGE')[0];
  db.set('runs', 'git_run', {
    id: 'git_run',
    tenant_id: 'tenant_a',
    run_type: 'EXECUTION_RUN',
    state: 'RUNNING',
    mission_id: 'mission_m1',
    task_id: task.id,
    worker_id: 'W01',
    autopilot_phase: 'GIT_STAGE'
  });
  const done = await finishGit(db);
  assert.equal(done.continuation_state, 'STARTED');
  assert.equal(milestone(db, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, 'm2').state, 'PLANNING');
  assert.equal(values(db, 'missions').length, 2);
  const replay = await finishGit(db);
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(brainRuns(db, 'PROGRAM').length, 1);
});

test('K/M. repeated verification COMPLETE and direct continuation reuse already-started next work', async () => {
  const db = new DB(); seed(db);
  const first = await complete(db);
  const replay = await complete(db);
  const direct = await continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1', { mission_id: 'mission_m1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(direct.continuation_state, 'ALREADY_RUNNING');
  assert.equal(replay.next_mission_id, first.next_mission_id);
  assert.equal(direct.next_mission_id, first.next_mission_id);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(brainRuns(db, 'PROGRAM').length, 1);
});

test('N/O. final milestone COMPLETE marks terminal Roadmap and replay creates no work', async () => {
  const db = new DB(); seed(db, { milestones: [
    { id: 'm1', title: 'Only', state: 'VERIFYING', order: 1, mission_id: 'mission_m1' }
  ] });
  const out = await complete(db);
  const replay = await complete(db);
  assert.equal(out.continuation_state, 'ROADMAP_COMPLETED');
  assert.equal(replay.continuation_state, 'ROADMAP_COMPLETED');
  assert.equal(db.get('roadmaps', 'roadmap_a').state, 'COMPLETED');
  assert.equal(values(db, 'missions').length, 1);
});

test('P/Q. incomplete ineligible or dependency-blocked later milestones do not falsely complete or start', async () => {
  const blockedState = new DB(); seed(blockedState, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, mission_id: 'mission_m1' },
    { id: 'm2', title: 'Blocked later', state: 'BLOCKED', order: 2, depends_on: ['m1'] }
  ] });
  const blockedOut = await complete(blockedState);
  assert.equal(blockedOut.continuation_state, 'NO_ELIGIBLE_MILESTONE');
  assert.equal(blockedState.get('roadmaps', 'roadmap_a').state, 'ACTIVE');

  const dependencyBlocked = new DB(); seed(dependencyBlocked, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['missing'] }
  ] });
  const depOut = await complete(dependencyBlocked);
  assert.equal(depOut.continuation_state, 'NO_ELIGIBLE_MILESTONE');
  assert.equal(values(dependencyBlocked, 'missions').length, 1);
});

test('R/S. provenance mismatch fails closed and completed mission_id is preserved', async () => {
  const db = new DB(); seed(db);
  await complete(db);
  db.set('missions', 'wrong_mission', {
    id: 'wrong_mission',
    tenant_id: 'tenant_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2',
    state: 'RUNNING'
  });
  const beforeMissionId = milestone(db, 'm1').mission_id;
  const beforeCount = values(db, 'missions').length;
  const out = await continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1', { mission_id: 'wrong_mission' });
  assert.equal(out.continuation_state, 'DENIED');
  assert.equal(values(db, 'missions').length, beforeCount);
  assert.equal(milestone(db, 'm1').mission_id, beforeMissionId);
});

test('T. normal COMPLETE result distinguishes STARTED, DISABLED, and ROADMAP_COMPLETED', async () => {
  const startedDb = new DB(); seed(startedDb);
  const started = await complete(startedDb);
  assert.equal(started.continuation_state, 'STARTED');
  assert.ok(started.next_mission_id);

  const disabledDb = new DB(); seed(disabledDb, { roadmap: { auto_advance: false } });
  const disabled = await complete(disabledDb);
  assert.equal(disabled.continuation_state, 'DISABLED');
  assert.equal(disabled.next_mission_id, null);

  const terminalDb = new DB(); seed(terminalDb, { milestones: [
    { id: 'm1', title: 'Only', state: 'VERIFYING', order: 1, mission_id: 'mission_m1' }
  ] });
  const terminal = await complete(terminalDb);
  assert.equal(terminal.continuation_state, 'ROADMAP_COMPLETED');
  assert.equal(terminal.next_mission_id, null);
});
