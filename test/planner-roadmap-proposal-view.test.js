const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  requestPlannerRoadmapChanges
} = require('../src/services/planner');

const root = path.join(__dirname, '..');

class Snap {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() { return this._data ? { ...this._data } : undefined; }
}

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class Doc {
  constructor(db, c, id) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
    this.id = id || db.next(c);
  }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(d, o = {}) { this.db.set(this.c, this.id, d, o); }
  async update(d) { this.db.update(this.c, this.id, d); }
}

class Query {
  constructor(db, c, filters = [], max = null) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
    this.filters = filters;
    this.max = max;
  }
  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.c, [...this.filters, { field, value }], this.max);
  }
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, d]) => this.filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) { return new Doc(this.db, this.c, id); }
}

class Tx {
  constructor() { this.hasWritten = false; }
  async get(x) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return x.get();
  }
  set(ref, d, o) {
    this.hasWritten = true;
    ref.db.set(ref.c || ref.collectionName, ref.id, d, o);
  }
  update(ref, d) {
    this.hasWritten = true;
    ref.db.update(ref.c || ref.collectionName, ref.id, d);
  }
}

class DB {
  constructor() {
    this.collections = {};
    this.n = {};
  }
  collection(c) {
    if (!this.collections[c]) this.collections[c] = {};
    return new Coll(this, c);
  }
  next(c) {
    this.n[c] = (this.n[c] || 0) + 1;
    return `${c}_${this.n[c]}`;
  }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) {
    if (!this.collections[c]) this.collections[c] = {};
    this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d };
  }
  update(c, id, d) {
    if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND');
    this.collections[c][id] = { ...this.collections[c][id], ...d };
  }
  async runTransaction(fn) { return fn(new Tx()); }
}

