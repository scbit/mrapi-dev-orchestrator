const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

const {
  createPlannerRequest,
  completePlannerBrainRun,
  approvePlannerRoadmap,
  startPlannerRoadmap
} = require('../src/services/planner');
const { completeBrainRun } = require('../src/services/orchestration');

const root = path.join(__dirname, '..');

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
  constructor(db, collectionName, id) {
    this.db = db;
    this.c = collectionName;
    this.collectionName = collectionName;
    this.id = id || db.next(collectionName);
  }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(data, options = {}) { this.db.write('set', this.c, this.id, data, options); }
  async update(data) { this.db.write('update', this.c, this.id, data); }
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
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snap(id, data, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) { return new Doc(this.db, this.c, id); }
}

class Tx {
  constructor() { this.hasWritten = false; }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options = {}) {
    this.hasWritten = true;
    ref.db.write('set', ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    ref.db.write('update', ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor() {
    this.collections = {};
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
  get(name, id) { return this.collections[name]?.[id] || null; }
  set(name, id, data, options = {}) {
    if (!this.collections[name]) this.collections[name] = {};
    this.collections[name][id] = options.merge
      ? { ...(this.collections[name][id] || {}), ...data }
      : { ...data };
  }
  write(method, collectionName, id, data, options = {}) {
    this.writes.push({ method, collectionName, id, data, options });
    this.set(collectionName, id, data, options);
  }
  update(name, id, data) {
    if (!this.collections[name]?.[id]) throw new Error('NOT_FOUND');
    this.collections[name][id] = { ...this.collections[name][id], ...data };
  }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    tasks: values(db, 'tasks').length
  };
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
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
}

function proposal() {
  return {
    title: 'Role Separation',
    objective: 'Keep Planner from driving later milestones.',
    summary: 'Planner starts Autopilot once; Autopilot owns continuation.',
    risks: ['Legacy routes could bypass trusted lifecycle'],
    dependencies: ['Existing Autopilot handoff'],
    assumptions: ['Approval happens before start'],
    milestones: [
      {
        id: 'm1',
        title: 'Initial milestone',
        objective: 'Start only this milestone.',
        description: 'Initial work package.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Initial work starts']
      },
      {
        id: 'm2',
        title: 'Later milestone',
        objective: 'Must not be selected by repeated Planner start.',
        description: 'Continuation work package.',
        executor_required: false,
        dependencies: ['m1'],
        risks: [],
        success_criteria: ['Only Autopilot continuation can start it']
      }
    ]
  };
}

async function createApproved(db) {
  seed(db);
  const request = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Build a separated lifecycle roadmap'
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', request.brain_run_id, { proposal: proposal() });
  await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  return { request, roadmap };
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
    for (const method of ['get', 'post', 'put']) {
      router[method] = (routePath, handler) => routes.push({ method: method.toUpperCase(), path: routePath, handler });
    }
    return router;
  }
  return { Router };
}

function loadRoute(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function repos(db) {
  return {
    roadmaps: {
      async getById(id) {
        const data = db.get('roadmaps', id);
        return data ? { id, ...data } : null;
      },
      async listByTenant() { return values(db, 'roadmaps'); },
      async listByProject(_tenantId, projectId) {
        return values(db, 'roadmaps').filter((item) => item.project_id === projectId);
      },
      async upsert(id, data, options = { merge: true }) {
        db.write('set', 'roadmaps', id, { id, ...data }, options);
        return { id, ...db.get('roadmaps', id) };
      }
    },
    projects: {
      async getById(id) {
        const data = db.get('projects', id);
        return data ? { id, ...data } : null;
      }
    }
  };
}

function app(routerFactory, db) {
  const router = routerFactory(db);
  return async (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      req.body = raw ? JSON.parse(raw) : {};
      req.query = Object.fromEntries(new URL(`http://x${req.url}`).searchParams);
      req.header = (name) => req.headers[String(name).toLowerCase()];
      req.tenantId = req.header('x-tenant-id') || 'tenant_a';
      req.url = req.url.replace(/^\/api\/(?:planner|roadmaps)/, '') || '/';
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

async function requestJson(handler, method, routePath, body = {}, headers = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method,
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

function plannerApp(db) {
  const { createPlannerRouter } = loadRoute('../src/routes/planner.routes');
  return app((state) => createPlannerRouter({ db: state }), db);
}

function roadmapsApp(db) {
  const { createRoadmapsRouter } = loadRoute('../src/routes/roadmaps.routes');
  return app((state) => createRoadmapsRouter({ db: state, repos: repos(state) }), db);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Planner initial start creates only first eligible milestone through Autopilot delegation', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);

  const started = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  assert.equal(started.milestone.id, 'm1');
  assert.equal(started.no_new_work, undefined);
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[0].state, 'PLANNING');
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[1].state, 'PENDING');
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0 });
});

