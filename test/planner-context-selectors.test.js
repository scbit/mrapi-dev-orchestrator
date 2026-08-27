const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function optionLabels(element) {
  return [...element.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
    .map((match) => ({ value: match[1], label: match[2] }));
}

function createHarness(html, options = {}) {
  const elements = new Map();
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, fetchOptions = {}) => {
    calls.push({ url: String(url), options: fetchOptions });
    if (url === '/api/workspaces') {
      return response(true, { items: [
        { id: 'workspace_scb', name: 'SCB Workspace' },
        { id: 'workspace_fallback' }
      ] });
    }
    if (url === '/api/projects') {
      return response(true, { items: [
        { id: 'project_scb_development', name: 'SCB Development', workspace_id: 'workspace_scb' },
        { id: 'project_legacy', workspace_id: 'workspace_scb' },
        { id: 'project_other', name: 'Other Project', workspace_id: 'workspace_fallback' }
      ] });
    }
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
  const context = { document, fetch: fetchImpl, encodeURIComponent, String, Boolean, Number, Array, Error, Promise };
  if ('localStorage' in options) context.localStorage = options.localStorage;
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  loadPlannerContextOptions,
  applyContextSelection,
  renderProjectOptions,
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

async function callWorkspaceRoute(tenantId, repos) {
  const { createWorkspacesRouter } = loadWithMiniExpress('../src/routes/workspaces.routes');
  const router = createWorkspacesRouter({ repos });
  let statusCode = 200;
  let body = null;
  await router(
    { method: 'GET', url: '/', tenantId },
    {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; }
    },
    (error) => { throw error || new Error('WORKSPACES_ROUTE_NOT_FOUND'); }
  );
  return { statusCode, body };
}

test('Workspace endpoint returns only current-tenant Workspaces sorted by friendly label with ID fallback', async () => {
  const all = [
    { id: 'workspace_z', tenant_id: 'tenant_a', name: 'Zulu Workspace' },
    { id: 'workspace_a', tenant_id: 'tenant_a' },
    { id: 'workspace_b', tenant_id: 'tenant_b', name: 'Other Tenant Workspace' }
  ];
  const repos = {
    workspaces: {
      async listByTenant(tenantId) {
        return all.filter((workspace) => workspace.tenant_id === tenantId);
      }
    }
  };

  const tenantA = await callWorkspaceRoute('tenant_a', repos);
  const tenantB = await callWorkspaceRoute('tenant_b', repos);

  assert.deepEqual(tenantA.body.items.map((workspace) => workspace.id), ['workspace_a', 'workspace_z']);
  assert.deepEqual(tenantA.body.items.map((workspace) => workspace.name || workspace.id), ['workspace_a', 'Zulu Workspace']);
  assert.deepEqual(tenantB.body.items.map((workspace) => workspace.id), ['workspace_b']);
  assert.equal(tenantB.body.items.some((workspace) => workspace.tenant_id === 'tenant_a'), false);
});

test('/planner renders Workspace and Project selects instead of manual ID inputs', async () => {
  const html = await renderPlannerPage();

  assert.match(html, /<select id="workspaceId" name="workspace_id"[^>]*required/);
  assert.match(html, /<select id="projectId" name="project_id"[^>]*required/);
  assert.doesNotMatch(html, /<input id="workspaceId" name="workspace_id"/);
  assert.doesNotMatch(html, /<input id="projectId" name="project_id"/);
});

test('Planner startup fetches only tenant-scoped Workspace, Project, and recent history APIs', async () => {
  const html = await renderPlannerPage();
  const { calls } = createHarness(html);
  await flush();

  assert.deepEqual(calls.map((call) => call.url), ['/api/planner/recent?limit=10', '/api/workspaces', '/api/projects']);
  assert.equal(calls.every((call) => !call.options?.method || call.options.method === 'GET'), true);
  assert.equal(calls.some((call) => /\/api\/(tasks|runs|planner\/requests|planner\/roadmaps)/.test(call.url)), false);
});

test('selectors display friendly names with IDs as option values and filter Projects by Workspace', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  await flush();

  assert.deepEqual(optionLabels(planner.els.workspace), [
    { value: '', label: 'Elegí un workspace' },
    { value: 'workspace_scb', label: 'SCB Workspace' },
    { value: 'workspace_fallback', label: 'workspace_fallback' }
  ]);

  planner.els.workspace.value = 'workspace_scb';
  planner.els.workspace.listeners.change();
  assert.deepEqual(optionLabels(planner.els.project), [
    { value: '', label: 'Elegí un project' },
    { value: 'project_scb_development', label: 'SCB Development' },
    { value: 'project_legacy', label: 'project_legacy' }
  ]);

  planner.els.project.value = 'project_scb_development';
  planner.els.workspace.value = 'workspace_fallback';
  planner.els.workspace.listeners.change();
  assert.deepEqual(optionLabels(planner.els.project), [
    { value: '', label: 'Elegí un project' },
    { value: 'project_other', label: 'Other Project' }
  ]);
  assert.equal(planner.els.project.value, '');
});

