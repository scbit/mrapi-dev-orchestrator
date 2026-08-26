const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');
const { createPlannerRequest } = require('../src/services/planner');

function createMiniExpress() {
  function Router() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method === req.method && route.path === req.url.split('?')[0]) {
          return route.handler(req, res, next);
        }
      }
      return next();
    };
    router.get = (routePath, handler) => routes.push({ method: 'GET', path: routePath, handler });
    return router;
  }
  return { Router };
}

function loadPlannerUiRouter() {
  const routePath = require.resolve('../src/routes/planner.ui.routes');
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/planner.ui.routes');
  } finally {
    Module._load = originalLoad;
  }
}

async function renderPlannerPage() {
  const { createPlannerUiRouter } = loadPlannerUiRouter();
  const router = createPlannerUiRouter();
  let html = '';
  await router({ method: 'GET', url: '/planner' }, { setHeader() {}, end(value) { html = value; } }, () => {
    throw new Error('PLANNER_UI_ROUTE_NOT_FOUND');
  });
  return html;
}

function sectionFrom(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = endMarker ? html.indexOf(endMarker, start) : html.length;
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return html.slice(start, end);
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'Planner page script must exist');
  return match[1];
}

function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    snapshot() { return Object.fromEntries(store.entries()); }
  };
}

function response(ok, body) {
  return { ok, json: async () => body };
}

