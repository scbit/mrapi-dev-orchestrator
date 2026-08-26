const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  approvePlannerRoadmap
} = require('../src/services/planner');
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
    name: 'Workspace A'
  });
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    repository_full_name: 'stored/project',
    local_path: 'C:\\stored-project',
    default_branch: 'main',
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    state: 'IDLE'
  });
}

function proposal(overrides = {}) {
  return {
    title: 'Roadmap Approval Workflow',
    objective: 'Approve a Planner-generated roadmap without starting execution.',
    summary: 'The approved roadmap becomes eligible for existing Autopilot progression.',
    risks: ['Approval could accidentally mutate the proposal'],
    dependencies: ['Existing Autopilot lifecycle'],
    assumptions: ['Human approval is explicit'],
    milestones: [
      {
        id: 'm1',
        title: 'Approval Gate',
        objective: 'Move a reviewed proposal into the active lifecycle.',
        description: 'Approve lifecycle metadata only.',
        executor_required: false,
        dependencies: [],
        risks: ['Brain-only work could be mistaken for Codex work'],
        success_criteria: ['No Task is created by approval']
      },
      {
        id: 'm2',
        title: 'Execution Eligible Work',
        objective: 'Let Autopilot request Brain planning for executable work later.',
        description: 'Keep dependency ordering intact for the executor-required milestone.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['A later milestone could start too early'],
        success_criteria: ['Only dependency-satisfied work can start']
      }
    ],
    ...overrides
  };
}

async function createProposedRoadmap(db) {
  seed(db);
  const request = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Build Planner roadmap approval'
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', request.brain_run_id, {
    proposal: proposal()
  });
  return { request, roadmap };
}

function assertNoExecutableSideEffects(db) {
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
}

function immutableProjection(roadmap) {
  return {
    title: roadmap.title,
    objective: roadmap.objective,
    summary: roadmap.summary,
    risks: roadmap.risks,
    dependencies: roadmap.dependencies,
    assumptions: roadmap.assumptions,
    tenant_id: roadmap.tenant_id,
    workspace_id: roadmap.workspace_id,
    project_id: roadmap.project_id,
    proposal_type: roadmap.proposal_type,
    planner_request_id: roadmap.planner_request_id,
    source_planner_mission_id: roadmap.source_planner_mission_id,
    source_planner_brain_run_id: roadmap.source_planner_brain_run_id,
    provenance: roadmap.provenance,
    milestones: roadmap.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      objective: milestone.objective,
      expected_outcome: milestone.expected_outcome,
      description: milestone.description,
      executor_required: milestone.executor_required,
      dependencies: milestone.dependencies,
      depends_on: milestone.depends_on,
      risks: milestone.risks,
      success_criteria: milestone.success_criteria,
      order: milestone.order
    }))
  };
}

test('Planner roadmap requires explicit approval and stays non-executable while proposed', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);

  await assert.rejects(
    () => startNextRoadmapMilestone(db, 'tenant_a', roadmap.roadmap_id),
    /ROADMAP_NOT_ACTIVE/
  );
  const read = await getPlannerProposal(db, 'tenant_a', roadmap.roadmap_id);
  assert.equal(read.state, 'PROPOSED');
  await assert.rejects(
    () => approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, {}),
    /EXPLICIT_PLANNER_ROADMAP_APPROVAL_REQUIRED/
  );
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).state, 'PROPOSED');
  assertNoExecutableSideEffects(db);
});

test('owning tenant approval activates roadmap without mutating accepted proposal structure', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);
  const before = immutableProjection(db.get('roadmaps', roadmap.roadmap_id));

  const approved = await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, {
    approve: true,
    title: 'Caller cannot replace title',
    milestones: [{ id: 'evil', dependencies: [] }],
    actor_id: 'user_1'
  });
  const stored = db.get('roadmaps', roadmap.roadmap_id);

  assert.equal(approved.state, 'ACTIVE');
  assert.equal(approved.approval_status, 'APPROVED');
  assert.equal(stored.state, 'ACTIVE');
  assert.equal(stored.approval_status, 'APPROVED');
  assert.equal(stored.non_executable, false);
  assert.equal(stored.approved_by, 'user_1');
  assert.equal(stored.approval.status, 'APPROVED');
  assert.equal(stored.approval.source, 'PLANNER_ROADMAP_APPROVAL');
  assert.deepEqual(immutableProjection(stored), before);
  assert.deepEqual(stored.milestones.map((milestone) => milestone.state), ['PENDING', 'PENDING']);
  assertNoExecutableSideEffects(db);
});

test('tenant isolation and invalid roadmap types are rejected by Planner approval path', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);

  await assert.rejects(
    () => approvePlannerRoadmap(db, 'tenant_b', roadmap.roadmap_id, { approve: true }),
    /PLANNER_ROADMAP_NOT_FOUND/
  );
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).state, 'PROPOSED');

  db.set('roadmaps', 'generic_roadmap', {
    id: 'generic_roadmap',
    tenant_id: 'tenant_a',
    proposal_type: 'GENERIC',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    non_executable: true,
    milestones: []
  });
  await assert.rejects(
    () => approvePlannerRoadmap(db, 'tenant_a', 'generic_roadmap', { approve: true }),
    /PLANNER_ROADMAP_NOT_APPROVABLE/
  );
});