test('repeated Planner start reuses trusted current work and ignores later milestone input', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const first = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  const repeat = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { milestone_id: 'm2' });

  assert.equal(repeat.reused, true);
  assert.equal(repeat.no_new_work, true);
  assert.equal(repeat.milestone.id, 'm1');
  assert.equal(repeat.mission.id, first.mission.id);
  assert.equal(repeat.brain_run.id, first.brain_run.id);
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[1].state, 'PENDING');
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0 });
});

test('Planner start after first milestone completion does not manually start second milestone', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const first = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);
  await completeBrainRun(db, 'tenant_a', first.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false}</MRAPI_CONTROL><MRAPI_RESULT>m1 done.</MRAPI_RESULT>'
  });
  const before = counts(db);
  const afterCompleteStart = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);

  assert.equal(afterCompleteStart.reused, true);
  assert.equal(afterCompleteStart.no_new_work, true);
  assert.equal(afterCompleteStart.milestone.id, 'm1');
  assert.equal(afterCompleteStart.mission.id, first.mission.id);
  assert.deepEqual(counts(db), before);
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((item) => item.state), ['COMPLETED', 'PENDING']);
});

test('Planner HTTP start rejects lifecycle-selection body fields', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const response = await requestJson(plannerApp(db), 'POST', `/api/planner/roadmaps/${roadmap.roadmap_id}/start`, {
    milestone_id: 'm2'
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'PLANNER_START_BODY_UNSUPPORTED_FIELD');
  assert.deepEqual(db.get('roadmaps', roadmap.roadmap_id).milestones.map((item) => item.state), ['PENDING', 'PENDING']);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0 });
});

test('Planner service delegates initial start and contains no imported Roadmap selector', () => {
  const source = read('src/services/planner.js');
  assert.match(source, /startNextRoadmapMilestone\(db, tenantId, roadmapId/);
  assert.doesNotMatch(source, /require\(['"]\.\.\/services\/roadmap['"]\)|require\(['"]\.\/roadmap['"]\)/);
});

test('Roadmap advance fails closed without creating Mission, Run, Task, or transition', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const before = JSON.stringify(db.collections);
  const response = await requestJson(roadmapsApp(db), 'POST', `/api/roadmaps/${roadmap.roadmap_id}/advance`, {
    milestone_id: 'm1'
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'ROADMAP_LIFECYCLE_MANAGED_BY_AUTOPILOT');
  assert.equal(JSON.stringify(db.collections), before);
});

test('Roadmap advance source no longer calls lifecycle start or dispatch', () => {
  const source = read('src/routes/roadmaps.routes.js');
  assert.doesNotMatch(source, /startNextRoadmapMilestone/);
  assert.doesNotMatch(source, /dispatchMission/);
});

test('Direct milestone state route fails closed and cannot complete milestone or roadmap', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const before = JSON.stringify(db.collections);
  const response = await requestJson(roadmapsApp(db), 'POST', `/api/roadmaps/${roadmap.roadmap_id}/milestones/m1/state`, {
    state: 'COMPLETED'
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'ROADMAP_MILESTONE_STATE_MANAGED_BY_AUTOPILOT');
  assert.equal(JSON.stringify(db.collections), before);
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[0].state, 'PENDING');
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).state, 'ACTIVE');
});

test('GET Roadmap remains read-only and returns persisted state, next milestone, and runtime', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  const started = await startPlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id);
  await completeBrainRun(db, 'tenant_a', started.brain_run.id, {
    output_text: '<MRAPI_CONTROL>{"requires_execution":false}</MRAPI_CONTROL><MRAPI_RESULT>m1 done.</MRAPI_RESULT>'
  });
  const beforeCounts = counts(db);
  const beforeWrites = db.writes.length;
  const response = await requestJson(roadmapsApp(db), 'GET', `/api/roadmaps/${roadmap.roadmap_id}`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.state, 'ACTIVE');
  assert.equal(response.body.next_milestone.id, 'm2');
  assert.equal(response.body.milestone_runtime.length, 2);
  assert.equal(response.body.milestone_runtime.find((item) => item.milestone_id === 'm1').mission_id, started.mission.id);
  assert.deepEqual(counts(db), beforeCounts);
  assert.equal(db.writes.length, beforeWrites);
});

