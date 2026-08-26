const test = require('node:test');
const assert = require('node:assert/strict');
const { RUN_TYPES } = require('../src/constants/runTypes');
const { EVIDENCE_TYPES } = require('../src/constants/evidenceTypes');
const { completeBrainRun } = require('../src/services/orchestration');

test('v0.2 includes execution run and evidence primitives', () => {
  assert.ok(RUN_TYPES.includes('EXECUTION_RUN'));
  assert.ok(EVIDENCE_TYPES.includes('LOG'));
  assert.ok(EVIDENCE_TYPES.includes('SCREENSHOT'));
  assert.ok(EVIDENCE_TYPES.includes('TEST_RESULT'));
});

test('runner security env is represented in example config', () => {
  const fs = require('fs');
  const env = fs.readFileSync(require('path').join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /RUNNER_SHARED_SECRET/);
  assert.match(env, /MRAPI_RUNNER_SECRET/);
});

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

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

test('non-Planner Brain completion still creates an execution Task', async () => {
  const db = new FakeDb();
  db.set('missions', 'mission_1', {
    id: 'mission_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    objective: 'Existing execution behavior',
    preferred_worker_id: 'W01',
    state: 'PLANNING'
  });
  db.set('runs', 'run_1', {
    id: 'run_1',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_1',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    worker_id: 'W01',
    state: 'RUNNING',
    objective: 'Existing execution behavior'
  });

  const result = await completeBrainRun(db, 'tenant_a', 'run_1', {
    output_text: 'Implement existing work.',
    task_spec: {
      title: 'Existing task',
      objective: 'Preserve existing behavior',
      instructions: 'Run local tests.'
    }
  });

  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(values(db, 'tasks')[0].state, 'QUEUED');
  assert.equal(result.task_id, values(db, 'tasks')[0].id);
});
