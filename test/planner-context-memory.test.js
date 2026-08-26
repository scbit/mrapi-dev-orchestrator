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

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'Planner page script must exist');
  return match[1];
}

function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    snapshot() {
      return Object.fromEntries(store.entries());
    }
  };
}

function response(ok, body) {
  return {
    ok,
    json: async () => body
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(html, options = {}) {
  const elements = new Map();
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, fetchOptions = {}) => {
    calls.push({ url: String(url), options: fetchOptions });
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
  if ('localStorage' in options) context.localStorage = options.localStorage;
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  readRememberedContext,
  persistRememberedContext,
  restoreRememberedContext,
  persistPlannerState,
  restorePlannerState
};`, context);
  return { planner: context.__planner, elements, calls };
}

test('Planner source uses a dedicated durable context key distinct from active-state storage', async () => {
  const html = await renderPlannerPage();
  const source = read('src/routes/planner.ui.routes.js');

  assert.match(source, /const plannerStorageKey = 'mrapi\.planner\.active\.v1'/);
  assert.match(source, /const plannerContextStorageKey = 'mrapi\.planner\.context\.v1'/);
  assert.match(source, /function readRememberedContext\(\)/);
  assert.match(source, /function persistRememberedContext\(workspaceId, projectId\)/);
  assert.match(source, /function restoreRememberedContext\(\)/);
  assert.match(html, /restoreRememberedContext\(\)/);
  assert.match(html, /loadPlannerContextOptions\(\)/);
});

test('durable context stores only trimmed workspaceId and projectId and never tenant_id', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage();
  const { planner } = createHarness(html, { localStorage: storage });

  assert.equal(planner.persistRememberedContext(' workspace_scb ', ' project_scb_development '), true);
  const durable = JSON.parse(storage.snapshot()['mrapi.planner.context.v1']);

  assert.deepEqual(durable, {
    workspaceId: 'workspace_scb',
    projectId: 'project_scb_development'
  });
  assert.equal(Object.hasOwn(durable, 'tenant_id'), false);
  assert.equal(Object.hasOwn(durable, 'request'), false);
  assert.equal(Object.hasOwn(durable, 'requestId'), false);
  assert.equal(Object.hasOwn(durable, 'proposalId'), false);
});

test('successful intake persists remembered context only after the accepted response', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage();
  let durableBeforeResponse;
  let submittedPayload;
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, fetchOptions = {}) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb', name: 'SCB Development' }] });
      durableBeforeResponse = storage.snapshot()['mrapi.planner.context.v1'];
      submittedPayload = JSON.parse(fetchOptions.body);
      return response(true, {
        planner_request_id: 'request_1',
        mission_id: 'mission_1',
        brain_run_id: 'brain_1'
      });
    }
  });
  await flush();

  planner.els.workspace.value = ' workspace_scb ';
  planner.els.project.value = ' project_scb_development ';
  planner.els.request.value = ' Build the Planner context behavior ';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(durableBeforeResponse, undefined);
  assert.deepEqual(submittedPayload, {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Build the Planner context behavior'
  });
  assert.equal(Object.hasOwn(submittedPayload, 'tenant_id'), false);
  assert.deepEqual(JSON.parse(storage.snapshot()['mrapi.planner.context.v1']), {
    workspaceId: 'workspace_scb',
    projectId: 'project_scb_development'
  });
});

test('successful intake is remembered and a later fresh page preloads only context', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage();
  const first = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_scb', name: 'SCB Workspace' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_scb_development', workspace_id: 'workspace_scb', name: 'SCB Development' }] });
      return response(true, {
      planner_request_id: 'request_1',
      mission_id: 'mission_1',
      brain_run_id: 'brain_1'
      });
    }
  });
  await flush();

  first.planner.els.workspace.value = ' workspace_scb ';
  first.planner.els.project.value = ' project_scb_development ';
  first.planner.els.request.value = ' Build the Planner context behavior ';
  await first.planner.els.form.listeners.submit({ preventDefault() {} });

  assert.deepEqual(JSON.parse(storage.snapshot()['mrapi.planner.context.v1']), {
    workspaceId: 'workspace_scb',
    projectId: 'project_scb_development'
  });
  assert.ok(storage.snapshot()['mrapi.planner.active.v1'], 'successful intake also leaves transient active Planner state');

  storage.removeItem('mrapi.planner.active.v1');
  const second = createHarness(html, { localStorage: storage });
  await flush();

  assert.equal(second.planner.els.workspace.value, '');
  assert.equal(second.planner.els.project.value, '');
  assert.equal(second.planner.els.request.value, '');
  assert.equal(second.planner.state.requestId, null);
  assert.equal(second.planner.state.missionId, null);
  assert.equal(second.planner.state.brainRunId, null);
  assert.equal(second.planner.state.proposalId, null);
  assert.equal(second.planner.els.proposalId.value, '');
  assert.deepEqual(second.calls.map((call) => call.url), ['/api/workspaces', '/api/projects']);
});

test('failed intake does not replace existing remembered context', async () => {
  const html = await renderPlannerPage();
  const existing = JSON.stringify({ workspaceId: 'workspace_old', projectId: 'project_old' });
  const storage = createMemoryStorage({ 'mrapi.planner.context.v1': existing });
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_new' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_new', workspace_id: 'workspace_new' }] });
      return response(false, { error: 'PLANNER_INTAKE_REJECTED' });
    }
  });
  await flush();

  planner.els.workspace.value = 'workspace_new';
  planner.els.project.value = 'project_new';
  planner.els.request.value = 'Rejected request';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], existing);
  assert.notDeepEqual(JSON.parse(storage.snapshot()['mrapi.planner.context.v1']), {
    workspaceId: 'workspace_new',
    projectId: 'project_old'
  });
  assert.notDeepEqual(JSON.parse(storage.snapshot()['mrapi.planner.context.v1']), {
    workspaceId: 'workspace_old',
    projectId: 'project_new'
  });
  assert.match(planner.els.status.textContent, /Planner request failed/);
});

test('fresh Planner page with no preference starts empty after loading tenant context', async () => {
  const html = await renderPlannerPage();
  const { planner, calls } = createHarness(html, { localStorage: createMemoryStorage() });
  await flush();

  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');
  assert.equal(planner.els.request.value, '');
  assert.equal(planner.els.proposalId.value, '');
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.missionId, null);
  assert.equal(planner.state.brainRunId, null);
  assert.equal(planner.state.proposalId, null);
  assert.equal(planner.state.proposal, null);
  assert.deepEqual(calls.map((call) => call.url), ['/api/workspaces', '/api/projects']);
});

test('remembered context prefills only workspace and project when no active Planner state exists', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage({
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: ' workspace_scb ', projectId: ' project_scb_development ' })
  });
  const { planner, calls } = createHarness(html, { localStorage: storage });
  await flush();

  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');
  assert.equal(planner.els.request.value, '');
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.missionId, null);
  assert.equal(planner.state.brainRunId, null);
  assert.equal(planner.state.proposalId, null);
  assert.equal(planner.els.proposalId.value, '');
  assert.deepEqual(calls.map((call) => call.url), ['/api/workspaces', '/api/projects']);
});

test('remembered context alone calls only context APIs, not lifecycle or work endpoints', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage({
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' })
  });
  const calls = [];
  createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, fetchOptions = {}) => {
      calls.push({ url: String(url), options: fetchOptions });
      return response(true, {});
    }
  });
  await flush();

  assert.deepEqual(calls.map((call) => call.url), ['/api/workspaces', '/api/projects']);
  assert.equal(calls.some((call) => /\/api\/(planner\/requests|planner\/proposals|planner\/roadmaps|missions|tasks|runs)/.test(call.url)), false);
});

test('active Planner state restores lifecycle values and takes precedence over remembered context', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({
      requestId: 'request_active',
      missionId: 'mission_active',
      brainRunId: 'brain_active',
      proposalId: 'proposal_active',
      workspaceId: 'workspace_active',
      projectId: 'project_active',
      request: 'Continue this active request'
    }),
    'mrapi.planner.context.v1': JSON.stringify({ workspaceId: 'workspace_memory', projectId: 'project_memory' })
  });
  const calls = [];
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, fetchOptions = {}) => {
      calls.push({ url: String(url), options: fetchOptions });
      return response(true, {});
    }
  });
  await flush();

  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');
  assert.equal(planner.els.request.value, 'Continue this active request');
  assert.equal(planner.state.requestId, 'request_active');
  assert.equal(planner.state.missionId, 'mission_active');
  assert.equal(planner.state.brainRunId, 'brain_active');
  assert.equal(planner.state.proposalId, 'proposal_active');
  assert.equal(planner.els.proposalId.value, 'proposal_active');
  assert.equal(calls.at(-1).url, '/api/planner/proposals/proposal_active');
});

test('Reset clears transient active state and repopulates workspace/project from remembered context', async () => {
  const html = await renderPlannerPage();
  const durable = JSON.stringify({ workspaceId: 'workspace_scb', projectId: 'project_scb_development' });
  const storage = createMemoryStorage({
    'mrapi.planner.active.v1': JSON.stringify({
      requestId: 'request_1',
      missionId: 'mission_1',
      brainRunId: 'brain_1',
      proposalId: 'proposal_1',
      workspaceId: 'workspace_active',
      projectId: 'project_active',
      request: 'Active request'
    }),
    'mrapi.planner.context.v1': durable
  });
  const { planner, calls } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, fetchOptions = {}) => {
      calls.push({ url: String(url), options: fetchOptions });
      return response(true, {});
    }
  });
  await flush();
  const callsBeforeReset = calls.length;

  planner.els.reset.listeners.click();

  assert.equal(storage.snapshot()['mrapi.planner.active.v1'], undefined);
  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], durable);
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.missionId, null);
  assert.equal(planner.state.brainRunId, null);
  assert.equal(planner.state.proposalId, null);
  assert.equal(planner.els.workspace.value, '');
  assert.equal(planner.els.project.value, '');
  assert.equal(planner.els.request.value, '');
  assert.equal(planner.els.proposalId.value, '');
  assert.equal(planner.els.revisionFeedback.value, '');
  assert.equal(planner.state.proposal, null);
  assert.equal(planner.state.submitting, false);
  assert.equal(planner.state.revisionSubmitting, false);
  assert.equal(calls.length, callsBeforeReset);
});

test('malformed, incomplete, and non-string remembered context is ignored safely', async () => {
  const html = await renderPlannerPage();
  for (const stored of [
    '{bad json',
    'null',
    JSON.stringify('workspace_scb'),
    JSON.stringify(123),
    JSON.stringify(['workspace_scb', 'project_scb_development']),
    JSON.stringify({ workspaceId: 'workspace_scb' }),
    JSON.stringify({ projectId: 'project_scb_development' }),
    JSON.stringify({ workspaceId: '', projectId: 'project_scb_development' }),
    JSON.stringify({ workspaceId: 'workspace_scb', projectId: '' }),
    JSON.stringify({ workspaceId: '   ', projectId: 'project_scb_development' }),
    JSON.stringify({ workspaceId: 'workspace_scb', projectId: '   ' }),
    JSON.stringify({ workspaceId: 123, projectId: 'project_scb_development' }),
    JSON.stringify({ workspaceId: 'workspace_scb', projectId: { id: 'project_scb_development' } })
  ]) {
    const storage = createMemoryStorage({ 'mrapi.planner.context.v1': stored });
    const { planner } = createHarness(html, { localStorage: storage });
    await flush();
    assert.equal(planner.els.workspace.value, '');
    assert.equal(planner.els.project.value, '');
    assert.equal(planner.readRememberedContext(), null);
  }
});

test('blank workspaceId or projectId is not persisted as durable context', async () => {
  const html = await renderPlannerPage();
  const storage = createMemoryStorage();
  const { planner } = createHarness(html, { localStorage: storage });

  assert.equal(planner.persistRememberedContext('   ', 'project_scb_development'), false);
  assert.equal(planner.persistRememberedContext('workspace_scb', '   '), false);
  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], undefined);
});

test('unavailable or throwing localStorage does not break Planner initialization', async () => {
  const html = await renderPlannerPage();
  const throwingStorage = {
    getItem() { throw new Error('STORAGE_UNAVAILABLE'); },
    setItem() { throw new Error('STORAGE_UNAVAILABLE'); },
    removeItem() { throw new Error('STORAGE_UNAVAILABLE'); }
  };

  assert.doesNotThrow(() => createHarness(html));
  assert.doesNotThrow(() => createHarness(html, { localStorage: throwingStorage }));
});

test('preloaded remembered context still goes through normal intake validation and rejection preserves memory', async () => {
  const html = await renderPlannerPage();
  const remembered = JSON.stringify({ workspaceId: 'workspace_old', projectId: 'project_old' });
  const storage = createMemoryStorage({ 'mrapi.planner.context.v1': remembered });
  const lifecycleWork = [];
  const calls = [];
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url, fetchOptions = {}) => {
      calls.push({ url: String(url), options: fetchOptions });
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_old' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_old', workspace_id: 'workspace_old' }] });
      if (url === '/api/planner/requests') {
        const body = JSON.parse(fetchOptions.body);
        assert.deepEqual(body, {
          workspace_id: 'workspace_old',
          project_id: 'project_old',
          request: 'Use remembered but unauthorized context'
        });
        assert.equal(Object.hasOwn(body, 'tenant_id'), false);
        return response(false, { error: 'PROJECT_NOT_IN_WORKSPACE' });
      }
      lifecycleWork.push({ url: String(url), options: fetchOptions });
      return response(true, {});
    }
  });
  await flush();

  assert.equal(planner.els.workspace.value, 'workspace_old');
  assert.equal(planner.els.project.value, 'project_old');
  planner.els.request.value = 'Use remembered but unauthorized context';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(calls.length, 3);
  assert.deepEqual(lifecycleWork, []);
  assert.equal(storage.snapshot()['mrapi.planner.context.v1'], remembered);
  assert.equal(storage.snapshot()['mrapi.planner.active.v1'], undefined);
  assert.equal(planner.state.requestId, null);
  assert.equal(planner.state.missionId, null);
  assert.equal(planner.state.brainRunId, null);
  assert.equal(planner.state.proposalId, null);
  assert.match(planner.els.status.textContent, /Planner request failed: PROJECT_NOT_IN_WORKSPACE/);
});

test('later successful valid context replaces remembered pair only after success response', async () => {
  const html = await renderPlannerPage();
  const remembered = JSON.stringify({ workspaceId: 'workspace_old', projectId: 'project_old' });
  const storage = createMemoryStorage({ 'mrapi.planner.context.v1': remembered });
  let durableBeforeSuccess;
  const { planner } = createHarness(html, {
    localStorage: storage,
    fetchImpl: async (url) => {
      if (url === '/api/workspaces') return response(true, { items: [{ id: 'workspace_new' }] });
      if (url === '/api/projects') return response(true, { items: [{ id: 'project_new', workspace_id: 'workspace_new' }] });
      durableBeforeSuccess = storage.snapshot()['mrapi.planner.context.v1'];
      return response(true, {
        planner_request_id: 'request_new',
        mission_id: 'mission_new',
        brain_run_id: 'brain_new'
      });
    }
  });
  await flush();

  planner.els.workspace.value = ' workspace_new ';
  planner.els.project.value = ' project_new ';
  planner.els.request.value = ' Valid request for new context ';
  await planner.els.form.listeners.submit({ preventDefault() {} });

  assert.equal(durableBeforeSuccess, remembered);
  assert.deepEqual(JSON.parse(storage.snapshot()['mrapi.planner.context.v1']), {
    workspaceId: 'workspace_new',
    projectId: 'project_new'
  });
});
