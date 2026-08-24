const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  registerExecutor,
  claimNextTask,
  completeBrainRun,
  dispatchMission
} = require('../src/services/orchestration');
const { createApi } = require('../runner/lib/api');
const { isTransientPollError } = require('../runner/shadow-runner');

class FakeSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = Boolean(data);
  }

  data() {
    return this._data ? { ...this._data } : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id || db.nextId(collectionName);
  }

  async get() {
    return new FakeSnapshot(this.id, this.db.get(this.collectionName, this.id));
  }

  async set(data, options = {}) {
    this.db.set(this.collectionName, this.id, data, options);
  }

  async update(data) {
    this.db.update(this.collectionName, this.id, data);
  }
}

class FakeQuery {
  constructor(db, collectionName, filters = [], max = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.max = max;
  }

  where(field, op, value) {
    assert.equal(op, '==');
    return new FakeQuery(this.db, this.collectionName, [...this.filters, { field, value }], this.max);
  }

  limit(max) {
    return new FakeQuery(this.db, this.collectionName, this.filters, max);
  }

  async get() {
    let docs = Object.entries(this.db.collections[this.collectionName] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new FakeSnapshot(id, data));

    if (this.max !== null) docs = docs.slice(0, this.max);
    return new FakeQuerySnapshot(docs);
  }
}

class FakeCollection extends FakeQuery {
  constructor(db, collectionName) {
    super(db, collectionName);
  }

  doc(id) {
    return new FakeDocRef(this.db, this.collectionName, id);
  }
}

class FakeTransaction {
  async get(refOrQuery) {
    return refOrQuery.get();
  }

  set(ref, data, options) {
    ref.db.set(ref.collectionName, ref.id, data, options);
  }

  update(ref, data) {
    ref.db.update(ref.collectionName, ref.id, data);
  }
}

class FakeDb {
  constructor() {
    this.collections = {};
    this.counters = {};
  }

  collection(name) {
    if (!this.collections[name]) this.collections[name] = {};
    return new FakeCollection(this, name);
  }

  nextId(collectionName) {
    this.counters[collectionName] = (this.counters[collectionName] || 0) + 1;
    return `${collectionName}_${this.counters[collectionName]}`;
  }

  get(collectionName, id) {
    return this.collections[collectionName]?.[id] || null;
  }

  set(collectionName, id, data, options = {}) {
    assertNoUndefinedFirestoreValues(data);
    if (!this.collections[collectionName]) this.collections[collectionName] = {};
    const existing = this.collections[collectionName][id] || {};
    this.collections[collectionName][id] = options.merge ? { ...existing, ...data } : { ...data };
  }

  update(collectionName, id, data) {
    assertNoUndefinedFirestoreValues(data);
    if (!this.collections[collectionName]?.[id]) throw new Error('NOT_FOUND');
    this.collections[collectionName][id] = { ...this.collections[collectionName][id], ...data };
  }

  async runTransaction(fn) {
    return fn(new FakeTransaction());
  }
}

function assertNoUndefinedFirestoreValues(value, path = 'data') {
  if (value === undefined) {
    throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}")`);
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assertNoUndefinedFirestoreValues(child, path === 'data' ? key : `${path}.${key}`);
  }
}

function seedBase(db, tenantId = 'tenant_a') {
  db.set('projects', 'project_1', {
    id: 'project_1',
    tenant_id: tenantId,
    workspace_id: 'workspace_1',
    primary_worker_ids: ['W01', 'W04']
  });
  for (const workerId of ['W01', 'W02', 'W03', 'W04', 'W05', 'W99']) {
    db.set('workers', workerId, {
      id: workerId,
      tenant_id: tenantId,
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      state: 'IDLE'
    });
  }
}

function seedTask(db, id, workerId, overrides = {}) {
  const missionId = overrides.mission_id || `mission_${id}`;
  const task = {
    id,
    tenant_id: overrides.tenant_id || 'tenant_a',
    mission_id: missionId,
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    worker_id: workerId,
    title: `Task ${id}`,
    objective: `Execute ${id}`,
    priority: overrides.priority || 'NORMAL',
    state: overrides.state || 'QUEUED',
    phase: overrides.phase || 'EXECUTION_PENDING',
    task_spec: {
      title: `Task ${id}`,
      objective: `Execute ${id}`,
      instructions: `Run local work for ${id}.`
    },
    attempt_count: 0,
    created_at: { toMillis: () => overrides.created_at || 1 }
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'brain_run_id')) {
    task.brain_run_id = overrides.brain_run_id;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'brain_completed_at')) {
    task.brain_completed_at = overrides.brain_completed_at;
  }
  if (overrides.createMission !== false) {
    db.set('missions', missionId, {
      id: missionId,
      tenant_id: overrides.tenant_id || 'tenant_a',
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      objective: `Mission ${id}`,
      state: overrides.mission_state || 'PLANNING'
    });
  }
  db.set('tasks', id, task);
}

