const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal
} = require('../src/services/planner');
const {
  claimNextTask,
  completeBrainRun,
  cancelMission
} = require('../src/services/orchestration');
const { startNextRoadmapMilestone } = require('../src/services/autopilot');

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
      .map(([id, data]) => new FakeSnapshot(id, data, new FakeDocRef(this.db, this.collectionName, id)));
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
  constructor() {
    this.hasWritten = false;
  }

  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }

  set(ref, data, options) {
    this.hasWritten = true;
    ref.db.set(ref.collectionName, ref.id, data, options);
  }

  update(ref, data) {
    this.hasWritten = true;
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

function seed(db) {
  db.set('workspaces', 'workspace_a', {
    id: 'workspace_a',
    tenant_id: 'tenant_a',
    name: 'Stored Workspace',
    description: 'Trusted workspace description'
  });
  db.set('workspaces', 'workspace_b', {
    id: 'workspace_b',
    tenant_id: 'tenant_b',
    name: 'Tenant B Workspace'
  });
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    repository_full_name: 'stored/project',
    local_path: 'C:\\stored-project',
    default_branch: 'main',
    primary_worker_ids: ['W01'],
    reusable_instructions: 'Stored project instructions only.',
    runtime_context: { package_manager: 'npm', test_command: 'node --test' }
  });
  db.set('projects', 'project_b', {
    id: 'project_b',
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_b',
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    state: 'IDLE'
  });
  db.set('executors', 'executor_1', {
    id: 'executor_1',
    tenant_id: 'tenant_a',
    worker_ids: ['W01'],
    state: 'ONLINE'
  });
}

function proposal(overrides = {}) {
  return {
    title: 'Roadmap Builder',
    objective: 'Produce a reviewable implementation roadmap.',
    summary: 'The roadmap decomposes the planner request into proposed milestones only.',
    risks: ['Approval flow is intentionally out of scope'],
    dependencies: ['Stored project context'],
    assumptions: ['A human will review the proposal later'],
    milestones: [
      {
        id: 'm1',
        title: 'Analyze Request',
        objective: 'Identify the project-specific planning scope.',
        description: 'Use the trusted request and stored project context to bound the roadmap.',
        executor_required: false,
        dependencies: [],
        risks: ['Context may be incomplete'],
        success_criteria: ['The original request is reflected in the proposal']
      },
      {
        id: 'm2',
        title: 'Define Builder Work',
        objective: 'Describe implementation work without approving execution.',
        description: 'Break future implementation into non-executable planning milestones.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Executor metadata could be mistaken for approval'],
        success_criteria: ['No Task is created before explicit approval']
      },
      {
        id: 'm3',
        title: 'Review Readiness',
        objective: 'Prepare the roadmap for human review.',
        description: 'Keep the proposal ordered and pending for a later approval milestone.',
        executor_required: false,
        dependencies: ['m2'],
        risks: [],
        success_criteria: ['Milestones remain in PROPOSED state']
      }
    ],
    ...overrides
  };
}

async function readyPlanner(db, request = 'Build Planner / Roadmap Builder / W01 roadmap proposal') {
  seed(db);
  return createPlannerRequest(db, 'tenant_a', {
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request
  });
}

function assertNoExecutionSideEffects(db) {
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.codex_handoff).length, 0);
}

test('Planner Brain context includes exact request and trusted stored project context', async () => {
  const db = new FakeDb();
  const request = '  Build a W01 roadmap proposal from this exact request  ';
  const created = await readyPlanner(db, request);
  const run = db.get('runs', created.brain_run_id);

  assert.equal(run.brain_context.natural_language_request, 'Build a W01 roadmap proposal from this exact request');
  assert.deepEqual(run.brain_context.trusted_scope, {
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a'
  });
  assert.equal(run.brain_context.project_context.repository_full_name, 'stored/project');
  assert.equal(run.brain_context.project_context.reusable_instructions, 'Stored project instructions only.');
  assert.deepEqual(run.brain_context.project_context.runtime_context, {
    package_manager: 'npm',
    test_command: 'node --test'
  });
});

