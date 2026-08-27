const test = require('node:test');
const assert = require('node:assert/strict');
const { completeBrainRun } = require('../src/services/orchestration');
const {
  completeVerificationBrainRun,
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
  constructor() { this.collections = {}; this.n = {}; }
  collection(c) { if (!this.collections[c]) this.collections[c] = {}; return new Coll(this, c); }
  next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) { if (!this.collections[c]) this.collections[c] = {}; this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d }; }
  update(c, id, d) { if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND'); this.collections[c][id] = { ...this.collections[c][id], ...d }; }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, c) { return Object.values(db.collections[c] || {}); }
function runs(db, phase = null) {
  return values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN' && (!phase || run.autopilot_phase === phase));
}
function tasks(db) { return values(db, 'tasks'); }
function executionRuns(db) { return values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN'); }
function milestone(db, id, roadmapId = 'roadmap_a') {
  return db.get('roadmaps', roadmapId).milestones.find((item) => item.id === id);
}

function seed(db, { autoAdvance = true, roadmapState = 'ACTIVE', milestones = null, tenant = 'tenant_a', localPath = 'C:/repo' } = {}) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: tenant,
    workspace_id: 'workspace_a',
    repository_full_name: 'stored/project',
    local_path: localPath,
    default_worker_id: 'W01'
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: tenant, state: 'IDLE' });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: tenant,
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Roadmap',
    objective: 'Ship safely',
    state: roadmapState,
    owner_worker_id: 'W01',
    auto_advance: autoAdvance,
    milestones: milestones || [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1', completed_at: 'keep-me' },
      { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'] }
    ]
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
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    brain_run_id: 'brain_m1'
  });
  db.set('runs', 'verify_m1', {
    id: 'verify_m1',
    tenant_id: tenant,
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_m1',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    autopilot_phase: 'VERIFY_EXECUTION'
  });
}

async function complete(db, runId = 'verify_m1', tenant = 'tenant_a') {
  return completeVerificationBrainRun(db, tenant, runId, {
    output_text: '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"done"}</MRAPI_AUTOPILOT>'
  });
}

test('two-milestone auto advance starts m2 with one Mission and one PROGRAM Brain Run', async () => {
  const db = new DB(); seed(db);
  const out = await complete(db);
  assert.equal(out.action, 'COMPLETE');
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(milestone(db, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, 'm2').state, 'PLANNING');
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 1);
  assert.equal(out.next_mission_id, milestone(db, 'm2').mission_id);
  assert.equal(out.next_brain_run_id, milestone(db, 'm2').brain_run_id);
});

test('three milestones progress sequentially and m3 waits for m2 COMPLETE', async () => {
  const db = new DB();
  seed(db, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'] },
    { id: 'm3', title: 'Three', state: 'PENDING', order: 3, depends_on: ['m2'] }
  ] });
  const first = await complete(db);
  assert.equal(first.next_milestone_id, 'm2');
  assert.equal(milestone(db, 'm3').state, 'PENDING');
  db.set('runs', 'verify_m2', {
    id: 'verify_m2',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: first.next_mission_id,
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2',
    autopilot_phase: 'VERIFY_EXECUTION'
  });
  db.set('missions', first.next_mission_id, { ...db.get('missions', first.next_mission_id), state: 'RUNNING', autopilot_phase: 'VERIFYING' });
  db.set('roadmaps', 'roadmap_a', {
    ...db.get('roadmaps', 'roadmap_a'),
    milestones: db.get('roadmaps', 'roadmap_a').milestones.map((item) => item.id === 'm2' ? { ...item, state: 'VERIFYING' } : item)
  });
  const second = await complete(db, 'verify_m2');
  assert.equal(second.next_milestone_id, 'm3');
  assert.equal(milestone(db, 'm3').state, 'PLANNING');
});

test('auto_advance false closes current milestone without creating next work', async () => {
  const db = new DB(); seed(db, { autoAdvance: false });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'DISABLED');
  assert.equal(out.auto_advance, false);
  assert.equal(milestone(db, 'm2').state, 'PENDING');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(runs(db, 'PROGRAM').length, 0);
});

test('final milestone COMPLETE marks roadmap COMPLETED without extra work', async () => {
  const db = new DB();
  seed(db, { milestones: [{ id: 'm1', title: 'Only', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' }] });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'ROADMAP_COMPLETED');
  assert.equal(db.get('roadmaps', 'roadmap_a').state, 'COMPLETED');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(runs(db, 'PROGRAM').length, 0);
});

test('replayed COMPLETE after m2 already started creates no duplicate Mission or Brain Run', async () => {
  const db = new DB(); seed(db);
  const first = await complete(db);
  const replay = await complete(db);
  assert.equal(replay.replayed, true);
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(replay.next_mission_id, first.next_mission_id);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 1);
});

test('repeated continuation helper invocation reuses existing next Mission and Brain Run', async () => {
  const db = new DB(); seed(db);
  const first = await complete(db);
  const repeated = await continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1');
  assert.equal(repeated.continuation_state, 'ALREADY_RUNNING');
  assert.equal(repeated.next_mission_id, first.next_mission_id);
  assert.equal(repeated.next_brain_run_id, first.next_brain_run_id);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 1);
});

test('concurrent idempotent start condition leaves only one active next milestone', async () => {
  const db = new DB(); seed(db);
  await complete(db);
  await Promise.all([
    continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1'),
    continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1')
  ]);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones.filter((item) => ['PLANNING', 'RUNNING', 'VERIFYING', 'NEED_HUMAN_ACTION'].includes(item.state)).length, 1);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 1);
});

