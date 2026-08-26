const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
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
  db.set('workspaces', 'workspace_1', {
    id: 'workspace_1',
    tenant_id: 'tenant_a',
    name: 'Workspace A'
  });
  db.set('workspaces', 'workspace_b', {
    id: 'workspace_b',
    tenant_id: 'tenant_b',
    name: 'Workspace B'
  });
  db.set('projects', 'project_1', {
    id: 'project_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    repository_full_name: 'org/project-one',
    local_path: 'C:\\project-one',
    default_branch: 'main',
    primary_worker_ids: ['W01'],
    reusable_instructions: 'Respect stored project context.',
    runtime_context: { package_manager: 'npm' }
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
    workspace_id: 'workspace_1',
    state: 'IDLE'
  });
  db.set('executors', 'executor_1', {
    id: 'executor_1',
    tenant_id: 'tenant_a',
    worker_ids: ['W01'],
    state: 'ONLINE'
  });
}

function validProposal(overrides = {}) {
  return {
    title: 'Build Planner Intake',
    objective: 'Create a reviewable roadmap proposal from one request.',
    summary: 'Planner intake captures context and returns milestones for review.',
    risks: ['Scope may be underspecified'],
    dependencies: ['Existing project metadata'],
    assumptions: ['Human approval happens later'],
    milestones: [
      {
        id: 'm1',
        title: 'Understand Context',
        objective: 'Capture trusted workspace and project context.',
        description: 'Read stored project context and preserve the original request.',
        executor_required: false,
        dependencies: [],
        risks: ['Missing context'],
        success_criteria: ['Context is present in the proposal provenance']
      },
      {
        id: 'm2',
        title: 'Implementation Plan',
        expected_outcome: 'Define executable work for a future approval step.',
        description: 'Order implementation work without starting it.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Premature execution'],
        success_criteria: ['No Task is created before approval']
      }
    ],
    ...overrides
  };
}

async function readyPlanner(db, request = 'Build a planner intake flow') {
  seed(db);
  return createPlannerRequest(db, 'tenant_a', {
    tenant_id: 'evil_tenant',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    request
  });
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
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: text ? JSON.parse(text) : null
          });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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
          if (routeParts[index].startsWith(':')) {
            params[routeParts[index].slice(1)] = decodeURIComponent(urlParts[index]);
          } else if (routeParts[index] !== urlParts[index]) {
            matched = false;
            break;
          }
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

function createPlannerHttpApp(db) {
  const { createPlannerRouter } = loadPlannerRouterWithMiniExpress();
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
          const payload = JSON.stringify(body);
          res.setHeader('content-type', 'application/json');
          res.end(payload);
        };
        await router(req, res, (error) => {
          if (error) {
            res.statusCode = error.status || 500;
            res.end(JSON.stringify({ error: error.message }));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        });
      } catch (error) {
        res.statusCode = error.status || 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  };
}

test('empty or whitespace Planner request is rejected', async () => {
  const db = new FakeDb();
  seed(db);
  await assert.rejects(
    () => createPlannerRequest(db, 'tenant_a', {
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      request: '   '
    }),
    /PLANNER_REQUEST_REQUIRED/
  );
});

test('valid intake creates one Brain-only Planner lifecycle and trusted Brain context', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db, '  Build a developer planner  ');
  const mission = db.get('missions', created.mission_id);
  const run = db.get('runs', created.brain_run_id);

  assert.equal(values(db, 'missions').length, 1);
  assert.equal(values(db, 'runs').length, 1);
  assert.equal(run.run_type, 'BRAIN_RUN');
  assert.equal(run.task_id, null);
  assert.equal(run.planning_mode, 'PLANNER_ROADMAP_PROPOSAL');
  assert.equal(run.brain_context.natural_language_request, 'Build a developer planner');
  assert.equal(run.brain_context.trusted_scope.tenant_id, 'tenant_a');
  assert.equal(run.brain_context.trusted_scope.workspace_id, 'workspace_1');
  assert.equal(run.brain_context.trusted_scope.project_id, 'project_1');
  assert.equal(run.brain_context.project_context.repository_full_name, 'org/project-one');
  assert.equal(run.brain_context.project_context.reusable_instructions, 'Respect stored project context.');
  assert.equal(mission.non_executable, true);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((item) => item.run_type === 'EXECUTION_RUN').length, 0);
});

test('conflicting payload scope cannot override stored tenant workspace project scope', async () => {
  const db = new FakeDb();
  seed(db);
  await assert.rejects(
    () => createPlannerRequest(db, 'tenant_a', {
      tenant_id: 'tenant_b',
      workspace_id: 'workspace_b',
      project_id: 'project_1',
      request: 'Build it'
    }),
    /WORKSPACE_NOT_FOUND|PROJECT_NOT_FOUND/
  );
});