test('request submission still sends IDs and request only', async () => {
  const html = await renderPlannerPage();
  let submittedPayload;
  const { planner } = createHarness(html, {
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', name: 'SCB Development', workspace_id: 'workspace_scb' }] });
      submittedPayload = JSON.parse(options.body);
      return response(true, { planner_request_id: 'request_1' });
    }
  });
  await flush();

  planner.els.workspace.value = 'workspace_scb';
  planner.els.workspace.listeners.change();
  planner.els.project.value = 'project_scb_development';
  planner.els.request.value = ' Build selectors ';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.deepEqual(submittedPayload, {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Build selectors'
  });
  assert.equal(Object.hasOwn(submittedPayload, 'tenant_id'), false);
  assert.equal(Object.values(submittedPayload).includes('SCB Workspace'), false);
  assert.equal(Object.values(submittedPayload).includes('SCB Development'), false);
});

test('remembered context is applied after async options load and stale values fail safely', async () => {
  const html = await renderPlannerPage();
  const valid = createHarness(html, {
    localStorage: createMemoryStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
    })
  });
  await flush();
  assert.equal(valid.planner.els.workspace.value, 'workspace_scb');
  assert.equal(valid.planner.els.project.value, 'project_scb_development');

  const staleWorkspace = createHarness(html, {
    localStorage: createMemoryStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_missing', projectId: 'project_scb_development' })
    })
  });
  await flush();
  assert.equal(staleWorkspace.planner.els.workspace.value, '');
  assert.equal(staleWorkspace.planner.els.project.value, '');

  const staleProject = createHarness(html, {
    localStorage: createMemoryStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_other' })
    })
  });
  await flush();
  assert.equal(staleProject.planner.els.workspace.value, 'workspace_scb');
  assert.equal(staleProject.planner.els.project.value, '');
});

test('remembered context waits for both workspace and project datasets before restoring selectors', async () => {
  const html = await renderPlannerPage();
  const workspaces = deferred();
  const projects = deferred();
  const { planner } = createHarness(html, {
    localStorage: createMemoryStorage({
      'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
    }),
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return workspaces.promise;
      if (url === '/api/projects') return projects.promise;
      return response(true, { items: [] });
    }
  });
  await flush();

  assert.equal(planner.state.contextLoading, true);
  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');

  workspaces.resolve(response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] }));
  await flush();
  assert.equal(planner.state.contextLoading, true);
  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');

  projects.resolve(response(true, { items: [{ id: 'project_scb_development', name: 'SCB Development', workspace_id: 'workspace_scb' }] }));
  await flush();

  assert.equal(planner.state.contextLoading, false);
  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
});

test('active Planner context takes precedence over durable context after option loading', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({
      requestId: 'request_active',
      proposalId: 'proposal_active',
      workspaceId: 'workspace_fallback',
      projectId: 'project_other',
      request: 'Continue active'
    }),
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
  });
  const calls = [];
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }, { id: 'workspace_fallback', name: 'Fallback Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [
        { id: 'project_scb_development', workspace_id: 'workspace_scb' },
        { id: 'project_other', workspace_id: 'workspace_fallback' }
      ] });
      return response(true, {});
    }
  });
  await flush();

  assert.equal(planner.els.workspace.value, 'workspace_fallback');
  assert.equal(planner.els.project.value, 'project_other');
  assert.equal(planner.els.request.value, 'Continue active');
  assert.equal(calls.at(-1).url, '/api/planner/proposals/proposal_active');
});

test('authoritative proposal context overrides active and remembered context without changing remembered memory', async () => {
  const html = await renderPlannerPage();
  const remembered = JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' });
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({
      requestId: 'request_active',
      proposalId: 'proposal_active',
      workspaceId: 'workspace_scb',
      projectId: 'project_scb_development',
      request: 'Continue active'
    }),
    'mrapi.planner.context.v1': remembered
  });
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }, { id: 'workspace_fallback' }] });
      if (url === '/api/projects') return response(true, { items: [
        { id: 'project_scb_development', workspace_id: 'workspace_scb' },
        { id: 'project_other', workspace_id: 'workspace_fallback' }
      ] });
      return response(true, {});
    }
  });
  await flush();

  planner.renderProposal({
    roadmap_id: 'historical_other',
    workspace_id: 'workspace_fallback',
    project_id: 'project_other',
    title: 'Historical Other',
    state: 'ACTIVE'
  });

  assert.equal(planner.els.workspace.value, 'workspace_fallback');
  assert.equal(planner.els.project.value, 'project_other');
  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], remembered);
  assert.deepEqual(JSON.parse(storage.snapshot()['mrapi.planner.active.v1']), {
    requestId: 'request_active',
    missionId: 'request_active',
    brainRunId: null,
    proposalId: 'historical_other',
    workspaceId: 'workspace_fallback',
    projectId: 'project_other',
    request: 'Continue active'
  });
});