async function registerCommonExecutor(db, tenantId = 'tenant_a') {
  return registerExecutor(db, tenantId, {
    executor_id: 'executor_shadow_codex_01',
    runner_version: 'v0.4.0.6',
    worker_ids: ['W01', 'W02', 'W03', 'W04', 'W05'],
    capabilities: ['EXECUTION_RUN:CODEX_CLI_AUTO', 'CODEX_HANDOFF:VALIDATED']
  });
}

test('v0.4.0.3 executor registers with W01-W05 binding', async () => {
  const db = new FakeDb();
  seedBase(db);

  const executor = await registerCommonExecutor(db);

  assert.deepEqual(executor.worker_ids, ['W01', 'W02', 'W03', 'W04', 'W05']);
});

test('v0.4.0.3 common executor claims W04 and W01 tasks without throwing', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_w04', 'W04', { priority: 'HIGH', created_at: 1 });
  seedTask(db, 'task_w01', 'W01', { priority: 'NORMAL', created_at: 2 });

  const first = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });
  assert.equal(first.task.id, 'task_w04');
  assert.equal(first.run.run_type, 'EXECUTION_RUN');

  db.update('workers', 'W04', { state: 'IDLE' });
  const second = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });
  assert.equal(second.task.id, 'task_w01');
});

test('v0.4.0.4 ASSIGNED W04 task is recovered and claimed once', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_assigned_w04', 'W04', { state: 'ASSIGNED' });

  const first = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });
  const second = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(first.task.id, 'task_assigned_w04');
  assert.equal(db.get('tasks', 'task_assigned_w04').state, 'RUNNING');
  assert.equal(second, null);
  assert.equal(Object.values(db.collections.runs || {}).filter((run) => run.run_type === 'EXECUTION_RUN').length, 1);
});

test('v0.4.0.5 legacy task with undefined brain_run_id persists null linkage', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_undefined_brain', 'W04');

  let claim;
  await assert.doesNotReject(async () => {
    claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
      repository_path: 'C:\\repo'
    });
  });

  const run = db.get('runs', claim.run.id);
  assert.equal(run.brain_run_id, null);
  assert.equal(run.parent_run_id, null);
  assert.equal(claim.run.brain_run_id, null);
  assert.equal(claim.run.parent_run_id, null);
  assert.equal(claim.task.brain_run_id, null);
});

test('v0.4.0.5 task with real brain_run_id preserves and validates it', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  db.set('runs', 'brain_1', {
    id: 'brain_1',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'COMPLETED',
    mission_id: 'mission_task_real_brain',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    brain_output: {
      task_spec: {
        objective: 'Execute with Brain context',
        instructions: 'Use the real Brain handoff.'
      }
    }
  });
  seedTask(db, 'task_real_brain', 'W04', {
    brain_run_id: 'brain_1',
    brain_completed_at: { toMillis: () => 1 }
  });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });
  const run = db.get('runs', claim.run.id);

  assert.equal(run.brain_run_id, 'brain_1');
  assert.equal(run.parent_run_id, 'brain_1');
  assert.equal(claim.run.brain_run_id, 'brain_1');
  assert.equal(claim.codex_handoff.brain_run_id, 'brain_1');
});

test('v0.4.0.5 task with real Brain Run still requires completed Brain', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  db.set('runs', 'brain_incomplete', {
    id: 'brain_incomplete',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'RUNNING',
    mission_id: 'mission_task_incomplete_brain'
  });
  seedTask(db, 'task_incomplete_brain', 'W04', {
    brain_run_id: 'brain_incomplete',
    brain_completed_at: { toMillis: () => 1 }
  });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim, null);
  assert.equal(Object.values(db.collections.runs || {}).filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
});

test('v0.4.0.4 RUNNING task cannot be claimed', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_running', 'W04', { state: 'RUNNING', phase: 'EXECUTION_RUNNING' });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim, null);
  assert.equal(Object.values(db.collections.runs || {}).length, 0);
});

