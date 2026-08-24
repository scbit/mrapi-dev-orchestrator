const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dispatchMission,
  registerExecutor,
  claimNextTask,
  completeBrainRun,
  completeRun
} = require('../src/services/orchestration');

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

function seed(db, tenantId = 'tenant_a') {
  db.set('projects', 'project_1', {
    id: 'project_1',
    tenant_id: tenantId,
    workspace_id: 'workspace_1',
    primary_worker_ids: ['worker_1']
  });
  db.set('workers', 'worker_1', {
    id: 'worker_1',
    tenant_id: tenantId,
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    state: 'IDLE'
  });
  db.set('missions', 'mission_1', {
    id: 'mission_1',
    tenant_id: tenantId,
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    objective: 'Prueba v0.3 Brain Run',
    priority: 'HIGH',
    state: 'READY'
  });
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

test('v0.3 mission lifecycle separates Brain Run from Execution Run', async () => {
  const db = new FakeDb();
  seed(db);
  await registerExecutor(db, 'tenant_a', {
    executor_id: 'executor_1',
    worker_ids: ['worker_1'],
    host_name: 'Shadow'
  });

  const brainRun = await dispatchMission(db, 'tenant_a', 'mission_1');

  assert.equal(brainRun.run_type, 'BRAIN_RUN');
  assert.equal(brainRun.state, 'RUNNING');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(await claimNextTask(db, 'tenant_a', 'executor_1'), null);

  const brainCompletion = await completeBrainRun(db, 'tenant_a', brainRun.id, {
    summary: 'Plan ready',
    output_text: 'Implement the execution safely.',
    task_spec: {
      title: 'Execute Prueba v0.3 Brain Run',
      objective: 'Implement execution phase after Brain output',
      instructions: 'Use local tests only.'
    },
    execution_constraints: {
      no_gcp: true,
      no_cloud_run: true,
      no_deploy: true
    }
  });

  const completedBrainRun = db.get('runs', brainRun.id);
  assert.equal(completedBrainRun.state, 'COMPLETED');
  assert.equal(completedBrainRun.brain_output.objective, 'Prueba v0.3 Brain Run');
  assert.equal(completedBrainRun.brain_output.worker_id, 'worker_1');
  assert.equal(completedBrainRun.brain_output.brain_run_id, brainRun.id);

  const task = db.get('tasks', brainCompletion.task_id);
  assert.equal(task.state, 'QUEUED');
  assert.equal(task.phase, 'EXECUTION_PENDING');
  assert.equal(task.brain_run_id, brainRun.id);
  assert.equal(task.tenant_id, 'tenant_a');
  assert.equal(task.workspace_id, 'workspace_1');
  assert.equal(task.project_id, 'project_1');

  const brainOutputResult = db.get('results', brainCompletion.result_id);
  assert.equal(brainOutputResult.result_type, 'BRAIN_OUTPUT');
  assert.equal(brainOutputResult.output.brain_run_id, brainRun.id);

  const missionAfterBrain = db.get('missions', 'mission_1');
  assert.equal(missionAfterBrain.state, 'PLANNING');
  assert.notEqual(missionAfterBrain.state, 'COMPLETED');

  const claim = await claimNextTask(db, 'tenant_a', 'executor_1');
  assert.equal(claim.run.run_type, 'EXECUTION_RUN');
  assert.equal(claim.run.brain_run_id, brainRun.id);
  assert.equal(claim.run.parent_run_id, brainRun.id);

  const executionResult = await completeRun(db, 'tenant_a', claim.run.id, {
    success: true,
    summary: 'Execution done',
    output: { ok: true }
  });

  assert.equal(executionResult.success, true);
  assert.equal(db.get('tasks', task.id).state, 'DONE');
  assert.equal(db.get('missions', 'mission_1').state, 'COMPLETED');

  const executionOutput = db.get('results', executionResult.result_id);
  assert.equal(executionOutput.brain_run_id, brainRun.id);
  assert.equal(executionOutput.workspace_id, 'workspace_1');
  assert.equal(executionOutput.project_id, 'project_1');
});

test('claiming and completing runs remains tenant isolated', async () => {
  const db = new FakeDb();
  seed(db);
  await registerExecutor(db, 'tenant_b', {
    executor_id: 'executor_b',
    worker_ids: ['worker_1']
  });

  const brainRun = await dispatchMission(db, 'tenant_a', 'mission_1');
  await assert.rejects(
    () => completeRun(db, 'tenant_b', brainRun.id, { success: true }),
    /RUN_NOT_FOUND/
  );
  assert.equal(await claimNextTask(db, 'tenant_b', 'executor_b'), null);
});

test('generic completeRun advances Brain Run without completing Mission', async () => {
  const db = new FakeDb();
  seed(db);

  const brainRun = await dispatchMission(db, 'tenant_a', 'mission_1');
  const result = await completeRun(db, 'tenant_a', brainRun.id, {
    success: true,
    output_text: 'Brain output through generic completion'
  });

  assert.equal(result.success, true);
  assert.equal(result.brain_run_id, brainRun.id);
  assert.equal(db.get('runs', brainRun.id).state, 'COMPLETED');
  assert.equal(db.get('missions', 'mission_1').state, 'PLANNING');
  assert.equal(db.get('tasks', result.task_id).state, 'QUEUED');
});