function createHarness(html, options = {}) {
  const elements = new Map();
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, fetchOptions = {}) => {
    calls.push({ url: String(url), options: fetchOptions });
    if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
    if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', name: 'SCB Development', workspace_id: 'workspace_scb' }] });
    if (url === '/api/planner/requests') return response(true, { planner_request_id: 'planner_req_1', mission_id: 'mission_1', brain_run_id: 'brain_1' });
    if (url === '/api/planner/proposals/roadmap_1') return response(true, proposedProposal());
    if (url === '/api/planner/roadmaps/roadmap_1/approve') return response(true, approvedProposal());
    return response(true, {});
  });
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
  const context = {
    document,
    fetch: fetchImpl,
    localStorage: options.localStorage,
    encodeURIComponent,
    String,
    Boolean,
    Number,
    Array,
    Error,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  renderProposal,
  loadProposal,
  readRememberedContext,
  persistRememberedContext
};`, context);
  return { planner: context.__planner, elements, calls };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function proposedProposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_1',
    title: 'Roadmap listo',
    objective: 'Preparar un plan revisable.',
    summary: 'El roadmap queda pendiente hasta aprobación explícita.',
    risks: [],
    dependencies: [],
    assumptions: [],
    state: 'PROPOSED',
    approval_status: 'PENDING',
    milestones: [{
      id: 'm1',
      title: 'Primer paso',
      objective: 'Definir el primer paso.',
      description: 'Mantener el plan sin ejecución.',
      executor_required: false,
      dependencies: [],
      risks: [],
      success_criteria: ['Nada se ejecuta antes de aprobar']
    }],
    ...overrides
  };
}

function approvedProposal() {
  return proposedProposal({ state: 'ACTIVE', approval_status: 'APPROVED' });
}

class Snapshot {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() { return this._data ? { ...this._data } : undefined; }
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
  async get() { return new Snapshot(this.id, this.db.get(this.collectionName, this.id), this); }
  async set(data, options = {}) { this.db.set(this.collectionName, this.id, data, options); }
  async update(data) { this.db.update(this.collectionName, this.id, data); }
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
  limit(max) { return new Query(this.db, this.collectionName, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.collectionName] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snapshot(id, data, new DocRef(this.db, this.collectionName, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnapshot(docs);
  }
}

class Collection extends Query {
  doc(id) { return new DocRef(this.db, this.collectionName, id); }
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
  get(collectionName, id) { return this.collections[collectionName]?.[id] || null; }
  set(collectionName, id, data, options = {}) {
    if (!this.collections[collectionName]) this.collections[collectionName] = {};
    this.collections[collectionName][id] = options.merge ? { ...(this.collections[collectionName][id] || {}), ...data } : { ...data };
  }
  update(collectionName, id, data) {
    if (!this.collections[collectionName]?.[id]) throw new Error('NOT_FOUND');
    this.collections[collectionName][id] = { ...this.collections[collectionName][id], ...data };
  }
  async runTransaction(fn) { return fn(new Transaction()); }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function seed(db) {
  db.set('workspaces', 'workspace_scb', { id: 'workspace_scb', tenant_id: 'tenant_a', name: 'SCB Workspace' });
  db.set('projects', 'project_scb_development', {
    id: 'project_scb_development',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_scb',
    repository_full_name: 'org/scb',
    local_path: 'C:/repo/scb',
    default_branch: 'main',
    primary_worker_ids: ['W01']
  });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', workspace_id: 'workspace_scb', state: 'IDLE' });
}

test('main request experience is human-facing and primary before technical roadmap controls', async () => {
  const html = await renderPlannerPage();
  const form = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '</form>');
  const pageBeforeProposal = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '<div id="proposalView"');

  assert.match(form, /<h2>¿Qué querés hacer\?<\/h2>/);
  assert.match(form, /Contale a W01 qué necesitás/);
  assert.match(form, /Contame qué querés crear, cambiar o mejorar/);
  assert.ok(form.indexOf('id="plannerRequest"') < form.indexOf('aria-label="Contexto"'));
  assert.ok(html.indexOf('id="plannerRequest"') < html.indexOf('id="proposalId"'));
  assert.doesNotMatch(pageBeforeProposal, /BRAIN_RUN|EXECUTION_RUN|Task IDs|Executor IDs|Codex/);
});

test('Workspace and Project stay friendly select controls grouped as context', async () => {
  const html = await renderPlannerPage();
  const form = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '</form>');

  assert.match(form, /aria-label="Contexto"/);
  assert.match(form, /<select id="workspaceId" name="workspace_id"[^>]*required/);
  assert.match(form, /<select id="projectId" name="project_id"[^>]*required/);
  assert.doesNotMatch(form, /<input id="workspaceId" name="workspace_id"/);
  assert.doesNotMatch(form, /<input id="projectId" name="project_id"/);
});

test('initial and loading states are friendly while submit remains disabled', async () => {
  const html = await renderPlannerPage();
  assert.match(html, /Elegí el contexto y contame qué querés hacer/);
  assert.match(html, /Cargando contexto/);

  const { planner } = createHarness(html, {
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb' }] });
      return response(true, {});
    }
  });

  assert.equal(planner.els.submit.disabled, true);
  assert.match(planner.els.status.textContent, /Cargando contexto/);
  await flush();
  assert.match(planner.els.status.textContent, /Elegí el contexto y contame qué querés hacer/);
});

test('successful intake uses exact payload and shows Planning without internal IDs', async () => {
  const html = await renderPlannerPage();
  let submittedPayload;
  const { planner } = createHarness(html, {
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', name: 'SCB Development', workspace_id: 'workspace_scb' }] });
      submittedPayload = JSON.parse(options.body);
      return response(true, { planner_request_id: 'request_1', mission_id: 'mission_1', brain_run_id: 'brain_1' });
    }
  });
  await flush();

  planner.els.workspace.value = 'workspace_scb';
  planner.els.workspace.listeners.change();
  planner.els.project.value = 'project_scb_development';
  planner.els.request.value = '  Mejorar el flujo diario  ';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.deepEqual(submittedPayload, {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Mejorar el flujo diario'
  });
  assert.equal(Object.hasOwn(submittedPayload, 'tenant_id'), false);
  assert.match(planner.els.status.textContent, /W01 está preparando el roadmap/);
  assert.doesNotMatch(planner.els.status.textContent, /request_1|mission_1|brain_1|proposal/i);
});

test('PLANNING intake creates no Task or EXECUTION_RUN through backend flow', async () => {
  const db = new Db();
  seed(db);

  await createPlannerRequest(db, 'tenant_a', {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Crear un plan sin ejecutar'
  });

  assert.equal(values(db, 'missions').length, 1);
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length, 0);
});

test('PROPOSED exposes review actions while Start remains unavailable before approval', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  await flush();

  planner.renderProposal(proposedProposal());

  assert.match(planner.els.status.textContent, /Plan listo/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('approval remains separate from Start and Start appears only after approved state', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  const { planner } = createHarness(html, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb' }] });
      if (url === '/api/planner/roadmaps/roadmap_1/approve') return response(true, approvedProposal());
      if (url === '/api/planner/proposals/roadmap_1') return response(true, approvedProposal());
      return response(true, {});
    }
  });
  await flush();

  planner.renderProposal(proposedProposal());
  await planner.els.approve.listeners.click();

  assert.equal(calls.some((call) => call.url.endsWith('/approve')), true);
  assert.equal(calls.some((call) => call.url.endsWith('/start')), false);
  assert.equal(planner.els.start.classList.contains('hidden'), false);
});

test('Reset preserves remembered context while clearing request and transient state', async () => {
  const html = await renderPlannerPage();
  const durable = JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' });
  const storage = createMemoryStorage({
    'mrapi.planner.context.v1': durable,
    'mrapi.planner.active.v1': JSON.stringify({ requestId: 'request_1', proposalId: 'roadmap_1', request: 'Activa' })
  });
  const { planner } = createHarness(html, { localStorage: storage });
  await flush();

  planner.els.request.value = 'Texto transitorio';
  planner.renderProposal(proposedProposal());
  planner.els.reset.listeners.click();

  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], durable);
  assert.equal(storage.snapshot()['mrapi.planner.active.v1'], undefined);
  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
  assert.equal(planner.els.request.value, '');
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.proposalId, null);
});

test('active-state restoration and refresh do not auto-approve or auto-start', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  createHarness(html, {
    localStorage: createMemoryStorage({
      'mrapi.planner.active.v1': JSON.stringify({
        requestId: 'request_active',
        proposalId: 'roadmap_1',
        workspaceId: 'workspace_scb',
        projectId: 'project_scb_development',
        request: 'Continuar pedido'
      })
    }),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb' }] });
      if (url === '/api/planner/proposals/roadmap_1') return response(true, proposedProposal());
      return response(true, {});
    }
  });
  await flush();

  assert.equal(calls.some((call) => call.url === '/api/planner/proposals/roadmap_1'), true);
  assert.equal(calls.some((call) => call.url.endsWith('/approve')), false);
  assert.equal(calls.some((call) => call.url.endsWith('/start')), false);
});