test('explicit unmet next prerequisite pauses next milestone with no Task or EXECUTION_RUN', async () => {
  const db = new DB();
  seed(db, {
    localPath: '',
    milestones: [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
      { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'], prerequisites: [{ type: 'REPOSITORY_LOCAL_PATH' }] }
    ]
  });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'NEED_HUMAN_ACTION');
  assert.equal(milestone(db, 'm2').state, 'NEED_HUMAN_ACTION');
  assert.ok(out.checkpoint_id);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 0);
  assert.equal(tasks(db).length, 0);
  assert.equal(executionRuns(db).length, 0);
});

test('auto advance consumes persisted Planner Human Action prerequisite before execution work', async () => {
  const db = new DB();
  seed(db, {
    milestones: [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
      {
        id: 'm2',
        title: 'Two',
        state: 'PENDING',
        order: 2,
        depends_on: ['m1'],
        execution_prerequisites: [{
          type: 'MANUAL_HUMAN',
          name: 'repository_clean',
          human_action_request: 'Clean the repository worktree before continuing.',
          user_action: 'Ensure the repository worktree is clean, then press LISTO.',
          action_location: 'project repository',
          validation_method: 'git_worktree_clean'
        }]
      }
    ]
  });
  const before = { tasks: tasks(db).length, executionRuns: executionRuns(db).length };

  const out = await complete(db);
  const m2 = milestone(db, 'm2');
  const mission = db.get('missions', m2.mission_id);

  assert.equal(out.continuation_state, 'NEED_HUMAN_ACTION');
  assert.equal(out.next_milestone_id, 'm2');
  assert.equal(out.next_brain_run_id, null);
  assert.equal(m2.state, 'NEED_HUMAN_ACTION');
  assert.equal(mission.state, 'NEED_HUMAN_ACTION');
  assert.equal(mission.roadmap_id, 'roadmap_a');
  assert.equal(mission.milestone_id, 'm2');
  assert.equal(m2.human_action_checkpoint.status, 'WAITING_FOR_HUMAN');
  assert.equal(m2.human_action_checkpoint.validation_method, 'git_worktree_clean');
  assert.equal(m2.human_action_checkpoint.roadmap_id, 'roadmap_a');
  assert.equal(m2.human_action_checkpoint.milestone_id, 'm2');
  assert.equal(m2.human_action_checkpoint.mission_id, m2.mission_id);
  assert.equal(m2.human_action_checkpoint.validation_metadata.repository_path, 'C:/repo');
  assert.equal(m2.human_action_checkpoint.validation_metadata.repository_identity, 'stored/project');
  assert.equal(tasks(db).length, before.tasks);
  assert.equal(executionRuns(db).length, before.executionRuns);
});

test('repeated continuation while next milestone NEED_HUMAN_ACTION reuses checkpoint and Mission', async () => {
  const db = new DB();
  seed(db, {
    localPath: '',
    milestones: [
      { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
      { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'], prerequisites: [{ type: 'REPOSITORY_LOCAL_PATH' }] }
    ]
  });
  const first = await complete(db);
  const repeated = await continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm1');
  assert.equal(repeated.continuation_state, 'NEED_HUMAN_ACTION');
  assert.equal(repeated.next_mission_id, first.next_mission_id);
  assert.equal(repeated.checkpoint_id, first.checkpoint_id);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(tasks(db).length, 0);
  assert.equal(executionRuns(db).length, 0);
});

test('satisfied next prerequisite starts normal Brain PROGRAM flow', async () => {
  const db = new DB();
  seed(db, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['m1'], prerequisites: [{ type: 'REPOSITORY_LOCAL_PATH' }] }
  ] });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(runs(db, 'PROGRAM').length, 1);
});

test('completed predecessor audit fields remain unchanged', async () => {
  const db = new DB(); seed(db);
  const before = milestone(db, 'm1').completed_at;
  await complete(db);
  assert.equal(milestone(db, 'm1').completed_at instanceof Date, true);
  assert.equal(milestone(db, 'm1').mission_id, 'mission_m1');
  assert.equal(before, 'keep-me');
});

test('dependency ordering does not start milestone with unsatisfied dependency', async () => {
  const db = new DB();
  seed(db, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PENDING', order: 2, depends_on: ['missing'] },
    { id: 'm3', title: 'Three', state: 'PENDING', order: 3, depends_on: ['m2'] }
  ] });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'NO_ELIGIBLE_MILESTONE');
  assert.equal(values(db, 'missions').length, 1);
});