test('proposal context loaded before selector datasets is queued and applied after both loads finish', async () => {
  const html = await renderPlannerPage();
  const workspaces = deferred();
  const projects = deferred();
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' }),
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
  });
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return workspaces.promise;
      if (url === '/api/projects') return projects.promise;
      return response(true, { items: [] });
    }
  });
  await flush();

  planner.renderProposal({
    roadmap_id: 'queued_context',
    workspace_id: 'workspace_fallback',
    project_id: 'project_other',
    title: 'Queued Context',
    state: 'ACTIVE'
  });

  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');
  assert.equal(planner.state.pendingAuthoritativeContext.workspaceId, 'workspace_fallback');
  assert.equal(planner.state.pendingAuthoritativeContext.projectId, 'project_other');

  workspaces.resolve(response(true, { items: [{ id: 'workspace_scb' }, { id: 'workspace_fallback' }] }));
  projects.resolve(response(true, { items: [
    { id: 'project_scb_development', workspace_id: 'workspace_scb' },
    { id: 'project_other', workspace_id: 'workspace_fallback' }
  ] }));
  await flush();

  assert.equal(planner.els.workspace.value, 'workspace_fallback');
  assert.equal(planner.els.project.value, 'project_other');
  assert.equal(planner.state.pendingAuthoritativeContext, null);
  assert.equal(JSON.parse(storage.snapshot()['mrapi.planner.active.v1']).workspaceId, 'workspace_fallback');
});

test('proposal context loaded after selector datasets applies immediately', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  await flush();

  planner.renderProposal({
    roadmap_id: 'immediate_context',
    workspace_id: 'workspace_fallback',
    project_id: 'project_other',
    title: 'Immediate Context',
    state: 'ACTIVE'
  });

  assert.equal(planner.els.workspace.value, 'workspace_fallback');
  assert.equal(planner.els.project.value, 'project_other');
});

test('explicit invalid project keeps valid workspace and does not auto-select the only project', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html, {
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb' }] });
      return response(true, { items: [] });
    }
  });
  await flush();

  planner.applyContextSelection({ workspaceId: 'workspace_scb', projectId: 'project_missing' });

  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, '');
});

test('workspace-only context may retain existing single-project auto-selection', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html, {
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb' }] });
      return response(true, { items: [] });
    }
  });
  await flush();

  planner.applyContextSelection({ workspaceId: 'workspace_scb' });

  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
});

test('Reset preserves and reapplies remembered selector context', async () => {
  const html = await renderPlannerPage();
  const durable = JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' });
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({ requestId: 'request_1', workspaceId: 'workspace_fallback', projectId: 'project_other' }),
    'mrapi.planner.context.v1': durable
  });
  const { planner } = createHarness(html, { localStorage: storage });
  await flush();

  planner.els.reset.listeners.click();

  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], durable);
  assert.equal(storage.snapshot()['mrapi.planner.active.v1'], undefined);
  assert.equal(planner.els.workspace.value, 'workspace_scb');
  assert.equal(planner.els.project.value, 'project_scb_development');
});

test('selecting context does not overwrite durable memory before successful intake and failed intake preserves it', async () => {
  const html = await renderPlannerPage();
  const durable = JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' });
  const storage = createMemoryStorage({ 'mrapi.planner.context.v1': durable });
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb' }, { id: 'workspace_fallback' }] });
      if (url === '/api/projects') return response(true, { items: [
        { id: 'project_scb_development', workspace_id: 'workspace_scb' },
        { id: 'project_other', workspace_id: 'workspace_fallback' }
      ] });
      return response(false, { error: 'PROJECT_NOT_IN_WORKSPACE' });
    }
  });
  await flush();

  planner.els.workspace.value = 'workspace_fallback';
  planner.els.workspace.listeners.change();
  planner.els.project.value = 'project_other';
  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], durable);
  planner.els.request.value = 'Rejected request';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], durable);
  assert.match(planner.els.status.textContent, /Planner request failed/);
});

test('context loading failure leaves submit disabled and shows readable error', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html, {
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(false, { error: 'NO_CONTEXT' });
      return response(true, { items: [] });
    }
  });
  await flush();

  assert.equal(planner.els.submit.disabled, true);
  assert.equal(planner.els.workspace.disabled, true);
  assert.equal(planner.els.project.disabled, true);
  assert.match(planner.els.status.textContent, /No pude cargar el contexto/);
  assert.doesNotMatch(planner.els.status.textContent, /stack|Error:/i);
});

test('selectors do not weaken backend tenant/workspace/project validation', async () => {
  const serviceSource = read('src/services/planner.js');
  const uiSource = read('src/routes/planner.ui.routes.js');

  assert.match(serviceSource, /workspaceSnap\.data\(\)\.tenant_id !== tenantId/);
  assert.match(serviceSource, /projectSnap\.data\(\)\.tenant_id !== tenantId/);
  assert.match(serviceSource, /projectSnap\.data\(\)\.workspace_id !== workspaceId/);
  assert.doesNotMatch(uiSource, /name="tenant_id"|id="tenantId"/);
});
