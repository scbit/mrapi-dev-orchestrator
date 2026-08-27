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

async function renderPlannerPage() {
  const { createPlannerUiRouter } = loadPlannerUiRouter();
  const router = createPlannerUiRouter();
  let html = '';
  await router(
    { method: 'GET', url: '/planner' },
    { setHeader() {}, end(value) { html = value; } },
    () => {
      throw new Error('PLANNER_ROUTE_NOT_FOUND');
    }
  );
  return html;
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match, 'planner page script must exist');
  return match[1];
}

function createElement(id) {
  const classes = new Set(['approveRoadmap', 'requestChanges', 'startAutopilot', 'proposalView', 'startView'].includes(id) ? ['hidden'] : []);
  const element = {
    id,
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    listeners: {},
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    reset() {
      this.value = '';
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
}

function createHarness(html, fetchImpl = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    }
  };
  const context = {
    document,
    fetch: fetchImpl,
    encodeURIComponent,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    JSON,
    String,
    Boolean,
    Number,
    Array,
    Error
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal };`, context);
  return context.__planner;
}

function proposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_summary_1',
    title: 'Summary First Roadmap',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    objective: 'Make roadmap review usable for daily planning.',
    summary: 'A concise proposal summary remains visible before internal details.',
    risks: ['Too much internal metadata', 'Approval could be confused with start', 'Mobile layout could become dense', 'Troubleshooting data could disappear'],
    dependencies: ['Persisted proposal API', 'Existing read-only renderer', 'Planner approval gate', 'Current lifecycle states'],
    assumptions: ['Users review before approving'],
    original_request: 'Refactor the Planner proposal view',
    provenance: { source: 'PLANNER_BRAIN_RUN', planner_mission_id: 'mission_123', brain_run_id: 'brain_456' },
    planner_mission_id: 'mission_123',
    brain_run_id: 'brain_456',
    revision_number: 2,
    revision_status: 'READY',
    latest_revision_feedback: 'Keep the approval boundary clear.',
    revision_history: [{ revision_number: 1, feedback: 'Clarify summary.' }],
    milestones: [
      {
        id: 'm-human',
        order: 1,
        title: 'Human Checkpoint',
        objective: 'Confirm the user-facing plan.',
        description: 'The reviewer checks the summary before approving.',
        executor_required: false,
        human_action_required: true,
        dependencies: [],
        risks: ['Reviewer may miss a dependency'],
        success_criteria: ['Approval remains explicit'],
        state: 'PROPOSED'
      },
      {
        id: 'm-brain',
        order: 2,
        title: 'Brain Only Follow-up',
        objective: 'Keep non-executor planning visible without fabricating human work.',
        description: 'This milestone is not counted as Human Action merely because Executor is false.',
        executor_required: false,
        dependencies: ['m-human'],
        risks: ['False human-action count'],
        success_criteria: ['Human Action count stays explicit'],
        state: 'PENDING'
      },
      {
        id: 'm-executor',
        order: 3,
        title: 'Executor Implementation',
        objective: 'Apply approved changes after review.',
        description: 'Executor work stays separate from approval and start.',
        executor_required: true,
        dependencies: ['m-human', 'm-brain'],
        risks: ['Start could happen too early'],
        success_criteria: ['Start remains hidden before approval'],
        state: 'RUNNING'
      }
    ],
    ...overrides
  };
}

function firstMilestoneSummary(html) {
  const match = html.match(/<summary class="milestone-summary">([\s\S]*?)<\/summary>/);
  assert.ok(match, 'milestone summary must render');
  return match[1];
}

test('proposal review is summary-first and keeps technical roadmap details advanced', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.ok(rendered.indexOf('Make roadmap review usable for daily planning') < rendered.indexOf('Advanced roadmap details'));
  assert.match(rendered, /Summary First Roadmap/);
  assert.match(rendered, /Milestones[\s\S]*<strong>3<\/strong>/);
  assert.match(rendered, /Executor required[\s\S]*<strong>1<\/strong>/);
  assert.match(rendered, /Human actions[\s\S]*<strong>1<\/strong>/);
  assert.match(rendered, /Too much internal metadata/);
  assert.match(rendered, /Approval could be confused with start/);
  assert.match(rendered, /\+1 more in Advanced details/);
  assert.match(rendered, /Persisted proposal API/);
  assert.match(rendered, /Existing read-only renderer/);
  assert.match(rendered, /Planner approval gate/);
  assert.doesNotMatch(rendered.slice(0, rendered.indexOf('Advanced roadmap details')), /Troubleshooting data could disappear/);
});

test('historical summary display uses not-recorded wording without enabling actions', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal({
    roadmap_id: 'historical_summary_1',
    title: 'Historical Summary Roadmap',
    objective: 'Review available legacy roadmap content.',
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    milestones: [{
      id: 'legacy_summary_m1',
      title: 'Legacy Summary Milestone',
      expected_outcome: 'Keep the available legacy outcome visible.'
    }]
  });
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Historical read-only roadmap/);
  assert.match(rendered, /Summary not recorded in this historical roadmap/);
  assert.match(rendered, /Major risks[\s\S]*Not recorded/);
  assert.match(rendered, /Major dependencies[\s\S]*Not recorded/);
  assert.match(rendered, /Assumptions[\s\S]*Not recorded/);
  assert.match(rendered, /Keep the available legacy outcome visible/);
  assert.doesNotMatch(rendered, /Brain only/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('Human Action count only uses explicit persisted metadata', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  const noExplicitHumanAction = proposal({
    milestones: proposal().milestones.map((milestone) => ({
      ...milestone,
      human_action_required: undefined,
      requires_human_action: undefined,
      action_type: undefined,
      checkpoint_type: undefined
    }))
  });
  planner.renderProposal(noExplicitHumanAction);

  assert.match(planner.els.proposalView.innerHTML, /Human actions[\s\S]*<strong>none identified<\/strong>/);
});

test('milestones are collapsed by default with human-facing headers and advanced technical details', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;
  const collapsedHeader = firstMilestoneSummary(rendered);

  assert.match(rendered, /<details class="milestone"><summary class="milestone-summary">/);
  assert.doesNotMatch(rendered, /<details class="milestone" open/);
  assert.match(collapsedHeader, /Human Checkpoint/);
  assert.match(collapsedHeader, /Confirm the user-facing plan/);
  assert.match(collapsedHeader, /Need human action/);
  assert.doesNotMatch(collapsedHeader, /m-human|executor_required|Executor requirement|Dependencies|Reviewer may miss|Approval remains explicit|PROPOSED/);

  assert.match(rendered, /The reviewer checks the summary before approving/);
  assert.match(rendered, /Advanced milestone details/);
  assert.match(rendered, /Milestone ID[\s\S]*m-human/);
  assert.match(rendered, /Raw lifecycle state[\s\S]*PROPOSED/);
  assert.match(rendered, /Executor requirement[\s\S]*Brain only/);
  assert.match(rendered, /Dependencies[\s\S]*m-human/);
  assert.match(rendered, /Risks[\s\S]*Reviewer may miss a dependency/);
  assert.match(rendered, /Success criteria[\s\S]*Approval remains explicit/);
});

test('advanced roadmap details retain lifecycle, approval, revision, provenance and source identifiers', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Advanced roadmap details/);
  assert.match(rendered, /Lifecycle state[\s\S]*PROPOSED/);
  assert.match(rendered, /Approval status[\s\S]*Awaiting explicit approval/);
  assert.match(rendered, /Revision 2/);
  assert.match(rendered, /Keep the approval boundary clear/);
  assert.match(rendered, /Provenance[\s\S]*PLANNER_BRAIN_RUN/);
  assert.match(rendered, /Planner Mission ID[\s\S]*mission_123/);
  assert.match(rendered, /Brain Run ID[\s\S]*brain_456/);
  assert.match(rendered, /Refactor the Planner proposal view/);
});

test('proposal-derived text is escaped before rendering', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);
  planner.renderProposal(proposal({
    title: '<img src=x onerror=alert(1)>',
    objective: 'Escape <script>alert(1)</script> objective.',
    milestones: proposal().milestones.map((milestone, index) => index === 0 ? {
      ...milestone,
      title: '<b>Unsafe milestone</b>',
      description: 'Never render <script>bad()</script>.'
    } : milestone)
  }));
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /Escape &lt;script&gt;alert\(1\)&lt;\/script&gt; objective/);
  assert.match(rendered, /&lt;b&gt;Unsafe milestone&lt;\/b&gt;/);
  assert.doesNotMatch(rendered, /<script>alert\(1\)|<b>Unsafe milestone<\/b>/);
});

test('malformed proposals still block approval and existing action gates are preserved', async () => {
  const html = await renderPlannerPage();
  const planner = createHarness(html);

  planner.renderProposal({ roadmap_id: 'bad', title: 'Incomplete', state: 'PROPOSED', approval_status: 'PENDING' });
  assert.match(planner.els.proposalView.innerHTML, /incomplete or malformed/i);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);

  planner.renderProposal(proposal());
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal(proposal({
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    milestones: proposal().milestones.map((milestone) => ({ ...milestone, state: 'PENDING' }))
  }));
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), false);
});

test('refresh and approval remain side-effect bounded and approval does not start', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  const responses = [
    proposal(),
    { ok: true },
    proposal({ state: 'ACTIVE', approval_status: 'APPROVED' })
  ];
  const planner = createHarness(html, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/api/workspaces') || String(url).endsWith('/api/projects')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => responses.shift() };
  });

  calls.length = 0;
  planner.els.proposalId.value = 'roadmap_summary_1';
  await planner.els.refresh.listeners.click();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/planner\/proposals\/roadmap_summary_1$/);
  assert.doesNotMatch(calls[0].url, /\/tasks|\/runs|\/approve|\/start|EXECUTION_RUN/);

  await planner.els.approve.listeners.click();
  assert.match(calls[1].url, /\/approve$/);
  assert.equal(calls[1].options.body, JSON.stringify({ approve: true }));
  assert.doesNotMatch(calls.map((call) => call.url).join('\n'), /\/start|\/api\/tasks|\/api\/runs|EXECUTION_RUN/);
});
