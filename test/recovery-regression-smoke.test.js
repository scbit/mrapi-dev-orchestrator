const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const { recoverMission, getMissionRecoveryStatus } = require('../src/services/missionRecovery');
const { resolveMilestoneRuntime, resolveRoadmapRuntime } = require('../src/services/milestoneRuntime');
const { saveMilestoneResponse, listMilestoneResponses } = require('../src/services/milestoneResponse');
const {
  createDownstreamImpactProposal,
  updateDownstreamImpactStatus
} = require('../src/services/downstreamImpact');

class Snap {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() {
    return this._data ? structuredClone(this._data) : undefined;
  }
}

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class Doc {
  constructor(db, collectionName, id) {
    this.db = db;
    this.c = collectionName;
    this.collectionName = collectionName;
    this.id = id || db.next(collectionName);
  }
  async get() {
    return new Snap(this.id, this.db.get(this.c, this.id), this);
  }
  async set(data, options = {}) {
    this.db.write('set', this.c, this.id, data, options);
  }
  async update(data) {
    this.db.write('update', this.c, this.id, data);
  }
}

class Query {
  constructor(db, collectionName, filters = [], max = null) {
    this.db = db;
    this.c = collectionName;
    this.collectionName = collectionName;
    this.filters = filters;
    this.max = max;
  }
  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.c, [...this.filters, { field, value }], this.max);
  }
  limit(max) {
    return new Query(this.db, this.c, this.filters, max);
  }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snap(id, data, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) {
    return new Doc(this.db, this.c, id);
  }
}

class Tx {
  constructor(db) {
    this.db = db;
    this.hasWritten = false;
  }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options = {}) {
    this.hasWritten = true;
    this.db.write('set', ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    this.db.write('update', ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor(seed = null) {
    this.collections = seed ? structuredClone(seed) : {};
    this.n = {};
    this.writes = [];
  }
  collection(name) {
    if (!this.collections[name]) this.collections[name] = {};
    return new Coll(this, name);
  }
  next(name) {
    this.n[name] = (this.n[name] || 0) + 1;
    return `${name}_${this.n[name]}`;
  }
  get(name, id) {
    return this.collections[name]?.[id] ? structuredClone(this.collections[name][id]) : null;
  }
  set(name, id, data, options = {}) {
    if (!this.collections[name]) this.collections[name] = {};
    this.collections[name][id] = options.merge
      ? { ...(this.collections[name][id] || {}), ...structuredClone(data) }
      : structuredClone(data);
  }
  write(method, collectionName, id, data, options = {}) {
    this.writes.push({ method, collectionName, id, data: structuredClone(data), options });
    this.set(collectionName, id, data, options);
  }
  update(name, id, data) {
    if (!this.collections[name]?.[id]) throw new Error('NOT_FOUND');
    this.collections[name][id] = { ...this.collections[name][id], ...structuredClone(data) };
  }
  async runTransaction(fn) {
    return fn(new Tx(this));
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function snapshotRoadmapShape(db, roadmapId = 'roadmap_a') {
  const roadmap = db.get('roadmaps', roadmapId);
  return {
    id: roadmap.id,
    milestone_ids: roadmap.milestones.map((item) => item.id),
    orders: roadmap.milestones.map((item) => item.order),
    depends_on: roadmap.milestones.map((item) => item.depends_on || []),
    dependencies: roadmap.milestones.map((item) => item.dependencies || []),
    downstream: roadmap.milestones.slice(2).map((item) => structuredClone(item))
  };
}

function seedProject(db) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    default_worker_id: 'W01',
    repository_full_name: 'scbit/mrapi-dev-orchestrator',
    local_path: 'C:/repo'
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'IDLE'
  });
}

function baseRoadmap(milestoneOverrides = {}, roadmapOverrides = {}) {
  return {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Recovery Smoke Roadmap',
    objective: 'Validate recovery semantics',
    state: 'BLOCKED',
    proposal_type: 'PLANNER_ROADMAP',
    approval_status: 'APPROVED',
    milestones: [
      { id: 'm0', title: 'Done', objective: 'Done', description: 'Done', state: 'COMPLETED', order: 1, depends_on: [], dependencies: [] },
      {
        id: 'm1',
        title: 'Current',
        objective: 'Recover current milestone',
        description: 'Current desc',
        state: 'BLOCKED',
        order: 2,
        depends_on: ['m0'],
        dependencies: ['m0'],
        mission_id: 'mission_a',
        ...milestoneOverrides
      },
      { id: 'm2', title: 'Later one', objective: 'Later one', description: 'Later one desc', state: 'PENDING', order: 3, depends_on: ['m1'], dependencies: ['m1'], acceptance: ['preserve m2'] },
      { id: 'm3', title: 'Later two', objective: 'Later two', description: 'Later two desc', state: 'PENDING', order: 4, depends_on: ['m2'], dependencies: ['m2'], acceptance: ['preserve m3'] }
    ],
    ...roadmapOverrides
  };
}

function seedMission(db, overrides = {}, milestoneOverrides = {}, roadmapOverrides = {}) {
  db.set('roadmaps', 'roadmap_a', baseRoadmap(milestoneOverrides, roadmapOverrides));
  db.set('missions', overrides.id || 'mission_a', {
    id: overrides.id || 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    objective: 'Recover this exact mission',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    brain_context: { existing: 'keep' },
    ...overrides
  });
}

function seedBrainFailure(db) {
  seedMission(db, { blocker_code: 'BRAIN_RESULT_MISSING', retry_count: 0 }, {}, { state: 'ACTIVE' });
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'FAILED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    attempt: 1,
    created_at: new Date('2026-01-01T00:00:00Z')
  });
}

