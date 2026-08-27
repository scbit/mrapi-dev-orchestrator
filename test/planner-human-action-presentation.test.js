const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  const localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
  const context = { document, fetch: fetchImpl, localStorage, encodeURIComponent, String, Boolean, Number, Array, Error, Date };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  renderProposal,
  renderRecentPlannerRequests,
  openRecentPlannerRequest
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
    roadmap_id: 'roadmap_human_action',
    title: 'Human Action Presentation Roadmap',
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    objective: 'Show explicit persisted human checkpoints without mutating execution.',
    summary: 'The UI presents Human Action only from explicit metadata.',
    risks: [],
    dependencies: [],
    assumptions: [],
    milestones: [
      {
        id: 'm1',
        order: 1,
        title: 'Implementation milestone',
        objective: 'Render Planner state.',
        description: 'No human checkpoint is recorded.',
        executor_required: true,
        dependencies: [],
        risks: [],
        success_criteria: ['Rendered'],
        state: 'PENDING'
      }
    ],
    ...overrides
  };
}

function humanMilestone(overrides = {}) {
  return {
    id: 'human_m1',
    order: 1,
    title: 'Human checkpoint milestone',
    objective: 'Wait for a persisted user checkpoint.',
    description: 'Explicit checkpoint metadata is stored on this milestone.',
    executor_required: false,
    human_action_required: true,
    human_action_request: 'MRAPI needs access confirmation.',
    user_action: 'Confirm the account has access.',
    checkpoint_id: 'checkpoint_1',
    checkpoint_type: 'MANUAL_ACTION',
    status: 'WAITING_FOR_HUMAN',
    dependencies: [],
    risks: [],
    success_criteria: ['Confirmation recorded'],
    state: 'PENDING',
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

test('Human Action panel is absent without explicit persisted checkpoint evidence', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal());
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /human-action-panel|LISTO|MRAPI needs:/);

  planner.renderProposal(proposal({
    milestones: [{
      ...proposal().milestones[0],
      executor_required: false,
      title: 'Brain-only user discussion',
      description: 'A human user is mentioned in prose, but no checkpoint metadata exists.',
      objective: 'Review human wording without inferring action.'
    }]
  }));
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /human-action-panel|LISTO|MRAPI needs:/);
  assert.match(planner.els.proposalView.innerHTML, /Brain-only user discussion[\s\S]*Pending/);
});

test('explicit Human Action renders requirement, instruction, friendly status, fallbacks, and escaping', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal({
    current_milestone_id: 'human_m1',
    milestones: [humanMilestone({
      human_action_request: 'MRAPI needs <b>credential approval</b>.',
      user_action: 'Open <script>alert(1)</script> and approve access.'
    })]
  }));

  const rendered = planner.els.proposalView.innerHTML;
  assert.match(rendered, /human-action-panel is-current/);
  assert.match(rendered, /Need human action/);
  assert.match(rendered, /MRAPI needs:<\/strong> MRAPI needs &lt;b&gt;credential approval&lt;\/b&gt;/);
  assert.match(rendered, /What you need to do:<\/strong> Open &lt;script&gt;alert\(1\)&lt;\/script&gt; and approve access/);
  assert.match(rendered, /Current checkpoint status:<\/strong> Need human action/);
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>|<b>credential approval<\/b>/);

  planner.renderProposal(proposal({
    milestones: [humanMilestone({
      human_action_request: '',
      user_action: '',
      requirement: '',
      instructions: ''
    })]
  }));
  assert.match(planner.els.proposalView.innerHTML, /MRAPI is waiting for a user action/);
  assert.match(planner.els.proposalView.innerHTML, /No specific user instruction was recorded/);
});

test('checkpoint IDs, types, source milestone, and raw status stay in Advanced details', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal({ milestones: [humanMilestone()] }));
  const rendered = planner.els.proposalView.innerHTML;
  const advancedIndex = rendered.indexOf('Advanced checkpoint details');
  assert.ok(advancedIndex > -1);
  assert.equal(rendered.indexOf('checkpoint_1') > advancedIndex, true);
  assert.equal(rendered.indexOf('MANUAL_ACTION') > advancedIndex, true);
  assert.equal(rendered.indexOf('WAITING_FOR_HUMAN') > advancedIndex, true);
  assert.equal(rendered.indexOf('human_m1') > advancedIndex, true);
  assert.match(rendered, /Lifecycle state[\s\S]*ACTIVE/);
  assert.match(rendered, /Raw lifecycle state[\s\S]*PENDING/);
});

