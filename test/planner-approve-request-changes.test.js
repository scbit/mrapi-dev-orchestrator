const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const vm = require('node:vm');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  requestPlannerRoadmapChanges,
  approvePlannerRoadmap
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
  db.set('workspaces', 'workspace_a', { id: 'workspace_a', tenant_id: 'tenant_a', name: 'Workspace A' });
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    primary_worker_ids: ['W01'],
    repository_full_name: 'stored/project'
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', workspace_id: 'workspace_a', state: 'IDLE' });
}

function proposal(overrides = {}) {
  return {
    title: 'Planner Review Roadmap',
    objective: 'Review the roadmap before any execution work starts.',
    summary: 'The proposal is read-only until approval or revision feedback.',
    risks: ['Revision could accidentally start execution'],
    dependencies: ['Planner proposal endpoint'],
    assumptions: ['Human approval is explicit'],
    milestones: [
      {
        id: 'm1',
        title: 'Review',
        objective: 'Inspect the proposal.',
        description: 'Show fields for human review only.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Start remains hidden']
      },
      {
        id: 'm2',
        title: 'Future Work',
        objective: 'Define future executor work.',
        description: 'Keep Codex work separate until approval and start.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Task creation could happen too early'],
        success_criteria: ['No Task is created by revision']
      }
    ],
    ...overrides
  };
}

async function proposedRoadmap(db) {
  seed(db);
  const request = await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    request: 'Build the original planner request'
  });
  const roadmap = await completePlannerBrainRun(db, 'tenant_a', request.brain_run_id, {
    proposal: proposal()
  });
  return { request, roadmap };
}

function counts(db) {
  return {
    tasks: values(db, 'tasks').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length
  };
}

function assertNoCodexWork(db) {
  assert.equal(counts(db).tasks, 0);
  assert.equal(counts(db).executionRuns, 0);
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
  delete require.cache[require.resolve(modulePath)];
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

function plannerApp(db) {
  const { createPlannerRouter } = loadWithMiniExpress('../src/routes/planner.routes');
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

async function renderPlannerPage() {
  const { createPlannerUiRouter } = loadWithMiniExpress('../src/routes/planner.ui.routes');
  const router = createPlannerUiRouter();
  let html = '';
  await router({ method: 'GET', url: '/planner' }, { setHeader() {}, end(value) { html = value; } }, () => {
    throw new Error('PLANNER_ROUTE_NOT_FOUND');
  });
  return html;
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match);
  return match[1];
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

function uiProposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_1',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    title: 'Planner Review Roadmap',
    objective: 'Review a persisted proposal.',
    summary: 'Read-only proposal fields are rendered for approval or revision.',
    risks: [],
    dependencies: [],
    assumptions: [],
    milestones: [
      {
        id: 'm1',
        title: 'Review',
        objective: 'Review the proposal.',
        description: 'No roadmap field is editable.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Feedback is separate'],
        state: 'PROPOSED'
      }
    ],
    ...overrides
  };
}

