const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');

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

function renderPlannerPage() {
  return loadPlannerUiRouter().plannerPageHtml();
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'planner page script must exist');
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

function createHarness(fetchImpl = async (url) => {
  if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
  if (url === '/api/planner/recent?limit=10') return response({ items: [] });
  return response({});
}) {
  const html = renderPlannerPage();
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const storage = {};
  const localStorage = {
    getItem(key) { return Object.hasOwn(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
    removeItem(key) { delete storage[key]; }
  };
  const context = {
    document,
    fetch: fetchImpl,
    localStorage,
    encodeURIComponent,
    String,
    Boolean,
    Number,
    Array,
    Error,
    Date
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  renderProposal,
  renderRecentPlannerRequests,
  openRecentPlannerRequest,
  loadProposal
};`, context);
  return context.__planner;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function proposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_lifecycle',
    title: 'Friendly Lifecycle Roadmap',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    objective: 'Present persisted Planner lifecycle in human language.',
    summary: 'Planner state labels are display-only and preserve action boundaries.',
    risks: [],
    dependencies: [],
    assumptions: [],
    milestones: [
      {
        id: 'm1',
        order: 1,
        title: 'First milestone',
        objective: 'Do the first step.',
        description: 'First step details.',
        executor_required: true,
        dependencies: [],
        risks: [],
        success_criteria: ['Ready'],
        state: 'PENDING'
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

test('primary roadmap lifecycle labels are deterministic and preserve action gates', async () => {
  const planner = createHarness();

  const cases = [
    ['PLANNING', { state: 'PLANNING', approval_status: 'PENDING' }, /Planning/],
    ['PROPOSED', { state: 'PROPOSED', approval_status: 'PENDING' }, /Waiting for approval/],
    ['APPROVED', { state: 'ACTIVE', approval_status: 'APPROVED' }, /Approved/],
    ['RUNNING', { state: 'RUNNING', approval_status: 'APPROVED' }, /Running/],
    ['EXECUTING', { state: 'EXECUTING', approval_status: 'APPROVED' }, /Running/],
    ['VERIFYING', { state: 'VERIFYING', approval_status: 'APPROVED' }, /Running/],
    ['COMPLETED', { state: 'COMPLETED', approval_status: 'APPROVED' }, /Completed/],
    ['COMPLETE', { state: 'COMPLETE', approval_status: 'APPROVED' }, /Completed/],
    ['DONE', { state: 'DONE', approval_status: 'APPROVED' }, /Completed/],
    ['BLOCKED', { state: 'BLOCKED', approval_status: 'PENDING' }, /Blocked/],
    ['CANCELLED', { state: 'CANCELLED', approval_status: 'PENDING' }, /Cancelled/],
    ['CANCELED', { state: 'CANCELED', approval_status: 'PENDING' }, /Cancelled/],
    ['UNKNOWN', { state: 'WAITING_ON_VENDOR', approval_status: 'PENDING' }, /Waiting On Vendor \/ Pending/]
  ];

  for (const [name, overrides, expected] of cases) {
    planner.renderProposal(proposal(overrides));
    assert.match(planner.els.proposalView.innerHTML, expected, name);
  }

  planner.renderProposal(proposal({ state: 'PROPOSED', approval_status: 'PENDING' }));
  assert.deepEqual(visibleActions(planner), { approve: true, requestChanges: true, start: false });

  planner.renderProposal(proposal({ state: 'ACTIVE', approval_status: 'APPROVED' }));
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: true });

  for (const state of ['RUNNING', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'COMPLETE', 'DONE', 'BLOCKED', 'CANCELLED', 'CANCELED']) {
    planner.renderProposal(proposal({ state, approval_status: state === 'BLOCKED' ? 'PENDING' : 'APPROVED' }));
    assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false }, state);
  }
});

test('milestone labels use explicit evidence without inferring human action from executor_required false', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal({
    milestones: [
      {
        id: 'human',
        title: 'Human checkpoint',
        objective: 'Reviewer decides next step.',
        description: 'Explicit human action.',
        executor_required: false,
        human_action_required: true,
        dependencies: [],
        risks: [],
        success_criteria: ['Decision recorded'],
        state: 'PENDING'
      },
      {
        id: 'brain',
        title: 'Brain-only milestone',
        objective: 'No executor work.',
        description: 'No explicit human action.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Recorded'],
        state: 'PENDING'
      }
    ]
  }));

  assert.match(planner.els.proposalView.innerHTML, /Human checkpoint[\s\S]*Need human action/);
  assert.match(planner.els.proposalView.innerHTML, /Brain-only milestone[\s\S]*Pending/);
});

test('raw states remain in Advanced details and lifecycle-derived text is escaped', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal({
    state: '<script>alert(1)</script>',
    approval_status: 'PENDING',
    milestones: [{
      ...proposal().milestones[0],
      state: '<img src=x onerror=alert(1)>'
    }]
  }));

  const rendered = planner.els.proposalView.innerHTML;
  assert.match(rendered, /Lifecycle state[\s\S]*&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /Raw lifecycle state[\s\S]*&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>|<img src=x/);
});

test('recent Planner Requests use the same friendly lifecycle semantics without side effects', async () => {
  const calls = [];
  const planner = createHarness(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
    if (url === '/api/planner/recent?limit=10') return response({ items: [] });
    if (url === '/api/planner/proposals/recent_running') {
      return response(proposal({
        roadmap_id: 'recent_running',
        title: 'Recent Running',
        state: 'ACTIVE',
        approval_status: 'APPROVED',
        milestones: [{ ...proposal().milestones[0], state: 'VERIFYING' }]
      }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  await flush();
  calls.length = 0;

  planner.state.recentLoading = false;
  planner.state.recentPlannerRequests = [
    { roadmap_id: 'recent_proposed', title: 'Recent Proposed', state: 'PROPOSED', approval_status: 'PENDING' },
    { roadmap_id: 'recent_running', title: 'Recent Running', state: 'ACTIVE', approval_status: 'APPROVED', milestones: [{ state: 'RUNNING' }] },
    { roadmap_id: 'recent_cancelled', title: 'Recent Cancelled', state: 'CANCELLED', approval_status: 'PENDING' }
  ];
  planner.renderRecentPlannerRequests();

  assert.match(planner.els.recentList.innerHTML, /Recent Proposed[\s\S]*Waiting for approval/);
  assert.match(planner.els.recentList.innerHTML, /Recent Running[\s\S]*Running/);
  assert.match(planner.els.recentList.innerHTML, /Recent Cancelled[\s\S]*Cancelled/);

  await planner.openRecentPlannerRequest('recent_running');
  assert.equal(calls.some((call) => /\/approve$|\/request-changes$|\/start$|\/api\/tasks|EXECUTION_RUN/.test(call.url)), false);
});

test('approval, malformed proposals, and running presentation remain bounded', async () => {
  const calls = [];
  const responses = [
    { ok: true },
    proposal({ state: 'ACTIVE', approval_status: 'APPROVED' })
  ];
  const planner = createHarness(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
    if (url === '/api/planner/recent?limit=10') return response({ items: [] });
    return response(responses.shift() || {});
  });
  await flush();
  calls.length = 0;

  planner.renderProposal(proposal({ state: 'PROPOSED', approval_status: 'PENDING' }));
  await planner.els.approve.listeners.click();
  assert.match(calls[0].url, /\/approve$/);
  assert.equal(calls.some((call) => /\/start$/.test(call.url)), false);

  planner.renderProposal({ roadmap_id: 'bad', title: 'Malformed', state: 'PROPOSED', approval_status: 'PENDING' });
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal(proposal({
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    current_milestone_id: 'm-current',
    milestones: [{
      ...proposal().milestones[0],
      id: 'm-current',
      title: 'Implement lifecycle labels',
      objective: 'Show the work users care about.',
      state: 'RUNNING'
    }],
    mission_id: 'mission_should_be_advanced',
    brain_run_id: 'brain_should_be_advanced'
  }));
  const rendered = planner.els.proposalView.innerHTML;
  assert.match(rendered, /Running/);
  assert.match(rendered, /Current milestone: Implement lifecycle labels/);
  assert.equal(rendered.indexOf('Current milestone: Implement lifecycle labels') < rendered.indexOf('Advanced roadmap details'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});
