const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  approvePlannerRoadmap,
  startPlannerRoadmap
} = require('../src/services/planner');

class Snapshot {
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

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class DocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id || db.nextId(collectionName);
  }

  async get() {
    return new Snapshot(this.id, this.db.get(this.collectionName, this.id), this);
  }

  async set(data, options = {}) {
    this.db.set(this.collectionName, this.id, data, options);
  }

  async update(data) {
    this.db.update(this.collectionName, this.id, data);
  }
}

class Query {
  constructor(db, collectionName, filters = [], max = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.max = max;
  }

  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.collectionName, [...this.filters, { field, value }], this.max);
  }

  limit(max) {
    return new Query(this.db, this.collectionName, this.filters, max);
  }

  async get() {
    let docs = Object.entries(this.db.collections[this.collectionName] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snapshot(id, data, new DocRef(this.db, this.collectionName, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnapshot(docs);
  }
}

class Collection extends Query {
  constructor(db, collectionName) {
    super(db, collectionName);
  }

  doc(id) {
    return new DocRef(this.db, this.collectionName, id);
  }
}

class Transaction {
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

class Db {
  constructor() {
    this.collections = {};
    this.counters = {};
  }

  collection(name) {
    if (!this.collections[name]) this.collections[name] = {};
    return new Collection(this, name);
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
    return fn(new Transaction());
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function seed(db) {
  db.set('workspaces', 'workspace_a', {
    id: 'workspace_a',
    tenant_id: 'tenant_a',
    name: 'Planner UX Workspace'
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
    repository_full_name: 'stored/planner-project',
    local_path: 'C:/stored-planner-project',
    default_branch: 'main',
    default_worker_id: 'W01',
    primary_worker_ids: ['W01'],
    reusable_instructions: 'Use only trusted stored project context.'
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
}

function proposal() {
  return {
    title: 'Planner UX Validation Roadmap',
    objective: 'Validate request, review, approval, and handoff as one coherent Planner workflow.',
    summary: 'The proposal remains review-only until explicit approval and explicit start.',
    risks: ['Read operations might accidentally mutate lifecycle state'],
    dependencies: ['Existing Planner API', 'Existing Autopilot handoff'],
    assumptions: ['Tenant scope comes from server-side request context'],
    milestones: [
      {
        id: 'm1',
        title: 'Review Proposal',
        objective: 'Expose enough structured data for an approval decision.',
        description: 'Return proposal title, objective, summary, provenance, and milestone details.',
        executor_required: false,
        dependencies: [],
        risks: ['Insufficient review data'],
        success_criteria: ['Proposal fields are complete', 'No execution work is created']
      },
      {
        id: 'm2',
        title: 'Executor Handoff',
        objective: 'Start only after approval through the existing Autopilot lifecycle.',
        description: 'Create Brain planning linkage for the first dependency-satisfied milestone.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Start could duplicate active work'],
        success_criteria: ['Repeated start reuses the active mission and Brain Run']
      },
      {
        id: 'm3',
        title: 'Blocked Dependent Work',
        objective: 'Keep blocked or dependency-waiting work non-startable.',
        description: 'Represent dependent work without treating executor_required as execution intent.',
        executor_required: true,
        dependencies: ['m2'],
        risks: ['Dependency-blocked milestone could start too early'],
        success_criteria: ['Pending dependency prevents execution']
      }
    ]
  };
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    tasks: values(db, 'tasks').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function assertNoCodexWork(db) {
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
}

function immutableProposal(roadmap) {
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
      order: milestone.order,
      title: milestone.title,
      objective: milestone.objective,
      expected_outcome: milestone.expected_outcome,
      description: milestone.description,
      executor_required: milestone.executor_required,
      dependencies: milestone.dependencies,
      depends_on: milestone.depends_on,
      risks: milestone.risks,
      success_criteria: milestone.success_criteria
    }))
  };
}

function createMiniExpress() {
  function Router() {
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
  return { Router };
}

function loadPlannerRouter() {
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

function createPlannerApp(db) {
  const { createPlannerRouter } = loadPlannerRouter();
  const router = createPlannerRouter({ db });
  return async (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try {
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
      } catch (error) {
        res.statusCode = error.status || 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  };
}

async function requestJson(app, method, routePath, body = null, headers = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const payload = body === null ? '' : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers: {
          ...(payload ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
          } : {}),
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

test('Planner workflow API validates request, review, approval, and start UX gates', async () => {
  const db = new Db();
  seed(db);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(appSource, /createPlannerRouter/);
  assert.match(appSource, /\/api\/planner/);
  const app = createPlannerApp(db);

  const invalidRequest = await requestJson(app, 'POST', '/api/planner/requests', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: '   '
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(invalidRequest.statusCode, 400);
  assert.equal(invalidRequest.body.error, 'PLANNER_REQUEST_REQUIRED');
  assert.deepEqual(counts(db), { missions: 0, brainRuns: 0, tasks: 0, executionRuns: 0 });

  const intake = await requestJson(app, 'POST', '/api/planner/requests', {
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Validate the complete Planner UX workflow'
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(intake.statusCode, 202);
  assert.equal(intake.body.state, 'PLANNING');
  assert.equal(intake.body.brain_context.trusted_scope.tenant_id, 'tenant_a');
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });

  const proposed = await completePlannerBrainRun(db, 'tenant_a', intake.body.brain_run_id, {
    proposal: proposal()
  });
  const beforeReview = JSON.stringify(db.collections);
  const review = await requestJson(app, 'GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, {
    'x-tenant-id': 'tenant_a'
  });
  const secondReview = await requestJson(app, 'GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, {
    'x-tenant-id': 'tenant_a'
  });

  assert.equal(review.statusCode, 200);
  assert.equal(review.body.state, 'PROPOSED');
  assert.equal(review.body.approval_status, 'PENDING');
  assert.equal(review.body.title, proposal().title);
  assert.equal(review.body.objective, proposal().objective);
  assert.equal(review.body.summary, proposal().summary);
  assert.deepEqual(review.body.risks, proposal().risks);
  assert.deepEqual(review.body.dependencies, proposal().dependencies);
  assert.deepEqual(review.body.assumptions, proposal().assumptions);
  assert.equal(review.body.provenance.source, 'PLANNER_BRAIN_RUN');
  assert.equal(review.body.original_request, 'Validate the complete Planner UX workflow');
  assert.deepEqual(review.body.milestones.map((milestone) => milestone.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(review.body.milestones.map((milestone) => milestone.order), [1, 2, 3]);
  assert.equal(review.body.milestones[1].objective, 'Start only after approval through the existing Autopilot lifecycle.');
  assert.equal(review.body.milestones[1].description, 'Create Brain planning linkage for the first dependency-satisfied milestone.');
  assert.equal(review.body.milestones[1].executor_required, true);
  assert.deepEqual(review.body.milestones[1].dependencies, ['m1']);
  assert.deepEqual(review.body.milestones[1].risks, ['Start could duplicate active work']);
  assert.deepEqual(review.body.milestones[1].success_criteria, ['Repeated start reuses the active mission and Brain Run']);
  assert.equal(review.body.milestones[1].state, 'PROPOSED');
  assert.deepEqual(secondReview.body, review.body);
  assert.equal(JSON.stringify(db.collections), beforeReview);
  assertNoCodexWork(db);

  const startBeforeApproval = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(startBeforeApproval.statusCode, 409);
  assert.equal(startBeforeApproval.body.error, 'PLANNER_ROADMAP_NOT_STARTABLE');
  assert.equal(db.get('roadmaps', proposed.roadmap_id).state, 'PROPOSED');
  assertNoCodexWork(db);

  const invalidApproval = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/approve`, {
    approve: false
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(invalidApproval.statusCode, 400);
  assert.equal(invalidApproval.body.error, 'EXPLICIT_PLANNER_ROADMAP_APPROVAL_REQUIRED');
  assert.equal(db.get('roadmaps', proposed.roadmap_id).state, 'PROPOSED');

  const tenantBReview = await requestJson(app, 'GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, {
    'x-tenant-id': 'tenant_b'
  });
  assert.equal(tenantBReview.statusCode, 404);
  assert.equal(tenantBReview.body.error, 'PLANNER_PROPOSAL_NOT_FOUND');
  const tenantBApproval = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/approve`, {
    approve: true
  }, { 'x-tenant-id': 'tenant_b' });
  assert.equal(tenantBApproval.statusCode, 404);
  assert.equal(tenantBApproval.body.error, 'PLANNER_ROADMAP_NOT_FOUND');
  const tenantBStart = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, {
    'x-tenant-id': 'tenant_b'
  });
  assert.equal(tenantBStart.statusCode, 404);
  assert.equal(tenantBStart.body.error, 'ROADMAP_NOT_FOUND');

  const storedBeforeApproval = immutableProposal(db.get('roadmaps', proposed.roadmap_id));
  const approval = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/approve`, {
    approve: true,
    title: 'Caller replacement must be ignored',
    objective: 'Caller replacement must be ignored',
    milestones: [{ id: 'evil', dependencies: [] }],
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_b',
    project_id: 'project_b'
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(approval.statusCode, 200);
  assert.equal(approval.body.state, 'ACTIVE');
  assert.equal(approval.body.approval_status, 'APPROVED');
  assert.deepEqual(immutableProposal(db.get('roadmaps', proposed.roadmap_id)), storedBeforeApproval);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });

  const approvedReview = await requestJson(app, 'GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(approvedReview.body.state, 'ACTIVE');
  assert.equal(approvedReview.body.approval_status, 'APPROVED');
  assert.equal(approvedReview.body.title, proposal().title);
  assert.deepEqual(approvedReview.body.milestones.map((milestone) => milestone.state), ['PENDING', 'PENDING', 'PENDING']);

  const start = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_b',
    project_id: 'project_b',
    milestone_id: 'm2'
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(start.statusCode, 201);
  assert.equal(start.body.ok, true);
  assert.equal(start.body.milestone_id, 'm1');
  assert.equal(start.body.current_milestone.id, 'm1');
  assert.equal(start.body.current_milestone.state, 'PLANNING');
  assert.equal(start.body.brain_context.trusted_scope.tenant_id, 'tenant_a');
  assert.equal(start.body.brain_context.trusted_scope.workspace_id, 'workspace_a');
  assert.equal(start.body.brain_context.trusted_scope.project_id, 'project_a');
  assert.equal(start.body.brain_context.trusted_scope.roadmap_id, proposed.roadmap_id);
  assert.equal(start.body.brain_context.current_milestone.id, 'm1');
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0, executionRuns: 0 });

  const afterStartSnapshot = JSON.stringify(db.collections);
  const refresh = await requestJson(app, 'GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(refresh.body.milestones[0].state, 'PLANNING');
  assert.equal(refresh.body.milestones[0].brain_run_id, start.body.brain_run_id);
  assert.equal(JSON.stringify(db.collections), afterStartSnapshot);

  const repeatedStart = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, {
    'x-tenant-id': 'tenant_a'
  });
  assert.equal(repeatedStart.statusCode, 200);
  assert.equal(repeatedStart.body.reused, true);
  assert.equal(repeatedStart.body.no_new_work, true);
  assert.equal(repeatedStart.body.mission_id, start.body.mission_id);
  assert.equal(repeatedStart.body.brain_run_id, start.body.brain_run_id);
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0, executionRuns: 0 });
});

test('Planner service returns deterministic terminal and dependency-blocked start errors', async () => {
  const db = new Db();
  seed(db);
  const created = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Validate non-startable states'
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: proposal()
  });
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });

  const stored = db.get('roadmaps', roadmap.roadmap_id);
  db.set('roadmaps', roadmap.roadmap_id, {
    ...stored,
    milestones: stored.milestones.map((milestone) => (
      milestone.id === 'm1' ? { ...milestone, state: 'BLOCKED', blocked_reason: 'Waiting on decision' } : milestone
    ))
  });
  await assert.rejects(
    () => startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id),
    /NO_EXECUTABLE_MILESTONE/
  );
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[1].state, 'PENDING');
  assertNoCodexWork(db);

  db.set('roadmaps', 'cancelled_roadmap', {
    ...stored,
    id: 'cancelled_roadmap',
    state: 'CANCELLED',
    approval_status: 'APPROVED',
    non_executable: false
  });
  await assert.rejects(
    () => startPlannerRoadmap(db, 'tenant_a', 'cancelled_roadmap'),
    /PLANNER_ROADMAP_NOT_STARTABLE/
  );

  await assert.rejects(
    () => getPlannerProposal(db, 'tenant_b', roadmap.roadmap_id),
    /PLANNER_PROPOSAL_NOT_FOUND/
  );
});
