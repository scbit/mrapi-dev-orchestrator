const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const vm = require('node:vm');
const {
  completePlannerBrainRun
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

function plannerPageHtml() {
  return loadWithMiniExpress('../src/routes/planner.ui.routes').plannerPageHtml();
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

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'Planner page script must exist');
  return match[1];
}

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) { return Object.hasOwn(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    snapshot() { return { ...store }; }
  };
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
    reset() { this.value = ''; },
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

function sortedTenantItems(db, collectionName) {
  return values(db, collectionName)
    .filter((item) => item.tenant_id === 'tenant_a')
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function createHarness(db, options = {}) {
  const html = plannerPageHtml();
  const app = plannerApp(db);
  const elements = new Map();
  const calls = [];
  const storage = options.storage || createStorage();
  const fetchImpl = async (url, fetchOptions = {}) => {
    const call = { url: String(url), options: fetchOptions };
    calls.push(call);
    if (url === '/api/workspaces') return response({ items: sortedTenantItems(db, 'workspaces') });
    if (url === '/api/projects') return response({ items: sortedTenantItems(db, 'projects') });
    if (String(url).startsWith('/api/planner/')) {
      const result = await requestJson(app, fetchOptions.method || 'GET', String(url), fetchOptions.body ? JSON.parse(fetchOptions.body) : null, {
        'x-tenant-id': 'tenant_a'
      });
      return response(result.body, result.statusCode >= 200 && result.statusCode < 300);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const context = { document, fetch: fetchImpl, localStorage: storage, encodeURIComponent, String, Boolean, Number, Array, Error, Date, Promise };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  loadProposal,
  renderProposal,
  renderRecentPlannerRequests,
  openRecentPlannerRequest,
  loadRecentPlannerRequests,
  restoreRememberedContext
};`, context);
  return { planner: context.__planner, calls, storage, elements };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function seed(db) {
  db.set('workspaces', 'workspace_scb', { id: 'workspace_scb', tenant_id: 'tenant_a', name: 'SCB Workspace' });
  db.set('workspaces', 'workspace_other', { id: 'workspace_other', tenant_id: 'tenant_a', name: 'Other Workspace' });
  db.set('workspaces', 'workspace_b', { id: 'workspace_b', tenant_id: 'tenant_b', name: 'Tenant B Workspace' });
  db.set('projects', 'project_scb_development', {
    id: 'project_scb_development',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_scb',
    name: 'SCB Development',
    repository_full_name: 'org/scb',
    local_path: 'C:/repo/scb',
    default_branch: 'main',
    primary_worker_ids: ['W01']
  });
  db.set('projects', 'project_other', {
    id: 'project_other',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_other',
    name: 'Other Project',
    primary_worker_ids: ['W01']
  });
  db.set('projects', 'project_b', { id: 'project_b', tenant_id: 'tenant_b', workspace_id: 'workspace_b', name: 'Tenant B Project' });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', workspace_id: 'workspace_scb', state: 'IDLE' });
}

function proposal(overrides = {}) {
  return {
    title: 'Daily Planner UX Roadmap',
    objective: 'Validate a coherent daily Planner flow.',
    summary: 'The roadmap stays read-only until explicit approval and explicit start.',
    risks: ['Accidental lifecycle mutation', '<script>alert(1)</script> hidden risk'],
    dependencies: ['Planner API', 'Recent history'],
    assumptions: ['Tenant scope is server-owned'],
    milestones: [
      {
        id: 'm1',
        title: 'Review plan',
        objective: 'Show the proposal in a summary-first review.',
        description: 'The reviewer sees this description only after expanding the milestone.',
        executor_required: false,
        dependencies: [],
        risks: ['Review detail can be too technical'],
        success_criteria: ['Approval remains explicit']
      },
      {
        id: 'm2',
        title: 'Start eligible work',
        objective: 'Start only after approval.',
        description: 'Autopilot handoff happens from the approved roadmap only.',
        executor_required: true,
        dependencies: [],
        risks: ['Start could run too early'],
        success_criteria: ['Start remains gated']
      }
    ],
    ...overrides
  };
}

function visibleActions(planner) {
  return {
    approve: !planner.els.approve.classList.contains('hidden'),
    requestChanges: !planner.els.requestChanges.classList.contains('hidden'),
    start: !planner.els.start.classList.contains('hidden')
  };
}

function mutationCalls(calls) {
  return calls.filter((call) => call.options?.method && call.options.method !== 'GET');
}

test('daily-use Planner UX integrates context, intake, review, approval, history, terminal, and human-action gates', async () => {
  const db = new Db();
  seed(db);
  const storage = createStorage({
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
  });
  const { planner, calls } = createHarness(db, { storage });
  await flush();

  assert.deepEqual(calls.map((call) => call.url), ['/api/planner/recent?limit=10', '/api/workspaces', '/api/projects']);
  assert.equal(mutationCalls(calls).length, 0);
  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
  assert.match(planner.els.workspace.innerHTML, /SCB Workspace/);
  assert.match(planner.els.workspace.innerHTML, /Other Workspace/);
  assert.match(planner.els.project.innerHTML, /SCB Development/);
  assert.doesNotMatch(planner.els.project.innerHTML, /Other Project/);
  assert.deepEqual(counts(db), { missions: 0, brainRuns: 0, tasks: 0, executionRuns: 0 });

  planner.els.request.value = '  Validate Planner daily use  ';
  await planner.els.form.listeners.submit({ preventDefault() {} });
  const requestCall = calls.find((call) => call.url === '/api/planner/requests');
  assert.deepEqual(JSON.parse(requestCall.options.body), {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Validate Planner daily use'
  });
  assert.equal(Object.hasOwn(JSON.parse(requestCall.options.body), 'tenant_id'), false);
  assert.match(planner.els.status.textContent, /W01.*preparando el roadmap/);
  assert.doesNotMatch(planner.els.status.textContent, /missions_|runs_|planner/i);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });

  const requestId = planner.state.requestId;
  const brainRunId = planner.state.brainRunId;
  const completed = await completePlannerBrainRun(db, 'tenant_a', brainRunId, { proposal: proposal() });
  assert.equal(db.get('roadmaps', completed.roadmap_id).non_executable, true);
  assertNoCodexWork(db);

  calls.length = 0;
  planner.els.proposalId.value = completed.roadmap_id;
  await planner.loadProposal();
  const proposedHtml = planner.els.proposalView.innerHTML;
  assert.equal(planner.state.proposalId, completed.roadmap_id);
  assert.match(planner.els.status.textContent, /Waiting for approval/);
  assert.deepEqual(visibleActions(planner), { approve: true, requestChanges: true, start: false });
  assert.equal(calls.map((call) => call.url).includes(`/api/planner/proposals/${completed.roadmap_id}`), true);
  assert.equal(mutationCalls(calls).length, 0);
  assertNoCodexWork(db);
  assert.equal(proposedHtml.indexOf('ROADMAP SUMMARY') < proposedHtml.indexOf('Advanced roadmap details'), true);
  assert.match(proposedHtml, /Validate a coherent daily Planner flow/);
  assert.match(proposedHtml, /Review plan[\s\S]*Show the proposal in a summary-first review/);
  assert.doesNotMatch(proposedHtml, /<details class="milestone" open/);
  assert.doesNotMatch(proposedHtml.match(/<summary class="milestone-summary">([\s\S]*?)<\/summary>/)[1], /m1|executor_required|false|PROPOSED/);
  assert.match(proposedHtml, /The reviewer sees this description only after expanding the milestone/);
  assert.match(proposedHtml, /Advanced milestone details[\s\S]*Milestone ID[\s\S]*m1/);
  assert.match(proposedHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  planner.els.requestChanges.listeners.click();
  planner.els.revisionFeedback.value = '  Make the summary more operational.  ';
  planner.els.revisionFeedback.listeners.input();
  calls.length = 0;
  await planner.els.submitRevision.listeners.click();
  const revisionCall = calls.find((call) => call.url.endsWith('/request-changes'));
  assert.equal(revisionCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(revisionCall.options.body), { feedback: 'Make the summary more operational.' });
  assert.equal(calls.some((call) => call.url.endsWith('/start') || call.url.includes('/api/tasks')), false);
  assertNoCodexWork(db);
  assert.match(planner.els.status.textContent, /Cambios pedidos/);
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false });

  const pendingRevision = db.get('roadmaps', completed.roadmap_id);
  const revised = await completePlannerBrainRun(db, 'tenant_a', pendingRevision.active_revision_brain_run_id, {
    proposal: proposal({
      summary: 'Updated proposal summary after revision.',
      milestones: proposal().milestones.map((milestone) => ({ ...milestone, description: `${milestone.description} Revised.` }))
    })
  });
  calls.length = 0;
  await planner.loadProposal();
  assert.equal(revised.roadmap_id, completed.roadmap_id);
  assert.match(planner.els.proposalView.innerHTML, /Updated proposal summary after revision/);
  assert.deepEqual(visibleActions(planner), { approve: true, requestChanges: true, start: false });
  assert.equal(mutationCalls(calls).length, 0);
  assertNoCodexWork(db);

  calls.length = 0;
  await planner.els.approve.listeners.click();
  assert.equal(calls.some((call) => call.url.endsWith('/approve') && call.options.method === 'POST'), true);
  assert.equal(calls.some((call) => call.url.endsWith('/start')), false);
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: true });
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 2, tasks: 0, executionRuns: 0 });

  calls.length = 0;
  await planner.els.start.listeners.click();
  assert.equal(calls.some((call) => call.url.endsWith('/start') && call.options.method === 'POST'), true);
  assert.match(planner.els.startView.innerHTML, /Autopilot started|Existing Autopilot work reused/);
  assert.match(planner.els.startView.innerHTML, /Current milestone: Review plan/);
  assert.equal(planner.els.startView.innerHTML.indexOf('Current milestone: Review plan') < planner.els.startView.innerHTML.indexOf('Advanced execution details'), true);
  assert.match(planner.els.startView.innerHTML, /Mission ID[\s\S]*Brain Run ID/);
  assertNoCodexWork(db);

  calls.length = 0;
  await planner.loadRecentPlannerRequests();
  assert.equal(calls[0].url, '/api/planner/recent?limit=10');
  assert.match(planner.els.recentList.innerHTML, /Daily Planner UX Roadmap/);
  assert.match(planner.els.recentList.innerHTML, /Workspace: SCB Workspace/);
  assert.match(planner.els.recentList.innerHTML, /Project: SCB Development/);
  assert.match(planner.els.recentList.innerHTML, /Approved|Running/);
  planner.state.recentPlannerRequests = [{
    roadmap_id: completed.roadmap_id,
    title: 'Abbreviated title only',
    summary: '<img src=x onerror=alert(1)>',
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    workspace_name: 'SCB Workspace',
    project_name: 'SCB Development',
    updated_at: '2026-01-01T00:00:00.000Z'
  }];
  planner.renderRecentPlannerRequests();
  assert.match(planner.els.recentList.innerHTML, /Abbreviated title only/);
  assert.doesNotMatch(planner.els.recentList.innerHTML, /<img src=x/);
  calls.length = 0;
  await planner.openRecentPlannerRequest(completed.roadmap_id);
  assert.deepEqual(calls.map((call) => call.url), [`/api/planner/proposals/${completed.roadmap_id}`]);
  assert.match(planner.els.proposalView.innerHTML, /Updated proposal summary after revision/);
  assert.equal(mutationCalls(calls).length, 0);

  planner.renderProposal({
    ...proposal({ state: 'RUNNING', approval_status: 'APPROVED' }),
    roadmap_id: 'running_view',
    current_milestone_id: 'm2',
    mission_id: 'mission_technical',
    brain_run_id: 'brain_technical',
    milestones: [
      { ...proposal().milestones[0], state: 'COMPLETED' },
      { ...proposal().milestones[1], id: 'm2', title: 'Current daily work', objective: 'Finish the visible milestone.', state: 'RUNNING' }
    ]
  });
  assert.match(planner.els.proposalView.innerHTML, /Running/);
  assert.match(planner.els.proposalView.innerHTML, /Current milestone: Current daily work/);
  assert.equal(planner.els.proposalView.innerHTML.indexOf('Current milestone: Current daily work') < planner.els.proposalView.innerHTML.indexOf('Advanced roadmap details'), true);

  const completedProposal = {
    ...proposal({ state: 'COMPLETED', approval_status: 'APPROVED' }),
    roadmap_id: 'completed_history',
    final_summary: 'Persisted final narrative.',
    milestones: [
      { ...proposal().milestones[0], state: 'COMPLETED' },
      { ...proposal().milestones[1], state: 'BLOCKED' }
    ]
  };
  db.set('roadmaps', 'completed_history', {
    ...completedProposal,
    id: 'completed_history',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    proposal_type: 'PLANNER_ROADMAP',
    non_executable: true,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z'
  });
  calls.length = 0;
  await planner.openRecentPlannerRequest('completed_history');
  assert.deepEqual(calls.map((call) => call.url), ['/api/planner/proposals/completed_history']);
  assert.match(planner.els.proposalView.innerHTML, /COMPLETED ROADMAP/);
  assert.match(planner.els.proposalView.innerHTML, /Original objective:<\/strong> Validate a coherent daily Planner flow/);
  assert.match(planner.els.proposalView.innerHTML, /Completed[\s\S]*<strong>1<\/strong>/);
  assert.match(planner.els.proposalView.innerHTML, /Persisted final narrative/);
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false });

  planner.renderProposal({
    ...completedProposal,
    roadmap_id: 'completed_fallback',
    final_summary: ''
  });
  assert.match(planner.els.proposalView.innerHTML, /Completed based on persisted roadmap state; no final result summary is available/);

  planner.renderProposal({
    ...proposal({ state: 'ACTIVE', approval_status: 'APPROVED' }),
    roadmap_id: 'human_action',
    current_milestone_id: 'human_m1',
    milestones: [{
      id: 'human_m1',
      title: 'User checkpoint',
      objective: 'Wait for explicit user action.',
      description: 'Explicit checkpoint metadata drives this panel.',
      executor_required: false,
      human_action_required: true,
      human_action_request: 'MRAPI needs access confirmation.',
      user_action: 'Confirm access in the provider.',
      checkpoint_id: 'checkpoint_1',
      checkpoint_type: 'MANUAL_ACTION',
      status: 'WAITING_FOR_HUMAN',
      dependencies: [],
      risks: [],
      success_criteria: ['Access confirmed']
    }]
  });
  assert.match(planner.els.proposalView.innerHTML, /Need human action/);
  assert.match(planner.els.proposalView.innerHTML, /MRAPI needs:<\/strong> MRAPI needs access confirmation/);
  assert.match(planner.els.proposalView.innerHTML, /What you need to do:<\/strong> Confirm access in the provider/);
  assert.match(planner.els.proposalView.innerHTML, /<button class="primary" type="button" disabled>LISTO<\/button>/);
  assert.match(planner.els.proposalView.innerHTML, /Advanced checkpoint details[\s\S]*checkpoint_1[\s\S]*MANUAL_ACTION/);
  assert.equal(mutationCalls(calls).some((call) => /checkpoint|continue|resume|listo/i.test(call.url)), false);

  planner.renderProposal({
    ...proposal({ state: 'ACTIVE', approval_status: 'APPROVED' }),
    roadmap_id: 'brain_only',
    milestones: [{ ...proposal().milestones[0], executor_required: false, title: 'Brain only discussion' }]
  });
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /human-action-panel|LISTO|MRAPI needs:/);

  planner.renderProposal({ roadmap_id: 'malformed', title: 'Malformed', state: 'PROPOSED', approval_status: 'PENDING' });
  assert.match(planner.els.proposalView.innerHTML, /incomplete or malformed/i);
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false });
  for (const state of ['BLOCKED', 'CANCELLED']) {
    planner.renderProposal(proposal({ roadmap_id: `${state}_roadmap`, state, approval_status: 'PENDING' }));
    assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false }, state);
  }

  storage.setItem('mrapi.planner.context.v1', JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' }));
  planner.state.recentPlannerRequests = [{ roadmap_id: 'completed_history', title: 'Completed history', state: 'COMPLETED' }];
  planner.renderRecentPlannerRequests();
  planner.els.reset.listeners.click();
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.proposalId, null);
  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
  assert.match(planner.els.recentList.innerHTML, /Completed history/);
  assert.equal(values(db, 'roadmaps').some((roadmap) => roadmap.id === completed.roadmap_id || roadmap.title === 'Daily Planner UX Roadmap'), true);
  assert.equal(requestId.startsWith('missions_'), true);
});

test('remembered context safety handles stale and active asynchronous restoration without lifecycle mutation', async () => {
  const db = new Db();
  seed(db);
  const staleProject = createHarness(db, {
    storage: createStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_other' })
    })
  });
  await flush();
  assert.equal(staleProject.planner.els.workspace.value, 'workspace_scb');
  assert.equal(staleProject.planner.els.project.value, '');
  assert.equal(mutationCalls(staleProject.calls).length, 0);

  const missingWorkspace = createHarness(db, {
    storage: createStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_missing', projectId: 'project_scb_development' })
    })
  });
  await flush();
  assert.equal(missingWorkspace.planner.els.workspace.value, '');
  assert.equal(missingWorkspace.planner.els.project.value, '');
  assert.equal(mutationCalls(missingWorkspace.calls).length, 0);

  db.set('roadmaps', 'active_restore', {
    ...proposal({ state: 'ACTIVE', approval_status: 'APPROVED' }),
    id: 'active_restore',
    roadmap_id: 'active_restore',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_other',
    project_id: 'project_other',
    proposal_type: 'PLANNER_ROADMAP',
    non_executable: true,
    created_at: '2026-01-03T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z'
  });
  const active = createHarness(db, {
    storage: createStorage({
      'mrapi.planner.active.v1': JSON.stringify({
        requestId: 'request_active',
        proposalId: 'active_restore',
        workspaceId: 'workspace_other',
        projectId: 'project_other',
        request: 'Continue active request'
      }),
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
    })
  });
  for (let i = 0; i < 5 && !active.planner.els.proposalView.innerHTML; i += 1) {
    await flush();
  }
  assert.equal(active.planner.els.workspace.value, 'workspace_other');
  assert.equal(active.planner.els.project.value, 'project_other');
  assert.equal(active.planner.state.proposalId, 'active_restore');
  assert.match(active.planner.els.proposalView.innerHTML, /Daily Planner UX Roadmap/);
  assert.equal(active.calls.some((call) => call.url === '/api/planner/proposals/active_restore'), true);
  assert.equal(active.calls.some((call) => call.url.includes('/approve') || call.url.includes('/request-changes') || call.url.includes('/start')), false);
  assert.equal(mutationCalls(active.calls).length, 0);
  assertNoCodexWork(db);
});