test('LISTO is visible only for explicit Human Action and has no continuation side effect', async () => {
  const calls = [];
  const planner = createHarness(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
    if (url === '/api/planner/recent?limit=10') return response({ items: [] });
    return response({});
  });
  await flush();
  calls.length = 0;

  planner.renderProposal(proposal({ milestones: [humanMilestone()] }));
  assert.match(planner.els.proposalView.innerHTML, /<button class="primary" type="button" disabled>LISTO<\/button>/);
  assert.match(planner.els.proposalView.innerHTML, /Confirmation will be enabled when MRAPI provides a continuation endpoint/);
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /continued|successfully resumed|execution continued/i);
  assert.deepEqual(calls, []);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'planner.ui.routes.js'), 'utf8');
  assert.doesNotMatch(source, /\/continue|\/resume|\/human-action|\/checkpoint\/complete|\/listo/);
  assert.doesNotMatch(source, /LISTO[\s\S]{0,240}fetch\(|fetch\([\s\S]{0,240}LISTO/);
  assert.doesNotMatch(source, /LISTO[\s\S]{0,240}\/approve|LISTO[\s\S]{0,240}\/start|LISTO[\s\S]{0,240}request-changes/);
});

test('multiple Human Action checkpoints render deterministically, deduplicate by checkpoint ID, and emphasize current first', async () => {
  const planner = createHarness();
  planner.renderProposal(proposal({
    current_milestone_id: 'm2',
    current_milestone: humanMilestone({
      id: 'm2',
      order: 2,
      title: 'Current checkpoint duplicate',
      checkpoint_id: 'checkpoint_2',
      human_action_request: 'MRAPI needs current confirmation.'
    }),
    milestones: [
      humanMilestone({
        id: 'm1',
        order: 1,
        title: 'First checkpoint',
        checkpoint_id: 'checkpoint_1',
        human_action_request: 'MRAPI needs first confirmation.'
      }),
      humanMilestone({
        id: 'm2',
        order: 2,
        title: 'Current checkpoint',
        checkpoint_id: 'checkpoint_2',
        human_action_request: 'MRAPI needs current confirmation.'
      }),
      humanMilestone({
        id: 'm3',
        order: 3,
        title: 'Duplicate checkpoint',
        checkpoint_id: 'checkpoint_1',
        human_action_request: 'Duplicate representation should not render twice.'
      })
    ]
  }));

  const rendered = planner.els.proposalView.innerHTML;
  assert.equal((rendered.match(/human-action-panel/g) || []).length, 2);
  assert.equal((rendered.match(/checkpoint_1/g) || []).length, 1);
  assert.equal((rendered.match(/checkpoint_2/g) || []).length, 1);
  assert.equal(rendered.indexOf('MRAPI needs current confirmation') < rendered.indexOf('MRAPI needs first confirmation'), true);
});

test('history rows do not fabricate checkpoint text; reopen fetches canonical proposal read-only', async () => {
  const calls = [];
  const planner = createHarness(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
    if (url === '/api/planner/recent?limit=10') return response({ items: [] });
    if (url === '/api/planner/proposals/history_human') {
      return response(proposal({
        roadmap_id: 'history_human',
        milestones: [humanMilestone({ human_action_request: 'MRAPI needs canonical approval.' })]
      }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  await flush();
  calls.length = 0;

  planner.state.recentLoading = false;
  planner.state.recentPlannerRequests = [
    { roadmap_id: 'history_human', title: 'History human', state: 'NEEDS_HUMAN_ACTION', summary: 'User should maybe approve from prose.' }
  ];
  planner.renderRecentPlannerRequests();
  assert.match(planner.els.recentList.innerHTML, /History human[\s\S]*Need human action/);
  assert.doesNotMatch(planner.els.recentList.innerHTML, /User should maybe approve|MRAPI needs canonical approval|LISTO/);

  await planner.openRecentPlannerRequest('history_human');
  assert.deepEqual(calls.map((call) => call.url), ['/api/planner/proposals/history_human']);
  assert.match(planner.els.proposalView.innerHTML, /MRAPI needs canonical approval/);
  assert.equal(calls.some((call) => /\/approve$|\/request-changes$|\/start$|\/api\/tasks|EXECUTION_RUN/.test(call.url)), false);
});

test('existing approval, Start, terminal, and completed-summary behavior remains unchanged', async () => {
  const planner = createHarness();

  planner.renderProposal(proposal({ state: 'PROPOSED', approval_status: 'PENDING' }));
  assert.deepEqual(visibleActions(planner), { approve: true, requestChanges: true, start: false });

  planner.renderProposal(proposal({ state: 'ACTIVE', approval_status: 'APPROVED' }));
  assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: true });

  for (const state of ['COMPLETED', 'BLOCKED', 'CANCELLED']) {
    planner.renderProposal(proposal({ state, approval_status: state === 'COMPLETED' ? 'APPROVED' : 'PENDING' }));
    assert.deepEqual(visibleActions(planner), { approve: false, requestChanges: false, start: false }, state);
  }

  planner.renderProposal(proposal({
    state: 'COMPLETED',
    approval_status: 'APPROVED',
    final_summary: 'Finished without replacing the completed summary.'
  }));
  assert.match(planner.els.proposalView.innerHTML, /COMPLETED ROADMAP/);
  assert.match(planner.els.proposalView.innerHTML, /Finished without replacing the completed summary/);
});
