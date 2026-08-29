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
  const intervalCalls = [];
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
    setInterval(handler, ms) { intervalCalls.push({ handler, ms }); return intervalCalls.length; },
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
  return { api: context.mrapiWorkersExecutorHostExperienceV1, state: context.__state, context, elements, intervalCalls };
}

function seedArchitectureState(state) {
  state.workspaces = [{ id: 'workspace_scb', name: 'SCB Workspace' }];
  state.projects = [{ id: 'project_scb_development', workspace_id: 'workspace_scb', name: 'SCB Development' }];
  state.missions = [{
    id: 'mission_active',
    objective: 'Implement workers architecture view.',
    state: 'RUNNING',
    updated_at: '2026-08-29T10:00:00.000Z'
  }];
  state.tasks = [{ id: 'task_run', title: 'Run frontend tests', state: 'RUNNING' }];
  state.runs = [{
    id: 'run_active',
    task_id: 'task_run',
    run_type: 'EXECUTION_RUN',
    state: 'RUNNING',
    updated_at: '2026-08-29T10:15:00.000Z'
  }];
  state.dashboard = {
    recent_missions: state.missions,
    executors: {
      items: [{
        id: 'executor_codex',
        name: 'Codex Executor',
        executor_type: 'CODEX',
        health_state: 'ONLINE',
        runner_status: 'RUNNING',
        current_run_id: 'run_active',
        worker_ids: ['worker_w01', 'W01'],
        capabilities: ['read_files', 'run_tests', 'git_push'],
        host_name: 'Shadow',
        host_id: 'host_shadow',
        host_environment: 'Windows local',
        host_state: 'ONLINE',
        repository_state: 'READY',
        runtime_validation_state: 'VALID',
        runner_version: '1.2.3',
        heartbeat_age_seconds: 4
      }]
    },
    brain_adapters: {
      items: [{
        id: 'brain_binding_w01',
        name: 'Planner Brain',
        type: 'LLM',
        health_state: 'ONLINE',
        current_brain_run_id: 'brain_run_1',
        worker_ids: ['worker_w01', 'W01'],
        updated_at: '2026-08-29T10:20:00.000Z'
      }]
    }
  };
}

function sampleWorker(overrides = {}) {
  return {
    id: 'worker_w01',
    code: 'W01',
    name: 'Development Worker',
    role: 'Frontend implementation',
    tenant_id: 'tenant_facundo_group',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    operational_status: 'RUNNING',
    current_mission_id: 'mission_active',
    brain_binding: { id: 'brain_binding_w01' },
    executor_binding: { id: 'executor_codex' },
    host_binding: { host_id: 'host_shadow', provider: 'local', validation_state: 'VALID' },
    capabilities: ['read_files', 'run_tests', 'deploy'],
    permissions: { read_files: true, deploy: false, push: false },
    updated_at: '2026-08-29T10:10:00.000Z',
    ...overrides
  };
}

test('A/B/C/D. Worker primary view separates Worker, Brain, Executor, Host, Scope, Capabilities and Permissions', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const html = api.renderWorkerCard(sampleWorker());
  assert.match(html, /Worker identity[\s\S]*Development Worker[\s\S]*Frontend implementation[\s\S]*W01/);
  for (const label of ['Brain', 'Executor', 'Host', 'Scope', 'Capabilities', 'Permissions']) {
    assert.match(html, new RegExp(`aria-label="${label}"|>${label}<`));
  }
  assert.match(html, /Current Mission[\s\S]*Implement workers architecture view[\s\S]*RUNNING/);
  assert.match(html, /Brain[\s\S]*Planner Brain/);
  assert.match(html, /Executor[\s\S]*Codex Executor[\s\S]*Executes Tasks\/Runs/);
  assert.match(html, /Host[\s\S]*Shadow[\s\S]*Environment where Executor runs/);
  assert.ok(html.indexOf('Worker identity') < html.indexOf('Brain'));
  assert.ok(html.indexOf('Executor') < html.indexOf('Host'));
});

test('E/F/G/H/I/J. Worker status mapping supports human states from trusted inputs', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  state.dashboard.executors.items = [];
  assert.equal(api.deriveWorkerHumanStatus(sampleWorker({ operational_status: 'IDLE', current_mission_id: '', current_run_id: '' })), 'IDLE');
  seedArchitectureState(state);
  assert.equal(api.deriveWorkerHumanStatus(sampleWorker({ operational_status: 'RUNNING' })), 'WORKING');
  state.dashboard.executors.items = [];
  assert.equal(api.deriveWorkerHumanStatus(sampleWorker({ operational_status: 'IDLE', current_mission_id: 'mission_wait', current_mission_status: 'WAITING_FOR_EXECUTOR' })), 'WAITING');
  assert.equal(api.deriveWorkerHumanStatus(sampleWorker({ operational_status: 'BLOCKED' })), 'BLOCKED');
  assert.equal(api.deriveWorkerHumanStatus(sampleWorker({ operational_status: 'OFFLINE', executor_health: 'OFFLINE', current_mission_id: '' })), 'OFFLINE');
});

test('K/L. Current Mission uses already-loaded Mission details and does not invent missing objective', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const matched = api.renderWorkerCard(sampleWorker());
  assert.match(matched, /Implement workers architecture view/);
  const missing = api.renderWorkerCard(sampleWorker({ current_mission_id: 'mission_missing' }));
  const primary = missing.slice(0, missing.indexOf('Advanced / Technical Details'));
  assert.match(primary, /Current Mission[\s\S]*Mission details unavailable in loaded data/);
  assert.doesNotMatch(primary, /mission_missing/);
  assert.match(missing.slice(missing.indexOf('Advanced / Technical Details')), /Current Mission ID[\s\S]*mission_missing/);
});