test('valid proposal is accepted, preserved, and returned as review-ready structure', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db, 'Build the roadmap builder');
  const accepted = await completeBrainRun(db, 'tenant_a', created.brain_run_id, {
    output_text: `<MRAPI_ROADMAP_PROPOSAL>${JSON.stringify(proposal())}</MRAPI_ROADMAP_PROPOSAL>`
  });
  const roadmap = values(db, 'roadmaps')[0];
  const retrieved = await getPlannerProposal(db, 'tenant_a', accepted.roadmap_id);

  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(roadmap.state, 'PROPOSED');
  assert.equal(roadmap.approval_status, 'PENDING');
  assert.equal(roadmap.non_executable, true);
  assert.equal(accepted.title, 'Roadmap Builder');
  assert.equal(accepted.objective, 'Produce a reviewable implementation roadmap.');
  assert.equal(accepted.summary, 'The roadmap decomposes the planner request into proposed milestones only.');
  assert.deepEqual(accepted.risks, ['Approval flow is intentionally out of scope']);
  assert.deepEqual(accepted.dependencies, ['Stored project context']);
  assert.deepEqual(accepted.assumptions, ['A human will review the proposal later']);
  assert.deepEqual(accepted.milestones.map((milestone) => milestone.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(accepted.milestones.map((milestone) => milestone.order), [1, 2, 3]);
  assert.deepEqual(accepted.milestones[1], {
    id: 'm2',
    title: 'Define Builder Work',
    objective: 'Describe implementation work without approving execution.',
    expected_outcome: 'Describe implementation work without approving execution.',
    description: 'Break future implementation into non-executable planning milestones.',
    executor_required: true,
    dependencies: ['m1'],
    depends_on: ['m1'],
    risks: ['Executor metadata could be mistaken for approval'],
    success_criteria: ['No Task is created before explicit approval'],
    state: 'PROPOSED',
    order: 2
  });
  assert.equal(roadmap.original_request, 'Build the roadmap builder');
  assert.equal(roadmap.source_planner_mission_id, created.mission_id);
  assert.equal(roadmap.source_planner_brain_run_id, created.brain_run_id);
  assert.equal(roadmap.tenant_id, 'tenant_a');
  assert.equal(roadmap.workspace_id, 'workspace_a');
  assert.equal(roadmap.project_id, 'project_a');
  assert.equal(retrieved.provenance.original_request, 'Build the roadmap builder');
  assert.equal(retrieved.mission_id, created.mission_id);
  assert.equal(retrieved.brain_run_id, created.brain_run_id);
  assert.deepEqual(retrieved.milestones.map((milestone) => milestone.title), [
    'Analyze Request',
    'Define Builder Work',
    'Review Readiness'
  ]);
  assertNoExecutionSideEffects(db);
});