test('cancelled source lifecycle and malformed stored proposals fail atomically', async () => {
  const db = new FakeDb();
  const { request, roadmap } = await createProposedRoadmap(db);
  const before = db.get('roadmaps', roadmap.roadmap_id);
  db.set('missions', request.mission_id, { state: 'CANCELLED', cancellation_requested: true }, { merge: true });

  await assert.rejects(
    () => approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true }),
    /PLANNER_SOURCE_MISSION_CANCELLED/
  );
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id), before);
  assertNoExecutableSideEffects(db);

  const other = new FakeDb();
  const created = await createProposedRoadmap(other);
  const malformed = other.get('roadmaps', created.roadmap.roadmap_id);
  other.set('roadmaps', created.roadmap.roadmap_id, { ...malformed, milestones: [] });
  await assert.rejects(
    () => approvePlannerRoadmap(other, 'tenant_a', created.roadmap.roadmap_id, { approve: true }),
    /PLANNER_PROPOSAL_MILESTONES_REQUIRED/
  );
  assert.equal(other.get('roadmaps', created.roadmap.roadmap_id).state, 'PROPOSED');
  assertNoExecutableSideEffects(other);
});

test('approval is idempotent and subsequent Autopilot start creates only first eligible mission', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);

  const first = await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  const second = await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, {
    approve: true,
    title: 'Ignored conflicting replay'
  });
  assert.equal(first.roadmap_id, second.roadmap_id);
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'missions').length, 1);
  assertNoExecutableSideEffects(db);

  const started = await startNextRoadmapMilestone(db, 'tenant_a', roadmap.roadmap_id);
  assert.equal(started.milestone.id, 'm1');
  assert.equal(values(db, 'missions').length, 2);
  assert.equal(values(db, 'tasks').length, 0);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((item) => item.state), [
    'PLANNING',
    'PENDING'
  ]);
  const replayedStart = await startNextRoadmapMilestone(db, 'tenant_a', roadmap.roadmap_id);
  assert.equal(replayedStart.reused, true);
  assert.equal(replayedStart.no_new_work, true);
  assert.equal(replayedStart.mission.id, started.mission.id);
  assert.equal(values(db, 'missions').length, 2);

  const third = await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  assert.equal(third.state, 'ACTIVE');
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'missions').length, 2);
  assertNoExecutableSideEffects(db);
});

test('retrieval after approval exposes active lifecycle and full original proposal data', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });

  const retrieved = await getPlannerProposal(db, 'tenant_a', roadmap.roadmap_id);
  assert.equal(retrieved.state, 'ACTIVE');
  assert.equal(retrieved.approval_status, 'APPROVED');
  assert.equal(retrieved.title, proposal().title);
  assert.equal(retrieved.milestones[1].executor_required, true);
  assert.deepEqual(retrieved.milestones[1].dependencies, ['m1']);
  assert.deepEqual(retrieved.milestones[1].risks, ['A later milestone could start too early']);
  assert.deepEqual(retrieved.milestones[1].success_criteria, ['Only dependency-satisfied work can start']);
});

function createMiniExpress() {
  function createRouter() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const routeParts = route.path.split('/').filter(Boolean);
        const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
        if (routeParts.length !== urlParts.length) continue;
        const params = {};
        let matched = true;
        for (let index = 0; index < routeParts.length; index += 1) {
          if (routeParts[index].startsWith(':')) params[routeParts[index].slice(1)] = decodeURIComponent(urlParts[index]);
          else if (routeParts[index] !== urlParts[index]) matched = false;
        }
        if (!matched) continue;
        req.params = params;
        return route.handler(req, res, next);
      }
      return next();
    };
    router.get = (routePath, handler) => routes.push({ method: 'GET', path: routePath, handler });
    router.post = (routePath, handler) => routes.push({ method: 'POST', path: routePath, handler });
    return router;
  }
  return { Router: createRouter };
}

function loadPlannerRouterWithMiniExpress() {
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
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers
        }
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

function createPlannerHttpApp(db) {
  const { createPlannerRouter } = loadPlannerRouterWithMiniExpress();
  const router = createPlannerRouter({ db });
  return async (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      req.body = raw ? JSON.parse(raw) : {};
      req.header = (name) => req.headers[String(name).toLowerCase()];
      req.tenantId = req.header('x-tenant-id') || 'tenant_a';
      req.url = req.url.replace(/^\/api\/planner/, '') || '/';
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
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

test('HTTP approval route requires affirmative body and approves owning tenant roadmap', async () => {
  const db = new FakeDb();
  const { roadmap } = await createProposedRoadmap(db);
  const app = createPlannerHttpApp(db);

  const missingIntent = await postJson(app, `/api/planner/roadmaps/${roadmap.roadmap_id}/approve`, {}, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(missingIntent.statusCode, 400);
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).state, 'PROPOSED');

  const approved = await postJson(app, `/api/planner/roadmaps/${roadmap.roadmap_id}/approve`, { approve: true }, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.state, 'ACTIVE');
  assert.equal(approved.body.approval_status, 'APPROVED');
});
