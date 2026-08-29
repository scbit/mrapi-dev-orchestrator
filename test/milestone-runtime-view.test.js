const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const {
  resolveMilestoneRuntime,
  resolveRoadmapRuntime
} = require('../src/services/milestoneRuntime');

class Snap {
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
    this.db.reads += 1;
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
    this.db.reads += 1;
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

class DB {
  constructor() {
    this.collections = {};
    this.n = {};
    this.reads = 0;
    this.writes = [];
    this.transactions = 0;
  }
  collection(name) {
    return new Coll(this, name);
  }
  next(name) {
    this.n[name] = (this.n[name] || 0) + 1;
    return `${name}_${this.n[name]}`;
  }
  get(name, id) {
    return this.collections[name]?.[id] || null;
  }
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
  async runTransaction() {
    this.transactions += 1;
    throw new Error('UNEXPECTED_WRITE_TRANSACTION');
  }
}

function at(value) {
  return new Date(value);
}

function roadmap(overrides = {}) {
  return {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    title: 'Runtime Roadmap',
    custom_field: 'preserved',
    milestones: [
      {
        id: 'm1',
        title: 'First',
        state: 'RUNNING',
        dependencies: ['setup'],
        mission_id: 'mission_a'
      }
    ],
    ...overrides
  };
}

function seedTrustedMission(db, mission = {}, milestone = {}) {
  const storedRoadmap = roadmap({
    milestones: [{ ...roadmap().milestones[0], ...milestone }]
  });
  db.set('roadmaps', storedRoadmap.id, storedRoadmap);
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    state: 'BLOCKED',
    autopilot_mode: true,
    ...mission
  });
  return storedRoadmap;
}

async function assertNoRuntimeWrites(db, fn) {
  const before = JSON.stringify(db.collections);
  const result = await fn();
  assert.equal(db.writes.length, 0);
  assert.equal(db.transactions, 0);
  assert.equal(JSON.stringify(db.collections), before);
  return result;
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

function loadRoadmapsRouterWithMiniExpress() {
  const resolved = require.resolve('../src/routes/roadmaps.routes');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/roadmaps.routes');
  } finally {
    Module._load = originalLoad;
  }
}

function createRepos(db) {
  return {
    roadmaps: {
      async getById(id) {
        const data = db.get('roadmaps', id);
        return data ? { id, ...data } : null;
      },
      async listByTenant() { return []; },
      async listByProject() { return []; },
      async upsert() { throw new Error('UNEXPECTED_WRITE'); }
    },
    projects: {
      async getById() { return null; }
    }
  };
}

function roadmapsApp(db) {
  const { createRoadmapsRouter } = loadRoadmapsRouterWithMiniExpress();
  const router = createRoadmapsRouter({ db, repos: createRepos(db) });
  return async (req, res) => {
    req.body = {};
    req.query = {};
    req.header = (name) => req.headers[String(name).toLowerCase()];
    req.tenantId = req.header('x-tenant-id') || 'tenant_a';
    req.url = req.url.replace(/^\/api\/roadmaps/, '') || '/';
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
  };
}

async function requestJson(app, method, routePath, headers = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('milestone without mission_id returns null mission runtime and writes nothing', async () => {
  const db = new DB();
  const storedRoadmap = roadmap({ milestones: [{ id: 'm1', state: 'PENDING', dependencies: ['m0'] }] });
  const runtime = await assertNoRuntimeWrites(db, () =>
    resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]));

  assert.equal(runtime.mission_id, null);
  assert.equal(runtime.mission_state, null);
  assert.equal(runtime.brain_run, null);
  assert.equal(runtime.execution_run, null);
  assert.equal(runtime.human_action, null);
  assert.equal(runtime.latest_evidence, null);
  assert.equal(runtime.recovery.recoverable, false);
  assert.equal(runtime.recovery.reason, 'NO_MISSION_LINKED');
});

test('BLOCKED Mission remains represented with recovery classification', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { state: 'BLOCKED', blocker_code: 'BRAIN_RESULT_MISSING' }, { state: 'BLOCKED' });
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    mission_id: 'mission_a',
    run_type: 'BRAIN_RUN',
    state: 'FAILED',
    created_at: at('2026-01-01T00:00:00Z')
  });

  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.mission_id, 'mission_a');
  assert.equal(runtime.mission_state, 'BLOCKED');
  assert.equal(runtime.recovery.mode, 'BRAIN_REPLAY');
  assert.equal(runtime.recovery.action_label, 'Replay Brain');
});

test('FAILED Mission remains represented with the same mission_id', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { state: 'FAILED', failure_code: 'EXECUTION_FAILED' }, { state: 'FAILED' });
  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.mission_id, 'mission_a');
  assert.equal(runtime.mission_state, 'FAILED');
  assert.equal(runtime.blocker.code, 'EXECUTION_FAILED');
});

test('WAITING_HUMAN Mission remains represented and exposes checkpoint', async () => {
  const db = new DB();
  const checkpoint = {
    checkpoint_id: 'cp1',
    human_action_required: true,
    status: 'WAITING_FOR_HUMAN',
    human_action_request: 'Grant repository access.',
    mission_id: 'mission_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  };
  const storedRoadmap = seedTrustedMission(db, {
    state: 'WAITING_HUMAN',
    human_action_checkpoint: checkpoint
  }, {
    state: 'NEED_HUMAN_ACTION',
    human_action_checkpoint: checkpoint
  });

  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.mission_id, 'mission_a');
  assert.equal(runtime.mission_state, 'WAITING_HUMAN');
  assert.equal(runtime.human_action.checkpoint_id, 'cp1');
  assert.equal(runtime.human_action.human_action_request, 'Grant repository access.');
});

