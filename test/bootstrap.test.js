const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapInitialData } = require('../src/services/bootstrap');

class FakeDoc {
  constructor(store, collection, id) {
    this.store = store;
    this.collectionName = collection;
    this.id = id;
  }

  async get() {
    const value = this.store[this.collectionName]?.[this.id];
    return {
      exists: Boolean(value),
      id: this.id,
      data: () => value
    };
  }

  async set(data, options = {}) {
    this.store[this.collectionName] ||= {};
    const previous = this.store[this.collectionName][this.id] || {};
    this.store[this.collectionName][this.id] = options.merge
      ? { ...previous, ...data }
      : { ...data };
  }
}

class FakeCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }
  doc(id) { return new FakeDoc(this.store, this.name, id); }
}

class FakeDb {
  constructor() {
    this.store = {};
  }
  collection(name) { return new FakeCollection(this.store, name); }
}

test('bootstrap creates required tenant, 3 workspaces, 4 projects and 5 workers', async () => {
  const db = new FakeDb();
  await bootstrapInitialData(db);

  assert.equal(Object.keys(db.store.tenants).length, 1);
  assert.equal(Object.keys(db.store.workspaces).length, 3);
  assert.equal(Object.keys(db.store.projects).length, 4);
  assert.equal(Object.keys(db.store.worker_profiles).length, 5);
  assert.equal(Object.keys(db.store.workers).length, 5);
  assert.equal(db.store.system.primary.state, 'RUNNING');

  for (const worker of Object.values(db.store.workers)) {
    assert.equal(worker.state, 'IDLE');
    assert.equal(worker.tenant_id, 'tenant_facundo_group');
  }
});

test('bootstrap is idempotent and does not duplicate workers', async () => {
  const db = new FakeDb();
  await bootstrapInitialData(db);
  await bootstrapInitialData(db);

  assert.equal(Object.keys(db.store.workspaces).length, 3);
  assert.equal(Object.keys(db.store.projects).length, 4);
  assert.equal(Object.keys(db.store.workers).length, 5);
});

test('bootstrap does not reset live worker state', async () => {
  const db = new FakeDb();
  await bootstrapInitialData(db);
  db.store.workers.W01.state = 'BUSY';
  db.store.workers.W01.current_mission_id = 'mission_live';

  await bootstrapInitialData(db);

  assert.equal(db.store.workers.W01.state, 'BUSY');
  assert.equal(db.store.workers.W01.current_mission_id, 'mission_live');
});

test('bootstrap safely adds W01-W05 runtime fields without leaking W01 Git permissions', async () => {
  const db = new FakeDb();
  db.store.workers = {
    W01: {
      id: 'W01',
      code: 'W01',
      tenant_id: 'tenant_facundo_group',
      state: 'BUSY',
      current_mission_id: 'mission_live',
      brain_binding: { provider: 'Existing Brain' }
    }
  };

  await bootstrapInitialData(db);

  assert.deepEqual(Object.keys(db.store.workers).sort(), ['W01', 'W02', 'W03', 'W04', 'W05']);
  assert.equal(db.store.workers.W01.state, 'BUSY');
  assert.equal(db.store.workers.W01.brain_binding.provider, 'Existing Brain');

  for (const id of ['W02', 'W03', 'W04', 'W05']) {
    assert.equal(db.store.workers[id].executor_binding.provider, 'Codex');
    assert.equal(db.store.workers[id].permissions.allow_git_commit, false);
    assert.equal(db.store.workers[id].permissions.allow_git_push, false);
  }
});
