const test = require('node:test');
const assert = require('node:assert/strict');
const { completeVerificationBrainRun, confirmHumanActionReady } = require('../src/services/autopilot');

class Snap { constructor(id, data, ref = null) { this.id = id; this._data = data; this.ref = ref; this.exists = Boolean(data); } data() { return this._data ? { ...this._data } : undefined; } }
class QuerySnap { constructor(docs) { this.docs = docs; this.empty = docs.length === 0; } }
class Doc { constructor(db, c, id) { this.db = db; this.c = c; this.collectionName = c; this.id = id || db.next(c); } async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); } async set(d, o = {}) { this.db.set(this.c, this.id, d, o); } async update(d) { this.db.update(this.c, this.id, d); } }
class Query { constructor(db, c, filters = [], max = null) { this.db = db; this.c = c; this.collectionName = c; this.filters = filters; this.max = max; } where(field, op, value) { assert.equal(op, '=='); return new Query(this.db, this.c, [...this.filters, { field, value }], this.max); } limit(max) { return new Query(this.db, this.c, this.filters, max); } async get() { let docs = Object.entries(this.db.collections[this.c] || {}).filter(([, d]) => this.filters.every((f) => d[f.field] === f.value)).map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id))); if (this.max !== null) docs = docs.slice(0, this.max); return new QuerySnap(docs); } }
class Coll extends Query { doc(id) { return new Doc(this.db, this.c, id); } }
class Tx { constructor() { this.hasWritten = false; } async get(x) { if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE'); return x.get(); } set(ref, d, o) { this.hasWritten = true; ref.db.set(ref.c || ref.collectionName, ref.id, d, o); } update(ref, d) { this.hasWritten = true; ref.db.update(ref.c || ref.collectionName, ref.id, d); } }
class DB { constructor() { this.collections = {}; this.n = {}; } collection(c) { if (!this.collections[c]) this.collections[c] = {}; return new Coll(this, c); } next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; } get(c, id) { return this.collections[c]?.[id] || null; } set(c, id, d, o = {}) { if (!this.collections[c]) this.collections[c] = {}; this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d }; } update(c, id, d) { if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND'); this.collections[c][id] = { ...this.collections[c][id], ...d }; } async runTransaction(fn) { return fn(new Tx()); } }

function values(db, c) { return Object.values(db.collections[c] || {}); }
function roadmap(db) { return db.get('roadmaps', 'roadmap_a'); }
function mission(db) { return db.get('missions', 'mission_a'); }
function current(db) { return roadmap(db).milestones[1]; }
function execRuns(db) { return values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN'); }

function seed(overrides = {}) {
  const db = new DB();
  db.set('projects', 'project_a', { id: 'project_a', tenant_id: 'tenant_a', workspace_id: 'workspace_a', local_path: 'C:/repo', ...(overrides.project || {}) });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a', tenant_id: 'tenant_a', workspace_id: 'workspace_a', project_id: 'project_a',
    state: 'ACTIVE', auto_advance: false, milestones: [
      { id: 'm0', title: 'Done', state: 'COMPLETED', order: 1, marker: 'byte-stable' },
      { id: 'm1', title: 'Current', state: 'VERIFYING', order: 2, depends_on: ['m0'], mission_id: 'mission_a' }
    ],
    ...(overrides.roadmap || {})
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a', tenant_id: 'tenant_a', workspace_id: 'workspace_a', project_id: 'project_a',
    preferred_worker_id: 'W01', priority: 'HIGH', state: 'RUNNING', autopilot_mode: true,
    autopilot_phase: 'VERIFYING', autopilot_attempt_count: 1, autopilot_max_attempts: 3,
    roadmap_id: 'roadmap_a', milestone_id: 'm1', current_task_id: 'task_prev',
    brain_output_result_id: 'brain_result_prev',
    ...(overrides.mission || {})
  });
  db.set('tasks', 'task_prev', { id: 'task_prev', tenant_id: 'tenant_a', mission_id: 'mission_a', state: 'DONE', phase: 'COMPLETED', current_run_id: 'exec_prev', task_spec: { allowed_files: ['unsafe/old.js'], required_tests: ['old'] } });
  db.set('runs', 'exec_prev', { id: 'exec_prev', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', state: 'COMPLETED', mission_id: 'mission_a', task_id: 'task_prev', result_id: 'result_prev' });
  db.set('results', 'result_prev', { id: 'result_prev', tenant_id: 'tenant_a', mission_id: 'mission_a', task_id: 'task_prev', run_id: 'exec_prev', summary: 'previous evidence' });
  db.set('runs', 'verify_1', { id: 'verify_1', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  return db;
}

function retryOutput(spec = {}, reason = 'fix failed tests') {
  return `<MRAPI_AUTOPILOT>${JSON.stringify({
    action: 'RETRY',
    reason,
    execution_spec: {
      instructions: 'Apply the bounded retry.',
      allowed_files: ['src/services/autopilot.js'],
      required_tests: ['node --test test/autopilot-retry-revision.test.js'],
      ...spec
    }
  })}</MRAPI_AUTOPILOT>`;
}

async function retry(db, runId = 'verify_1', spec = {}, reason) {
  return completeVerificationBrainRun(db, 'tenant_a', runId, { output_text: retryOutput(spec, reason) });
}

test('valid RETRY preserves identity, predecessors, evidence, and increments attempt once', async () => {
  const db = seed();
  const predecessor = JSON.stringify(roadmap(db).milestones[0]);
  const out = await retry(db);
  assert.equal(out.action, 'RETRY');
  assert.equal(out.roadmap_id, 'roadmap_a');
  assert.equal(out.milestone_id, 'm1');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(out.attempt, 2);
  assert.equal(mission(db).autopilot_attempt_count, 2);
  assert.equal(JSON.stringify(roadmap(db).milestones[0]), predecessor);
  assert.ok(db.get('tasks', 'task_prev'));
  assert.ok(db.get('runs', 'exec_prev'));
  assert.ok(db.get('results', 'result_prev'));
  assert.equal(mission(db).brain_output_result_id, 'brain_result_prev');
  assert.equal(values(db, 'tasks').length, 2);
});

test('retry metadata records revision, verification reason, active spec, and preserves revision history', async () => {
  const db = seed();
  const first = await retry(db, 'verify_1', { allowed_files: ['one.js'] }, 'first failure');
  db.set('runs', 'verify_2', { id: 'verify_2', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const second = await retry(db, 'verify_2', { allowed_files: ['two.js'] }, 'second failure');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(mission(db).active_retry_execution_spec.allowed_files[0], 'two.js');
  assert.equal(mission(db).last_retry_reason, 'second failure');
  assert.equal(mission(db).autopilot_retry_history.length, 2);
  assert.equal(mission(db).autopilot_retry_history[0].execution_spec.allowed_files[0], 'one.js');
  assert.equal(current(db).retry_revision, 2);
});

test('new retry task uses only current allowed_files, not historical union', async () => {
  const db = seed();
  const out = await retry(db, 'verify_1', { allowed_files: ['current.js'] });
  const task = db.get('tasks', out.task_id);
  assert.deepEqual(task.task_spec.allowed_files, ['current.js']);
  assert.deepEqual(task.brain_output.task_spec.allowed_files, ['current.js']);
  assert.deepEqual(mission(db).autopilot_allowed_files, ['current.js']);
  assert.equal(mission(db).autopilot_retry_history[0].prior_task_id, 'task_prev');
});

test('malformed RETRY specs fail closed with zero retry task', async () => {
  for (const [payload, pattern] of [
    [{ allowed_files: ['a.js'], required_tests: ['node --test a.test.js'], instructions: '' }, /instructions/i],
    [{ instructions: 'x', required_tests: ['node --test a.test.js'], allowed_files: [] }, /allowed_files/i],
    [{ instructions: 'x', allowed_files: ['a.js'], required_tests: [] }, /required_tests/i]
  ]) {
    const db = seed();
    const out = await completeVerificationBrainRun(db, 'tenant_a', 'verify_1', {
      output_text: `<MRAPI_AUTOPILOT>${JSON.stringify({ action: 'RETRY', reason: 'bad', execution_spec: payload })}</MRAPI_AUTOPILOT>`
    });
    assert.equal(out.action, 'BLOCKED');
    assert.match(out.reason, pattern);
    assert.equal(values(db, 'tasks').length, 1);
  }
});

test('RETRY never starts next milestone even with auto_advance true', async () => {
  const db = seed({ roadmap: { auto_advance: true, milestones: [{ id: 'm0', title: 'Done', state: 'COMPLETED', order: 1 }, { id: 'm1', title: 'Current', state: 'VERIFYING', order: 2, mission_id: 'mission_a' }, { id: 'm2', title: 'Next', state: 'PENDING', order: 3, depends_on: ['m1'] }] } });
  await retry(db);
  assert.equal(roadmap(db).milestones[1].state, 'RUNNING');
  assert.equal(roadmap(db).milestones[2].state, 'PENDING');
  assert.equal(values(db, 'missions').length, 1);
});

test('retry preflight missing env var pauses as NEED_HUMAN_ACTION with zero execution work', async () => {
  const old = process.env.MRAPI_RETRY_SECRET;
  delete process.env.MRAPI_RETRY_SECRET;
  try {
    const db = seed();
    const out = await retry(db, 'verify_1', { required_env_vars: ['MRAPI_RETRY_SECRET'] });
    assert.equal(out.action, 'NEED_HUMAN_ACTION');
    assert.equal(values(db, 'tasks').length, 1);
    assert.equal(execRuns(db).length, 1);
    assert.equal(current(db).state, 'NEED_HUMAN_ACTION');
    assert.equal(mission(db).pending_retry_execution.execution_spec.required_env_vars[0], 'MRAPI_RETRY_SECRET');
  } finally {
    if (old === undefined) delete process.env.MRAPI_RETRY_SECRET;
    else process.env.MRAPI_RETRY_SECRET = old;
  }
});

test('retry preflight missing repository prerequisite pauses and reuses checkpoint', async () => {
  const db = seed({ project: { local_path: '', runtime_context: {} } });
  const first = await retry(db, 'verify_1', { requires_repository: true });
  const checkpointId = first.checkpoint_id;
  db.set('runs', 'verify_2', { id: 'verify_2', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const second = await retry(db, 'verify_2', { requires_repository: true });
  assert.equal(second.action, 'NEED_HUMAN_ACTION');
  assert.equal(second.checkpoint_id, checkpointId);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(execRuns(db).length, 1);
});

test('LISTO resolves retry prerequisite once and resumes same attempt without new roadmap or Mission', async () => {
  const old = process.env.MRAPI_RETRY_SECRET;
  delete process.env.MRAPI_RETRY_SECRET;
  const db = seed();
  const paused = await retry(db, 'verify_1', { required_env_vars: ['MRAPI_RETRY_SECRET'] });
  process.env.MRAPI_RETRY_SECRET = 'must-not-leak';
  try {
    const first = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', paused.checkpoint_id, { ready: true });
    const second = await confirmHumanActionReady(db, 'tenant_a', 'roadmap_a', paused.checkpoint_id, { ready: true });
    assert.equal(first.resumed, true);
    assert.equal(first.task_id, second.task_id);
    assert.equal(values(db, 'tasks').length, 2);
    assert.equal(mission(db).autopilot_attempt_count, 2);
    assert.equal(values(db, 'missions').length, 1);
    assert.equal(values(db, 'roadmaps').length, 1);
  } finally {
    if (old === undefined) delete process.env.MRAPI_RETRY_SECRET;
    else process.env.MRAPI_RETRY_SECRET = old;
  }
});

test('retry limit reached blocks without new task or run and preserves evidence', async () => {
  const db = seed({ mission: { autopilot_attempt_count: 3, autopilot_max_attempts: 3 } });
  const out = await retry(db);
  assert.equal(out.action, 'BLOCKED');
  assert.match(out.reason, /retry limit/i);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(execRuns(db).length, 1);
  assert.ok(db.get('results', 'result_prev'));
});

test('ordinary implementation failure remains RETRY unless structured prerequisite evidence exists', async () => {
  const db = seed();
  const out = await retry(db, 'verify_1', {}, 'tests failed with assertion error');
  assert.equal(out.action, 'RETRY');
  assert.equal(current(db).state, 'RUNNING');
});

test('cross-tenant retry verification fails with no mutation', async () => {
  const db = seed();
  const before = JSON.stringify(db.collections);
  await assert.rejects(() => completeVerificationBrainRun(db, 'tenant_b', 'verify_1', { output_text: retryOutput() }), /RUN_NOT_FOUND/);
  assert.equal(JSON.stringify(db.collections), before);
});

test('retry audit metadata contains no secret values', async () => {
  const db = seed();
  await retry(db, 'verify_1', {
    preflight: { token_value: 'hidden-token', public_name: 'safe-name' },
    prerequisites: [{ type: 'MANUAL_HUMAN', validation_metadata: { secret_value: 'hidden-secret', identifier: 'safe-id' } }]
  });
  const serialized = JSON.stringify({
    mission_retry_history: mission(db).autopilot_retry_history,
    mission_active_retry_execution_spec: mission(db).active_retry_execution_spec,
    milestone_retry_history: current(db).retry_history,
    milestone_active_retry_execution_spec: current(db).active_retry_execution_spec,
    checkpoint: current(db).human_action_checkpoint
  });
  assert.equal(serialized.includes('hidden-token'), false);
  assert.equal(serialized.includes('hidden-secret'), false);
  assert.equal(serialized.includes('safe-name'), true);
});