test('v0.4.0.3 claim preserves worker binding and tenant isolation', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_outside_worker', 'W99');
  seedTask(db, 'task_other_tenant', 'W04', { tenant_id: 'tenant_b' });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim, null);
});

test('v0.4.0.3 no eligible or cancelled task returns no work', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);

  assert.equal(await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  }), null);

  seedTask(db, 'task_cancelled', 'W04', { mission_state: 'CANCELLED' });
  assert.equal(await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  }), null);
});

test('v0.4.0.3 malformed stale candidate is skipped and next valid task is claimed', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_stale', 'W04', { createMission: false, created_at: 1 });
  seedTask(db, 'task_valid', 'W04', { created_at: 2 });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim.task.id, 'task_valid');
});

test('v0.4.0.4 expected handoff validation failure is skipped without 500', async () => {
  const db = new FakeDb();
  seedBase(db);
  await registerCommonExecutor(db);
  seedTask(db, 'task_missing_spec', 'W04', { created_at: 1 });
  db.update('tasks', 'task_missing_spec', { objective: '', title: '' });
  seedTask(db, 'task_after_bad_spec', 'W04', { created_at: 2 });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim.task.id, 'task_after_bad_spec');
});

test('v0.4.0.3 poll 500 is classified as transient and loop source retries', () => {
  const error = new Error('500 INTERNAL_SERVER_ERROR');
  error.status = 500;
  assert.equal(isTransientPollError(error), true);

  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /SHADOW POLL ERROR/);
  assert.match(source, /retrying in/);
  assert.match(source, /isTransientPollError/);
});

test('v0.4.0.4 runner API includes safe diagnostic detail in errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 500,
    ok: false,
    text: async () => JSON.stringify({
      error: 'RUNNER_CLAIM_INTERNAL_ERROR',
      detail: 'CODEX_HANDOFF_TASK_NOT_CLAIMABLE'
    })
  });

  try {
    const api = createApi({ baseUrl: 'https://mrapi.test', secret: 'test', tenantId: 'tenant_a' });
    await assert.rejects(
      () => api.request('/api/runner/next-task', { executor_id: 'executor_shadow_codex_01' }),
      (error) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, 'RUNNER_CLAIM_INTERNAL_ERROR');
        assert.equal(error.detail, 'CODEX_HANDOFF_TASK_NOT_CLAIMABLE');
        assert.match(error.message, /500 RUNNER_CLAIM_INTERNAL_ERROR: CODEX_HANDOFF_TASK_NOT_CLAIMABLE/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('v0.4.0.4 next-task route returns safe authenticated diagnostic contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'runner.routes.js'), 'utf8');

  assert.match(source, /RUNNER NEXT_TASK ERROR/);
  assert.match(source, /stack: error\.stack/);
  assert.match(source, /res\.status\(500\)\.json/);
  assert.match(source, /error: 'RUNNER_CLAIM_INTERNAL_ERROR'/);
  assert.match(source, /detail: String\(error\.message \|\| 'Unexpected runner claim failure'\)\.slice\(0, 500\)/);
});

test('v0.4.0.3 Brain-only path remains unaffected', async () => {
  const db = new FakeDb();
  seedBase(db);
  db.set('missions', 'mission_brain', {
    id: 'mission_brain',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    objective: 'Brain only answer',
    preferred_worker_id: 'W04',
    state: 'READY'
  });

  const run = await dispatchMission(db, 'tenant_a', 'mission_brain');
  const result = await completeBrainRun(db, 'tenant_a', run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false,"execution_type":"BRAIN_ONLY"}</MRAPI_CONTROL><MRAPI_RESULT>Final Brain answer.</MRAPI_RESULT>'
  });

  assert.equal(result.requires_execution, false);
  assert.equal(Object.values(db.collections.tasks || {}).length, 0);
  assert.equal(db.get('results', result.result_id).result_type, 'BRAIN_RESULT');
});

test('v0.4.0.3 W01 Git-only permissions remain source-controlled in worker profile', () => {
  const { WORKER_PROFILES } = require('../src/services/bootstrapData');
  const w01 = WORKER_PROFILES.find((profile) => profile.worker_code === 'W01');
  const w04 = WORKER_PROFILES.find((profile) => profile.worker_code === 'W04');

  assert.equal(w01.permissions.allow_git_commit, true);
  assert.equal(w01.permissions.allow_git_push, true);
  assert.notEqual(w04.permissions.allow_git_commit, true);
  assert.notEqual(w04.permissions.allow_git_push, true);
});