function seedExecutionFailure(db) {
  seedProject(db);
  seedMission(db, {
    state: 'FAILED',
    failure_code: 'EXECUTION_FAILED',
    blocker_code: 'REQUIRED_TEST_FAILED',
    blocker_message: 'fatal: detected dubious ownership in repository at C:/repo; configure safe.directory',
    approved_execution_snapshot_id: 'snapshot_a',
    current_plan_revision_id: 'plan_a',
    brain_run_id: 'brain_a',
    current_task_id: 'task_failed'
  }, { state: 'FAILED', blocker_code: 'REQUIRED_TEST_FAILED' }, { state: 'ACTIVE' });
  db.set('runs', 'brain_a', {
    id: 'brain_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'COMPLETED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    created_at: new Date('2026-01-01T00:00:00Z')
  });
  db.set('runs', 'exec_failed', {
    id: 'exec_failed',
    tenant_id: 'tenant_a',
    run_type: 'EXECUTION_RUN',
    mission_id: 'mission_a',
    task_id: 'task_failed',
    state: 'FAILED',
    error: 'fatal: detected dubious ownership in repository at C:/repo',
    output: {
      required_tests: [{
        command: 'node --test test/recovery-regression-smoke.test.js',
        passed: false,
        stderr: 'fatal: detected dubious ownership in repository at C:/repo'
      }]
    },
    created_at: new Date('2026-01-02T00:00:00Z')
  });
  db.set('execution_snapshots', 'snapshot_a', {
    id: 'snapshot_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    objective: 'Retry bounded execution',
    execution_type: 'EXECUTOR',
    approved_plan_revision_id: 'plan_a',
    approved_plan_revision_number: 1,
    execution_spec: {
      title: 'Recovery smoke execution',
      objective: 'Retry after representative required-test failure',
      instructions: 'Retry the same approved execution after Git safe.directory is addressed by the host.',
      allowed_files: ['test/recovery-regression-smoke.test.js'],
      required_tests: ['node --test test/recovery-regression-smoke.test.js']
    }
  });
  db.set('tasks', 'task_failed', {
    id: 'task_failed',
    tenant_id: 'tenant_a',
    mission_id: 'mission_a',
    execution_snapshot_id: 'snapshot_a',
    current_run_id: 'exec_failed',
    attempt_count: 1,
    state: 'FAILED',
    task_spec: { required_tests: ['node --test test/recovery-regression-smoke.test.js'] }
  });
  db.set('evidence', 'ev_git_required_test', {
    id: 'ev_git_required_test',
    tenant_id: 'tenant_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    mission_id: 'mission_a',
    type: 'EXECUTION_FAILURE',
    title: 'Required test failed',
    summary: 'Git safe.directory / dubious ownership blocked required tests.',
    created_at: new Date('2026-01-02T00:00:00Z')
  });
}