function seedScb(db) {
  db.set('workspaces', 'workspace_scb', { id: 'workspace_scb', tenant_id: 'tenant_facundo_group', name: 'SCB' });
  db.set('projects', 'project_scb_development', {
    id: 'project_scb_development',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    name: 'SCB Development',
    default_worker_id: 'W01',
    primary_worker_ids: ['W01']
  });
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
  await router(
    { method: 'GET', url: '/planner' },
    {
      setHeader() {},
      end(value) { html = value; }
    },
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
  const classes = new Set(['approveRoadmap', 'startAutopilot', 'proposalView', 'startView'].includes(id) ? ['hidden'] : []);
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
    String,
    Boolean,
    Number,
    Array,
    Error
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal };`, context);
  return { context, elements, planner: context.__planner };
}

function proposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_1',
    title: 'Persisted W01 Roadmap',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    objective: 'Review a persisted roadmap before approval.',
    summary: 'The roadmap is generated by Brain and remains read-only in Planner.',
    risks: ['Approval could be confused with execution'],
    dependencies: ['Stored Planner proposal endpoint'],
    assumptions: ['A human reviewer decides whether to approve'],
    original_request: 'Build the Planner roadmap review screen',
    provenance: { source: 'PLANNER_BRAIN_RUN', original_request: 'Build the Planner roadmap review screen' },
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    milestones: [
      {
        id: 'm2',
        order: 2,
        title: 'Executor Follow-up',
        objective: 'Prepare future executor work after approval.',
        description: 'Describe the executor-facing milestone without starting it.',
        executor_required: true,
        dependencies: ['m1'],
        risks: ['Could be started too early'],
        success_criteria: ['Start remains separate from approval'],
        state: 'PROPOSED'
      },
      {
        id: 'm1',
        order: 1,
        title: 'Brain Review',
        objective: 'Explain the planning decision.',
        description: 'Summarize the roadmap and approval boundary.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Reviewer sees complete proposal fields'],
        state: 'PROPOSED'
      }
    ],
    ...overrides
  };
}

function historicalProposal(overrides = {}) {
  return {
    roadmap_id: 'historical_1',
    title: 'Historical Planner Roadmap',
    state: 'PROPOSED',
    objective: 'Show a legacy roadmap without allowing lifecycle actions.',
    milestones: [
      {
        id: 'legacy_m1',
        title: 'Legacy Outcome Milestone',
        expected_outcome: 'Render the persisted outcome from the older schema.'
      }
    ],
    ...overrides
  };
}

function structuredPlannerProposal(overrides = {}) {
  return {
    title: 'SCB Structured Proposal',
    objective: 'Persist canonical structured metadata without prose inference.',
    summary: 'Plain proposal text with no metadata keywords.',
    risks: [],
    dependencies: [],
    assumptions: [],
    auto_advance: true,
    expected_human_actions: [{
      milestone_id: 'm2',
      human_action_request: 'Confirm the integration boundary.',
      user_action: 'Review and confirm the boundary.',
      action_location: 'Planner review',
      validation_method: 'manual_confirmation',
      checkpoint_id: 'runtime_checkpoint_must_not_persist',
      validator_result: 'secret result'
    }],
    milestones: [
      {
        id: 'm1',
        title: 'Prepare',
        objective: 'Prepare the proposal.',
        description: 'Plain setup text.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Preparation is described.']
      },
      {
        id: 'm2',
        title: 'Review',
        objective: 'Review the proposal.',
        description: 'Plain review text.',
        executor_required: false,
        dependencies: ['m1'],
        risks: [],
        success_criteria: ['Review is described.']
      }
    ],
    ...overrides
  };
}

async function persistedStructuredProposal(db, proposalBody = structuredPlannerProposal(), requestOverrides = {}) {
  seedScb(db);
  const request = await createPlannerRequest(db, 'tenant_facundo_group', {
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    request: 'Create a plain proposal.',
    ...requestOverrides
  });
  const created = await completePlannerBrainRun(db, 'tenant_facundo_group', request.brain_run_id, { proposal: proposalBody });
  const readBack = await getPlannerProposal(db, 'tenant_facundo_group', created.roadmap_id);
  return { request, created, readBack };
}

test('/planner contains a clearly labeled Roadmap Proposal review section', async () => {
  const html = await renderPlannerPage();
  assert.match(html, /id="proposalView"/);
  assert.match(html, /ROADMAP PROPOSAL/);
  assert.match(html, /Roadmap Proposal|ROADMAP PROPOSAL/);
});

test('Planner service persists trusted scope, boolean auto advance, and expected Human Actions canonically', async () => {
  const db = new DB();
  const { readBack } = await persistedStructuredProposal(db, structuredPlannerProposal({
    title: 'No prose metadata',
    objective: 'Keep structured fields from the contract.',
    summary: 'This description intentionally omits operational metadata words.'
  }), { auto_advance: true });

  assert.equal(readBack.tenant_id, 'tenant_facundo_group');
  assert.equal(readBack.workspace_id, 'workspace_scb');
  assert.equal(readBack.project_id, 'project_scb_development');
  assert.equal(readBack.proposal_type, 'PLANNER_ROADMAP');
  assert.equal(readBack.auto_advance, true);
  assert.equal(typeof readBack.auto_advance, 'boolean');
  assert.equal(readBack.expected_human_actions.length, 1);
  assert.equal(readBack.expected_human_actions[0].milestone_id, 'm2');
  assert.equal(readBack.expected_human_actions[0].human_action_required, true);
  assert.equal(readBack.expected_human_actions[0].checkpoint_id, undefined);
  assert.equal(readBack.expected_human_actions[0].validator_result, undefined);
});

test('Planner service persists explicit Human Action as canonical execution prerequisite', async () => {
  const db = new DB();
  const { readBack } = await persistedStructuredProposal(db, structuredPlannerProposal({
    expected_human_actions: [{
      milestone_id: 'm2',
      human_action_request: 'Clean the repository worktree before continuing.',
      user_action: 'Ensure the repository worktree is clean, then press LISTO.',
      action_location: 'project repository',
      validation_method: 'git_worktree_clean',
      validation_metadata: { repository_path: 'C:/planner/must-not-persist' }
    }]
  }));

  const m2 = readBack.milestones.find((milestone) => milestone.id === 'm2');
  assert.ok(Array.isArray(m2.execution_prerequisites));
  assert.deepEqual(m2.execution_prerequisites, [{
    type: 'MANUAL_HUMAN',
    name: 'repository_clean',
    human_action_request: 'Clean the repository worktree before continuing.',
    user_action: 'Ensure the repository worktree is clean, then press LISTO.',
    action_location: 'project repository',
    validation_method: 'git_worktree_clean'
  }]);
  assert.equal(JSON.stringify(m2.execution_prerequisites).includes('C:/planner/must-not-persist'), false);
});

test('Planner service does not manufacture expected Human Actions from ordinary prose', async () => {
  const db = new DB();
  const body = structuredPlannerProposal({
    title: 'Ordinary Proposal',
    objective: 'Persist regular roadmap text only.',
    summary: 'Review text is present as ordinary proposal content.'
  });
  delete body.expected_human_actions;
  body.milestones = body.milestones.map((milestone) => ({
    ...milestone,
    description: milestone.id === 'm2'
      ? 'A reviewer checks normal proposal details after preparation.'
      : milestone.description
  }));

  const { readBack } = await persistedStructuredProposal(db, body);

  assert.ok(Array.isArray(readBack.expected_human_actions));
  assert.equal(readBack.expected_human_actions.length, 0);
  const m2 = readBack.milestones.find((milestone) => milestone.id === 'm2');
  assert.equal(m2.execution_prerequisites, undefined);
});

test('conflicting Brain proposal scope cannot override trusted Planner scope', async () => {
  const db = new DB();
  const { readBack } = await persistedStructuredProposal(db, structuredPlannerProposal({
    tenant_id: 'tenant_evil',
    workspace_id: 'workspace_evil',
    project_id: 'project_evil'
  }), { auto_advance: true });

  assert.equal(readBack.tenant_id, 'tenant_facundo_group');
  assert.equal(readBack.workspace_id, 'workspace_scb');
  assert.equal(readBack.project_id, 'project_scb_development');
});

test('Planner roadmap revision preserves structured metadata when replacing proposal text', async () => {
  const db = new DB();
  const { readBack } = await persistedStructuredProposal(db, structuredPlannerProposal(), { auto_advance: true });
  const revision = await requestPlannerRoadmapChanges(db, 'tenant_facundo_group', readBack.roadmap_id, {
    feedback: 'Replace the prose while preserving structured metadata.'
  });
  const replacement = structuredPlannerProposal({
    title: 'Replacement prose only',
    objective: 'The revision replaces ordinary proposal content.',
    summary: 'No structured metadata is present in this revision body.'
  });
  delete replacement.auto_advance;
  delete replacement.expected_human_actions;

  await completePlannerBrainRun(db, 'tenant_facundo_group', revision.brain_run_id, { proposal: replacement });
  const revised = await getPlannerProposal(db, 'tenant_facundo_group', readBack.roadmap_id);

  assert.equal(revised.title, 'Replacement prose only');
  assert.equal(revised.tenant_id, 'tenant_facundo_group');
  assert.equal(revised.workspace_id, 'workspace_scb');
  assert.equal(revised.project_id, 'project_scb_development');
  assert.equal(revised.auto_advance, true);
  assert.ok(Array.isArray(revised.expected_human_actions));
  assert.equal(revised.expected_human_actions.length, 1);
  assert.equal(revised.expected_human_actions[0].milestone_id, 'm2');
});

test('proposal rendering uses persisted retrieval data and shows complete review fields', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Persisted W01 Roadmap/);
  assert.match(rendered, /Review a persisted roadmap before approval/);
  assert.match(rendered, /The roadmap is generated by Brain/);
  assert.ok(rendered.indexOf('Review a persisted roadmap before approval') < rendered.indexOf('Advanced roadmap details'));
  assert.match(rendered, /Awaiting explicit approval/);
  assert.match(rendered, /Approval could be confused with execution/);
  assert.match(rendered, /Stored Planner proposal endpoint/);
  assert.match(rendered, /A human reviewer decides whether to approve/);
  assert.match(rendered, /Pedido original/);
  assert.match(rendered, /Build the Planner roadmap review screen/);
  assert.match(rendered, /Origen del plan/);
  assert.match(rendered, /PLANNER_BRAIN_RUN/);
  assert.doesNotMatch(rendered, /tenant_facundo_group|MRAPI_CONTROL|EXECUTION_RUN|codex_handoff/);
});

test('milestones render in persisted order with read-only details and readable empty states', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.ok(rendered.indexOf('Brain Review') < rendered.indexOf('Executor Follow-up'));
  assert.match(rendered, /Milestone ID[\s\S]*m1/);
  assert.match(rendered, /Milestone ID[\s\S]*m2/);
  assert.match(rendered, /Explain the planning decision/);
  assert.match(rendered, /Description/);
  assert.match(rendered, /Summarize the roadmap and approval boundary/);
  assert.match(rendered, /Advanced milestone details/);
  assert.match(rendered, /Executor requirement/);
  assert.match(rendered, /Brain only/);
  assert.match(rendered, /Executor required/);
  assert.match(rendered, /No dependencies/);
  assert.match(rendered, /None recorded/);
  assert.match(rendered, /Success criteria/);
  assert.match(rendered, /Raw lifecycle state/);
});

test('PROPOSED state explains approval boundary, enables approval, and hides Start Autopilot', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(proposal());

  assert.match(planner.els.proposalView.innerHTML, /Waiting for approval/);
  assert.match(planner.els.proposalView.innerHTML, /Awaiting explicit approval/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('approval payload is affirmative-only, refresh is side-effect free, and approval does not start', async () => {
  const html = await renderPlannerPage();
  const calls = [];
  const responses = [
    proposal(),
    { ok: true },
    proposal({ state: 'ACTIVE', approval_status: 'APPROVED', milestones: proposal().milestones.map((m) => ({ ...m, state: 'PENDING' })) })
  ];
  const { planner } = createHarness(html, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/api/workspaces') || String(url).endsWith('/api/projects')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (String(url).startsWith('/api/planner/recent')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    const body = responses.shift();
    return { ok: true, json: async () => body };
  });

  calls.length = 0;
  planner.els.proposalId.value = 'roadmap_1';
  await planner.els.refresh.listeners.click();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/planner\/proposals\/roadmap_1$/);
  assert.doesNotMatch(calls[0].url, /\/approve|\/start/);

  await planner.els.approve.listeners.click();
  const lifecycleCalls = calls.filter((call) => !String(call.url).startsWith('/api/planner/recent'));
  assert.equal(lifecycleCalls.length, 3);
  assert.match(calls[1].url, /\/approve$/);
  assert.equal(calls[1].options.body, JSON.stringify({ approve: true }));
  assert.doesNotMatch(calls.map((call) => call.url).join('\n'), /\/start/);
  assert.match(planner.els.proposalView.innerHTML, /Aprobado|APPROVED/);
  assert.equal(planner.els.start.classList.contains('hidden'), false);
});

test('terminal and malformed proposals are not shown as ordinary startable work', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);

  planner.renderProposal(proposal({ state: 'BLOCKED', approval_status: 'PENDING' }));
  assert.match(planner.els.proposalView.innerHTML, /BLOCKED/);
  assert.match(planner.els.proposalView.innerHTML, /not presented as ordinary executable approved work/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal(proposal({ state: 'CANCELLED', approval_status: 'APPROVED' }));
  assert.match(planner.els.proposalView.innerHTML, /CANCELLED/);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal({ roadmap_id: 'bad', title: 'Incomplete', state: 'PROPOSED', approval_status: 'PENDING' });
  assert.match(planner.els.proposalView.innerHTML, /incomplete or malformed/i);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
});

test('historical proposals missing presentation metadata render read-only', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(historicalProposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.doesNotMatch(rendered, /Proposal unavailable/);
  assert.match(rendered, /Historical Planner Roadmap/);
  assert.match(rendered, /Historical read-only roadmap/);
  assert.match(rendered, /metadata was not recorded by the older schema/);
  assert.match(rendered, /Summary not recorded in this historical roadmap/);
  assert.match(rendered, /Major risks[\s\S]*Not recorded/);
  assert.match(rendered, /Major dependencies[\s\S]*Not recorded/);
  assert.match(rendered, /Assumptions[\s\S]*Not recorded/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('historical milestones render expected outcome and unknown metadata explicitly', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(historicalProposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.match(rendered, /Legacy Outcome Milestone/);
  assert.match(rendered, /Render the persisted outcome from the older schema/);
  assert.match(rendered, /Description not recorded/);
  assert.match(rendered, /Executor requirement[\s\S]*Executor requirement not recorded/);
  assert.match(rendered, /Dependencies[\s\S]*Not recorded/);
  assert.match(rendered, /Risks[\s\S]*Not recorded/);
  assert.match(rendered, /Success criteria[\s\S]*Not recorded/);
  assert.doesNotMatch(rendered, /Brain only/);
});

test('historical read-only branch hides lifecycle controls for proposed and active-looking roadmaps', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);

  planner.renderProposal(historicalProposal({ state: 'PROPOSED', approval_status: 'PENDING' }));
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);

  planner.renderProposal(historicalProposal({ state: 'ACTIVE', approval_status: 'APPROVED' }));
  assert.match(planner.els.proposalView.innerHTML, /Historical read-only roadmap/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('proposals missing historical renderability facts still fail closed', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  const cases = [
    historicalProposal({ title: '' }),
    historicalProposal({ objective: '' }),
    historicalProposal({ state: '' }),
    { ...historicalProposal(), milestones: null },
    historicalProposal({ milestones: [{ title: 'Missing ID', expected_outcome: 'Has an outcome.' }] }),
    historicalProposal({ milestones: [{ id: 'missing_title', expected_outcome: 'Has an outcome.' }] }),
    historicalProposal({ milestones: [{ id: 'missing_objective', title: 'Missing Objective' }] })
  ];

  for (const item of cases) {
    planner.renderProposal(item);
    assert.match(planner.els.proposalView.innerHTML, /Proposal unavailable/);
    assert.match(planner.els.proposalView.innerHTML, /incomplete or malformed/i);
    assert.equal(planner.els.approve.classList.contains('hidden'), true);
    assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
    assert.equal(planner.els.start.classList.contains('hidden'), true);
  }
});

test('malformed proposal review stays unavailable while explicit Human Action continuity renders', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(proposal({
    summary: '',
    active_human_action_checkpoint_id: 'checkpoint_roadmap_view',
    current_human_action_milestone_id: 'm6',
    milestones: [
    {
      id: 'broken_m5',
      title: 'Malformed prior milestone'
    },
    {
      id: 'm6',
      title: 'Persisted Human Action',
      objective: 'Wait for explicit user action.',
      human_action_required: true,
      checkpoint_id: 'checkpoint_roadmap_view',
      checkpoint_type: 'MANUAL_ACTION',
      status: 'NEED_HUMAN_ACTION',
      milestone_id: 'm6',
      mission_id: 'mission_m6',
      roadmap_id: 'roadmap_1',
      human_action_checkpoint: {
        checkpoint_id: 'checkpoint_roadmap_view',
        checkpoint_type: 'MANUAL_ACTION',
        checkpoint_status: 'NEED_HUMAN_ACTION',
        milestone_id: 'm6',
        mission_id: 'mission_m6',
        roadmap_id: 'roadmap_1',
        human_action_required: true
      },
      human_action_request: 'MRAPI needs the deployment confirmation.',
      user_action: 'Confirm the manual deployment completed.',
      action_location: 'Deployment checklist',
      validation_method: 'manual_confirmation'
    }]
  }));

  const rendered = planner.els.proposalView.innerHTML;
  assert.match(rendered, /Proposal unavailable/);
  assert.match(rendered, /incomplete or malformed/i);
  assert.match(rendered, /MRAPI needs:<\/strong> MRAPI needs the deployment confirmation/);
  assert.match(rendered, /What you need to do:<\/strong> Confirm the manual deployment completed/);
  assert.match(rendered, /Action location:<\/strong> Deployment checklist/);
  assert.match(rendered, /Validation method:<\/strong> manual_confirmation/);
  assert.match(rendered, /data-human-action-ready="1" data-checkpoint-id="checkpoint_roadmap_view">LISTO<\/button>/);
  assert.doesNotMatch(rendered, /LISTO is available only for the current unresolved checkpoint/);
  assert.equal(planner.els.approve.classList.contains('hidden'), true);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), true);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('full current proposals keep existing proposal actions and presentation', async () => {
  const html = await renderPlannerPage();
  const { planner } = createHarness(html);
  planner.renderProposal(proposal());
  const rendered = planner.els.proposalView.innerHTML;

  assert.doesNotMatch(rendered, /Historical read-only roadmap/);
  assert.match(rendered, /Waiting for approval/);
  assert.match(rendered, /The roadmap is generated by Brain/);
  assert.match(rendered, /Dependencies[\s\S]*No dependencies/);
  assert.match(rendered, /Executor requirement[\s\S]*Brain only/);
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('proposal review remains read-only and exposes no unauthorized controls', async () => {
  const source = fs.readFileSync(path.join(root, 'src', 'routes', 'planner.ui.routes.js'), 'utf8');
  const html = await renderPlannerPage();

  assert.doesNotMatch(html, /contenteditable|draggable|editMilestone|editTitle|deleteMilestone|regenerate|reorder|drag\/drop/i);
  assert.doesNotMatch(html, /name="tenant_id"|id="tenantId"/);
  assert.doesNotMatch(source, /fetch\('\/api\/tasks|fetch\('\/api\/runs|\/regenerate|\/delete|\/reorder|\/executor/);
});