test('no dependency-eligible pending milestone creates no arbitrary work', async () => {
  const db = new DB();
  seed(db, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PENDING', order: 2, dependencies: ['m3'] },
    { id: 'm3', title: 'Three', state: 'PENDING', order: 3, dependencies: ['m2'] }
  ] });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'NO_ELIGIBLE_MILESTONE');
  assert.equal(values(db, 'missions').length, 1);
});

test('existing active milestone prevents duplicate advance and is returned', async () => {
  const db = new DB();
  seed(db, { milestones: [
    { id: 'm1', title: 'One', state: 'VERIFYING', order: 1, depends_on: [], mission_id: 'mission_m1' },
    { id: 'm2', title: 'Two', state: 'PLANNING', order: 2, depends_on: ['m1'], mission_id: 'mission_m2', brain_run_id: 'brain_m2' }
  ] });
  db.set('missions', 'mission_m2', { id: 'mission_m2', tenant_id: 'tenant_a', state: 'PLANNING', autopilot_mode: true, roadmap_id: 'roadmap_a', milestone_id: 'm2' });
  db.set('runs', 'brain_m2', { id: 'brain_m2', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_m2', autopilot_phase: 'PROGRAM' });
  const out = await complete(db);
  assert.equal(out.continuation_state, 'ALREADY_RUNNING');
  assert.equal(out.next_mission_id, 'mission_m2');
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').length, 1);
});

test('non-runnable roadmap states do not advance', async () => {
  for (const state of ['BLOCKED', 'FAILED', 'CANCELLED', 'NEED_HUMAN_ACTION']) {
    const db = new DB(); seed(db, { roadmapState: state });
    const out = await complete(db);
    assert.equal(out.continuation_state, 'STOPPED');
    assert.equal(values(db, 'missions').length, 1);
  }
});

test('cross-tenant continuation is denied with no persistence mutation', async () => {
  const db = new DB(); seed(db);
  const before = JSON.stringify(db.collections);
  const out = await continueRoadmapAfterComplete(db, 'tenant_b', 'roadmap_a', 'm1');
  assert.equal(out.continuation_state, 'DENIED');
  assert.equal(JSON.stringify(db.collections), before);
});

test('RETRY result never advances to another milestone', async () => {
  const db = new DB(); seed(db);
  const out = await completeVerificationBrainRun(db, 'tenant_a', 'verify_m1', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"fix","allowed_files":["src/services/autopilot.js"],"required_tests":["node --test test/autopilot-auto-advance.test.js"]}}</MRAPI_AUTOPILOT>'
  });
  assert.equal(out.action, 'RETRY');
  assert.equal(milestone(db, 'm2').state, 'PENDING');
  assert.equal(values(db, 'missions').length, 1);
});

test('auto advance creates no Executor Task directly before Brain PROGRAM contract', async () => {
  const db = new DB(); seed(db);
  await complete(db);
  assert.equal(tasks(db).length, 0);
  assert.equal(executionRuns(db).length, 0);
});

test('trusted Planner Brain-only milestone cannot be escalated into Executor work by Brain output', async () => {
  const db = new DB();
  seed(db, {
    milestones: [
      { id: 'm1', title: 'Brain only', state: 'PLANNING', order: 1, depends_on: [], mission_id: 'mission_m1', executor_required: false },
      { id: 'm2', title: 'Executor work', state: 'PENDING', order: 2, depends_on: ['m1'], executor_required: true }
    ]
  });
  db.set('roadmaps', 'roadmap_a', { proposal_type: 'PLANNER_ROADMAP' }, { merge: true });
  db.set('missions', 'mission_m1', {
    ...db.get('missions', 'mission_m1'),
    state: 'PLANNING',
    autopilot_phase: 'PROGRAM',
    milestone_id: 'm1',
    brain_run_id: 'brain_m1'
  });
  db.set('runs', 'brain_m1', {
    id: 'brain_m1',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_m1',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  });

  const out = await completeBrainRun(db, 'tenant_a', 'brain_m1', {
    output_text: '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"title":"Escalate","objective":"Try to create work","instructions":"Should not become a Task.","allowed_files":["src/services/orchestration.js"],"required_tests":["node --test test/autopilot-auto-advance.test.js"]}}</MRAPI_CONTROL><MRAPI_RESULT>Brain-only milestone completed.</MRAPI_RESULT>'
  });

  assert.equal(out.requires_execution, false);
  assert.equal(out.task_id, null);
  assert.equal(out.continuation_state, 'STARTED');
  assert.equal(milestone(db, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, 'm2').state, 'PLANNING');
  assert.equal(tasks(db).filter((task) => task.mission_id === 'mission_m1').length, 0);
  assert.equal(executionRuns(db).filter((run) => run.mission_id === 'mission_m1').length, 0);
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(runs(db, 'PROGRAM').filter((run) => run.mission_id === milestone(db, 'm2').mission_id).length, 1);
});

test('completed milestone Mission and Run audit IDs are preserved', async () => {
  const db = new DB(); seed(db);
  await complete(db);
  const done = milestone(db, 'm1');
  assert.equal(done.mission_id, 'mission_m1');
  assert.equal(done.verification_brain_run_id, 'verify_m1');
  assert.equal(db.get('missions', 'mission_m1').brain_run_id, 'brain_m1');
});
