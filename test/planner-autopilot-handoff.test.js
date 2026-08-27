const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  approvePlannerRoadmap,
  startPlannerRoadmap
} = require('../src/services/planner');
const { startNextRoadmapMilestone, completeVerificationBrainRun } = require('../src/services/autopilot');
const { completeBrainRun } = require('../src/services/orchestration');

class Snap {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() { return this._data ? { ...this._data } : undefined; }
}

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class Doc {
  constructor(db, c, id) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
    this.id = id || db.next(c);
  }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(d, o = {}) { this.db.set(this.c, this.id, d, o); }
  async update(d) { this.db.update(this.c, this.id, d); }
}

class Query {
  constructor(db, c, filters = [], max = null) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
    this.filters = filters;
    this.max = max;
  }
  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.c, [...this.filters, { field, value }], this.max);
  }
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, d]) => this.filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) { return new Doc(this.db, this.c, id); }
}

class Tx {
  constructor() { this.hasWritten = false; }
  async get(x) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return x.get();
  }
  set(ref, d, o) {
    this.hasWritten = true;
    ref.db.set(ref.c || ref.collectionName, ref.id, d, o);
  }
  update(ref, d) {
    this.hasWritten = true;
    ref.db.update(ref.c || ref.collectionName, ref.id, d);
  }
}

class DB {
  constructor() {
    this.collections = {};
    this.n = {};
  }
  collection(c) {
    if (!this.collections[c]) this.collections[c] = {};
    return new Coll(this, c);
  }
  next(c) {
    this.n[c] = (this.n[c] || 0) + 1;
    return `${c}_${this.n[c]}`;
  }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) {
    if (!this.collections[c]) this.collections[c] = {};
    this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d };
  }
  update(c, id, d) {
    if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND');
    this.collections[c][id] = { ...this.collections[c][id], ...d };
  }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, c) {
  return Object.values(db.collections[c] || {});
}

function seed(db) {
  db.set('workspaces', 'workspace_a', { id: 'workspace_a', tenant_id: 'tenant_a', name: 'A' });
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    repository_full_name: 'stored/project',
    local_path: 'C:/stored',
    default_branch: 'main',
    default_worker_id: 'W01',
    primary_worker_ids: ['W01'],
    reusable_instructions: 'Preserve local contracts.'
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
}

function proposal() {
  return {
    title: 'Planner Autopilot Handoff',
    objective: 'Connect approved Planner roadmaps to Autopilot progression.',
    summary: 'The roadmap advances one dependency-eligible milestone at a time.',
    risks: ['Progression could duplicate lifecycle records'],
    dependencies: ['Existing Autopilot state machine'],
    assumptions: ['Approval already happened'],
    milestones: [
      {
        id: 'm1',
        title: 'Brain-only predecessor',
        objective: 'Record the trusted predecessor outcome.',
        description: 'Use Brain-only completion without forcing Codex.',
        executor_required: false,
        dependencies: [],
        risks: ['Could create a fake task'],
        success_criteria: ['No Task exists for Brain-only work']
      },
      {
        id: 'm2',
        title: 'Executor milestone',
        objective: 'Create a bounded Executor task after Brain planning.',
        description: 'Brain writes the validated execution package.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Could start before m1 completes'],
        success_criteria: ['Task is created only after valid Brain output']
      },
      {
        id: 'm3',
        title: 'Final Brain milestone',
        objective: 'Close the roadmap after dependencies complete.',
        description: 'Finish with a Brain-only result.',
        executor_required: false,
        dependencies: ['m2'],
        risks: [],
        success_criteria: ['Roadmap is marked complete exactly once']
      }
    ]
  };
}

function proposalWithRepositoryCleanHumanAction() {
  return {
    ...proposal(),
    auto_advance: true,
    expected_human_actions: [{
      milestone_id: 'm2',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Ensure the repository worktree is clean, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/planner/must-not-persist' }
    }]
  };
}

async function createProposed(db) {
  seed(db);
  const request = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Original trusted Planner request'
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', request.brain_run_id, { proposal: proposal() });
  return { request, roadmap };
}

async function createProposedWith(db, proposalBody, requestOverrides = {}) {
  seed(db);
  const request = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Original trusted Planner request',
    ...requestOverrides
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', request.brain_run_id, { proposal: proposalBody });
  return { request, roadmap };
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    tasks: values(db, 'tasks').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function immutableProjection(roadmap) {
  return {
    title: roadmap.title,
    objective: roadmap.objective,
    summary: roadmap.summary,
    original_request: roadmap.original_request,
    provenance: roadmap.provenance,
    milestones: roadmap.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      objective: m.objective,
      expected_outcome: m.expected_outcome,
      description: m.description,
      dependencies: m.dependencies,
      depends_on: m.depends_on,
      executor_required: m.executor_required,
      risks: m.risks,
      success_criteria: m.success_criteria,
      order: m.order
    }))
  };
}

