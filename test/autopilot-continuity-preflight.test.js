const test = require('node:test');
const assert = require('node:assert/strict');
const { completeBrainRun } = require('../src/services/orchestration');
const { completeVerificationBrainRun, parseAutopilotDecision } = require('../src/services/autopilot');

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
    state: 'ACTIVE',
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

function programOutput(extraSpec = {}, requiresExecution = true) {
  if (!requiresExecution) {
    return '<MRAPI_CONTROL>{"requires_execution":false,"execution_type":"BRAIN_ONLY"}</MRAPI_CONTROL><MRAPI_RESULT>Brain-only done.</MRAPI_RESULT>';
  }
  return `<MRAPI_CONTROL>${JSON.stringify({
    requires_execution: true,
    execution_type: 'EXECUTOR',
    task_spec: {
      title: 'Do work',
      objective: 'Do work',
      instructions: 'Apply the bounded change.',
      allowed_files: ['src/services/autopilot.js'],
      required_tests: ['node --test test/autopilot-continuity-preflight.test.js'],
      ...extraSpec
    }
  })}</MRAPI_CONTROL>`;
}

function checkpoint(db) {
  return db.get('roadmaps', 'roadmap_a').milestones[1].human_action_checkpoint;
}

test('explicit repository requirement missing local path pauses with zero Task and EXECUTION_RUN', async () => {
  const db = new DB(); seedProgram(db);
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput({ requires_repository: true }) });
  assert.equal(out.action, 'NEED_HUMAN_ACTION');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
  assert.equal(db.get('missions', 'mission_a').state, 'NEED_HUMAN_ACTION');
  assert.equal(checkpoint(db).requirement_type, 'REPOSITORY_LOCAL_PATH');
});

test('repository requirement satisfied continues normal Task path', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/repo' } });
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput({ requires_repository: true }) });
  assert.ok(out.task_id);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'RUNNING');
});

test('Brain-only milestone without repository requirement has no fabricated blocker', async () => {
  const db = new DB(); seedProgram(db);
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput({}, false) });
  assert.equal(out.requires_execution, false);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[1].state, 'COMPLETED');
});

test('required env var present passes and absent pauses with secret-safe checkpoint', async () => {
  const oldValue = process.env.MRAPI_PREFLIGHT_SECRET;
  process.env.MRAPI_PREFLIGHT_SECRET = 'secret-value';
  try {
    const passDb = new DB(); seedProgram(passDb);
    const pass = await completeBrainRun(passDb, 'tenant_a', 'brain_a', { output_text: programOutput({ required_env_vars: ['MRAPI_PREFLIGHT_SECRET'] }) });
    assert.ok(pass.task_id);
  } finally {
    if (oldValue === undefined) delete process.env.MRAPI_PREFLIGHT_SECRET;
    else process.env.MRAPI_PREFLIGHT_SECRET = oldValue;
  }

  const failDb = new DB(); seedProgram(failDb);
  const fail = await completeBrainRun(failDb, 'tenant_a', 'brain_a', { output_text: programOutput({ required_env_vars: ['MRAPI_PREFLIGHT_SECRET'] }) });
  assert.equal(fail.action, 'NEED_HUMAN_ACTION');
  assert.equal(checkpoint(failDb).validation_metadata.env_var_name, 'MRAPI_PREFLIGHT_SECRET');
  assert.equal(JSON.stringify(checkpoint(failDb)).includes('secret-value'), false);
});

test('explicit external, manual, and manual deploy prerequisites persist structured checkpoints', async () => {
  for (const type of ['EXTERNAL_ACCESS', 'MANUAL_HUMAN', 'MANUAL_DEPLOY']) {
    const db = new DB(); seedProgram(db);
    const out = await completeBrainRun(db, 'tenant_a', 'brain_a', {
      output_text: programOutput({
        prerequisites: [{
          type,
          name: `${type}_name`,
          human_action_request: 'Authorize the external step.',
          user_action: 'Open the admin console and approve it.',
          action_location: 'admin console',
          validation_method: 'manual confirmation',
          validation_metadata: { identifier: `${type}_name`, token_value: 'must-not-persist' }
        }]
      })
    });
    assert.equal(out.action, 'NEED_HUMAN_ACTION');
    assert.equal(values(db, 'tasks').length, 0);
    assert.equal(checkpoint(db).requirement_type, type);
    assert.equal(checkpoint(db).human_action_request, 'Authorize the external step.');
    assert.equal(JSON.stringify(checkpoint(db)).includes('must-not-persist'), false);
  }
});