function createResolvedCheckpoint() {
  return {
    checkpoint_id: 'checkpoint_a',
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    paused_from_phase: 'PROGRAM',
    human_action_required: false,
    mission_id: 'mission_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    brain_run_id: 'brain_a'
  };
}

function createPlannerHarness(fetchImpl = async (url) => {
  if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
  if (url === '/api/planner/recent?limit=10') return response({ items: [] });
  if (url === '/api/missions') return response({ items: [] });
  return response({});
}) {
  const routePath = require.resolve('../src/routes/planner.ui.routes');
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpressExact();
    return originalLoad.call(this, request, parent, isMain);
  };
  let html;
  try {
    html = require('../src/routes/planner.ui.routes').plannerPageHtml();
  } finally {
    Module._load = originalLoad;
  }
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const context = {
    document,
    fetch: fetchImpl,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    encodeURIComponent,
    String,
    Boolean,
    Number,
    Array,
    Error,
    Date,
    JSON,
    Set,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  renderProposal,
  renderMissionsRecovery,
  loadMissionsRecovery
};`, context);
  return context.__planner;
}

function createMiniExpressExact() {
  function Router() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        if (route.path !== req.url.split('?')[0]) continue;
        return route.handler(req, res, next);
      }
      return next();
    };
    for (const method of ['get', 'post']) {
      router[method] = (routePath, handler) => routes.push({ method: method.toUpperCase(), path: routePath, handler });
    }
    return router;
  }
  return { Router };
}

function createElement(id) {
  const classes = new Set([
    'approveRoadmap',
    'requestChanges',
    'startAutopilot',
    'requestChangesView',
    'proposalView',
    'startView'
  ].includes(id) ? ['hidden'] : []);
  const children = new Map();
  return {
    id,
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    listeners: {},
    dataset: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    reset() { this.value = ''; },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, createElement(selector));
      return children.get(selector);
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    }
  };
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'planner page script must exist');
  return match[1];
}

function proposalFromRoadmap(roadmap, runtime) {
  return {
    roadmap_id: roadmap.id,
    title: roadmap.title,
    state: roadmap.state,
    approval_status: 'APPROVED',
    objective: roadmap.objective,
    summary: 'Runtime after refresh',
    risks: [],
    dependencies: [],
    assumptions: [],
    milestone_runtime: runtime,
    milestones: roadmap.milestones
  };
}

test('recoverable Git safe.directory required-test execution failure retries same Mission once', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  assert.equal(counts(db).missions, 1);

  const roadmap = db.get('roadmaps', 'roadmap_a');
  const beforeRuntime = await resolveMilestoneRuntime(db, 'tenant_a', roadmap, roadmap.milestones[1]);
  assert.equal(beforeRuntime.mission_id, 'mission_a');
  assert.equal(beforeRuntime.mission_state, 'FAILED');
  assert.equal(beforeRuntime.execution_run.id, 'exec_failed');
  assert.equal(beforeRuntime.latest_evidence.id, 'ev_git_required_test');
  assert.equal(beforeRuntime.recovery.mode, 'EXECUTION_RETRY');

  const before = counts(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const afterFirst = counts(db);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  const retryTask = db.get('tasks', first.result.task_id);

  assert.equal(first.mode, 'EXECUTION_RETRY');
  assert.equal(first.mission_id, 'mission_a');
  assert.equal(first.result.mission_id, 'mission_a');
  assert.equal(retryTask.mission_id, 'mission_a');
  assert.equal(retryTask.retry_of_task_id, 'task_failed');
  assert.equal(retryTask.attempt_count, 2);
  assert.deepEqual(retryTask.task_spec.required_tests, ['node --test test/recovery-regression-smoke.test.js']);
  assert.deepEqual(afterFirst, { ...before, missions: before.missions, tasks: before.tasks + 1 });
  assert.equal(second.mode, 'NO_ACTION');
  assert.equal(second.reason, 'MISSION_STATE_HEALTHY_OR_TERMINAL');
  assert.deepEqual(counts(db), afterFirst);
  assert.equal(values(db, 'missions').filter((mission) => mission.id === 'mission_a').length, 1);
});

test('Brain failure replay keeps same mission and repeated active recovery reuses active replay', async () => {
  const db = new DB();
  seedBrainFailure(db);
  const before = counts(db);

  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const replayRun = db.get('runs', first.brain_run_id);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');

  assert.equal(first.mode, 'BRAIN_REPLAY');
  assert.equal(first.mission_id, 'mission_a');
  assert.equal(first.retry_of_run_id, 'brain_failed');
  assert.equal(replayRun.mission_id, 'mission_a');
  assert.equal(replayRun.parent_run_id, 'brain_failed');
  assert.equal(replayRun.retry_of_run_id, 'brain_failed');
  assert.equal(replayRun.recovery_replay, true);
  assert.equal(counts(db).missions, before.missions);
  assert.equal(counts(db).brainRuns, before.brainRuns + 1);
  assert.equal(second.mode, 'NO_ACTION');
  assert.equal(second.reason, 'MISSION_HAS_ACTIVE_RUN');
  assert.equal(counts(db).brainRuns, before.brainRuns + 1);
  assert.equal(counts(db).missions, before.missions);
});

test('resolved Human Action recovery resumes same Mission, Roadmap, and milestone idempotently', async () => {
  const db = new DB();
  const checkpoint = createResolvedCheckpoint();
  seedMission(db, {
    state: 'PLANNING',
    human_action_required: false,
    human_action_checkpoint: checkpoint,
    brain_run_id: 'brain_a'
  }, {
    state: 'NEED_HUMAN_ACTION',
    human_action_checkpoint: checkpoint,
    human_action_required: false
  });
  db.set('runs', 'brain_a', {
    id: 'brain_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'COMPLETED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    worker_id: 'W01',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    brain_output: {
      objective: 'Continue after human checkpoint',
      worker_id: 'W01',
      requires_execution: true,
      execution_type: 'EXECUTOR',
      task_spec: {
        title: 'Continue',
        objective: 'Continue same mission',
        instructions: 'Resume the same mission.'
      }
    }
  });
  const before = counts(db);

  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const afterFirst = counts(db);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  const task = db.get('tasks', first.task_id);
  const mission = db.get('missions', 'mission_a');
  const milestone = db.get('roadmaps', 'roadmap_a').milestones[1];

  assert.equal(first.mode, 'HUMAN_ACTION_RESUME');
  assert.equal(first.mission_id, 'mission_a');
  assert.equal(first.roadmap_id, 'roadmap_a');
  assert.equal(first.milestone_id, 'm1');
  assert.equal(task.mission_id, 'mission_a');
  assert.equal(mission.roadmap_id, 'roadmap_a');
  assert.equal(mission.milestone_id, 'm1');
  assert.equal(milestone.mission_id, 'mission_a');
  assert.equal(milestone.human_action_checkpoint.continuation_task_id, first.task_id);
  assert.equal(afterFirst.missions, before.missions);
  assert.equal(afterFirst.tasks, before.tasks + 1);
  assert.equal(second.mode, 'NO_ACTION');
  assert.deepEqual(counts(db), afterFirst);
});

test('RESPONDER persists trusted scoped evidence only and feeds subsequent same-Mission Brain replay', async () => {
  const db = new DB();
  seedBrainFailure(db);
  db.set('tasks', 'task_old', { id: 'task_old', tenant_id: 'tenant_a', mission_id: 'mission_a' });
  db.set('runs', 'exec_old', { id: 'exec_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'EXECUTION_RUN' });
  const before = counts(db);

  const saved = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Use this response during replay.' });
  const afterResponse = counts(db);
  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);
  const reloaded = new DB(db.collections);
  const responses = await listMilestoneResponses(reloaded, 'tenant_a', 'roadmap_a', 'm1', {
    missionId: 'mission_a',
    includePremission: true
  });

  assert.equal(saved.type, 'MILESTONE_HUMAN_RESPONSE');
  assert.equal(saved.mission_id, 'mission_a');
  assert.deepEqual(afterResponse, before);
  assert.equal(replay.mode, 'BRAIN_REPLAY');
  assert.equal(run.mission_id, 'mission_a');
  assert.equal(run.brain_context.existing, 'keep');
  assert.deepEqual(run.brain_context.milestone_human_responses.map((item) => item.text), ['Use this response during replay.']);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].evidence_id, saved.evidence_id);
});

test('pre-Mission RESPONDER survives later legitimate Mission creation without evidence mutation', async () => {
  const db = new DB();
  db.set('roadmaps', 'roadmap_a', baseRoadmap({ mission_id: null, state: 'PENDING' }, { state: 'ACTIVE' }));
  const before = counts(db);

  const saved = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Pre-Mission context' });
  const originalEvidence = db.get('evidence', saved.evidence_id);
  assert.equal(saved.mission_id, null);
  assert.deepEqual(counts(db), before);

  db.set('roadmaps', 'roadmap_a', {
    ...db.get('roadmaps', 'roadmap_a'),
    milestones: db.get('roadmaps', 'roadmap_a').milestones.map((item) => item.id === 'm1'
      ? { ...item, mission_id: 'mission_a', state: 'BLOCKED' }
      : item)
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    brain_context: { existing: 'keep' },
    blocker_code: 'BRAIN_RESULT_MISSING'
  });
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'FAILED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const responses = db.get('runs', replay.brain_run_id).brain_context.milestone_human_responses;

  assert.deepEqual(db.get('evidence', saved.evidence_id), originalEvidence);
  assert.equal(db.get('evidence', saved.evidence_id).mission_id, null);
  assert.equal(counts(db).missions, 1);
  assert.deepEqual(responses.map((item) => item.text), ['Pre-Mission context']);
});

test('downstream impact detection and approval decisions preserve downstream milestone content', async () => {
  const db = new DB();
  seedBrainFailure(db);
  const beforeShape = snapshotRoadmapShape(db);
  const beforeRoadmap = db.get('roadmaps', 'roadmap_a');
  const beforeCounts = counts(db);

  const proposal = await createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm1', {
    affected_milestone_ids: ['m2', 'm3'],
    reason: 'Current recovery changes downstream assumptions.',
    proposed_changes: { m2: { objective: 'metadata only' } }
  });
  const pending = db.get('evidence', proposal.impact_id);
  assert.equal(pending.type, 'DOWNSTREAM_IMPACT');
  assert.equal(pending.status, 'PENDING_APPROVAL');
  assert.equal(pending.mission_id, 'mission_a');
  assert.deepEqual(snapshotRoadmapShape(db), beforeShape);
  assert.deepEqual(db.get('roadmaps', 'roadmap_a'), beforeRoadmap);
  assert.deepEqual(counts(db), beforeCounts);

  await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm1', proposal.impact_id, 'APPROVED', { actor: 'human_a' });
  assert.equal(db.get('evidence', proposal.impact_id).status, 'APPROVED');
  assert.equal(db.get('evidence', proposal.impact_id).approved_by, 'human_a');
  assert.deepEqual(snapshotRoadmapShape(db), beforeShape);
  assert.deepEqual(db.get('roadmaps', 'roadmap_a'), beforeRoadmap);

  const rejectedProposal = await createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm1', {
    affected_milestone_ids: ['m3'],
    reason: 'Reject this proposal.'
  });
  await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm1', rejectedProposal.impact_id, 'REJECTED', { actor: 'human_b' });
  assert.equal(db.get('evidence', rejectedProposal.impact_id).status, 'REJECTED');
  assert.equal(db.get('evidence', rejectedProposal.impact_id).rejected_by, 'human_b');
  assert.deepEqual(snapshotRoadmapShape(db), beforeShape);
  assert.deepEqual(db.get('roadmaps', 'roadmap_a'), beforeRoadmap);
});

test('same-Mission Brain replay receives structured downstream-impact context', async () => {
  const db = new DB();
  seedBrainFailure(db);
  await createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm1', {
    affected_milestone_ids: ['m2'],
    reason: 'm2 needs reviewed assumptions.'
  });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);

  assert.equal(replay.mode, 'BRAIN_REPLAY');
  assert.equal(replay.mission_id, 'mission_a');
  assert.deepEqual(run.brain_context.downstream_impact, {
    detected: true,
    status: 'PENDING_APPROVAL',
    approval_required: true,
    impact_id: 'evidence_1',
    roadmap_id: 'roadmap_a',
    source_milestone_id: 'm1',
    mission_id: 'mission_a',
    affected_milestones: ['m2'],
    affected_milestone_ids: ['m2'],
    reason: 'm2 needs reviewed assumptions.'
  });
  assert.equal(counts(db).missions, 1);
});

test('refresh-style reconstructed runtime exposes persisted recovery, response, evidence, runs, and impact', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Durable response.' });
  await createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm1', {
    affected_milestone_ids: ['m2'],
    reason: 'Durable downstream impact.'
  });
  db.set('evidence', 'ev_git_required_test', {
    ...db.get('evidence', 'ev_git_required_test'),
    updated_at: new Date('2027-01-01T00:00:00Z')
  });

  const reloaded = new DB(db.collections);
  const roadmap = reloaded.get('roadmaps', 'roadmap_a');
  const runtime = await resolveMilestoneRuntime(reloaded, 'tenant_a', roadmap, roadmap.milestones[1]);
  const roadmapRuntime = await resolveRoadmapRuntime(reloaded, 'tenant_a', roadmap);
  const status = await getMissionRecoveryStatus(reloaded, 'tenant_a', 'mission_a');

  assert.equal(runtime.mission_id, 'mission_a');
  assert.equal(runtime.brain_run.id, 'brain_a');
  assert.equal(runtime.execution_run.id, 'exec_failed');
  assert.equal(runtime.latest_evidence.id, 'ev_git_required_test');
  assert.equal(runtime.latest_human_response.text, 'Durable response.');
  assert.equal(runtime.downstream_impact.status, 'PENDING_APPROVAL');
  assert.equal(runtime.recovery.mode, 'EXECUTION_RETRY');
  assert.equal(status.mode, 'EXECUTION_RETRY');
  assert.equal(roadmapRuntime[1].mission_id, 'mission_a');
  assert.equal(roadmapRuntime[1].latest_human_response.text, 'Durable response.');
  assert.equal(roadmapRuntime[1].downstream_impact.reason, 'Durable downstream impact.');
});

test('Roadmap UI after trusted refetch renders recovery action, blocker, evidence, response, and same mission_id', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Render this durable response.' });
  await createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm1', {
    affected_milestone_ids: ['m2'],
    reason: 'Render downstream impact.'
  });
  db.set('evidence', 'ev_git_required_test', {
    ...db.get('evidence', 'ev_git_required_test'),
    updated_at: new Date('2027-01-01T00:00:00Z')
  });
  const reloaded = new DB(db.collections);
  const roadmap = reloaded.get('roadmaps', 'roadmap_a');
  const runtime = await resolveRoadmapRuntime(reloaded, 'tenant_a', roadmap);
  const planner = createPlannerHarness();

  planner.renderProposal(proposalFromRoadmap(roadmap, runtime));
  const html = planner.els.proposalView.innerHTML;
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/routes/planner.ui.routes.js'), 'utf8');

  assert.match(html, /Mission ID[\s\S]*mission_a/);
  assert.match(html, /Brain Run[\s\S]*brain_a \/ COMPLETED/);
  assert.match(html, /Execution Run[\s\S]*exec_failed \/ FAILED/);
  assert.match(html, /REQUIRED_TEST_FAILED[\s\S]*fatal: detected dubious ownership/);
  assert.match(html, /Git safe\.directory \/ dubious ownership blocked required tests\.[\s\S]*ID: ev_git_required_test/);
  assert.match(html, /Render this durable response\.[\s\S]*ID: evidence_1/);
  assert.match(html, /EXECUTION_RETRY \/ recoverable/);
  assert.match(html, /data-milestone-recovery="1" data-mission-id="mission_a" data-milestone-id="m1" data-recovery-mode="EXECUTION_RETRY">Retry Execution/);
  assert.match(html, /PENDING_APPROVAL[\s\S]*m2/);
  assert.match(source, /\/api\/missions\/' \+ encodeURIComponent\(missionId\) \+ '\/recover/);
  assert.doesNotMatch(source, /\/api\/roadmaps\/' \+ encodeURIComponent\(.*\) \+ '\/advance/);
});

test('Missions UI shows blocked, failed, waiting human, retryable, and normal states distinctly', () => {
  const planner = createPlannerHarness();
  planner.state.missionsLoading = false;
  planner.state.missions = [
    { id: 'mission_blocked', objective: 'Blocked', state: 'BLOCKED', recovery: { recoverable: true, mode: 'BRAIN_REPLAY', action_label: 'Replay Brain' } },
    { id: 'mission_failed', objective: 'Failed', state: 'FAILED', recovery: { recoverable: true, mode: 'EXECUTION_RETRY', action_label: 'Retry Execution' } },
    { id: 'mission_waiting', objective: 'Waiting', state: 'WAITING_HUMAN', recovery: { recoverable: true, mode: 'HUMAN_ACTION_RESUME', action_label: 'Resume' } },
    { id: 'mission_retryable', objective: 'Retryable', state: 'RETRYABLE', recovery: { recoverable: false, mode: 'NO_ACTION' } },
    { id: 'mission_running', objective: 'Running', state: 'RUNNING' },
    { id: 'mission_planning', objective: 'Planning', state: 'PLANNING' },
    { id: 'mission_completed', objective: 'Completed', state: 'COMPLETED' }
  ];

  planner.renderMissionsRecovery();
  const html = planner.els.missionsList.innerHTML;

  for (const label of ['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'RETRYABLE', 'RUNNING', 'PLANNING', 'COMPLETED']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /mission_blocked[\s\S]*Recovery: BRAIN_REPLAY[\s\S]*Replay Brain/);
  assert.match(html, /mission_failed[\s\S]*Recovery: EXECUTION_RETRY[\s\S]*Retry Execution/);
  assert.match(html, /mission_waiting[\s\S]*Recovery: HUMAN_ACTION_RESUME[\s\S]*Resume/);
  assert.match(html, /mission_retryable[\s\S]*Recovery: NO_ACTION/);
});