test('unapproved Planner roadmap cannot start and approval alone creates no execution work', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);

  await assert.rejects(
    () => startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { workspace_id: 'evil', project_id: 'evil' }),
    /PLANNER_ROADMAP_NOT_STARTABLE/
  );
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });

  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });
});

test('approved Planner start enters Autopilot once with trusted scope and Brain context', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  const before = immutableProjection(db.get('roadmaps', roadmap.roadmap_id));

  const first = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, {
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_b',
    project_id: 'project_b',
    milestone_id: 'm2'
  });
  const second = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  assert.equal(first.milestone.id, 'm1');
  assert.equal(second.reused, true);
  assert.equal(second.mission.id, first.mission.id);
  assert.equal(second.brain_run.id, first.brain_run.id);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((m) => m.state), ['PLANNING', 'PENDING', 'PENDING']);
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0, executionRuns: 0 });

  const run = db.get('runs', first.brain_run.id);
  assert.equal(run.workspace_id, 'workspace_a');
  assert.equal(run.project_id, 'project_a');
  assert.equal(run.roadmap_id, roadmap.roadmap_id);
  assert.equal(run.milestone_id, 'm1');
  assert.equal(run.brain_context.roadmap.objective, proposal().objective);
  assert.equal(run.brain_context.roadmap.original_request, 'Original trusted Planner request');
  assert.equal(run.brain_context.current_milestone.title, 'Brain-only predecessor');
  assert.deepEqual(run.brain_context.current_milestone.dependencies, []);
  assert.deepEqual(run.brain_context.current_milestone.risks, ['Could create a fake task']);
  assert.deepEqual(run.brain_context.current_milestone.success_criteria, ['No Task exists for Brain-only work']);
  assert.equal(run.brain_context.current_milestone.executor_required, false);
  assert.deepEqual(immutableProjection(db.get('roadmaps', roadmap.roadmap_id)), before);
});

test('Brain-only completion does not force Codex and unlocks only dependency-satisfied next milestone', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  const started = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  const brainOnly = await completeBrainRun(db, 'tenant_a', started.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false,"execution_type":"BRAIN_ONLY"}</MRAPI_CONTROL><MRAPI_RESULT>Predecessor evidence is complete.</MRAPI_RESULT>'
  });
  assert.equal(brainOnly.requires_execution, false);
  assert.equal(values(db, 'tasks').length, 0);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((m) => m.state), ['COMPLETED', 'PENDING', 'PENDING']);

  const next = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);
  assert.equal(next.milestone.id, 'm2');
  assert.equal(next.brain_run.brain_context.completed_predecessors[0].id, 'm1');
  assert.equal(next.brain_run.brain_context.current_milestone.executor_required, true);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((m) => m.state), ['COMPLETED', 'PLANNING', 'PENDING']);
});

test('Planner proposal persists m2 Human Action prerequisite for auto-advance preflight', async () => {
  const db = new DB();
  const { roadmap } = await createProposedWith(db, proposalWithRepositoryCleanHumanAction(), { auto_advance: true });
  const persistedM2 = db.get('roadmaps', roadmap.roadmap_id).milestones.find((milestone) => milestone.id === 'm2');
  assert.deepEqual(persistedM2.execution_prerequisites, [{
    type: 'MANUAL_HUMAN',
    name: 'repository_clean',
    human_action_request: 'Clean the repository worktree before continuing.',
    user_action: 'Ensure the repository worktree is clean, then press LISTO.',
    action_location: 'project repository',
    validation_method: 'git_worktree_clean'
  }]);
});

test('executor-required milestone creates no Task before valid Brain planning then uses existing Task path', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  const first = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);
  await completeBrainRun(db, 'tenant_a', first.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false}</MRAPI_CONTROL><MRAPI_RESULT>m1 done.</MRAPI_RESULT>'
  });
  const second = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  assert.equal(values(db, 'tasks').length, 0);
  const planned = await completeBrainRun(db, 'tenant_a', second.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"CODEX","task_spec":{"title":"Bounded work","objective":"Implement bounded work","instructions":"Change only the allowed file.","allowed_files":["src/services/autopilot.js"],"required_tests":["node --test test\\\\planner-autopilot-handoff.test.js"],"success_criteria":["Required test passes"],"stop_conditions":["DO NOT DEPLOY"]}}</MRAPI_CONTROL>'
  });
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(planned.task_id, values(db, 'tasks')[0].id);
  assert.deepEqual(values(db, 'tasks')[0].task_spec.allowed_files, ['src/services/autopilot.js']);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((m) => m.state), ['COMPLETED', 'RUNNING', 'PENDING']);
});