test('repository-clean Human Action preflight persists validator shape consumed by LISTO', async () => {
  const db = new DB(); seedProgram(db, { project: { local_path: 'C:/repo' } });
  const out = await completeBrainRun(db, 'tenant_a', 'brain_a', {
    output_text: programOutput({
      preflight: [{
        type: 'MANUAL_HUMAN',
        name: 'repository_dirty',
        human_action_request: 'Clean the repository worktree before continuing.',
        user_action: 'Remove or commit local changes, then press LISTO.',
        action_location: 'project.runtime_context.repository_path',
        validation_method: 'repository_clean',
        validation_metadata: { repository_path: 'C:/repo' }
      }]
    })
  });
  assert.equal(out.action, 'NEED_HUMAN_ACTION');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(checkpoint(db).requirement_type, 'MANUAL_HUMAN');
  assert.equal(checkpoint(db).validation_method, 'repository_clean');
  assert.equal(checkpoint(db).validation_metadata.repository_path, 'C:/repo');
});

test('repeat unresolved preflight reuses checkpoint and creates no duplicate work', async () => {
  const db = new DB(); seedProgram(db);
  await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput({ requires_repository: true }) });
  const firstId = checkpoint(db).checkpoint_id;
  db.set('runs', 'brain_b', { ...db.get('runs', 'brain_a'), id: 'brain_b', state: 'RUNNING' });
  await completeBrainRun(db, 'tenant_a', 'brain_b', { output_text: programOutput({ requires_repository: true }) });
  assert.equal(checkpoint(db).checkpoint_id, firstId);
  assert.equal(values(db, 'tasks').length, 0);
});

test('completed predecessors stay completed and cross-tenant complete mutates nothing', async () => {
  const db = new DB(); seedProgram(db);
  const before = JSON.stringify(db.collections);
  await assert.rejects(() => completeBrainRun(db, 'tenant_b', 'brain_a', { output_text: programOutput({ requires_repository: true }) }), /RUN_NOT_FOUND/);
  assert.equal(JSON.stringify(db.collections), before);
  await completeBrainRun(db, 'tenant_a', 'brain_a', { output_text: programOutput({ requires_repository: true }) });
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[0].state, 'COMPLETED');
});

test('W01 NEED_HUMAN_ACTION decision persists; malformed one fails closed as BLOCKED', async () => {
  const db = new DB(); seedProgram(db, { milestone: { state: 'VERIFYING' }, mission: { state: 'RUNNING', autopilot_phase: 'VERIFYING' } });
  db.set('runs', 'verify_a', { id: 'verify_a', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const valid = await completeVerificationBrainRun(db, 'tenant_a', 'verify_a', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"NEED_HUMAN_ACTION","reason":"needs approval","human_action":{"human_action_request":"Approve access","user_action":"Grant access","action_location":"settings","validation_method":"access check"},"execution_spec":null}</MRAPI_AUTOPILOT>'
  });
  assert.equal(valid.action, 'NEED_HUMAN_ACTION');
  assert.equal(db.get('missions', 'mission_a').state, 'NEED_HUMAN_ACTION');

  const badDb = new DB(); seedProgram(badDb, { milestone: { state: 'VERIFYING' }, mission: { state: 'RUNNING', autopilot_phase: 'VERIFYING' } });
  badDb.set('runs', 'verify_bad', { id: 'verify_bad', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const bad = await completeVerificationBrainRun(badDb, 'tenant_a', 'verify_bad', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"NEED_HUMAN_ACTION","reason":"missing fields","execution_spec":null}</MRAPI_AUTOPILOT>'
  });
  assert.equal(bad.action, 'BLOCKED');
  assert.match(bad.reason, /Malformed NEED_HUMAN_ACTION/);
});

test('existing decisions remain valid and RETRY still requires instructions allowed_files required_tests', () => {
  assert.equal(parseAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"ok"}</MRAPI_AUTOPILOT>').action, 'COMPLETE');
  assert.equal(parseAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"x","allowed_files":["a.js"],"required_tests":["node --test a.test.js"]}}</MRAPI_AUTOPILOT>').action, 'RETRY');
  assert.equal(parseAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"BLOCKED","reason":"stop"}</MRAPI_AUTOPILOT>').action, 'BLOCKED');
});

test('RETRY with no test directive blocks', async () => {
  const db = new DB(); seedProgram(db, { milestone: { state: 'VERIFYING' }, mission: { state: 'RUNNING', autopilot_phase: 'VERIFYING' } });
  db.set('runs', 'verify_no_tests', { id: 'verify_no_tests', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const out = await completeVerificationBrainRun(db, 'tenant_a', 'verify_no_tests', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"change code","allowed_files":["a.js"]}}</MRAPI_AUTOPILOT>'
  });
  assert.equal(out.action, 'BLOCKED');
  assert.match(out.reason, /required_tests/i);
  assert.equal(values(db, 'tasks').length, 0);
});
