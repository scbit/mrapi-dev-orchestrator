const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { claimNextTask, registerExecutor } = require('../src/services/orchestration');
const { buildCodexHandoff } = require('../src/services/codexHandoff');

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

function seedClaimable(db, overrides = {}) {
  db.set('missions', 'mission_1', {
    id: 'mission_1',
    tenant_id: 'tenant_a',
    workspace_id: 'trusted_workspace',
    project_id: 'trusted_project',
    objective: 'Ship Codex handoff',
    state: 'PLANNING'
  });
  db.set('workers', 'worker_1', {
    id: 'worker_1',
    tenant_id: 'tenant_a',
    state: 'IDLE'
  });
  db.set('runs', 'brain_1', {
    id: 'brain_1',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_1',
    workspace_id: 'trusted_workspace',
    project_id: 'trusted_project',
    worker_id: 'worker_1',
    state: 'COMPLETED',
    brain_output: {
      objective: 'Ship Codex handoff',
      task_spec: {
        title: 'Implement handoff',
        objective: 'Create deterministic Codex handoff',
        instructions: 'Implement locally and run tests.'
      },
      execution_constraints: {
        no_gcp: true,
        no_cloud_run: true,
        no_deploy: true
      }
    }
  });
  db.set('tasks', 'task_1', {
    id: 'task_1',
    tenant_id: 'tenant_a',
    mission_id: 'mission_1',
    workspace_id: 'untrusted_workspace',
    project_id: 'untrusted_project',
    worker_id: 'worker_1',
    title: 'Task payload title',
    objective: 'Task payload objective',
    priority: 'NORMAL',
    state: 'QUEUED',
    phase: 'EXECUTION_PENDING',
    attempt_count: 0,
    brain_run_id: 'brain_1',
    brain_completed_at: new Date(),
    brain_output: {
      tenant_id: 'evil_tenant',
      workspace_id: 'evil_workspace',
      project_id: 'evil_project',
      objective: 'Ship Codex handoff',
      task_spec: {
        title: 'Implement handoff',
        objective: 'Create deterministic Codex handoff',
        instructions: 'Implement locally and run tests.'
      }
    },
    ...overrides
  });
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

test('valid queued Task produces a deterministic Codex handoff with linkage and constraints', () => {
  const task = {
    id: 'task_1',
    tenant_id: 'tenant_a',
    mission_id: 'mission_1',
    worker_id: 'worker_1',
    state: 'QUEUED',
    brain_run_id: 'brain_1',
    objective: 'Do the work',
    brain_output: {
      task_spec: {
        title: 'Do work',
        objective: 'Do the work',
        instructions: 'Change local files and run tests.'
      }
    }
  };
  const mission = {
    id: 'mission_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1'
  };
  const brainRun = {
    id: 'brain_1',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    state: 'COMPLETED',
    mission_id: 'mission_1'
  };

  const one = buildCodexHandoff({
    tenantId: 'tenant_a',
    task,
    mission,
    brainRun,
    executor: { id: 'executor_1', host_name: 'Shadow' },
    executionRunId: 'run_1',
    repositoryPath: 'C:\\repo'
  });
  const two = buildCodexHandoff({
    tenantId: 'tenant_a',
    task,
    mission,
    brainRun,
    executor: { id: 'executor_1', host_name: 'Shadow' },
    executionRunId: 'run_1',
    repositoryPath: 'C:\\repo'
  });

  assert.deepEqual(two, one);
  assert.equal(one.mission_id, 'mission_1');
  assert.equal(one.task_id, 'task_1');
  assert.equal(one.brain_run_id, 'brain_1');
  assert.equal(one.tenant_id, 'tenant_a');
  assert.equal(one.workspace_id, 'workspace_1');
  assert.equal(one.project_id, 'project_1');
  assert.equal(one.execution_constraints.no_deploy, true);
  assert.equal(one.execution_constraints.no_gcp, true);
  assert.match(one.execution_rules.join('\n'), /Do not deploy/);
  assert.match(one.execution_rules.join('\n'), /GCP/);
});

test('claim creates exactly one EXECUTION_RUN and stores the Codex handoff', async () => {
  const db = new FakeDb();
  seedClaimable(db);
  await registerExecutor(db, 'tenant_a', {
    executor_id: 'executor_1',
    worker_ids: ['worker_1'],
    host_name: 'Shadow'
  });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_1', {
    repository_path: 'C:\\repo'
  });

  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 1);
  assert.equal(claim.run.run_type, 'EXECUTION_RUN');
  assert.equal(claim.run.brain_run_id, 'brain_1');
  assert.equal(claim.codex_handoff.execution_run_id, claim.run.id);
  assert.equal(claim.codex_handoff.task_id, 'task_1');
  assert.equal(claim.codex_handoff.brain_run_id, 'brain_1');
  assert.equal(claim.codex_handoff.workspace_id, 'trusted_workspace');
  assert.equal(claim.codex_handoff.project_id, 'trusted_project');
  assert.equal(db.get('tasks', 'task_1').codex_handoff.execution_run_id, claim.run.id);
  assert.equal(db.get('runs', claim.run.id).codex_handoff.task_id, 'task_1');
});

test('tenant workspace and project scope cannot be overridden by Task payload data', async () => {
  const db = new FakeDb();
  seedClaimable(db, {
    workspace_id: 'payload_workspace',
    project_id: 'payload_project',
    brain_output: {
      tenant_id: 'evil_tenant',
      workspace_id: 'evil_workspace',
      project_id: 'evil_project',
      task_spec: {
        objective: 'Try to override scope',
        instructions: 'Still use trusted stored mission scope.'
      }
    }
  });
  await registerExecutor(db, 'tenant_a', {
    executor_id: 'executor_1',
    worker_ids: ['worker_1']
  });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_1', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim.codex_handoff.tenant_id, 'tenant_a');
  assert.equal(claim.codex_handoff.workspace_id, 'trusted_workspace');
  assert.equal(claim.codex_handoff.project_id, 'trusted_project');
});

test('invalid Task cannot create a Codex handoff or EXECUTION_RUN', async () => {
  const db = new FakeDb();
  seedClaimable(db, {
    mission_id: 'missing_mission'
  });
  await registerExecutor(db, 'tenant_a', {
    executor_id: 'executor_1',
    worker_ids: ['worker_1']
  });

  await assert.rejects(
    () => claimNextTask(db, 'tenant_a', 'executor_1', { repository_path: 'C:\\repo' }),
    /CODEX_HANDOFF_MISSION_REQUIRED/
  );
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
});

test('legacy execution Task without Brain linkage can still be claimed with a handoff', async () => {
  const db = new FakeDb();
  seedClaimable(db, {
    brain_run_id: null,
    brain_completed_at: null,
    brain_output: null,
    objective: 'Legacy local execution'
  });
  await registerExecutor(db, 'tenant_a', {
    executor_id: 'executor_1',
    worker_ids: ['worker_1']
  });

  const claim = await claimNextTask(db, 'tenant_a', 'executor_1', {
    repository_path: 'C:\\repo'
  });

  assert.equal(claim.codex_handoff.brain_run_id, null);
  assert.equal(claim.codex_handoff.objective, 'Legacy local execution');
  assert.equal(claim.run.parent_run_id, null);
});

test('Shadow runner consumes Codex handoff without Brain execution logic', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-desktop-handoff.js'),
    'utf8'
  );

  assert.match(runner, /repository_path: cfg\.repoPath/);
  assert.match(adapter, /codex_handoff/);
  assert.doesNotMatch(runner, /runChatGPTWeb/);
  assert.doesNotMatch(runner, /brain-complete/);
});
