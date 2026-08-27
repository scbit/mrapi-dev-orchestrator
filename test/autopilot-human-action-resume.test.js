const test = require('node:test');
const assert = require('node:assert/strict');
const { completeBrainRun } = require('../src/services/orchestration');
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

async function pauseWith(db, extraSpec) {
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput(extraSpec) });
  assert.equal(out.action, 'NEED_HUMAN_ACTION');
  return checkpoint(db);
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

test('manual confirmation resolves only when persisted validator allows it', async () => {
  const db = new DB(); seedProgram(db);
  const cp = await pauseWith(db, { prerequisites: [{ type: 'MANUAL_HUMAN', human_action_request: 'Confirm', user_action: 'Confirm', action_location: 'operator', validation_method: 'manual_confirmation' }] });
  const out = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', cp.checkpoint_id, { ready: true });
  assert.equal(out.resumed, true);
  assert.equal(checkpoint(db).status, 'RESOLVED');
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
