const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dispatchMission,
  registerExecutor,
  claimNextTask,
  updateRunProgress,
  addEvidence,
  completeBrainRun,
  completeRun
} = require('../src/services/orchestration');

class FakeSnapshot {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
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
    return new FakeSnapshot(this.id, this.db.get(this.collectionName, this.id), this);
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
      .map(([id, data]) => {
        const ref = new FakeDocRef(this.db, this.collectionName, id);
        return new FakeSnapshot(id, data, ref);
      });

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

function seedScopedMission(db) {
  db.set('projects', 'project_scb_development', {
    id: 'project_scb_development',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    state: 'IDLE'
  });
  db.set('missions', 'mission_full_flow', {
    id: 'mission_full_flow',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    preferred_worker_id: 'W01',
    objective: 'Verify automated local v0.3.4 flow',
    priority: 'HIGH',
    state: 'READY'
  });
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function byType(db, type) {
  return values(db, 'runs').filter((run) => run.run_type === type);
}

function assertScope(object) {
  assert.equal(object.tenant_id, 'tenant_facundo_group');
  assert.equal(object.workspace_id, 'workspace_scb');
  assert.equal(object.project_id, 'project_scb_development');
}

test('automated local v0.3.4 Mission to final Result flow completes without manual stages', async () => {
  const db = new FakeDb();
  seedScopedMission(db);

  await registerExecutor(db, 'tenant_facundo_group', {
    executor_id: 'codex_shadow',
    worker_ids: ['W01'],
    host_name: 'Shadow',
    runner_version: 'local-test'
  });
  await registerExecutor(db, 'tenant_other', {
    executor_id: 'codex_other',
    worker_ids: ['W01'],
    host_name: 'OtherHost'
  });

  const brainRun = await dispatchMission(db, 'tenant_facundo_group', 'mission_full_flow');
  const duplicateDispatch = await dispatchMission(db, 'tenant_facundo_group', 'mission_full_flow');

  assert.equal(brainRun.run_type, 'BRAIN_RUN');
  assert.equal(duplicateDispatch.reused, true);
  assert.equal(duplicateDispatch.id, brainRun.id);
  assert.equal(byType(db, 'BRAIN_RUN').length, 1);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(await claimNextTask(db, 'tenant_facundo_group', 'codex_shadow'), null);

  const brainCompletion = await completeBrainRun(db, 'tenant_facundo_group', brainRun.id, {
    summary: 'Structured Brain plan ready',
    output_text: 'Create one local Codex task and keep deployment manual.',
    objective: 'Complete the local v0.3.4 execution phase',
    worker_id: 'W01',
    task_spec: {
      title: 'Complete full-flow verification',
      objective: 'Prove Mission to final Result lifecycle locally',
      instructions: 'Exercise local services only, persist evidence, run tests, and do not deploy.'
    },
    execution_constraints: {
      no_deploy: true,
      no_gcp: true,
      no_cloud_run: true,
      deployment: 'HUMAN_MANUAL_DEPLOY'
    },
    brain_chat_url: 'local://brain-adapter/full-flow'
  });

  await assert.rejects(
    () => completeBrainRun(db, 'tenant_facundo_group', brainRun.id, {
      output_text: 'duplicate Brain completion'
    }),
    /BRAIN_RUN_NOT_ACTIVE/
  );

  assert.equal(byType(db, 'BRAIN_RUN').length, 1);
  assert.equal(values(db, 'tasks').length, 1);

  const task = db.get('tasks', brainCompletion.task_id);
  assert.equal(task.state, 'QUEUED');
  assert.equal(task.phase, 'EXECUTION_PENDING');
  assert.equal(task.brain_run_id, brainRun.id);
  assert.equal(task.brain_output.brain_run_id, brainRun.id);
  assertScope(task);

  const completedBrainRun = db.get('runs', brainRun.id);
  assert.equal(completedBrainRun.state, 'COMPLETED');
  assert.equal(completedBrainRun.brain_output.task_spec.title, 'Complete full-flow verification');
  assertScope(completedBrainRun);

  const missionAfterBrain = db.get('missions', 'mission_full_flow');
  assert.equal(missionAfterBrain.state, 'PLANNING');
  assert.notEqual(missionAfterBrain.state, 'COMPLETED');

  assert.equal(await claimNextTask(db, 'tenant_other', 'codex_other'), null);

  const claim = await claimNextTask(db, 'tenant_facundo_group', 'codex_shadow', {
    repository_path: 'C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-dev-orchestrator'
  });
  const duplicateClaim = await claimNextTask(db, 'tenant_facundo_group', 'codex_shadow', {
    repository_path: 'C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-dev-orchestrator'
  });

  assert.equal(duplicateClaim, null);
  assert.equal(byType(db, 'EXECUTION_RUN').length, 1);
  assert.equal(claim.run.run_type, 'EXECUTION_RUN');
  assert.equal(claim.run.brain_run_id, brainRun.id);
  assert.equal(claim.run.parent_run_id, brainRun.id);

  const handoff = claim.codex_handoff;
  assert.equal(handoff.tenant_id, 'tenant_facundo_group');
  assert.equal(handoff.mission_id, 'mission_full_flow');
  assert.equal(handoff.task_id, task.id);
  assert.equal(handoff.brain_run_id, brainRun.id);
  assert.equal(handoff.execution_run_id, claim.run.id);
  assert.equal(handoff.worker_id, 'W01');
  assert.equal(handoff.task_spec.objective, 'Prove Mission to final Result lifecycle locally');
  assert.equal(handoff.execution_constraints.no_deploy, true);
  assert.equal(handoff.execution_constraints.no_gcp, true);
  assert.equal(handoff.execution_constraints.no_cloud_run, true);
  assert.equal(handoff.execution_constraints.repository_scope, 'LOCAL_REPOSITORY_ONLY');
  assertScope(handoff);

  const executionRun = db.get('runs', claim.run.id);
  assert.equal(executionRun.run_type, 'EXECUTION_RUN');
  assert.equal(executionRun.mission_id, 'mission_full_flow');
  assert.equal(executionRun.task_id, task.id);
  assert.equal(executionRun.brain_run_id, brainRun.id);
  assertScope(executionRun);

  await updateRunProgress(db, 'tenant_facundo_group', claim.run.id, {
    progress_percent: 55,
    message: 'Local verification in progress'
  });
  const evidence = await addEvidence(db, 'tenant_facundo_group', claim.run.id, {
    type: 'LOG',
    title: 'Local test evidence',
    description: 'Progress recorded through the local evidence interface.',
    url: 'local://evidence/full-flow'
  });

  assert.equal(db.get('runs', claim.run.id).progress_percent, 55);
  assert.equal(evidence.run_id, claim.run.id);
  assert.equal(evidence.task_id, task.id);
  assert.equal(evidence.brain_run_id, brainRun.id);
  assertScope(evidence);

  assert.equal(db.get('missions', 'mission_full_flow').state, 'RUNNING');
  assert.equal(db.get('tasks', task.id).state, 'RUNNING');

  const executionCompletion = await completeRun(db, 'tenant_facundo_group', claim.run.id, {
    success: true,
    summary: 'Full local lifecycle completed',
    output: {
      changed_files: ['test/full-flow.test.js', 'src/services/orchestration.js'],
      tests: ['node --test test/full-flow.test.js']
    }
  });

  await assert.rejects(
    () => completeRun(db, 'tenant_facundo_group', claim.run.id, {
      success: true,
      summary: 'duplicate execution completion'
    }),
    /RUN_NOT_ACTIVE/
  );

  assert.equal(byType(db, 'EXECUTION_RUN').length, 1);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(values(db, 'results').filter((result) => result.result_type === 'EXECUTION_OUTPUT').length, 1);

  const finalTask = db.get('tasks', task.id);
  assert.equal(finalTask.state, 'DONE');
  assert.equal(finalTask.phase, 'COMPLETED');
  assertScope(finalTask);

  const finalMission = db.get('missions', 'mission_full_flow');
  assert.equal(finalMission.state, 'COMPLETED');
  assertScope(finalMission);

  const finalResult = db.get('results', executionCompletion.result_id);
  assert.equal(finalResult.status, 'SUCCESS');
  assert.equal(finalResult.result_type, 'EXECUTION_OUTPUT');
  assert.equal(finalResult.run_id, claim.run.id);
  assert.equal(finalResult.task_id, task.id);
  assert.equal(finalResult.brain_run_id, brainRun.id);
  assertScope(finalResult);
});
