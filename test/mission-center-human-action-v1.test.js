const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function createElement(id = '') {
  return {
    id,
    hidden: id.includes('Modal'),
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    reset() {}
  };
}

function createHarness(fetchImpl = async () => ({ ok: true, json: async () => ({ items: [] }) })) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement(selector));
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const context = {
    document,
    fetch: fetchImpl,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { error() {}, warn() {} },
    confirm: () => true,
    prompt: () => '',
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    encodeURIComponent,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Set,
    Map,
    Error
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${read('src/public/app.js')}\nglobalThis.__state = state;`, context);
  return { api: context.mrapiMissionCenterHumanActionV1, state: context.__state, context };
}

function renderScenario(overrides = {}) {
  const { api, state } = createHarness();
  const mission = {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    objective: 'Implement Mission Center UX.',
    preferred_worker_id: 'W01',
    state: 'RUNNING',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm4',
    updated_at: '2026-08-29T10:00:00.000Z',
    ...overrides.mission
  };
  state.tasks = overrides.tasks || [{ id: 'task_a', mission_id: 'mission_a', title: 'Build UI', state: 'RUNNING', updated_at: '2026-08-29T10:10:00.000Z' }];
  state.runs = overrides.runs || [{ id: 'exec_a', mission_id: 'mission_a', task_id: 'task_a', run_type: 'EXECUTION_RUN', state: 'RUNNING', progress_percent: 22, updated_at: '2026-08-29T10:20:00.000Z' }];
  state.results = overrides.results || [];
  const html = api.renderMissionCenter({
    mission,
    tasks: state.tasks,
    runs: state.runs,
    results: state.results,
    planData: null,
    recovery: overrides.recovery || { recoverable: false, mode: 'NO_ACTION' }
  });
  return { html, api, state, mission };
}

test('A/B. Mission Detail is presented as Mission Center with primary human status areas', () => {
  const index = read('src/public/index.html');
  assert.match(index, /MISSION CENTER/);
  const { html } = renderScenario();
  assert.match(html, /Mission Center|mission-center/);
  assert.match(html, /What is happening now/);
  assert.match(html, /Mission objective[\s\S]*Implement Mission Center UX/);
  assert.match(html, /Worker[\s\S]*W01/);
  assert.match(html, /Current actor/);
  assert.match(html, /Latest activity/);
  assert.match(html, /Latest Outcome|Result \/ Verification/);
  assert.match(html, /Next expected step/);
});

test('C/D/E/F/G. Human lifecycle mapping follows trusted precedence', () => {
  const { api } = createHarness();
  const mission = { id: 'm1', state: 'PLANNING' };
  const phase = (input) => api.deriveMissionCenterPhase({ mission, tasks: [], runs: [], ...input }).label;
  assert.equal(phase({}), 'Planning');
  assert.equal(phase({ runs: [{ run_type: 'BRAIN_RUN', state: 'RUNNING', brain_run_type: 'PROGRAM' }] }), 'Brain Working');
  assert.equal(phase({ tasks: [{ state: 'READY', requires_execution: true }] }), 'Waiting for Executor');
  assert.equal(phase({ runs: [{ run_type: 'EXECUTION_RUN', state: 'RUNNING' }] }), 'Executor Working');
  assert.equal(phase({ runs: [{ run_type: 'EXECUTION_RUN', state: 'RUNNING', phase: 'TEST_VALIDATION' }] }), 'Testing');
  assert.equal(phase({ runs: [{ run_type: 'BRAIN_RUN', state: 'RUNNING', brain_run_type: 'VERIFICATION' }] }), 'Verification');
  assert.equal(phase({ humanAction: { checkpoint_id: 'cp1', human_action_required: true, status: 'WAITING_FOR_HUMAN' }, runs: [{ run_type: 'EXECUTION_RUN', state: 'RUNNING' }] }), 'Waiting Human Action');
  assert.equal(phase({ recovery: { recoverable: true, mode: 'EXECUTION_RETRY' }, runs: [{ run_type: 'BRAIN_RUN', state: 'RUNNING' }] }), 'Recovering');
  assert.equal(api.deriveMissionCenterPhase({ mission: { id: 'm2', state: 'COMPLETED' }, tasks: [], runs: [] }).label, 'Completed');
});

test('H/I/J/K/M. Mission Center avoids synthetic primary truth and moves raw IDs to Technical Details', () => {
  const source = read('src/public/app.js');
  assert.doesNotMatch(source, /Planning completed \/ waiting execution|percent:\s*45|percent:\s*55|Math\.min\(45/);
  const { html } = renderScenario({
    results: [{ id: 'result_a', mission_id: 'mission_a', run_id: 'exec_a', status: 'SUCCESS', summary: 'Persisted final result.' }]
  });
  const technicalIndex = html.indexOf('Advanced / Technical Details');
  const primary = html.slice(0, technicalIndex);
  assert.ok(technicalIndex > 0);
  assert.doesNotMatch(primary, /task_a|exec_a/);
  assert.match(html.slice(technicalIndex), /Mission ID[\s\S]*mission_a/);
  assert.match(html.slice(technicalIndex), /Task IDs and states[\s\S]*task_a/);
  assert.match(html.slice(technicalIndex), /Execution Run IDs\/states[\s\S]*exec_a/);
  assert.match(html, /Persisted final result/);
  assert.match(renderScenario().html, /Not verified yet/);
});

test('L/V/W. PASS and FAILED render only from trusted persisted validation or result evidence', () => {
  const { api } = createHarness();
  assert.equal(api.trustedEvidenceStatus({ summary: 'tests passed in prose only' }).label, 'Not verified yet');
  assert.equal(api.trustedEvidenceStatus({ status: 'PASS' }).label, 'PASS');
  assert.equal(api.trustedEvidenceStatus({ output: { validation_result: { ok: true } } }).label, 'PASS');
  assert.equal(api.trustedEvidenceStatus({ output: { validation_result: { status: 'FAILED' } } }).label, 'FAILED');
  const resolved = renderScenario({ mission: { human_action_checkpoint: { checkpoint_id: 'cp_done', human_action_required: false, status: 'RESOLVED' } } }).html;
  assert.doesNotMatch(resolved, /ACTION REQUIRED|data-human-action-ready="1"/);
});

test('N/O/P/Q/R/U/X/Y. Recovery and LISTO use existing same-Mission contracts without loops', () => {
  const app = read('src/public/app.js');
  const recovery = read('src/public/recovery-ui.js');
  assert.match(app, /Correct \/ Replay Brain/);
  assert.match(app, /Retry Execution/);
  assert.match(app, /Resume Mission|Resume Autopilot/);
  assert.match(recovery, /\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}\/recover/);
  assert.match(recovery, /await openMissionDetail\(missionId\)/);
  assert.doesNotMatch(recovery, /\/api\/missions['"`][\s\S]{0,80}method:\s*['"`]POST/);
  const html = renderScenario({ recovery: { recoverable: true, mode: 'EXECUTION_RETRY', active_run_id: 'run_recovery' } }).html;
  assert.match(html, /Retry Execution/);
  assert.match(html, /disabled>Recovery in progress/);
  assert.match(app, /\/api\/planner\/proposals\/\$\{encodeURIComponent\(roadmapId\)\}\/human-action\/\$\{encodeURIComponent\(checkpointId\)\}\/ready/);
  assert.match(app, /JSON\.stringify\(\{ ready: true \}\)/);
  assert.match(app, /await loadAll\(\);[\s\S]*await openMissionDetail\(missionId\)/);
  assert.doesNotMatch(app, /state\.[\w.]+\s*=\s*['"]PASS['"]|resolved\s*=\s*true/);
  assert.equal((app.match(/setInterval\(loadAll, 5000\)/g) || []).length, 1);
});

test('S/T. Human Action panel is dominant and LISTO does not fabricate PASS', () => {
  const checkpoint = {
    checkpoint_id: 'cp1',
    roadmap_id: 'roadmap_a',
    human_action_required: true,
    status: 'WAITING_FOR_HUMAN',
    human_action_request: 'MRAPI needs deployment confirmation.',
    reason: 'Manual deploy is required.',
    user_action: 'Deploy from the approved branch.',
    action_location: 'GitHub Desktop',
    validation_method: 'Persisted host validation result'
  };
  const { html } = renderScenario({ mission: { human_action_checkpoint: checkpoint } });
  assert.match(html, /mission-center-human-action/);
  assert.match(html, /ACTION REQUIRED/);
  assert.match(html, /MRAPI needs deployment confirmation/);
  assert.match(html, /Manual deploy is required/);
  assert.match(html, /Deploy from the approved branch/);
  assert.match(html, /GitHub Desktop/);
  assert.match(html, /Persisted host validation result/);
  assert.match(html, /data-human-action-ready="1"[\s\S]*>LISTO<\/button>/);
  assert.doesNotMatch(html, /evidence-badge pass/);
});

test('Z/AA/AB. CSS, artifact drill-down, and scoped fetch constraints remain in place', () => {
  const css = read('src/public/styles.css');
  const app = read('src/public/app.js');
  const artifact = read('src/public/artifact-ui.js');
  assert.match(css, /mission-center-human-action/);
  assert.match(css, /mission-center-recovery/);
  assert.match(css, /mission-center-technical/);
  assert.match(css, /mission-center-state/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*mission-center-grid \{ grid-template-columns:1fr/);
  assert.match(artifact, /window\.mrapiCleanResult = cleanResult/);
  assert.match(app, /mrapiCleanResult/);
  const detailBody = app.slice(app.indexOf('async function openMissionDetail'), app.indexOf('function closeMissionDetail'));
  assert.doesNotMatch(detailBody, /api\('\/api\/missions'\)|api\('\/api\/tasks'\)|api\('\/api\/runs'\)|api\('\/api\/evidence'\)/);
});