function createHarness(html, fetchImpl = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const context = { document, fetch: fetchImpl, encodeURIComponent, String, Boolean, Number, Array, Error };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal };`, context);
  return context.__planner;
}

test('valid PROPOSED proposal exposes approve and request-changes UI while Start stays hidden', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal(uiProposal());

  assert.match(html, /id="approveRoadmap"[^>]*>Approve roadmap/);
  assert.match(html, /id="requestChanges"[^>]*>Request changes/);
  assert.match(html, /id="revisionFeedback"/);
  assert.match(html, /textarea id="revisionFeedback"/);
  assert.match(html, /will be sent back to W01 to revise the roadmap/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
  assert.doesNotMatch(html, /name="tenant_id"|id="tenantId"/);
});

test('request-changes UI requires trimmed feedback and submits only bounded revision payload', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  const planner = createHarness(html, async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => uiProposal({
        state: 'PLANNING',
        revision_status: 'PENDING',
        revision_number: 2,
        latest_revision_feedback: 'Tighten the plan.'
      })
    };
  });

  planner.renderProposal(uiProposal());
  planner.els.proposalId.value = 'roadmap_1';
  await planner.els.requestChanges.listeners.click();
  assert.equal(planner.els.requestChangesView.classList.contains('hidden'), false);
  assert.equal(planner.els.submitRevision.disabled, true);

  planner.els.revisionFeedback.value = '   ';
  await planner.els.submitRevision.listeners.click();
  assert.equal(calls.length, 0);
  assert.match(planner.els.status.textContent, /feedback is required/i);

  planner.els.revisionFeedback.value = '  Tighten the plan.  ';
  planner.els.revisionFeedback.listeners.input();
  assert.equal(planner.els.submitRevision.disabled, false);
  await planner.els.submitRevision.listeners.click();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/planner\/roadmaps\/roadmap_1\/request-changes$/);
  assert.equal(calls[0].options.body, JSON.stringify({ feedback: 'Tighten the plan.' }));
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)), ['feedback']);
  assert.doesNotMatch(calls.map((call) => call.url).join('\n'), /\/approve|\/start/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
  assert.match(planner.els.status.textContent, /W01 is revising/);
});

test('approval, refresh, and request changes remain separate UI operations', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  const planner = createHarness(html, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/approve')) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => uiProposal({ state: 'ACTIVE', approval_status: 'APPROVED' }) };
  });
  planner.els.proposalId.value = 'roadmap_1';

  await planner.els.refresh.listeners.click();
  await planner.els.approve.listeners.click();

  assert.match(calls[0].url, /\/api\/planner\/proposals\/roadmap_1$/);
  assert.match(calls[1].url, /\/approve$/);
  assert.equal(calls[1].options.body, JSON.stringify({ approve: true }));
  assert.doesNotMatch(calls.map((call) => call.url).join('\n'), /request-changes|\/start/);
});

test('server rejects invalid request-changes states, malformed roadmaps, and wrong tenant', async () => {
  const terminalStates = ['ACTIVE', 'APPROVED', 'CANCELLED', 'BLOCKED', 'COMPLETED'];
  for (const state of terminalStates) {
    const db = new Db();
    const { roadmap } = await proposedRoadmap(db);
    db.set('roadmaps', roadmap.roadmap_id, {
      ...db.get('roadmaps', roadmap.roadmap_id),
      state,
      approval_status: state === 'ACTIVE' || state === 'APPROVED' ? 'APPROVED' : 'PENDING',
      non_executable: state === 'ACTIVE' || state === 'APPROVED' ? false : true
    });
    await assert.rejects(
      () => requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, { feedback: 'Revise it.' }),
      /PLANNER_ROADMAP_NOT_REVISIONABLE/
    );
    assertNoCodexWork(db);
  }

  const db = new Db();
  const { roadmap } = await proposedRoadmap(db);
  await assert.rejects(
    () => requestPlannerRoadmapChanges(db, 'tenant_b', roadmap.roadmap_id, { feedback: 'Revise it.' }),
    /PLANNER_ROADMAP_NOT_FOUND/
  );
  db.set('roadmaps', 'generic', {
    id: 'generic',
    tenant_id: 'tenant_a',
    proposal_type: 'GENERIC',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    non_executable: true,
    milestones: []
  });
  await assert.rejects(
    () => requestPlannerRoadmapChanges(db, 'tenant_a', 'generic', { feedback: 'Revise it.' }),
    /PLANNER_ROADMAP_NOT_REVISIONABLE/
  );
  await assert.rejects(
    () => requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, { feedback: '   ' }),
    /PLANNER_REVISION_FEEDBACK_REQUIRED/
  );
});

test('valid request changes persists feedback, provenance, W01 revision context, and no Codex work', async () => {
  const db = new Db();
  const { roadmap } = await proposedRoadmap(db);
  const before = counts(db);
  const result = await requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, {
    feedback: 'Split the first milestone and clarify review risks.',
    tenant_id: 'tenant_b',
    milestones: [{ id: 'evil' }],
    approve: true,
    start: true,
    executor_instructions: 'do work'
  });
  const stored = db.get('roadmaps', roadmap.roadmap_id);
  const run = db.get('runs', result.brain_run_id);

  assert.equal(result.state, 'PLANNING');
  assert.equal(stored.revision_status, 'PENDING');
  assert.equal(stored.latest_revision_feedback, 'Split the first milestone and clarify review risks.');
  assert.equal(stored.revision_number, 2);
  assert.equal(stored.active_revision_brain_run_id, result.brain_run_id);
  assert.equal(stored.revision_history.length, 1);
  assert.equal(stored.revision_history[0].title, 'Planner Review Roadmap');
  assert.equal(run.run_type, 'BRAIN_RUN');
  assert.equal(run.planning_mode, 'PLANNER_ROADMAP_PROPOSAL');
  assert.equal(run.task_id, null);
  assert.equal(run.revision_target_roadmap_id, roadmap.roadmap_id);
  assert.equal(run.brain_context.trusted_scope.tenant_id, 'tenant_a');
  assert.equal(run.brain_context.trusted_scope.workspace_id, 'workspace_a');
  assert.equal(run.brain_context.trusted_scope.project_id, 'project_a');
  assert.equal(run.brain_context.natural_language_request, 'Build the original planner request');
  assert.equal(run.brain_context.human_revision_feedback, 'Split the first milestone and clarify review risks.');
  assert.equal(run.brain_context.previous_proposal.title, 'Planner Review Roadmap');
  assert.equal(counts(db).brainRuns, before.brainRuns + 1);
  assertNoCodexWork(db);
});

test('duplicate request-changes replay reuses active Brain work', async () => {
  const db = new Db();
  const { roadmap } = await proposedRoadmap(db);
  const first = await requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, {
    feedback: 'Clarify dependencies.'
  });
  const second = await requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, {
    feedback: 'Clarify dependencies.'
  });

  assert.equal(second.reused, true);
  assert.equal(second.no_new_work, true);
  assert.equal(second.brain_run_id, first.brain_run_id);
  assert.equal(counts(db).brainRuns, 2);
  assertNoCodexWork(db);
});

test('completed revision returns to PROPOSED with pending approval and prior approval cannot carry forward', async () => {
  const db = new Db();
  const { roadmap } = await proposedRoadmap(db);
  const revision = await requestPlannerRoadmapChanges(db, 'tenant_a', roadmap.roadmap_id, {
    feedback: 'Make the revised roadmap more explicit.'
  });
  const revised = await completePlannerBrainRun(db, 'tenant_a', revision.brain_run_id, {
    proposal: proposal({ title: 'Revised Planner Review Roadmap' })
  });
  const stored = db.get('roadmaps', roadmap.roadmap_id);

  assert.equal(revised.roadmap_id, roadmap.roadmap_id);
  assert.equal(revised.title, 'Revised Planner Review Roadmap');
  assert.equal(revised.state, 'PROPOSED');
  assert.equal(revised.approval_status, 'PENDING');
  assert.equal(stored.approved_at, null);
  assert.equal(stored.approval, null);
  assert.equal(stored.non_executable, true);
  assert.equal(stored.revision_number, 2);
  assert.equal(stored.provenance.human_revision_feedback, 'Make the revised roadmap more explicit.');
  assertNoCodexWork(db);

  const approved = await approvePlannerRoadmap(db, 'tenant_a', roadmap.roadmap_id, { approve: true });
  assert.equal(approved.state, 'ACTIVE');
});

test('HTTP request-changes route accepts feedback only from owning tenant', async () => {
  const db = new Db();
  const { roadmap } = await proposedRoadmap(db);
  const app = plannerApp(db);

  const wrongTenant = await requestJson(app, 'POST', `/api/planner/roadmaps/${roadmap.roadmap_id}/request-changes`, {
    feedback: 'Revise this.'
  }, { 'x-tenant-id': 'tenant_b' });
  assert.equal(wrongTenant.statusCode, 404);
  assert.equal(wrongTenant.body.error, 'PLANNER_ROADMAP_NOT_FOUND');

  const ok = await requestJson(app, 'POST', `/api/planner/roadmaps/${roadmap.roadmap_id}/request-changes`, {
    feedback: 'Revise this.'
  }, { 'x-tenant-id': 'tenant_a' });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.body.state, 'PLANNING');
  assert.equal(ok.body.latest_revision_feedback, 'Revise this.');
  assertNoCodexWork(db);
});

test('revised PROPOSED UI again exposes approve/request changes and hides start; approved UI hides request changes', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);

  planner.renderProposal(uiProposal({
    revision_number: 2,
    latest_revision_feedback: 'Clarify the plan.'
  }));
  assert.match(planner.els.proposalView.innerHTML, /Revision 2/);
  assert.match(planner.els.proposalView.innerHTML, /Clarify the plan/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal(uiProposal({ state: 'ACTIVE', approval_status: 'APPROVED' }));
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), false);
});