test('valid Brain proposal persists exactly one PROPOSED non-approved roadmap with full provenance', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db, 'Build a roadmap builder');
  const proposal = await completeBrainRun(db, 'tenant_a', created.brain_run_id, {
    output_text: JSON.stringify(validProposal())
  });

  const roadmaps = values(db, 'roadmaps');
  assert.equal(roadmaps.length, 1);
  assert.equal(proposal.state, 'PROPOSED');
  assert.equal(roadmaps[0].approval_status, 'PENDING');
  assert.equal(roadmaps[0].non_executable, true);
  assert.equal(roadmaps[0].title, 'Build Planner Intake');
  assert.equal(roadmaps[0].objective, 'Create a reviewable roadmap proposal from one request.');
  assert.deepEqual(roadmaps[0].risks, ['Scope may be underspecified']);
  assert.deepEqual(roadmaps[0].dependencies, ['Existing project metadata']);
  assert.deepEqual(roadmaps[0].assumptions, ['Human approval happens later']);
  assert.equal(roadmaps[0].original_request, 'Build a roadmap builder');
  assert.equal(roadmaps[0].source_planner_brain_run_id, created.brain_run_id);
  assert.equal(roadmaps[0].source_planner_mission_id, created.mission_id);
});

test('ordered milestones preserve planning fields and do not auto-start', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const proposal = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal()
  });

  assert.deepEqual(proposal.milestones.map((item) => item.title), ['Understand Context', 'Implementation Plan']);
  assert.equal(proposal.milestones[0].objective, 'Capture trusted workspace and project context.');
  assert.equal(proposal.milestones[1].expected_outcome, 'Define executable work for a future approval step.');
  assert.equal(proposal.milestones[1].description, 'Order implementation work without starting it.');
  assert.equal(proposal.milestones[1].executor_required, true);
  assert.deepEqual(proposal.milestones[1].dependencies, ['m1']);
  assert.deepEqual(proposal.milestones[1].risks, ['Premature execution']);
  assert.deepEqual(proposal.milestones[1].success_criteria, ['No Task is created before approval']);
  assert.equal(proposal.milestones[0].state, 'PROPOSED');
  assert.equal(values(db, 'tasks').length, 0);
});

test('malformed proposals are rejected without executable state', async () => {
  for (const [name, proposal] of [
    ['duplicate id', validProposal({ milestones: [
      validProposal().milestones[0],
      { ...validProposal().milestones[1], id: 'm1' }
    ] })],
    ['unknown dependency', validProposal({ milestones: [
      validProposal().milestones[0],
      { ...validProposal().milestones[1], dependencies: ['missing'] }
    ] })],
    ['cycle', validProposal({ milestones: [
      { ...validProposal().milestones[0], dependencies: ['m2'] },
      validProposal().milestones[1]
    ] })],
    ['missing executor flag', validProposal({ milestones: [
      validProposal().milestones[0],
      { ...validProposal().milestones[1], executor_required: undefined }
    ] })]
  ]) {
    const db = new FakeDb();
    const created = await readyPlanner(db, `Request ${name}`);
    await assert.rejects(
      () => completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, { proposal }),
      /PLANNER_PROPOSAL_/
    );
    assert.equal(values(db, 'roadmaps').length, 0);
    assert.equal(values(db, 'tasks').length, 0);
    assert.equal(values(db, 'runs').filter((item) => item.run_type === 'EXECUTION_RUN').length, 0);
    assert.equal(db.get('missions', created.mission_id).state, 'BLOCKED');
    assert.equal(db.get('runs', created.brain_run_id).state, 'FAILED');
  }
});

test('replaying same Planner Brain completion creates no duplicate roadmap', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const first = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal()
  });
  const second = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal({ title: 'Ignored Replay' })
  });

  assert.equal(first.roadmap_id, second.roadmap_id);
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'roadmaps')[0].title, 'Build Planner Intake');
});

test('proposed roadmap is not Autopilot eligible and executor_required does not create Tasks', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const proposal = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal()
  });

  await assert.rejects(
    () => startNextRoadmapMilestone(db, 'tenant_a', proposal.roadmap_id),
    /ROADMAP_NOT_ACTIVE/
  );
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(await claimNextTask(db, 'tenant_a', 'executor_1'), null);
});

test('cancellation prevents Planner proposal completion and continuation', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  await cancelMission(db, 'tenant_a', created.mission_id, { reason: 'Stop planning' });

  const result = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal()
  });

  assert.equal(result.cancelled, true);
  assert.equal(values(db, 'roadmaps').length, 0);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(db.get('runs', created.brain_run_id).state, 'FAILED');
});

test('tenant isolation protects Planner proposals', async () => {
  const db = new FakeDb();
  const created = await readyPlanner(db);
  const proposal = await completePlannerBrainRun(db, 'tenant_a', created.brain_run_id, {
    proposal: validProposal()
  });

  await assert.rejects(
    () => completePlannerBrainRun(db, 'tenant_b', created.brain_run_id, { proposal: validProposal() }),
    /RUN_NOT_FOUND/
  );
  await assert.rejects(
    () => getPlannerProposal(db, 'tenant_b', proposal.roadmap_id),
    /PLANNER_PROPOSAL_NOT_FOUND/
  );
});

test('HTTP intake route reaches Planner service and can return PROPOSED proposal without execution side effects', async () => {
  const db = new FakeDb();
  seed(db);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(appSource, /createPlannerRouter/);
  assert.match(appSource, /\/api\/planner/);
  const app = createPlannerHttpApp(db);

  const response = await postJson(app, '/api/planner/requests', {
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    request: 'Create the roadmap intake',
    proposal: validProposal()
  }, { 'x-tenant-id': 'tenant_a' });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.state, 'PROPOSED');
  assert.equal(response.body.title, 'Build Planner Intake');
  assert.equal(values(db, 'roadmaps').length, 1);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((item) => item.run_type === 'EXECUTION_RUN').length, 0);
});
