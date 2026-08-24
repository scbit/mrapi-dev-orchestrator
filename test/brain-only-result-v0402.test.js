const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  dispatchMission,
  completeBrainRun,
  parseBrainResponse
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

function seed(db, missionId = 'mission_brain_only') {
  db.set('projects', 'project_1', {
    id: 'project_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    primary_worker_ids: ['W04']
  });
  db.set('workers', 'W04', {
    id: 'W04',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    state: 'IDLE'
  });
  db.set('missions', missionId, {
    id: missionId,
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    objective: 'Create campaign concepts',
    preferred_worker_id: 'W04',
    state: 'READY'
  });
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

test('v0.4.0.2 parser extracts tagged Brain-only result', () => {
  const parsed = parseBrainResponse(`<MRAPI_CONTROL>
{"requires_execution":false,"execution_type":"BRAIN_ONLY","task_spec":{"target_type":"MARKETING_STRATEGY"}}
</MRAPI_CONTROL>
<MRAPI_RESULT>
Campaign concept A: lead with trust.
</MRAPI_RESULT>`);

  assert.equal(parsed.requires_execution, false);
  assert.equal(parsed.execution_type, 'BRAIN_ONLY');
  assert.equal(parsed.final_result_text, 'Campaign concept A: lead with trust.');
  assert.equal(parsed.task_spec.target_type, 'MARKETING_STRATEGY');
});

test('v0.4.0.2 parser supports JSON followed by prose and final_result JSON field', () => {
  const trailing = parseBrainResponse('{"requires_execution":false,"execution_type":"BRAIN_ONLY"}\n\nFinal campaign concepts.');
  assert.equal(trailing.final_result_text, 'Final campaign concepts.');

  const finalField = parseBrainResponse(JSON.stringify({
    requires_execution: false,
    execution_type: 'BRAIN_ONLY',
    final_result: { summary: 'Structured final answer.' }
  }));
  assert.equal(finalField.final_result_text, 'Structured final answer.');
});

test('v0.4.0.2 parser extracts malformed instructions prose', () => {
  const parsed = parseBrainResponse('', {
    requires_execution: false,
    execution_type: 'BRAIN_ONLY',
    task_spec: {
      instructions: '{"requires_execution":false,"execution_type":"BRAIN_ONLY"}\n\nUseful answer accidentally placed here.'
    }
  });

  assert.equal(parsed.final_result_text, 'Useful answer accidentally placed here.');
  assert.equal(parsed.task_spec.instructions, undefined);
});

test('v0.4.0.2 Brain-only completion creates first-class Result and no Task or Execution Run', async () => {
  const db = new FakeDb();
  seed(db);
  const run = await dispatchMission(db, 'tenant_a', 'mission_brain_only');

  const completion = await completeBrainRun(db, 'tenant_a', run.id, {
    output_text: `<MRAPI_CONTROL>
{"requires_execution":false,"execution_type":"BRAIN_ONLY","task_spec":{"title":"Campaign concepts","target_type":"MARKETING_STRATEGY"}}
</MRAPI_CONTROL>
<MRAPI_RESULT>
Campaign concept A: trust-led onboarding.
Campaign concept B: proof-led launch.
</MRAPI_RESULT>`
  });

  assert.equal(completion.requires_execution, false);
  assert.equal(completion.task_id, null);
  assert.equal(db.get('missions', 'mission_brain_only').state, 'COMPLETED');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((item) => item.run_type === 'EXECUTION_RUN').length, 0);

  const result = db.get('results', completion.result_id);
  assert.equal(result.result_type, 'BRAIN_RESULT');
  assert.equal(result.brain_run_id, run.id);
  assert.equal(result.source_run_type, 'BRAIN_RUN');
  assert.match(result.content, /trust-led onboarding/);
  assert.equal(result.text, result.content);
});

test('v0.4.0.2 missing Brain-only final result blocks Mission instead of completing', async () => {
  const db = new FakeDb();
  seed(db);
  const run = await dispatchMission(db, 'tenant_a', 'mission_brain_only');

  const completion = await completeBrainRun(db, 'tenant_a', run.id, {
    output_text: '{"requires_execution":false,"execution_type":"BRAIN_ONLY","task_spec":{"target_type":"MARKETING_STRATEGY"}}'
  });

  assert.equal(completion.success, false);
  assert.equal(completion.error, 'BRAIN_RESULT_MISSING');
  assert.equal(db.get('runs', run.id).state, 'FAILED');
  assert.equal(db.get('runs', run.id).error, 'BRAIN_RESULT_MISSING');
  assert.equal(db.get('missions', 'mission_brain_only').state, 'BLOCKED');
  assert.equal(values(db, 'results').length, 0);
});

test('v0.4.0.2 execution-required flow creates Task without final prose in instructions', async () => {
  const db = new FakeDb();
  seed(db);
  const run = await dispatchMission(db, 'tenant_a', 'mission_brain_only');

  const completion = await completeBrainRun(db, 'tenant_a', run.id, {
    output_text: `<MRAPI_CONTROL>
{"requires_execution":true,"execution_type":"CODEX","task_spec":{"title":"Implement feature","objective":"Run local tests","instructions":"Edit the service and run node --test."}}
</MRAPI_CONTROL>
<MRAPI_RESULT>
This is final prose and must not become executor instructions.
</MRAPI_RESULT>`
  });

  const task = db.get('tasks', completion.task_id);
  assert.equal(task.state, 'QUEUED');
  assert.equal(task.brain_output.requires_execution, true);
  assert.equal(task.brain_output.task_spec.instructions, 'Edit the service and run node --test.');
  assert.doesNotMatch(task.brain_output.task_spec.instructions, /final prose/);
});

test('v0.4.0.2 UI reports include Brain results and render content', () => {
  const root = path.resolve(__dirname, '..');
  const artifactUi = fs.readFileSync(path.join(root, 'src', 'public', 'artifact-ui.js'), 'utf8');
  const appUi = fs.readFileSync(path.join(root, 'src', 'public', 'app.js'), 'utf8');

  assert.match(artifactUi, /BRAIN_RESULT/);
  assert.match(artifactUi, /result\.content \|\| result\.text/);
  assert.match(appUi, /BRAIN_RESULT/);
  assert.match(appUi, /result\.content \|\| result\.text/);
});