test('RETRYABLE Mission remains represented and is not filtered out', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { state: 'RETRYABLE' }, { state: 'BLOCKED' });
  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.mission_id, 'mission_a');
  assert.equal(runtime.mission_state, 'RETRYABLE');
  assert.equal(runtime.recovery.mode, 'NO_ACTION');
});

test('multiple runs choose latest Brain and Execution runs for same Mission only', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db);
  db.set('runs', 'brain_old', { id: 'brain_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'BRAIN_RUN', created_at: at('2026-01-01T00:00:00Z') });
  db.set('runs', 'brain_new', { id: 'brain_new', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'BRAIN_RUN', updated_at: at('2026-01-03T00:00:00Z') });
  db.set('runs', 'exec_old', { id: 'exec_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'EXECUTION_RUN', created_at: at('2026-01-02T00:00:00Z') });
  db.set('runs', 'exec_new', { id: 'exec_new', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'EXECUTION_RUN', completed_at: at('2026-01-04T00:00:00Z') });
  db.set('runs', 'brain_other', { id: 'brain_other', tenant_id: 'tenant_a', mission_id: 'other_mission', run_type: 'BRAIN_RUN', updated_at: at('2026-01-05T00:00:00Z') });

  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.brain_run.id, 'brain_new');
  assert.equal(runtime.execution_run.id, 'exec_new');
});

test('evidence selection returns latest exact tenant Mission milestone evidence only', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db);
  db.set('evidence', 'wrong_tenant', { id: 'wrong_tenant', tenant_id: 'tenant_b', mission_id: 'mission_a', milestone_id: 'm1', created_at: at('2026-01-05T00:00:00Z') });
  db.set('evidence', 'wrong_mission', { id: 'wrong_mission', tenant_id: 'tenant_a', mission_id: 'mission_b', milestone_id: 'm1', created_at: at('2026-01-06T00:00:00Z') });
  db.set('evidence', 'wrong_milestone', { id: 'wrong_milestone', tenant_id: 'tenant_a', mission_id: 'mission_a', milestone_id: 'm2', created_at: at('2026-01-07T00:00:00Z') });
  db.set('evidence', 'old_match', { id: 'old_match', tenant_id: 'tenant_a', mission_id: 'mission_a', milestone_id: 'm1', title: 'old', created_at: at('2026-01-01T00:00:00Z') });
  db.set('evidence', 'new_match', { id: 'new_match', tenant_id: 'tenant_a', mission_id: 'mission_a', milestone_id: 'm1', title: 'new', created_at: at('2026-01-04T00:00:00Z') });

  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.latest_evidence.id, 'new_match');
  assert.equal(runtime.latest_evidence.title, 'new');
});

test('Mission provenance mismatch fails closed and does not attach trusted Mission', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { roadmap_id: 'other_roadmap' });
  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', storedRoadmap, storedRoadmap.milestones[0]);
  assert.equal(runtime.mission_id, null);
  assert.equal(runtime.blocker.code, 'TRUSTED_PROVENANCE_MISMATCH');
  assert.equal(runtime.recovery.reason, 'TRUSTED_PROVENANCE_MISMATCH');
});

test('resolveRoadmapRuntime preserves milestone order, IDs, and dependencies', async () => {
  const db = new DB();
  const storedRoadmap = roadmap({
    milestones: [
      { id: 'm3', state: 'PENDING', dependencies: ['m2'] },
      { id: 'm1', state: 'COMPLETED', depends_on: [] },
      { id: 'm2', state: 'RUNNING', dependencies: ['m1'], mission_id: 'mission_a' }
    ]
  });
  db.set('roadmaps', storedRoadmap.id, storedRoadmap);
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    state: 'RUNNING',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2'
  });
  const beforeMilestones = JSON.stringify(storedRoadmap.milestones);

  const runtime = await resolveRoadmapRuntime(db, 'tenant_a', storedRoadmap);
  assert.deepEqual(runtime.map((item) => item.milestone_id), ['m3', 'm1', 'm2']);
  assert.equal(JSON.stringify(storedRoadmap.milestones), beforeMilestones);
  assert.deepEqual(storedRoadmap.milestones[0].dependencies, ['m2']);
  assert.deepEqual(storedRoadmap.milestones[2].dependencies, ['m1']);
});

test('GET /roadmaps/:roadmapId preserves existing response and adds milestone_runtime', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { state: 'RUNNING' }, { state: 'RUNNING' });
  db.set('roadmaps', storedRoadmap.id, {
    ...storedRoadmap,
    custom_field: 'still here'
  });

  const response = await requestJson(
    roadmapsApp(db),
    'GET',
    '/api/roadmaps/roadmap_a',
    { 'x-tenant-id': 'tenant_a' }
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, 'roadmap_a');
  assert.equal(response.body.custom_field, 'still here');
  assert.ok(Object.hasOwn(response.body, 'next_milestone'));
  assert.equal(response.body.milestone_runtime.length, 1);
  assert.equal(response.body.milestone_runtime[0].mission_id, 'mission_a');
});

test('runtime resolution invokes no write method', async () => {
  const db = new DB();
  const storedRoadmap = seedTrustedMission(db, { state: 'FAILED' }, { state: 'FAILED' });
  await assertNoRuntimeWrites(db, () => resolveRoadmapRuntime(db, 'tenant_a', storedRoadmap));
});
