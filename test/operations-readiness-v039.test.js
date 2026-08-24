const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  heartbeatHealth,
  needAttention,
  workerHealth
} = require('../src/services/operations');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('runner exposes heartbeat with runner status and current run', () => {
  const source = read('runner/shadow-runner.js');
  assert.match(source, /runner_status/);
  assert.match(source, /current_run_id/);
  assert.match(source, /v(?:0\.3\.9-alpha\.0|0\.4\.0-alpha\.0|0\.4\.0\.[1234567]|0\.4\.1\.[012]|0\.4\.2\.[012])/);
});

test('executor heartbeat health derives online stale offline', () => {
  const now = Date.parse('2026-08-24T12:00:00Z');
  assert.equal(heartbeatHealth(new Date(now - 44000), now).state, 'ONLINE');
  assert.equal(heartbeatHealth(new Date(now - 46000), now).state, 'STALE');
  assert.equal(heartbeatHealth(new Date(now - 121000), now).state, 'OFFLINE');
  assert.equal(heartbeatHealth(null, now).state, 'OFFLINE');
});

test('brain heartbeat is separate from executor heartbeat', () => {
  const source = read('src/routes/brain.routes.js');
  assert.match(source, /brain_adapters/);
  assert.match(source, /brain_adapter_id/);
  assert.match(source, /current_brain_run_id/);
  assert.match(source, /adapter_version/);
});

test('brain adapter process reports operational heartbeat', () => {
  const source = read('brain-adapter/brain-adapter.js');
  assert.match(source, /\/api\/brain\/register/);
  assert.match(source, /\/api\/brain\/heartbeat/);
  assert.match(source, /adapter_status/);
  assert.match(source, /v(?:0\.3\.9-alpha\.0|0\.4\.0-alpha\.0|0\.4\.0\.[1234567]|0\.4\.1\.[012]|0\.4\.2\.[012])/);
});

test('worker health aggregation derives compact status', () => {
  const worker = { id: 'W01', code: 'W01', state: 'IDLE' };
  const brainAdapters = [{ id: 'brain', worker_ids: ['W01'], health_state: 'ONLINE' }];
  const executors = [{ id: 'executor', worker_ids: ['W01'], health_state: 'STALE' }];
  assert.equal(workerHealth(worker, { brainAdapters, executors }).operational_status, 'DEGRADED');
  assert.equal(workerHealth({ ...worker, current_task_id: 'task1' }, { brainAdapters, executors }).operational_status, 'BUSY');
  assert.equal(workerHealth({ ...worker, state: 'BLOCKED' }, { brainAdapters, executors }).operational_status, 'BLOCKED');
});

test('Need Attention includes failed and offline components', () => {
  const items = needAttention({
    missions: [{ id: 'm1', state: 'FAILED', objective: 'Fix app' }],
    tasks: [{ id: 't1', state: 'BLOCKED', title: 'Run tests' }],
    executors: [{ id: 'ex1', name: 'Codex', health_state: 'OFFLINE' }],
    brainAdapters: [{ id: 'brain1', health_state: 'STALE' }],
    results: [{ id: 'r1', run_id: 'run1', output: { git: { error: 'GIT_PUSH_FAILED' } } }]
  });
  assert.ok(items.some((item) => item.entity_type === 'MISSION'));
  assert.ok(items.some((item) => item.entity_type === 'TASK'));
  assert.ok(items.some((item) => item.entity_type === 'EXECUTOR'));
  assert.ok(items.some((item) => item.entity_type === 'BRAIN_ADAPTER'));
  assert.ok(items.some((item) => item.entity_type === 'GIT'));
});

test('frontend contains operational health concepts', () => {
  const source = read('src/public/app.js');
  assert.match(source, /Need Attention|need.?attention|attention/i);
  assert.match(source, /executor|runner/i);
});

test('mission operations expose retry or cancel behavior', () => {
  const files = [
    'src/services/orchestration.js',
    'src/routes/mission.routes.js',
    'src/routes/missions.routes.js',
    'src/public/app.js'
  ].filter((rel) => fs.existsSync(path.join(ROOT, rel)));

  const source = files.map(read).join('\n');
  assert.match(source, /retry/i);
  assert.match(source, /cancel/i);
});

test('retry creates new history without overwriting old runs', () => {
  const source = read('src/services/orchestration.js');
  assert.match(source, /async function retryMission/);
  assert.match(source, /MISSION_RETRY_NOT_ALLOWED/);
  assert.match(source, /retry_of_run_id/);
  assert.match(source, /const runRef = db\.collection\('runs'\)\.doc\(\)/);
});

test('cancel prevents future claim and blocks runner Git', () => {
  const orchestration = read('src/services/orchestration.js');
  const runner = read('runner/shadow-runner.js');
  assert.match(orchestration, /MISSION_CANCELLED/);
  assert.match(orchestration, /cancellation_requested/);
  assert.match(orchestration, /state:\s*'SKIPPED'/);
  assert.match(runner, /cancellationRequested/);
  assert.match(runner, /cancelledBeforeGit/);
  assert.match(runner, /MISSION_CANCELLED/);
});

test('frontend exposes health need attention retry and cancel', () => {
  const source = read('src/public/app.js');
  assert.match(source, /operationsHealth/);
  assert.match(source, /attentionList/);
  assert.match(source, /retry-button/);
  assert.match(source, /cancel-mission-button/);
  assert.match(source, /\/retry/);
  assert.match(source, /\/cancel/);
});

test('index exposes operational version and executors view', () => {
  const source = read('src/public/index.html');
  assert.match(source, /v(?:0\.3\.9-alpha\.0|0\.4\.0-alpha\.0|0\.4\.0\.[1234567]|0\.4\.1\.[012]|0\.4\.2\.[012])/);
  assert.match(source, /id="view-executors"/);
  assert.match(source, /id="executorsList"/);
});
