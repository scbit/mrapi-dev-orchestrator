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
  openRecentPlannerRequest,
  loadProposal,
  renderRecentPlannerRequests
};`, context);
  return context.__planner;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function milestones(states = ['COMPLETED', 'COMPLETE', 'DONE']) {
  return states.map((state, index) => ({
    id: `m${index + 1}`,
    order: index + 1,
    title: `Milestone ${index + 1}`,
    objective: `Objective ${index + 1}`,
    description: `Description ${index + 1}`,
    executor_required: index !== 0,
    dependencies: index === 0 ? [] : ['m1'],
    risks: ['Risk detail'],
    success_criteria: ['Criterion detail'],
    state
  }));
}

function completedProposal(overrides = {}) {
  return {
    roadmap_id: 'completed_roadmap',
    proposal_id: 'completed_roadmap',
    title: 'Completed Daily Planner Roadmap',
    state: 'COMPLETED',
    approval_status: 'APPROVED',
    objective: 'Ship the persisted completed roadmap summary.',
    summary: 'Original proposal summary remains available for review.',
    risks: [],
    dependencies: [],
    assumptions: [],
    original_request: 'Show completed roadmaps clearly.',
    provenance: { source: 'PLANNER_BRAIN_RUN', original_request: 'Show completed roadmaps clearly.' },
    planner_mission_id: 'mission_completed',
    brain_run_id: 'brain_completed',
    revision_number: 3,
    revision_status: 'READY',
    milestones: milestones(),
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

test('COMPLETED roadmap renders a completed summary before milestone internals with persisted facts', async () => {
  const planner = createHarness();
  planner.renderProposal(completedProposal({
    final_summary: 'Persisted final result narrative.',
    milestones: milestones(['COMPLETED', 'COMPLETE', 'DONE', 'BLOCKED', 'RUNNING', 'CANCELLED'])
  }));
  const rendered = planner.els.proposalView.innerHTML;

  assert.ok(rendered.indexOf('COMPLETED ROADMAP') < rendered.indexOf('<h2>Milestones</h2>'));
  assert.match(rendered, /Completed Daily Planner Roadmap/);
  assert.match(rendered, /Original objective:<\/strong> Ship the persisted completed roadmap summary/);
  assert.match(rendered, /State[\s\S]*<strong>Completed<\/strong>/);
  assert.match(rendered, /Milestones[\s\S]*<strong>6<\/strong>/);
  assert.match(rendered, /Completed[\s\S]*<strong>3<\/strong>/);
  assert.match(rendered, /3 of 6 milestones completed/);
  assert.match(rendered, /Persisted final result narrative/);
  assert.equal(visibleActions(planner).approve, false);
  assert.equal(visibleActions(planner).requestChanges, false);
  assert.equal(visibleActions(planner).start, false);
});

test('COMPLETE and DONE roadmap variants use the same completed presentation', async () => {
  const planner = createHarness();
  for (const state of ['COMPLETE', 'DONE']) {
    planner.renderProposal(completedProposal({ state }));
    assert.match(planner.els.proposalView.innerHTML, /COMPLETED ROADMAP/);
    assert.match(planner.els.proposalView.innerHTML, /State[\s\S]*<strong>Completed<\/strong>/);
    assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false });
  }
});

test('zero completed-roadmap milestones render a safe factual zero-state', async () => {
  const planner = createHarness();
  planner.renderProposal(completedProposal({ milestones: [] }));
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /COMPLETED ROADMAP/);
  assert.match(rendered, /Milestones[\s\S]*<strong>0<\/strong>/);
  assert.match(rendered, /Completed[\s\S]*<strong>0<\/strong>/);
  assert.match(rendered, /0 milestones recorded; 0 completed/);
  assert.doesNotMatch(rendered, /NaN|Infinity/);
});

test('absence or untrusted narrative fields fall back without fabricating outcome claims', async () => {
  const planner = createHarness();
  planner.renderProposal(completedProposal({
    raw_brain_output: 'Executor stdout says deployed to production.',
    output_text: 'Generic log says business impact was achieved.',
    executor_stdout: 'stdout should not be promoted.',
    evidence: { text: 'Evidence blob should not become a final summary.' },
    logs: ['Log line should not become a final summary.'],
    results: [
      { tenant_id: 'other_tenant', summary: 'Cross-tenant result summary must not render.' },
      { tenant_id: 'tenant_a', summary: 'Ambiguous result list must not render.' }
    ]
  }));
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Completed based on persisted roadmap state; no final result summary is available/);
  assert.doesNotMatch(rendered, /deployed to production|business impact|stdout should not|Evidence blob|Log line|Cross-tenant result|Ambiguous result/);
});

test('completed summary escapes persisted final narrative and keeps advanced details collapsed', async () => {
  const planner = createHarness();
  planner.renderProposal(completedProposal({
    final_summary: 'Safe <script>alert(1)</script> final text.',
    milestones: milestones(['COMPLETED'])
  }));
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Safe &lt;script&gt;alert\(1\)&lt;\/script&gt; final text/);
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>/);
  assert.match(rendered, /<details class="advanced-details"><summary><strong>Advanced roadmap details<\/strong><\/summary>/);
  assert.doesNotMatch(rendered, /<details class="advanced-details" open/);
  assert.match(rendered, /<details class="milestone"><summary class="milestone-summary">/);
  assert.doesNotMatch(rendered, /<details class="milestone" open/);
  assert.match(rendered, /Raw lifecycle state[\s\S]*COMPLETED/);
  assert.match(rendered, /Planner Mission ID[\s\S]*mission_completed/);
  assert.match(rendered, /Brain Run ID[\s\S]*brain_completed/);
  assert.match(rendered, /Revision 3/);
});

test('non-completed terminal and running states do not render the completed summary', async () => {
  const planner = createHarness();
  for (const state of ['BLOCKED', 'CANCELLED', 'RUNNING', 'ACTIVE']) {
    planner.renderProposal(completedProposal({
      state,
      approval_status: state === 'ACTIVE' || state === 'RUNNING' ? 'APPROVED' : 'PENDING',
      milestones: milestones(['PENDING'])
    }));
    assert.doesNotMatch(planner.els.proposalView.innerHTML, /COMPLETED ROADMAP/, state);
  }
});

test('opening a completed roadmap from recent history fetches canonical proposal and stays read-only', async () => {
  const calls = [];
  const planner = createHarness(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
    if (url === '/api/planner/recent?limit=10') {
      return response({ items: [{ roadmap_id: 'completed_history', title: 'History item', state: 'COMPLETED', approval_status: 'APPROVED' }] });
    }
    if (url === '/api/planner/proposals/completed_history') {
      return response(completedProposal({ roadmap_id: 'completed_history', final_summary: 'Canonical persisted summary.' }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  await flush();
  calls.length = 0;

  await planner.openRecentPlannerRequest('completed_history');
  await flush();

  assert.equal(calls.filter((call) => call.url === '/api/planner/proposals/completed_history').length, 1);
  assert.equal(calls.some((call) => call.options?.method === 'POST'), false);
  assert.equal(calls.some((call) => /\/api\/tasks|EXECUTION_RUN|\/approve$|\/request-changes$|\/start$/.test(call.url)), false);
  assert.match(planner.els.proposalView.innerHTML, /COMPLETED ROADMAP/);
  assert.match(planner.els.proposalView.innerHTML, /Canonical persisted summary/);
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false });
});
