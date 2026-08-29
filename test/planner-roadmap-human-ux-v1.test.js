const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

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

async function renderPlannerPage() {
  const routePath = require.resolve('../src/routes/planner.ui.routes');
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { createPlannerUiRouter } = require('../src/routes/planner.ui.routes');
    const router = createPlannerUiRouter();
    let html = '';
    await router(
      { method: 'GET', url: '/planner' },
      { setHeader() {}, end(value) { html = value; } },
      () => { throw new Error('PLANNER_ROUTE_NOT_FOUND'); }
    );
    return html;
  } finally {
    Module._load = originalLoad;
  }
}

function scriptFrom(html) {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(match);
  return match[1];
}

function createElement(id) {
  const classes = new Set(['approveRoadmap', 'requestChanges', 'startAutopilot', 'proposalView', 'startView', 'requestChangesView'].includes(id) ? ['hidden'] : []);
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
    querySelector() { return null; },
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

function createPlannerHarness(html, fetchImpl = async () => ({ ok: true, json: async () => ({ items: [] }) })) {
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
    Error,
    Set,
    Map,
    URLSearchParams
  };
  vm.createContext(context);
  vm.runInContext(`${scriptFrom(html)}\nglobalThis.__planner = { state, els, renderProposal, loadProposal };`, context);
  return context.__planner;
}

function plannerProposal(overrides = {}) {
  return {
    roadmap_id: 'roadmap_human_1',
    title: 'Human UX Roadmap',
    state: 'PROPOSED',
    approval_status: 'PENDING',
    objective: 'Make Planner readable before Autopilot starts.',
    summary: 'MRAPI prepared a roadmap for review.',
    risks: ['Raw internals could distract the reviewer'],
    dependencies: ['Trusted Planner proposal'],
    assumptions: ['User reviews before start'],
    planner_mission_id: 'mission_planner',
    brain_run_id: 'brain_planner',
    milestones: [
      {
        id: 'm1',
        order: 1,
        title: 'Review plan',
        objective: 'Confirm the proposed work.',
        description: 'The human reviews the roadmap.',
        executor_required: false,
        dependencies: [],
        risks: [],
        success_criteria: ['Review actions are explicit'],
        state: 'PROPOSED'
      }
    ],
    ...overrides
  };
}

test('A/B. Planner expresses human request-review-approval-start flow and retains actions', async () => {
  const html = await renderPlannerPage();
  assert.match(html, /Ask \/ Request/);
  assert.match(html, /Roadmap prepared/);
  assert.match(html, /Review/);
  assert.match(html, /Approve or Request Changes/);
  assert.match(html, /Start Autopilot/);
  assert.match(html, /id="approveRoadmap"/);
  assert.match(html, /id="requestChanges"/);
  assert.match(html, /id="startAutopilot"/);

  const planner = createPlannerHarness(html);
  planner.renderProposal(plannerProposal());
  assert.equal(planner.els.approve.classList.contains('hidden'), false);
  assert.equal(planner.els.requestChanges.classList.contains('hidden'), false);
  assert.equal(planner.els.start.classList.contains('hidden'), true);
});

test('C/D/E/F. Planner makes resume and repair contextual while keeping IDs advanced', async () => {
  const html = await renderPlannerPage();
  const planner = createPlannerHarness(html);
  planner.renderProposal(plannerProposal({
    state: 'ACTIVE',
    approval_status: 'APPROVED',
    milestones: [{
      ...plannerProposal().milestones[0],
      state: 'FAILED',
      mission_id: 'mission_failed'
    }],
    milestone_runtime: [{
      milestone_id: 'm1',
      mission_id: 'mission_failed',
      milestone_state: 'FAILED',
      brain_run: { id: 'brain_failed', state: 'FAILED' },
      execution_run: { id: 'exec_failed', state: 'FAILED' },
      task_id: 'task_failed',
      recovery: { recoverable: true, mode: 'EXECUTION_RETRY', reason: 'trusted failure' }
    }]
  }));
  const rendered = planner.els.proposalView.innerHTML;
  const primary = rendered.slice(0, rendered.indexOf('Advanced roadmap details'));

  assert.equal(planner.els.start.textContent, 'Resume Autopilot');
  assert.match(rendered, /Retry Execution/);
  assert.doesNotMatch(primary, /task_failed|brain_failed|exec_failed/);
  assert.match(rendered, /Advanced \/ Technical Details|Advanced roadmap details/);
  assert.match(rendered, /Task IDs[\s\S]*task_failed/);
  assert.match(rendered, /Brain Run IDs[\s\S]*brain_failed/);
  assert.match(rendered, /Execution Run IDs[\s\S]*exec_failed/);
  assert.match(html, /repair-metadata/);
  assert.match(html, /Roadmap metadata needs repair/);
  assert.match(html, /Metadata repair details/);
});