test('M/N/O/P/AG. Capabilities and permissions are separate and capability never grants permission', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const html = api.renderWorkerCard(sampleWorker({ capabilities: ['deploy', 'publish'], permissions: { deploy: false } }));
  assert.match(html, /aria-label="Capabilities"[\s\S]*deploy/);
  assert.match(html, /aria-label="Permissions"[\s\S]*deploy[\s\S]*Not authorized/);
  assert.match(html, /push[\s\S]*Not configured/);
  assert.doesNotMatch(html, /publish[\s\S]*Allowed/);
  assert.doesNotMatch(read('src/public/app.js'), /grantPermission|allowDeploy|allowProduction|push_permission\s*=\s*true/);
});

test('Q/R. Brain section only presents trusted configuration fields and legacy gaps render safely', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const configured = api.renderWorkerCard(sampleWorker());
  assert.match(configured, /Brain[\s\S]*Configured[\s\S]*Yes[\s\S]*LLM[\s\S]*ONLINE[\s\S]*Brain Run active/);
  assert.doesNotMatch(configured, /Create Brain Profile|Persistent Brain Profile created/);
  state.dashboard.brain_adapters.items = [];
  state.dashboard.executors.items = [];
  const legacy = api.renderWorkerCard(sampleWorker({ brain_binding: null, executor_binding: null, host_binding: null, current_mission_id: '', permissions: {}, capabilities: [] }));
  assert.match(legacy, /Brain configuration[\s\S]*Configured[\s\S]*No/);
  assert.match(legacy, /Executor availability[\s\S]*Configured[\s\S]*No/);
  assert.match(legacy, /Host environment[\s\S]*Not reported/);
});

test('S/T/U/V. Executors view exposes Executor identity/current work separately from Host metadata', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const executor = state.dashboard.executors.items[0];
  const html = api.renderExecutorCard(executor);
  assert.match(html, /aria-label="Executor"[\s\S]*Codex Executor[\s\S]*CODEX[\s\S]*Run frontend tests/);
  assert.match(html, /aria-label="Host"[\s\S]*Shadow[\s\S]*Windows local[\s\S]*READY[\s\S]*VALID/);
  assert.ok(html.indexOf('Codex Executor') < html.indexOf('Shadow'));
  const primary = html.slice(0, html.indexOf('Advanced / Technical Details'));
  assert.doesNotMatch(primary, /run_active/);
  assert.match(html.slice(html.indexOf('Advanced / Technical Details')), /Current Run ID[\s\S]*run_active/);
  const fallback = api.renderExecutorCard({ id: 'executor_empty', executor_type: 'CODEX', health_state: 'ONLINE' });
  assert.match(fallback, /Host not reported|Not reported/);
});

test('W/X. Scope prefers trusted human names and Advanced retains raw identifiers and binding data', () => {
  const { api, state } = createHarness();
  seedArchitectureState(state);
  const html = api.renderWorkerCard(sampleWorker());
  assert.match(html, /Scope[\s\S]*SCB Workspace[\s\S]*SCB Development/);
  const advanced = html.slice(html.indexOf('Advanced / Technical Details'));
  assert.match(advanced, /Worker ID[\s\S]*worker_w01/);
  assert.match(advanced, /tenant_facundo_group \/ workspace_scb \/ project_scb_development/);
  assert.match(advanced, /Current Mission ID[\s\S]*mission_active/);
  assert.match(advanced, /Brain binding\/profile IDs[\s\S]*brain_binding_w01/);
  assert.match(advanced, /Executor binding\/type\/id[\s\S]*CODEX|Executor binding\/type\/id[\s\S]*executor_codex/);
  assert.match(advanced, /Host binding\/provider\/id[\s\S]*local|Host binding\/provider\/id[\s\S]*host_shadow/);
  assert.match(advanced, /Raw permissions[\s\S]*deploy/);
});

test('Y/Z/AA/AH. Worker/Executor/Host rendering adds no N+1 fetches, polling loops or lifecycle mutation', () => {
  const app = read('src/public/app.js');
  assert.doesNotMatch(app, /\/api\/missions\/\$\{[^}]+worker|forEach\([^)]*api\('\/api\/missions/);
  assert.doesNotMatch(app, /\/api\/tasks\/\$\{|\/api\/runs\/\$\{|\/api\/hosts\/\$\{/);
  assert.equal((app.match(/setInterval\(loadAll, 5000\)/g) || []).length, 1);
  assert.doesNotMatch(app, /advanceRoadmap|startNextMilestone|recovery.*state\s*=|autopilot.*state\s*=/i);
  const { intervalCalls } = createHarness();
  assert.equal(intervalCalls.length, 1);
});

test('AB/AC/AD/AE/AF. CSS and overview preserve responsive, accessible, generic separation', () => {
  const css = read('src/public/styles.css');
  const app = read('src/public/app.js');
  assert.match(css, /@media \(max-width: 840px\)[\s\S]*architecture-grid \{ grid-template-columns:1fr; \}/);
  assert.match(css, /compact-tags[\s\S]*flex-wrap:wrap/);
  assert.match(css, /permission-list[\s\S]*flex-wrap:wrap/);
  assert.match(css, /focus-visible/);
  assert.match(app, /W01 Worker/);
  assert.match(app, /W01 Brain/);
  assert.match(app, /W01 Executor/);
  const reusableSource = app.slice(app.indexOf('function renderWorkerCard'), app.indexOf('function renderExecutorCard'));
  assert.doesNotMatch(reusableSource, /W01|W02|W03|W04|W05/);
});