test('retry and blocked decisions remain on current milestone and prevent later starts', async () => {
  const db = new DB();
  seed(db);
  db.set('roadmaps', 'roadmap_retry', {
    id: 'roadmap_retry',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    proposal_type: 'PLANNER_ROADMAP',
    approval_status: 'APPROVED',
    state: 'ACTIVE',
    title: 'Retry roadmap',
    objective: 'Retry same milestone',
    milestones: [
      { id: 'm1', title: 'Current', objective: 'Current', description: 'Current', executor_required: true, state: 'VERIFYING', order: 1, dependencies: [], depends_on: [], mission_id: 'mission_retry' },
      { id: 'm2', title: 'Later', objective: 'Later', description: 'Later', executor_required: true, state: 'PENDING', order: 2, dependencies: ['m1'], depends_on: ['m1'] }
    ]
  });
  db.set('missions', 'mission_retry', { id: 'mission_retry', tenant_id: 'tenant_a', workspace_id: 'workspace_a', project_id: 'project_a', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_phase: 'VERIFYING', autopilot_attempt_count: 1, autopilot_max_attempts: 3, roadmap_id: 'roadmap_retry', milestone_id: 'm1' });
  db.set('runs', 'verify_retry', { id: 'verify_retry', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_retry', roadmap_id: 'roadmap_retry', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });

  const retry = await completeVerificationBrainRun(db, 'tenant_a', 'verify_retry', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"Fix current milestone.","allowed_files":["x.js"],"required_tests":["node --test x.test.js"]}}</MRAPI_AUTOPILOT>'
  });
  assert.equal(retry.milestone_id, 'm1');
  assert.equal(db.get('roadmaps', 'roadmap_retry').milestones[0].state, 'RUNNING');
  assert.equal((await startPlannerRoadmap(db, 'tenant_a', 'roadmap_retry')).milestone.id, 'm1');

  db.set('roadmaps', 'roadmap_blocked', {
    ...db.get('roadmaps', 'roadmap_retry'),
    id: 'roadmap_blocked',
    state: 'ACTIVE',
    milestones: [
      { id: 'm1', title: 'Current', objective: 'Current', description: 'Current', executor_required: true, state: 'VERIFYING', order: 1, dependencies: [], depends_on: [], mission_id: 'mission_blocked' },
      { id: 'm2', title: 'Later', objective: 'Later', description: 'Later', executor_required: true, state: 'PENDING', order: 2, dependencies: ['m1'], depends_on: ['m1'] }
    ]
  });
  db.set('missions', 'mission_blocked', { id: 'mission_blocked', tenant_id: 'tenant_a', workspace_id: 'workspace_a', project_id: 'project_a', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_phase: 'VERIFYING', roadmap_id: 'roadmap_blocked', milestone_id: 'm1' });
  db.set('runs', 'verify_blocked', { id: 'verify_blocked', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_blocked', roadmap_id: 'roadmap_blocked', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  await completeVerificationBrainRun(db, 'tenant_a', 'verify_blocked', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"BLOCKED","reason":"blocked"}</MRAPI_AUTOPILOT>'
  });
  await assert.rejects(() => startPlannerRoadmap(db, 'tenant_a', 'roadmap_blocked'), /PLANNER_ROADMAP_NOT_STARTABLE/);
});

test('complete advances exactly once, final completion closes roadmap, replay and cancellation create no work', async () => {
  const db = new DB();
  seed(db);
  db.set('roadmaps', 'roadmap_complete', {
    id: 'roadmap_complete',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    proposal_type: 'PLANNER_ROADMAP',
    approval_status: 'APPROVED',
    state: 'ACTIVE',
    title: 'Complete roadmap',
    objective: 'Complete sequentially',
    milestones: [
      { id: 'm1', title: 'Done', objective: 'Done', description: 'Done', executor_required: true, state: 'VERIFYING', order: 1, dependencies: [], depends_on: [], mission_id: 'mission_complete' },
      { id: 'm2', title: 'Next', objective: 'Next', description: 'Next', executor_required: false, state: 'PENDING', order: 2, dependencies: ['m1'], depends_on: ['m1'] }
    ]
  });
  db.set('missions', 'mission_complete', { id: 'mission_complete', tenant_id: 'tenant_a', workspace_id: 'workspace_a', project_id: 'project_a', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_phase: 'VERIFYING', roadmap_id: 'roadmap_complete', milestone_id: 'm1' });
  db.set('runs', 'verify_complete', { id: 'verify_complete', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission_complete', roadmap_id: 'roadmap_complete', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  await completeVerificationBrainRun(db, 'tenant_a', 'verify_complete', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"done"}</MRAPI_AUTOPILOT>'
  });
  await assert.rejects(() => completeVerificationBrainRun(db, 'tenant_a', 'verify_complete', {
    output_text: '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"replay"}</MRAPI_AUTOPILOT>'
  }), /AUTOPILOT_VERIFICATION_RUN_NOT_ACTIVE/);
  const beforeStart = counts(db);
  const next = await startPlannerRoadmap(db, 'tenant_a', 'roadmap_complete');
  assert.equal(next.milestone.id, 'm2');
  assert.equal(counts(db).missions, beforeStart.missions + 1);
  await completeBrainRun(db, 'tenant_a', next.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false}</MRAPI_CONTROL><MRAPI_RESULT>final done.</MRAPI_RESULT>'
  });
  assert.equal(db.get('roadmaps', 'roadmap_complete').state, 'COMPLETED');
  const completeCounts = counts(db);
  const replayStart = await startPlannerRoadmap(db, 'tenant_a', 'roadmap_complete');
  assert.equal(replayStart.already_complete, true);
  assert.deepEqual(counts(db), completeCounts);

  db.set('roadmaps', 'roadmap_cancelled', {
    ...db.get('roadmaps', 'roadmap_complete'),
    id: 'roadmap_cancelled',
    state: 'CANCELLED',
    milestones: [{ id: 'm1', title: 'No', state: 'PENDING', order: 1, dependencies: [], depends_on: [] }]
  });
  await assert.rejects(() => startPlannerRoadmap(db, 'tenant_a', 'roadmap_cancelled'), /PLANNER_ROADMAP_NOT_STARTABLE/);
});

