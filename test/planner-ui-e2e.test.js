const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  completePlannerBrainRun,
  getPlannerProposal
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

function assertNoExecutorWork(db) {
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
}

function seed(db) {
  db.set('workspaces', 'workspace_scb', {
    id: 'workspace_scb',
    tenant_id: 'tenant_facundo_group',
    name: 'SCB Workspace',
    description: 'Trusted test workspace'
  });
  db.set('projects', 'project_scb_development', {
    id: 'project_scb_development',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    repository_full_name: 'facundo/scb',
    local_path: 'C:/repo/scb',
    default_branch: 'main',
    default_worker_id: 'W01',
    primary_worker_ids: ['W01'],
    reusable_instructions: 'Use stored project context only.'
  });
  db.set('workspaces', 'workspace_other', {
    id: 'workspace_other',
    tenant_id: 'tenant_other',
    name: 'Other Workspace'
  });
  db.set('projects', 'project_other', {
    id: 'project_other',
    tenant_id: 'tenant_other',
    workspace_id: 'workspace_other',
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    state: 'IDLE'
  });
}

function proposal(overrides = {}) {
  return {
    title: 'SCB Planner Roadmap',
    objective: 'Validate the Planner request, review, approval, and Autopilot handoff workflow.',
    summary: 'The roadmap remains persisted and non-executable until explicit approval, then explicit start.',
    risks: ['Start could be confused with approval'],
    dependencies: ['Existing Planner lifecycle', 'Existing Autopilot handoff'],
    assumptions: ['Tenant scope is server-authoritative'],
    milestones: [
      {
        id: 'm1',
        title: 'Brain-only Foundation',
        objective: 'Confirm the stored request and context.',
        description: 'Prepare the non-executable foundation for later milestones.',
        executor_required: false,
        dependencies: [],
        risks: ['Could create task work too early'],
        success_criteria: ['No Task is created before Brain-only completion']
      },
      {
        id: 'm2',
        title: 'Executor Implementation',
        objective: 'Prepare executable work only after the foundation completes.',
        description: 'Use dependency gating so this milestone cannot start first.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Dependency gating could be bypassed'],
        success_criteria: ['Only current eligible work starts']
      }
    ],
    ...overrides
  };
}

