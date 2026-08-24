const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  completeRun,
  emitEvent,
  sanitizeEventPayload
} = require('../src/services/orchestration');
const { isRunAlreadyTerminalError } = require('../runner/shadow-runner');

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
    assertNoUndefined(data);
    if (!this.collections[collectionName]) this.collections[collectionName] = {};
    const existing = this.collections[collectionName][id] || {};
    this.collections[collectionName][id] = options.merge ? { ...existing, ...data } : { ...data };
  }

  update(collectionName, id, data) {
    assertNoUndefined(data);
    if (!this.collections[collectionName]?.[id]) throw new Error('NOT_FOUND');
    this.collections[collectionName][id] = { ...this.collections[collectionName][id], ...data };
  }

  async runTransaction(fn) {
    return fn(new FakeTransaction());
  }
}

function assertNoUndefined(value, pathName = 'data') {
  if (value === undefined) throw new Error(`Cannot use undefined at ${pathName}`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assertNoUndefined(item, `${pathName}.${key}`);
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function seedExecutionRun(db, overrides = {}) {
  const missionState = overrides.mission_state || 'RUNNING';
  db.set('missions', 'mission_1', {
    id: 'mission_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    state: missionState,
    cancellation_requested: overrides.cancellation_requested === true
  });
  db.set('workers', 'W04', {
    id: 'W04',
    tenant_id: 'tenant_a',
    state: 'BUSY',
    current_mission_id: 'mission_1',
    current_task_id: 'task_1'
  });
  db.set('tasks', 'task_1', {
    id: 'task_1',
    tenant_id: 'tenant_a',
    mission_id: 'mission_1',
    worker_id: 'W04',
    state: 'RUNNING',
    phase: 'EXECUTION_RUNNING'
  });
  db.set('executors', 'executor_1', {
    id: 'executor_1',
    tenant_id: 'tenant_a',
    state: 'ONLINE',
    current_run_id: 'run_1'
  });
  db.set('runs', 'run_1', {
    id: 'run_1',
    tenant_id: 'tenant_a',
    run_type: 'EXECUTION_RUN',
    state: 'RUNNING',
    mission_id: 'mission_1',
    task_id: 'task_1',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    worker_id: 'W04',
    executor_id: 'executor_1',
    brain_run_id: null,
    parent_run_id: null
  });
}

test('v0.4.0.6 successful execution completion returns cancelled false and emits event', async () => {
  const db = new FakeDb();
  seedExecutionRun(db);

  const result = await completeRun(db, 'tenant_a', 'run_1', {
    success: true,
    summary: 'Codex completed',
    output: { ok: true }
  });

  assert.equal(result.success, true);
  assert.equal(result.cancelled, false);
  assert.equal(db.get('runs', 'run_1').state, 'COMPLETED');
  assert.equal(values(db, 'results').length, 1);
  assert.equal(values(db, 'events').filter((event) => event.type === 'RUN_COMPLETED').length, 1);
});

test('v0.4.0.6 cancelled execution completion returns cancelled true', async () => {
  const db = new FakeDb();
  seedExecutionRun(db, { mission_state: 'CANCELLED', cancellation_requested: true });

  const result = await completeRun(db, 'tenant_a', 'run_1', {
    success: true,
    summary: 'Late completion'
  });

  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.equal(db.get('runs', 'run_1').state, 'FAILED');
  assert.equal(values(db, 'events').filter((event) => event.type === 'RUN_FAILED').length, 1);
});

test('v0.4.0.6 emitEvent sanitizes nested undefined without mutating payload', async () => {
  const db = new FakeDb();
  const payload = {
    top: undefined,
    nested: { keep: 'value', missing: undefined },
    list: [1, undefined, { child: undefined }]
  };
  const original = { ...payload, nested: { ...payload.nested }, list: [...payload.list] };

  const eventId = await emitEvent(db, 'tenant_a', 'TEST_EVENT', payload, 'INFO');
  const event = db.get('events', eventId);

  assert.equal(event.payload.top, null);
  assert.equal(event.payload.nested.missing, null);
  assert.equal(event.payload.list[1], null);
  assert.equal(event.payload.list[2].child, null);
  assert.equal(payload.top, original.top);
  assert.equal(payload.nested.missing, original.nested.missing);
  assert.equal(payload.list[1], original.list[1]);
});

test('v0.4.0.6 sanitizer preserves original object and Dates', () => {
  const date = new Date('2026-08-24T00:00:00Z');
  const payload = { date, nested: { missing: undefined } };
  const sanitized = sanitizeEventPayload(payload);

  assert.notEqual(sanitized, payload);
  assert.equal(sanitized.date, date);
  assert.equal(sanitized.nested.missing, null);
  assert.equal(payload.nested.missing, undefined);
});

test('v0.4.0.6 repeated terminal completion does not create duplicate Result', async () => {
  const db = new FakeDb();
  seedExecutionRun(db);

  await completeRun(db, 'tenant_a', 'run_1', {
    success: true,
    summary: 'Codex completed'
  });
  await assert.rejects(
    () => completeRun(db, 'tenant_a', 'run_1', { success: false }),
    /RUN_NOT_ACTIVE/
  );

  assert.equal(values(db, 'results').length, 1);
});

test('v0.4.0.6 runner recognizes terminal completion conflict', () => {
  const error = new Error('409 RUN_NOT_ACTIVE');
  error.status = 409;
  error.code = 'RUN_NOT_ACTIVE';

  assert.equal(isRunAlreadyTerminalError(error), true);
  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'shadow-runner.js'), 'utf8');
  assert.match(source, /SHADOW COMPLETE SKIP/);
  assert.match(source, /not sending duplicate completion/);
});