test('tenant B cannot start or complete tenant A Planner roadmap lifecycle', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  await assert.rejects(() => startPlannerRoadmap(db, 'tenant_b', roadmap.roadmap_id), /ROADMAP_NOT_FOUND/);
  const started = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);
  await assert.rejects(() => completeBrainRun(db, 'tenant_b', started.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false}</MRAPI_CONTROL><MRAPI_RESULT>bad tenant</MRAPI_RESULT>'
  }), /RUN_NOT_FOUND/);
  assert.equal(values(db, 'tasks').length, 0);
});

function createMiniExpress() {
  function Router() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const rp = route.path.split('/').filter(Boolean);
        const up = req.url.split('?')[0].split('/').filter(Boolean);
        if (rp.length !== up.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < rp.length; i += 1) {
          if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(up[i]);
          else if (rp[i] !== up[i]) matched = false;
        }
        if (!matched) continue;
        req.params = params;
        return route.handler(req, res, next);
      }
      return next();
    };
    router.get = (path, handler) => routes.push({ method: 'GET', path, handler });
    router.post = (path, handler) => routes.push({ method: 'POST', path, handler });
    return router;
  }
  return { Router };
}

function loadRouter() {
  const routePath = require.resolve('../src/routes/planner.routes');
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/planner.routes');
  } finally {
    Module._load = originalLoad;
  }
}

async function postJson(app, path, body, headers = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function app(db) {
  const { createPlannerRouter } = loadRouter();
  const router = createPlannerRouter({ db });
  return async (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      req.body = raw ? JSON.parse(raw) : {};
      req.header = (name) => req.headers[String(name).toLowerCase()];
      req.tenantId = req.header('x-tenant-id') || 'tenant_a';
      req.url = req.url.replace(/^\/api\/planner/, '') || '/';
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      await router(req, res, (error) => {
        res.statusCode = error?.status || 404;
        res.end(JSON.stringify({ error: error?.message || 'NOT_FOUND' }));
      });
    });
  };
}

test('Planner HTTP start route delegates to service lifecycle', async () => {
  const db = new DB();
  const { roadmap } = await createProposed(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });

  const response = await postJson(app(db), `/api/planner/roadmaps/${roadmap.roadmap_id}/start`, {
    workspace_id: 'caller_workspace',
    project_id: 'caller_project'
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.milestone_id, 'm1');
  assert.equal(response.body.no_new_work, false);

  const replay = await postJson(app(db), `/api/planner/roadmaps/${roadmap.roadmap_id}/start`, {}, { 'x-tenant-id': 'tenant_a' });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.reused, true);
  assert.equal(replay.body.brain_run_id, response.body.brain_run_id);
});

test('ordinary non-Planner start behavior is preserved', async () => {
  const db = new DB();
  seed(db);
  db.set('roadmaps', 'generic', {
    id: 'generic',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    title: 'Generic',
    objective: 'Generic Autopilot',
    owner_worker_id: 'W01',
    milestones: [{ id: 'g1', title: 'Generic milestone', state: 'PENDING', order: 1, depends_on: [] }]
  });
  const started = await startNextRoadmapMilestone(db, 'tenant_a', 'generic');
  assert.equal(started.milestone.id, 'g1');
  assert.equal(started.brain_run, null);
  assert.equal(values(db, 'runs').length, 0);
});