function revisedProposal() {
  return proposal({
    title: 'Revised SCB Planner Roadmap',
    summary: 'The revised roadmap incorporates human feedback and returns to pending approval.',
    risks: ['Revision feedback could be dropped']
  });
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
      try {
        req.body = raw ? JSON.parse(raw) : {};
        req.header = (name) => req.headers[String(name).toLowerCase()];
        req.tenantId = req.header('x-tenant-id') || 'tenant_facundo_group';
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

async function renderPlannerPage() {
  const { createPlannerUiRouter } = loadWithMiniExpress('../src/routes/planner.ui.routes');
  const router = createPlannerUiRouter();
  let html = '';
  await router({ method: 'GET', url: '/planner' }, { setHeader() {}, end(value) { html = value; } }, () => {
    throw new Error('PLANNER_UI_ROUTE_NOT_FOUND');
  });
  return html;
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'Planner page script must exist');
  return match[1];
}

function createHarness(html, fetchImpl) {
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
    const element = {
      id,
      value: '',
      disabled: false,
      textContent: '',
      innerHTML: '',
      className: '',
      listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      reset() {
        for (const current of elements.values()) current.value = '';
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
    return element;
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const context = { document, fetch: fetchImpl, encodeURIComponent, String, Boolean, Number, Array, Error };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal };`, context);
  return { planner: context.__planner, elements };
}

function responseFromRoute(routeResponse) {
  return {
    ok: routeResponse.statusCode >= 200 && routeResponse.statusCode < 300,
    json: async () => routeResponse.body
  };
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

test('integrated UI request changes approval and start lifecycle is persisted and idempotent', async () => {
  const db = new Db();
  seed(db);
  const app = plannerApp(db);
  const html = await renderPlannerPage();
  const calls = [];
  const { planner } = createHarness(html, async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    return responseFromRoute(await requestJson(app, method, String(url), body, { 'x-tenant-id': 'tenant_facundo_group' }));
  });

  planner.els.workspace.value = ' workspace_scb ';
  planner.els.project.value = ' project_scb_development ';
  planner.els.request.value = '  Build a coherent Planner UI workflow  ';
  planner.els.request.listeners.input();
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(calls[0].url, '/api/planner/requests');
  assert.equal(calls[0].options.body, JSON.stringify({
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Build a coherent Planner UI workflow'
  }));
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });
  assert.match(planner.els.status.textContent, /Waiting for W01 roadmap proposal generation/);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  const intakeRunId = values(db, 'runs')[0].id;
  const proposed = await completePlannerBrainRun(db, 'tenant_facundo_group', intakeRunId, {
    proposal: proposal(),
    output_text: `<MRAPI_ROADMAP_PROPOSAL>${JSON.stringify(proposal())}</MRAPI_ROADMAP_PROPOSAL>`
  });
  const beforeRefresh = JSON.stringify(db.collections);
  planner.els.proposalId.value = proposed.roadmap_id;
  await planner.els.refresh.listeners.click();
  assert.equal(JSON.stringify(db.collections), beforeRefresh);
  assert.match(planner.els.proposalView.innerHTML, /SCB Planner Roadmap/);
  assert.match(planner.els.proposalView.innerHTML, /Brain-only Foundation/);
  assert.match(planner.els.proposalView.innerHTML, /Executor Implementation/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  await planner.els.requestChanges.listeners.click();
  await planner.els.submitRevision.listeners.click();
  assert.match(planner.els.status.textContent, /feedback is required/i);
  const feedback = 'Clarify dependency gating and revision provenance.';
  planner.els.revisionFeedback.value = `  ${feedback}  `;
  planner.els.revisionFeedback.listeners.input();
  await planner.els.submitRevision.listeners.click();

  const revisionCall = calls.at(-1);
  assert.match(revisionCall.url, /\/api\/planner\/roadmaps\/roadmaps_1\/request-changes$/);
  assert.deepEqual(Object.keys(JSON.parse(revisionCall.options.body)), ['feedback']);
  assert.equal(JSON.parse(revisionCall.options.body).feedback, feedback);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 2, tasks: 0, executionRuns: 0 });
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  const pending = await getPlannerProposal(db, 'tenant_facundo_group', proposed.roadmap_id);
  assert.equal(pending.state, 'PLANNING');
  assert.equal(pending.latest_revision_feedback, feedback);
  assert.equal(pending.revision_history[0].title, 'SCB Planner Roadmap');
  const revisionRun = db.get('runs', pending.active_revision_brain_run_id);
  assert.equal(revisionRun.task_id, null);
  assert.equal(revisionRun.brain_context.human_revision_feedback, feedback);
  assert.equal(revisionRun.brain_context.previous_proposal.title, 'SCB Planner Roadmap');
  assert.deepEqual(revisionRun.brain_context.trusted_scope, {
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    roadmap_id: proposed.roadmap_id
  });

  const revised = await completePlannerBrainRun(db, 'tenant_facundo_group', pending.active_revision_brain_run_id, {
    proposal: revisedProposal()
  });
  assert.equal(revised.roadmap_id, proposed.roadmap_id);
  assert.equal(revised.state, 'PROPOSED');
  assert.equal(revised.approval_status, 'PENDING');
  assert.equal(revised.revision_number, 2);
  assertNoExecutorWork(db);
  await planner.els.refresh.listeners.click();
  assert.match(planner.els.proposalView.innerHTML, /Revised SCB Planner Roadmap/);
  assert.match(planner.els.proposalView.innerHTML, /Revision 2/);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  const beforeApproval = immutableProposal(db.get('roadmaps', proposed.roadmap_id));
  await planner.els.approve.listeners.click();
  const approvalCall = calls.find((call) => call.url.endsWith('/approve'));
  assert.equal(approvalCall.options.body, JSON.stringify({ approve: true }));
  assert.deepEqual(immutableProposal(db.get('roadmaps', proposed.roadmap_id)), beforeApproval);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 2, tasks: 0, executionRuns: 0 });
  assert.equal(planner.els.start.classList.contains('hidden'), false);

  await planner.els.start.listeners.click();
  const firstStart = calls.at(-2).url.endsWith('/start') ? calls.at(-2) : calls.at(-1);
  assert.match(firstStart.url, /\/api\/planner\/roadmaps\/roadmaps_1\/start$/);
  assert.match(planner.els.startView.innerHTML, /Current milestone: m1/);
  assert.match(planner.els.startView.innerHTML, /Mission:/);
  assert.match(planner.els.startView.innerHTML, /Brain Run:/);
  assert.doesNotMatch(planner.els.proposalView.innerHTML + planner.els.startView.innerHTML, /MRAPI_CONTROL|executor_instructions|codex_handoff|raw_brain_output|stack/i);
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 3, tasks: 0, executionRuns: 0 });
  assert.equal(db.get('roadmaps', proposed.roadmap_id).milestones[0].state, 'PLANNING');
  assert.equal(db.get('roadmaps', proposed.roadmap_id).milestones[1].state, 'PENDING');

  const afterStartCounts = counts(db);
  await planner.els.refresh.listeners.click();
  assert.deepEqual(counts(db), afterStartCounts);
  await planner.els.start.listeners.click();
  assert.match(planner.els.startView.innerHTML, /Existing Autopilot work reused/);
  assert.deepEqual(counts(db), afterStartCounts);

  planner.els.reset.listeners.click();
  assert.equal(planner.state.proposalId, null);
  assert.equal(planner.els.proposalId.value, '');
  assert.equal(db.get('roadmaps', proposed.roadmap_id).state, 'ACTIVE');
});

test('direct approval UI flow keeps approval and start distinct', async () => {
  const db = new Db();
  seed(db);
  const app = plannerApp(db);
  const html = await renderPlannerPage();
  const calls = [];
  const { planner } = createHarness(html, async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    return responseFromRoute(await requestJson(app, method, String(url), body, { 'x-tenant-id': 'tenant_facundo_group' }));
  });

  planner.els.workspace.value = 'workspace_scb';
  planner.els.project.value = 'project_scb_development';
  planner.els.request.value = 'Build a direct approval Planner flow';
  await planner.els.form.listeners.submit({ preventDefault() {} });
  const runId = values(db, 'runs')[0].id;
  const proposed = await completePlannerBrainRun(db, 'tenant_facundo_group', runId, { proposal: proposal() });
  planner.els.proposalId.value = proposed.roadmap_id;
  await planner.els.refresh.listeners.click();

  const startBeforeApproval = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, {
    'x-tenant-id': 'tenant_facundo_group'
  });
  assert.equal(startBeforeApproval.statusCode, 409);
  assert.equal(startBeforeApproval.body.error, 'PLANNER_ROADMAP_NOT_STARTABLE');
  assert.equal(planner.els.start.classList.contains('hidden'), true);
  assertNoExecutorWork(db);

  await planner.els.approve.listeners.click();
  const approvalCalls = calls.filter((call) => call.url.endsWith('/approve'));
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].options.body, JSON.stringify({ approve: true }));
  assert.equal(calls.some((call) => call.url.endsWith('/start')), false);
  assert.deepEqual(counts(db), { missions: 1, brainRuns: 1, tasks: 0, executionRuns: 0 });
  assert.equal(planner.els.start.classList.contains('hidden'), false);

  await planner.els.start.listeners.click();
  assert.equal(calls.filter((call) => call.url.endsWith('/start')).length, 1);
  assert.deepEqual(counts(db), { missions: 2, brainRuns: 2, tasks: 0, executionRuns: 0 });
});

test('tenant isolation terminal controls dependency gating and UI source boundaries are preserved', async () => {
  const db = new Db();
  seed(db);
  const app = plannerApp(db);
  const html = await renderPlannerPage();
  const { planner } = createHarness(html, async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    return responseFromRoute(await requestJson(app, method, String(url), body, { 'x-tenant-id': 'tenant_facundo_group' }));
  });

  planner.els.workspace.value = 'workspace_scb';
  planner.els.project.value = 'project_scb_development';
  planner.els.request.value = 'Build tenant isolated Planner flow';
  await planner.els.form.listeners.submit({ preventDefault() {} });
  const proposed = await completePlannerBrainRun(db, 'tenant_facundo_group', values(db, 'runs')[0].id, { proposal: proposal() });

  for (const [method, routePath, body, expected] of [
    ['GET', `/api/planner/proposals/${proposed.roadmap_id}`, null, 'PLANNER_PROPOSAL_NOT_FOUND'],
    ['POST', `/api/planner/roadmaps/${proposed.roadmap_id}/request-changes`, { feedback: 'Change it' }, 'PLANNER_ROADMAP_NOT_FOUND'],
    ['POST', `/api/planner/roadmaps/${proposed.roadmap_id}/approve`, { approve: true }, 'PLANNER_ROADMAP_NOT_FOUND'],
    ['POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, 'ROADMAP_NOT_FOUND']
  ]) {
    const response = await requestJson(app, method, routePath, body, { 'x-tenant-id': 'tenant_other' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, expected);
  }

  const stored = db.get('roadmaps', proposed.roadmap_id);
  db.set('roadmaps', proposed.roadmap_id, {
    ...stored,
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    non_executable: false,
    milestones: stored.milestones.map((milestone) => (
      milestone.id === 'm1' ? { ...milestone, state: 'BLOCKED' } : { ...milestone, state: 'PENDING' }
    ))
  });
  const blockedStart = await requestJson(app, 'POST', `/api/planner/roadmaps/${proposed.roadmap_id}/start`, {}, {
    'x-tenant-id': 'tenant_facundo_group'
  });
  assert.equal(blockedStart.statusCode, 409);
  assert.equal(blockedStart.body.error, 'NO_EXECUTABLE_MILESTONE');
  assert.equal(db.get('roadmaps', proposed.roadmap_id).milestones[1].state, 'PENDING');
  assertNoExecutorWork(db);

  for (const state of ['BLOCKED', 'CANCELLED', 'COMPLETED']) {
    planner.renderProposal({
      roadmap_id: `roadmap_${state}`,
      title: `${state} Roadmap`,
      objective: 'Terminal roadmap',
      summary: 'Terminal state is not ordinary startable work.',
      risks: [],
      dependencies: [],
      assumptions: [],
      state,
      approval_status: state === 'COMPLETED' ? 'APPROVED' : 'PENDING',
      milestones: [{
        id: 'm1',
        title: 'Terminal',
        objective: 'Terminal',
        description: 'Terminal',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Hidden controls'],
        state
      }]
    });
    assert.equal(planner.els.approve.classList.contains('hidden'), true);
    assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
    assert.equal(planner.els.start.classList.contains('hidden'), true);
  }

  const uiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'planner.ui.routes.js'), 'utf8');
  assert.doesNotMatch(uiSource, /fetch\('\/api\/tasks|fetch\('\/api\/runs|createTask|createExecutionRun|contenteditable|name="tenant_id"|id="tenantId"/);
  assert.doesNotMatch(uiSource, /MRAPI_CONTROL|executor_instructions|raw_brain_output|database dump|stack trace/i);
});