test('G/H/I/J/Y. Planner has no manual progression and refetches after mutations', async () => {
  const html = await renderPlannerPage();
  assert.doesNotMatch(html, /Start Next Milestone|Start next milestone|Next Milestone/);
  assert.doesNotMatch(html, /\/advance/);
  assert.doesNotMatch(html, /\/milestones\/' \+ encodeURIComponent\([^)]*\) \+ '\/state/);
  assert.doesNotMatch(html, /setInterval/);
  assert.match(html, /request-changes[\s\S]*await loadProposal\(\)/);
  assert.match(html, /\/approve[\s\S]*await loadProposal\(\)/);
  assert.match(html, /\/autopilot[\s\S]*await loadProposal\(\)/);
  assert.doesNotMatch(html, /state\.proposal\.state\s*=|state\.proposal\.milestones\s*=/);
});

test('K/L/M/N/O/U/V/W/X/Z. Roadmap renders trusted ordered timeline with human states and details', () => {
  const js = read('src/public/roadmap-page.js');
  const css = read('src/public/roadmap-page.css');
  const html = read('src/public/roadmap.html');

  assert.match(js, /orderedMilestones/);
  assert.match(js, /timeline-stepper/);
  for (const label of ['COMPLETED', 'CURRENT', 'PENDING', 'BLOCKED', 'HUMAN ACTION', 'RECOVERABLE']) {
    assert.match(js, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(js, /of \$\{esc\(total\)\} milestones completed/);
  assert.doesNotMatch(js, /percentage|percent|progress_percent|mission.*percent/i);
  assert.match(js, /Linked Mission/);
  assert.match(js, /Worker/);
  assert.match(js, /Brain-only/);
  assert.match(js, /Executor required/);
  assert.match(js, /Success Criteria/);
  assert.match(js, /Verification/);
  assert.match(js, /Recovery/);
  assert.match(js, /milestone_id/);
  assert.match(js, /mission_id/);
  assert.match(js, /Dependencies IDs/);
  assert.match(js, /Raw milestone state/);
  assert.match(js, /Raw runtime state/);
  assert.match(js, /Waiting for your action/);
  assert.match(js, /data-human-action-ready/);
  assert.match(js, /data-mission-recovery/);
  assert.match(js, /Not verified yet/);
  assert.match(js, /await loadRoadmaps\(\);[\s\S]*await editRoadmap/);
  assert.doesNotMatch(js, /\/api\/missions\?|\/api\/tasks|\/api\/runs|\/api\/evidence/);
  assert.doesNotMatch(js, /setInterval/);
  assert.match(css, /timeline-stepper/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*timeline-grid[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /focus-visible/);
  assert.match(html, /Read-only roadmap workspace and project context/);
});

test('P/Q/R/S/T. Roadmap avoids manual lifecycle authority and keeps informational next milestone non-actionable', () => {
  const source = read('src/public/roadmap-page.js') + read('src/public/roadmap.html');
  assert.doesNotMatch(source, /\/advance/);
  assert.doesNotMatch(source, /milestones\/.*\/state/);
  assert.doesNotMatch(source, /Start Next Milestone|Start next milestone|Next Milestone/);
  assert.match(source, /Next milestone, informational only/);
  assert.match(source, /\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}\/recover/);
  assert.doesNotMatch(source, /state\.milestones\s*=|currentRoadmap\.milestones\s*=/);
});
