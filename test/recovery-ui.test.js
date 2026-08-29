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
        if (route.method !== req.method) continue;
        if (route.path !== req.url.split('?')[0]) continue;
        return route.handler(req, res, next);
      }
      return next();
    };
    for (const method of ['get', 'post']) {
      router[method] = (routePath, handler) => routes.push({ method: method.toUpperCase(), path: routePath, handler });
    }
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
  const children = new Map();
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
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, createElement(selector));
      return children.get(selector);
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
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function createHarness(fetchImpl = async (url) => {
  if (url === '/api/workspaces' || url === '/api/projects') return response({ items: [] });
  if (url === '/api/planner/recent?limit=10') return response({ items: [] });
  if (url === '/api/missions') return response({ items: [] });
  return response({});
}) {
  const html = loadPlannerUiRouter().plannerPageHtml();
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
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    encodeURIComponent,
    String,
    Boolean,
    Number,
    Array,
    Error,
    Date,
    JSON,
    Set,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}
globalThis.__planner = {
  state,
  els,
  renderProposal,
  renderMissionsRecovery,
  loadMissionsRecovery
};`, context);
  return context.__planner;
}

function baseProposal(runtime = []) {
  return {
    roadmap_id: 'roadmap_a',
    title: 'Recovery Roadmap',
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    objective: 'Recover milestones.',
    summary: 'Operational runtime view.',
    risks: [],
    dependencies: [],
    assumptions: [],
    milestone_runtime: runtime,
    milestones: [{
      id: 'm1',
      order: 1,
      title: 'Recoverable milestone',
      objective: 'Recover same Mission.',
      description: 'Inspect runtime.',
      executor_required: true,
      dependencies: [],
      risks: [],
      success_criteria: ['Recovered'],
      state: 'BLOCKED',
      mission_id: 'mission_a'
    }]
  };
}

function runtime(overrides = {}) {
  return {
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    milestone_state: 'BLOCKED',
    mission_id: 'mission_a',
    mission_state: 'BLOCKED',
    brain_run: { id: 'brain_1', state: 'FAILED' },
    execution_run: { id: 'exec_1', state: 'FAILED' },
    blocker: { code: 'BRAIN_RESULT_MISSING', message: 'Brain output missing.' },
    latest_evidence: { id: 'ev_1', title: 'Failure evidence', summary: 'Evidence summary' },
    latest_human_response: { evidence_id: 'human_1', text: 'Use this response.' },
    recovery: { recoverable: true, mode: 'BRAIN_REPLAY', reason: 'trusted runtime', action_label: 'Replay Brain' },
    downstream_impact: null,
    ...overrides
  };
}

test('Roadmap UI renders trusted milestone runtime fields and nulls safely', () => {
  const planner = createHarness();
  planner.renderProposal(baseProposal([runtime()]));
  const html = planner.els.proposalView.innerHTML;

  assert.match(html, /Milestone state[\s\S]*BLOCKED/);
  assert.match(html, /Mission ID[\s\S]*mission_a/);
  assert.match(html, /Brain Run[\s\S]*brain_1 \/ FAILED/);
  assert.match(html, /Execution Run[\s\S]*exec_1 \/ FAILED/);
  assert.match(html, /BRAIN_RESULT_MISSING[\s\S]*Brain output missing/);
  assert.match(html, /Evidence summary[\s\S]*ID: ev_1/);
  assert.match(html, /Use this response[\s\S]*ID: human_1/);
  assert.match(html, /BRAIN_REPLAY \/ recoverable/);

  planner.renderProposal(baseProposal([runtime({
    mission_id: null,
    brain_run: null,
    execution_run: null,
    blocker: null,
    latest_evidence: null,
    latest_human_response: null,
    recovery: { recoverable: false, mode: 'NO_ACTION', reason: 'NO_MISSION_LINKED' }
  })]));
  assert.match(planner.els.proposalView.innerHTML, /Not recorded/);
});

test('Roadmap recovery actions trust runtime recovery mode only', () => {
  const planner = createHarness();

  planner.renderProposal(baseProposal([runtime({ recovery: { recoverable: true, mode: 'BRAIN_REPLAY', reason: 'trusted' } })]));
  assert.match(planner.els.proposalView.innerHTML, />Replay Brain<\/button>/);
  assert.doesNotMatch(planner.els.proposalView.innerHTML, />Retry Execution<\/button>/);

  planner.renderProposal(baseProposal([runtime({ milestone_state: 'FAILED', recovery: { recoverable: true, mode: 'EXECUTION_RETRY', reason: 'trusted' } })]));
  assert.match(planner.els.proposalView.innerHTML, />Retry Execution<\/button>/);
  assert.doesNotMatch(planner.els.proposalView.innerHTML, />Replay Brain<\/button>/);

  planner.renderProposal(baseProposal([runtime({ recovery: { recoverable: true, mode: 'HUMAN_ACTION_RESUME', reason: 'trusted' } })]));
  assert.match(planner.els.proposalView.innerHTML, />Resume<\/button>/);

  planner.renderProposal(baseProposal([runtime({ recovery: { recoverable: false, mode: 'NO_ACTION', reason: 'healthy' } })]));
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /data-milestone-recovery="1"/);
});

test('RESPONDER, Human Action, evidence, and downstream controls use existing scoped contracts', () => {
  const planner = createHarness();
  planner.renderProposal(baseProposal([runtime({
    human_action: {
      checkpoint_id: 'checkpoint_1',
      status: 'WAITING_FOR_HUMAN',
      mission_id: 'mission_a',
      roadmap_id: 'roadmap_a',
      milestone_id: 'm1'
    },
    downstream_impact: {
      impact_id: 'impact_1',
      status: 'PENDING_APPROVAL',
      affected_milestone_ids: ['m2', 'm3'],
      reason: 'Later milestones depend on this.'
    }
  })]));
  const html = planner.els.proposalView.innerHTML;

  assert.match(html, /data-milestone-respond="1" data-roadmap-id="roadmap_a" data-milestone-id="m1"/);
  assert.match(html, /\/api\/roadmaps\/roadmap_a\/milestones\/m1\/respond/);
  assert.match(html, /data-runtime-human-action-ready="1" data-checkpoint-id="checkpoint_1">Resolve Human Action/);
  assert.match(html, /data-milestone-evidence="1" data-roadmap-id="roadmap_a" data-mission-id="mission_a" data-milestone-id="m1"/);
  assert.match(html, /PENDING_APPROVAL[\s\S]*m2[\s\S]*m3/);
  assert.match(html, /data-downstream-impact="approve"[\s\S]*data-impact-id="impact_1"/);
  assert.match(html, /data-downstream-impact="reject"[\s\S]*data-impact-id="impact_1"/);

  planner.renderProposal(baseProposal([runtime({ human_action: { checkpoint_id: 'done', status: 'RESOLVED' } })]));
  assert.doesNotMatch(planner.els.proposalView.innerHTML, /Resolve Human Action/);
});

test('Missions UI visibly includes blocked, failed, waiting-human, retryable, and ordinary states', () => {
  const planner = createHarness();
  planner.state.missionsLoading = false;
  planner.state.missions = [
    { id: 'mission_blocked', objective: 'Blocked', state: 'BLOCKED', recovery: { recoverable: true, mode: 'BRAIN_REPLAY', action_label: 'Replay Brain' } },
    { id: 'mission_failed', objective: 'Failed', state: 'FAILED', recovery: { recoverable: true, mode: 'EXECUTION_RETRY', action_label: 'Retry Execution' } },
    { id: 'mission_waiting', objective: 'Waiting', state: 'WAITING_HUMAN', recovery: { recoverable: true, mode: 'HUMAN_ACTION_RESUME', action_label: 'Resume' } },
    { id: 'mission_retryable', objective: 'Retryable', state: 'RETRYABLE', recovery: { recoverable: false, mode: 'NO_ACTION' } },
    { id: 'mission_running', objective: 'Running', state: 'RUNNING' },
    { id: 'mission_planning', objective: 'Planning', state: 'PLANNING' },
    { id: 'mission_completed', objective: 'Completed', state: 'COMPLETED' }
  ];
  planner.renderMissionsRecovery();
  const html = planner.els.missionsList.innerHTML;

  for (const label of ['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'RETRYABLE', 'RUNNING', 'PLANNING', 'COMPLETED']) {
    assert.match(html, new RegExp(label));
  }
});

test('Missions list API includes recoverable terminal and waiting states', async () => {
  const { createMissionsRouter } = (() => {
    const routePath = require.resolve('../src/routes/missions.routes');
    delete require.cache[routePath];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'express') return createMiniExpress();
      if (request === '@google-cloud/firestore') return { FieldValue: { serverTimestamp: () => new Date() } };
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      return require('../src/routes/missions.routes');
    } finally {
      Module._load = originalLoad;
    }
  })();
  const items = ['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'RETRYABLE', 'COMPLETED', 'RUNNING', 'PLANNING']
    .map((state) => ({ id: `mission_${state}`, tenant_id: 'tenant_a', state }));
  const router = createMissionsRouter({
    repos: {
      missions: {
        async listByTenant() { return items; }
      }
    }
  });
  const req = { method: 'GET', url: '/', tenantId: 'tenant_a', query: {} };
  const res = {
    json(body) { this.body = body; }
  };
  await router(req, res, (error) => { if (error) throw error; });

  assert.deepEqual(res.body.items.map((item) => item.state), items.map((item) => item.state));
});

test('Recovery UI source calls trusted endpoints and does not classify recovery from blocker codes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/routes/planner.ui.routes.js'), 'utf8');
  assert.match(source, /\/api\/missions\/' \+ encodeURIComponent\(missionId\) \+ '\/recover/);
  assert.match(source, /\/api\/roadmaps\/' \+ encodeURIComponent\(roadmapId\) \+ '\/milestones\/' \+ encodeURIComponent\(milestoneId\) \+ '\/respond/);
  assert.match(source, /\/api\/evidence/);
  assert.match(source, /\/downstream-impact\/' \+ encodeURIComponent\(impactId\) \+ '\/' \+ encodeURIComponent\(action\)/);
  assert.doesNotMatch(source, /blocker(?:_code|\.code)[\s\S]{0,160}(?:BRAIN_REPLAY|EXECUTION_RETRY)/);
  assert.doesNotMatch(source, /\/api\/roadmaps\/' \+ encodeURIComponent\(.*\) \+ '\/advance/);
});
