const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const vm = require('node:vm');
const { completePlannerBrainRun } = require('../src/services/planner');

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

  async runTransaction(fn) {
    return fn(new Transaction());
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
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

function loadWithMiniExpress(modulePath) {
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

function plannerApp(db) {
  const { createPlannerRouter } = loadWithMiniExpress('../src/routes/planner.routes');
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
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
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

function renderPlannerPage() {
  const { plannerPageHtml } = loadWithMiniExpress('../src/routes/planner.ui.routes');
  return plannerPageHtml();
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match);
  return match[1];
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function createHarness(html, fetchImpl, storage = {}) {
  const elements = new Map();
  const createElement = (id) => {
    const classes = new Set([
      'approveRoadmap',
      'requestChanges',
      'startAutopilot',
      'requestChangesView',
      'proposalView',
      'startView'
    ].includes(id) ? ['hidden'] : []);
    return {
      id,
      value: '',
      disabled: false,
      textContent: '',
      innerHTML: '',
      className: '',
      listeners: {},
      dataset: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      reset() { for (const current of elements.values()) current.value = ''; },
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
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const localStorage = {
    getItem(key) { return Object.hasOwn(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
    removeItem(key) { delete storage[key]; }
  };
  const context = { document, fetch: fetchImpl, localStorage, encodeURIComponent, String, Boolean, Number, Array, Error, Date };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal, openRecentPlannerRequest };`, context);
  return { planner: context.__planner, elements, storage };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function baseRoadmap(id, overrides = {}) {
  return {
    id,
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    proposal_type: 'PLANNER_ROADMAP',
    planner_request_id: `mission_${id}`,
    source_planner_mission_id: `mission_${id}`,
    source_planner_brain_run_id: `run_${id}`,
    title: `Roadmap ${id}`,
    objective: `Objective ${id}`,
    summary: `Summary ${id}`,
    risks: [],
    dependencies: [],
    assumptions: [],
    state: 'PROPOSED',
    approval_status: 'PENDING',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    milestones: [{
      id: 'm1',
      title: 'First milestone',
      objective: 'Do first work',
      description: 'Review first work',
      executor_required: false,
      dependencies: [],
      risks: [],
      success_criteria: ['Ready']
    }],
    provenance: { source: 'PLANNER_BRAIN_RUN' },
    ...overrides
  };
}

function seedHistory(db) {
  db.set('workspaces', 'workspace_a', { id: 'workspace_a', tenant_id: 'tenant_a', name: 'Alpha Workspace' });
  db.set('projects', 'project_a', { id: 'project_a', tenant_id: 'tenant_a', workspace_id: 'workspace_a', name: 'Alpha Project' });
  db.set('workspaces', 'workspace_b', { id: 'workspace_b', tenant_id: 'tenant_b', name: 'Beta Workspace' });
  db.set('projects', 'project_b', { id: 'project_b', tenant_id: 'tenant_b', workspace_id: 'workspace_b', name: 'Beta Project' });
  const states = [
    ['proposed', 'PROPOSED', 'PENDING'],
    ['active', 'ACTIVE', 'APPROVED'],
    ['completed', 'COMPLETED', 'APPROVED'],
    ['blocked', 'BLOCKED', 'PENDING'],
    ['cancelled', 'CANCELLED', 'PENDING']
  ];
  states.forEach(([id, state, approval], index) => {
    db.set('roadmaps', id, baseRoadmap(id, {
      title: `${state} title`,
      state,
      approval_status: approval,
      updated_at: `2026-01-0${index + 1}T00:00:00.000Z`
    }));
  });
  db.set('roadmaps', 'tenant_b_planner', baseRoadmap('tenant_b_planner', {
    tenant_id: 'tenant_b',
    workspace_id: 'workspace_b',
    project_id: 'project_b',
    title: 'Tenant B Planner',
    updated_at: '2026-02-01T00:00:00.000Z'
  }));
  db.set('roadmaps', 'generic_roadmap', {
    id: 'generic_roadmap',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Generic Roadmap',
    state: 'ACTIVE',
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z'
  });
}

function collectionCounts(db) {
  return {
    missions: values(db, 'missions').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    tasks: values(db, 'tasks').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length,
    roadmaps: values(db, 'roadmaps').length,
    events: values(db, 'events').length
  };
}

test('recent endpoint returns bounded tenant-scoped Planner history only with names and no side effects', async () => {
  const db = new Db();
  seedHistory(db);
  for (let index = 0; index < 12; index += 1) {
    db.set('roadmaps', `extra_${index}`, baseRoadmap(`extra_${index}`, {
      title: `Extra ${index}`,
      updated_at: `2026-01-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`
    }));
  }
  db.set('roadmaps', 'missing_names', baseRoadmap('missing_names', {
    workspace_id: 'workspace_missing',
    project_id: 'project_missing',
    title: '',
    objective: 'Fallback objective',
    updated_at: '2026-01-30T00:00:00.000Z'
  }));
  db.set('workspaces', 'workspace_missing', { id: 'workspace_missing', tenant_id: 'tenant_b', name: 'Do Not Leak Workspace' });
  db.set('projects', 'project_missing', { id: 'project_missing', tenant_id: 'tenant_b', workspace_id: 'workspace_missing', name: 'Do Not Leak Project' });
  const app = plannerApp(db);
  const before = JSON.stringify(db.collections);
  const beforeCounts = collectionCounts(db);

  const defaultResponse = await requestJson(app, 'GET', '/api/planner/recent', null, { 'x-tenant-id': 'tenant_a' });
  assert.equal(defaultResponse.statusCode, 200);
  assert.equal(defaultResponse.body.items.length, 10);
  assert.equal(defaultResponse.body.items[0].roadmap_id, 'missing_names');
  assert.equal(defaultResponse.body.items[0].proposal_id, 'missing_names');
  assert.equal(defaultResponse.body.items[0].title, 'Fallback objective');
  assert.equal(defaultResponse.body.items[0].workspace_name, 'workspace_missing');
  assert.equal(defaultResponse.body.items[0].project_name, 'project_missing');
  assert.ok(defaultResponse.body.items.every((item) => item.workspace_id && item.project_id && item.created_at && item.updated_at));
  assert.equal(defaultResponse.body.items.some((item) => item.title === 'Generic Roadmap'), false);
  assert.equal(defaultResponse.body.items.some((item) => item.title === 'Tenant B Planner'), false);
  assert.deepEqual(collectionCounts(db), beforeCounts);
  assert.equal(JSON.stringify(db.collections), before);

  const tenantBResponse = await requestJson(app, 'GET', '/api/planner/recent?limit=50', null, { 'x-tenant-id': 'tenant_b' });
  assert.deepEqual(tenantBResponse.body.items.map((item) => item.roadmap_id), ['tenant_b_planner']);
  assert.equal(tenantBResponse.body.items[0].workspace_name, 'Beta Workspace');

  const limitedResponse = await requestJson(app, 'GET', '/api/planner/recent?limit=500', null, { 'x-tenant-id': 'tenant_a' });
  assert.equal(limitedResponse.body.limit, 50);
  assert.ok(limitedResponse.body.items.length <= 50);
  const invalidLimitResponse = await requestJson(app, 'GET', '/api/planner/recent?limit=not-a-number', null, { 'x-tenant-id': 'tenant_a' });
  assert.equal(invalidLimitResponse.body.limit, 10);
});

test('recent endpoint preserves supported lifecycle records', async () => {
  const db = new Db();
  seedHistory(db);
  const app = plannerApp(db);
  const response = await requestJson(app, 'GET', '/api/planner/recent?limit=50', null, { 'x-tenant-id': 'tenant_a' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    new Set(response.body.items.map((item) => item.state)),
    new Set(['PROPOSED', 'ACTIVE', 'COMPLETED', 'BLOCKED', 'CANCELLED'])
  );
  assert.deepEqual(response.body.items.map((item) => item.roadmap_id), ['cancelled', 'blocked', 'completed', 'active', 'proposed']);
});

test('planner page renders recent history, tolerates history failure, escapes HTML, and reopens canonically', async () => {
  const html = renderPlannerPage();
  assert.match(html, /Recent Planner Requests/);
  assert.match(html, /\/api\/planner\/recent\?limit=10/);

  const calls = [];
  const canonicalProposal = baseRoadmap('safe_id', {
    title: 'Canonical Summary Title',
    state: 'PROPOSED',
    approval_status: 'PENDING'
  });
  const { planner } = createHarness(html, async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces') return response({ items: [{ id: 'workspace_a', name: 'Alpha Workspace' }] });
    if (url === '/api/projects') return response({ items: [{ id: 'project_a', workspace_id: 'workspace_a', name: 'Alpha Project' }] });
    if (url === '/api/planner/recent?limit=10') {
      return response({
        items: [{
          roadmap_id: 'safe_id',
          proposal_id: 'safe_id',
          title: '<img src=x onerror=alert(1)>',
          state: 'PROPOSED',
          approval_status: 'PENDING',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          workspace_id: 'workspace_a',
          project_id: 'project_a',
          workspace_name: '<b>Workspace</b>',
          project_name: 'Alpha Project'
        }]
      });
    }
    if (url === '/api/planner/proposals/safe_id') return response(canonicalProposal);
    throw new Error(`Unexpected fetch ${url}`);
  });
  await flush();
  assert.match(planner.els.recentList.innerHTML, /Recent|&lt;img/);
  assert.doesNotMatch(planner.els.recentList.innerHTML, /<img src=x/);
  assert.match(planner.els.recentList.innerHTML, /Waiting for approval/);
  assert.match(planner.els.recentList.innerHTML, /Workspace: &lt;b&gt;Workspace&lt;\/b&gt;/);
  assert.match(planner.els.recentList.innerHTML, /Project: Alpha Project/);

  await planner.els.recentList.listeners.click({
    target: {
      dataset: { proposalId: 'safe_id' },
      closest() { return this; }
    }
  });
  await flush();
  assert.equal(calls.filter((call) => call.url === '/api/planner/proposals/safe_id').length, 1);
  assert.equal(calls.some((call) => call.url === '/api/planner/requests' && call.options.method === 'POST'), false);
  assert.equal(calls.some((call) => /\/approve$|\/request-changes$|\/start$/.test(call.url)), false);
  assert.match(planner.els.proposalView.innerHTML, /ROADMAP SUMMARY/);
  assert.match(planner.els.proposalView.innerHTML, /Canonical Summary Title/);
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /&lt;img/);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.els.reset.listeners.click();
  assert.match(planner.els.recentList.innerHTML, /&lt;img/);

  const failing = createHarness(html, async (url) => {
    if (url === '/api/workspaces') return response({ items: [{ id: 'workspace_a', name: 'Alpha Workspace' }] });
    if (url === '/api/projects') return response({ items: [{ id: 'project_a', workspace_id: 'workspace_a', name: 'Alpha Project' }] });
    if (url === '/api/planner/recent?limit=10') return response({ error: 'BROKEN' }, false);
    if (url === '/api/planner/requests') return response({ planner_request_id: 'mission_1', mission_id: 'mission_1', brain_run_id: 'run_1' }, true);
    throw new Error(`Unexpected fetch ${url}`);
  });
  await flush();
  assert.equal(failing.planner.state.recentError, 'Recent Planner Requests failed to load.');
  failing.planner.els.workspace.value = 'workspace_a';
  failing.planner.els.project.value = 'project_a';
  failing.planner.els.request.value = 'New request';
  failing.planner.els.request.listeners.input();
  assert.equal(failing.planner.els.submit.disabled, false);
  await failing.planner.els.form.listeners.submit({ preventDefault() {} });
  assert.equal(failing.planner.state.requestId, 'mission_1');
});

test('history reopen does not overwrite restored active proposal until explicit click', async () => {
  const html = renderPlannerPage();
  const calls = [];
  const storage = {
    'mrapi.planner.active.v1': JSON.stringify({
      requestId: 'mission_active',
      proposalId: 'active_id',
      workspaceId: 'workspace_a',
      projectId: 'project_a',
      request: 'Active request'
    })
  };
  const { planner } = createHarness(html, async (url) => {
    calls.push(String(url));
    if (url === '/api/workspaces') return response({ items: [{ id: 'workspace_a', name: 'Alpha Workspace' }] });
    if (url === '/api/projects') return response({ items: [{ id: 'project_a', workspace_id: 'workspace_a', name: 'Alpha Project' }] });
    if (url === '/api/planner/recent?limit=10') {
      return response({ items: [{ roadmap_id: 'history_id', title: 'History', state: 'ACTIVE', approval_status: 'APPROVED', workspace_id: 'workspace_a', project_id: 'project_a' }] });
    }
    if (url === '/api/planner/proposals/active_id') return response(baseRoadmap('active_id', { title: 'Restored Active', state: 'ACTIVE', approval_status: 'APPROVED' }));
    if (url === '/api/planner/proposals/history_id') return response(baseRoadmap('history_id', { title: 'Clicked History', state: 'ACTIVE', approval_status: 'APPROVED' }));
    throw new Error(`Unexpected fetch ${url}`);
  }, storage);
  await flush();
  assert.equal(planner.state.proposalId, 'active_id');
  assert.match(planner.els.proposalView.innerHTML, /Restored Active/);
  assert.equal(calls.includes('/api/planner/proposals/history_id'), false);
  await planner.openRecentPlannerRequest('history_id');
  assert.equal(planner.state.proposalId, 'history_id');
  assert.match(planner.els.proposalView.innerHTML, /Clicked History/);
});

test('opening approved and terminal history uses existing action gates without auto-starting', async () => {
  const html = renderPlannerPage();
  const states = [
    ['approved_id', 'ACTIVE', 'APPROVED', false],
    ['completed_id', 'COMPLETED', 'APPROVED', true],
    ['blocked_id', 'BLOCKED', 'PENDING', true],
    ['cancelled_id', 'CANCELLED', 'PENDING', true]
  ];
  for (const [id, state, approval, startHidden] of states) {
    const calls = [];
    const { planner } = createHarness(html, async (url) => {
      calls.push(String(url));
      if (url === '/api/workspaces') return response({ items: [{ id: 'workspace_a', name: 'Alpha Workspace' }] });
      if (url === '/api/projects') return response({ items: [{ id: 'project_a', workspace_id: 'workspace_a', name: 'Alpha Project' }] });
      if (url === '/api/planner/recent?limit=10') return response({ items: [] });
      if (url === `/api/planner/proposals/${id}`) return response(baseRoadmap(id, { state, approval_status: approval }));
      throw new Error(`Unexpected fetch ${url}`);
    });
    await flush();
    await planner.openRecentPlannerRequest(id);
    assert.equal(planner.els.start.classList.contains('hidden'), startHidden, id);
    assert.equal(calls.some((call) => call.endsWith('/start')), false);
  }
});