test('malformed proposals are rejected atomically with validation evidence', async () => {
  const invalidCases = [
    ['empty title', proposal({ title: '   ' }), /PLANNER_PROPOSAL_TITLE_REQUIRED/],
    ['empty objective', proposal({ objective: '' }), /PLANNER_PROPOSAL_OBJECTIVE_REQUIRED/],
    ['empty summary', proposal({ summary: ' ' }), /PLANNER_PROPOSAL_SUMMARY_REQUIRED/],
    ['missing milestones', proposal({ milestones: undefined }), /PLANNER_PROPOSAL_MILESTONES_REQUIRED/],
    ['empty milestones', proposal({ milestones: [] }), /PLANNER_PROPOSAL_MILESTONES_REQUIRED/],
    ['duplicate ids', proposal({ milestones: [proposal().milestones[0], { ...proposal().milestones[1], id: 'm1' }] }), /PLANNER_PROPOSAL_DUPLICATE_MILESTONE_ID/],
    ['unknown dependency', proposal({ milestones: [proposal().milestones[0], { ...proposal().milestones[1], dependencies: ['missing'] }] }), /PLANNER_PROPOSAL_UNKNOWN_DEPENDENCY/],
    ['self dependency', proposal({ milestones: [{ ...proposal().milestones[0], dependencies: ['m1'] }] }), /PLANNER_PROPOSAL_SELF_DEPENDENCY/],
    ['cyclic dependencies', proposal({ milestones: [{ ...proposal().milestones[0], dependencies: ['m2'] }, { ...proposal().milestones[1], dependencies: ['m1'] }] }), /PLANNER_PROPOSAL_CYCLIC_DEPENDENCIES/],
    ['missing executor required', proposal({ milestones: [{ ...proposal().milestones[0], executor_required: undefined }] }), /PLANNER_PROPOSAL_EXECUTOR_REQUIRED_REQUIRED/],
    ['non boolean executor required', proposal({ milestones: [{ ...proposal().milestones[0], executor_required: 'true' }] }), /PLANNER_PROPOSAL_EXECUTOR_REQUIRED_REQUIRED/],
    ['empty milestone title', proposal({ milestones: [{ ...proposal().milestones[0], title: '' }] }), /PLANNER_PROPOSAL_MILESTONE_TITLE_REQUIRED/],
    ['empty milestone objective', proposal({ milestones: [{ ...proposal().milestones[0], objective: ' ' }] }), /PLANNER_PROPOSAL_MILESTONE_OBJECTIVE_REQUIRED/],
    ['empty milestone description', proposal({ milestones: [{ ...proposal().milestones[0], description: '' }] }), /PLANNER_PROPOSAL_MILESTONE_DESCRIPTION_REQUIRED/],
    ['missing success criteria', proposal({ milestones: [{ ...proposal().milestones[0], success_criteria: undefined }] }), /PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA_MUST_BE_ARRAY/],
    ['empty success criteria', proposal({ milestones: [{ ...proposal().milestones[0], success_criteria: [] }] }), /PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA_REQUIRED/],
    ['malformed risks array', proposal({ risks: ['ok', 1] }), /PLANNER_PROPOSAL_RISKS_MUST_BE_ARRAY_OF_STRINGS/]
  ];

  for (const [name, invalidProposal, pattern] of invalidCases) {
    const db = new FakeDb();
    const created = await readyPlanner(db, `Invalid ${name}`);
    await assert.rejects(
      () => completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, { proposal: invalidProposal }),
      pattern
    );
    assert.equal(values(db, 'roadmaps').length, 0, name);
    assertNoExecutionSideEffects(db);
    assert.equal(db.get('missions', created.mission_id).state, 'BLOCKED', name);
    assert.equal(db.get('missions', created.mission_id).blocker_stage, 'PLANNER_PROPOSAL_VALIDATION', name);
    assert.match(db.get('runs', created.brain_run_id).error, /PLANNER_PROPOSAL_/, name);
  }
});

test('executor_required proposal metadata creates no execution and cannot start before approval', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const accepted = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal()
  });

  assert.equal(accepted.milestones.some((milestone) => milestone.executor_required), true);
  assertNoExecutionSideEffects(db);
  assert.equal(await claimNextTask(db, 'tenant_a', 'executor_1'), null);
  await assert.rejects(
    () => startNextRoadmapMilestone(db, 'tenant_a', accepted.roadmap_id),
    /ROADMAP_NOT_ACTIVE/
  );
  assertNoExecutionSideEffects(db);
});

test('replays reuse the first accepted proposal and never overwrite it', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const first = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal()
  });
  const second = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal({ title: 'Different Replay Title' })
  });

  assert.equal(first.roadmap_id, second.roadmap_id);
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'roadmaps')[0].title, 'Roadmap Builder');
  assert.equal(second.title, 'Roadmap Builder');
});

test('cancellation prevents late proposal creation and continuation', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  await cancelMission(db, 'tenant_a', created.mission_id, { reason: 'Cancelled before proposal' });

  const result = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal()
  });

  assert.equal(result.cancelled, true);
  assert.equal(values(db, 'roadmaps').length, 0);
  assertNoExecutionSideEffects(db);
});

test('Tenant B cannot complete or retrieve Tenant A proposal', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const accepted = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal()
  });

  await assert.rejects(
    () => completePlannerBrainRun(db, 'tenant_b', created.brain_run_id, { proposal: proposal() }),
    /RUN_NOT_FOUND/
  );
  await assert.rejects(
    () => getPlannerProposal(db, 'tenant_b', accepted.roadmap_id),
    /PLANNER_PROPOSAL_NOT_FOUND/
  );
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'roadmaps')[0].tenant_id, 'tenant_a');
});