test('RESPONDER and downstream impact routes remain present', () => {
  const source = read('src/routes/roadmaps.routes.js');
  assert.match(source, /\/:roadmapId\/milestones\/:milestoneId\/respond/);
  assert.match(source, /\/:roadmapId\/milestones\/:milestoneId\/downstream-impact/);
  assert.match(source, /\/:roadmapId\/milestones\/:milestoneId\/downstream-impact\/:impactId\/approve/);
  assert.match(source, /\/:roadmapId\/milestones\/:milestoneId\/downstream-impact\/:impactId\/reject/);
});

test('Planner UI preserves recovery/read controls and initial Start Autopilot only', () => {
  const source = read('src/routes/planner.ui.routes.js');
  assert.match(source, /id="startAutopilot"/);
  assert.match(source, /\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/start'/);
  assert.match(source, /Replay Brain/);
  assert.match(source, /Retry Execution/);
  assert.match(source, /Resume/);
  assert.doesNotMatch(source, /\/api\/roadmaps\/' \+ encodeURIComponent\(.*\) \+ '\/advance/);
  assert.doesNotMatch(source, /\/milestones\/' \+ encodeURIComponent\([^)]*\) \+ '\/state/);
  assert.doesNotMatch(source, /Start Next Milestone|Start next milestone|Next Milestone/);
  assert.match(source, /hasStartedMilestone\(proposal\)/);
  assert.match(source, /await loadProposal\(\);/);
  assert.doesNotMatch(source, /state\.proposal\.milestones\s*=/);
  assert.doesNotMatch(source, /state\.proposal\.state\s*=/);
});

test('reopen preserves existing mission_id on blocked milestone and creates no Mission or Run', async () => {
  const db = new DB();
  const { roadmap } = await createApproved(db);
  db.set('roadmaps', roadmap.roadmap_id, {
    milestones: db.get('roadmaps', roadmap.roadmap_id).milestones.map((item) => item.id === 'm1'
      ? { ...item, state: 'BLOCKED', mission_id: 'mission_existing' }
      : item)
  }, { merge: true });
  db.set('missions', 'mission_existing', {
    id: 'mission_existing',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    roadmap_id: roadmap.roadmap_id,
    milestone_id: 'm1',
    state: 'BLOCKED'
  });
  const before = counts(db);
  const response = await requestJson(roadmapsApp(db), 'POST', `/api/roadmaps/${roadmap.roadmap_id}/reopen`, {
    milestone_id: 'm1'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[0].mission_id, 'mission_existing');
  assert.equal(db.get('roadmaps', roadmap.roadmap_id).milestones[0].state, 'BLOCKED');
  assert.deepEqual(counts(db), before);
});

test('m2 completion logic source remains in Autopilot and this milestone did not touch that file', () => {
  const source = read('src/services/autopilot.js');
  assert.match(source, /continueRoadmapAfterComplete/);
  assert.match(source, /completeVerificationBrainRun/);
});
