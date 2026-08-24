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
    if (!this.collections[collectionName]) this.collections[collectionName] = {};
    const existing = this.collections[collectionName][id] || {};
    this.collections[collectionName][id] = options.merge ? { ...existing, ...data } : { ...data };
  }

  update(collectionName, id, data) {
    if (!this.collections[collectionName]?.[id]) throw new Error('NOT_FOUND');
    this.collections[collectionName][id] = { ...this.collections[collectionName][id], ...data };
  }

  async runTransaction(fn) {
    return fn(new FakeTransaction());
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
  db.set('tasks', id, {
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
  });
}

async function registerCommonExecutor(db, tenantId = 'tenant_a') {
  return registerExecutor(db, tenantId, {
    executor_id: 'executor_shadow_codex_01',
    runner_version: 'v0.4.0.3',
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

test('v0.4.0.3 poll 500 is classified as transient and loop source retries', () => {
  const error = new Error('500 INTERNAL_SERVER_ERROR');
  error.status = 500;
  assert.equal(isTransientPollError(error), true);

  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /SHADOW POLL ERROR/);
  assert.match(source, /retrying in/);
  assert.match(source, /isTransientPollError/);
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
