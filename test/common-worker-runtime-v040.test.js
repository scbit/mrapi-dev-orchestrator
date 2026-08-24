const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WORKER_PROFILES, WORKERS } = require('../src/services/bootstrapData');
const { WORKER_BRAIN_PROFILES } = require('../brain-adapter/lib/worker-profiles');
const { chromeProfileNames } = require('../brain-adapter/lib/config');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('all five workers remain defined', () => {
  const src = read('src/services/bootstrapData.js');
  for (const id of ['W01','W02','W03','W04','W05']) assert.match(src, new RegExp(id));
});

test('brain adapter remains the planner and codex remains executor', () => {
  const brain = read('brain-adapter/brain-adapter.js');
  const runner = read('runner/shadow-runner.js');
  assert.match(brain, /brain|ChatGPT/i);
  assert.match(runner, /Codex|CODEX/i);
});

test('runtime supports worker-specific chat bindings', () => {
  const cfg = read('brain-adapter/lib/config.js');
  for (const id of ['W01','W02','W03','W04','W05']) assert.match(cfg, new RegExp(`MRAPI_${id}_CHAT_URL|${id}`, 'i'));
  assert.match(cfg, /chatUrlForWorker/);
  assert.match(cfg, /BRAIN_CHAT_NOT_CONFIGURED_FOR_/);
});

test('five independent Chrome profiles are defined', () => {
  assert.deepEqual(chromeProfileNames, {
    W01: 'chrome-w01',
    W02: 'chrome-w02',
    W03: 'chrome-w03',
    W04: 'chrome-w04',
    W05: 'chrome-w05'
  });
});

test('brain profiles exist for W01-W05', () => {
  for (const id of ['W01', 'W02', 'W03', 'W04', 'W05']) {
    assert.equal(WORKER_BRAIN_PROFILES[id].worker_id, id);
    assert.equal(WORKER_BRAIN_PROFILES[id].executor_available, true);
    assert.ok(WORKER_BRAIN_PROFILES[id].output_contract);
  }
});

test('every worker has brain executor and host bindings', () => {
  assert.equal(WORKERS.length, 5);
  for (const worker of WORKERS) {
    assert.equal(worker.brain_binding.provider, 'ChatGPT Web');
    assert.equal(worker.executor_binding.provider, 'Codex');
    assert.equal(worker.host_binding.provider, 'Shadow');
  }
});

test('W01 Git permissions remain W01-only', () => {
  for (const profile of WORKER_PROFILES) {
    const isW01 = profile.worker_code === 'W01';
    assert.equal(profile.permissions.allow_git_commit === true, isW01);
    assert.equal(profile.permissions.allow_git_push === true, isW01);
  }
});

test('W04 and W05 are execution-capable but do not publish by default', () => {
  const w04 = WORKER_PROFILES.find((profile) => profile.worker_code === 'W04');
  const w05 = WORKER_PROFILES.find((profile) => profile.worker_code === 'W05');
  for (const profile of [w04, w05]) {
    assert.equal(profile.default_executor.provider, 'Codex');
    assert.equal(profile.execution_metadata.browser_required, true);
    assert.equal(profile.execution_metadata.evidence_required, true);
    assert.equal(profile.permissions.allow_publish, false);
  }
});

test('Brain-only missions can complete without fake Task', () => {
  const source = read('src/services/orchestration.js');
  assert.match(source, /requires_execution === false/);
  assert.match(source, /Brain-only result completed/);
  assert.match(source, /task_id:\s*null/);
});

test('execution missions still create Task for Codex', () => {
  const source = read('src/services/orchestration.js');
  assert.match(source, /state:\s*'QUEUED'/);
  assert.match(source, /phase:\s*'EXECUTION_PENDING'/);
  assert.match(source, /brain_completed_at/);
});

test('Codex receives Brain task spec and executor-only contract', () => {
  const source = read('src/services/codexHandoff.js');
  assert.match(source, /task_spec/);
  assert.match(source, /You are the Executor, not the Brain/);
  assert.match(source, /Do not redesign strategy/);
  assert.match(source, /Do not invent business objectives/);
  assert.match(source, /Do not change Worker role/);
});

test('startup scripts exist for each worker without secrets', () => {
  for (const id of ['w01', 'w02', 'w03', 'w04', 'w05']) {
    const script = read(`brain-adapter/start-${id}.cmd`);
    assert.match(script, new RegExp(`MRAPI_WORKER_IDS=${id.toUpperCase()}`));
    assert.match(script, new RegExp(`MRAPI_${id.toUpperCase()}_CHAT_URL`));
    assert.doesNotMatch(script, /https:\/\/chatgpt\.com/);
  }
});

test('UI workers view exposes runtime readiness without chat URLs', () => {
  const source = read('src/public/app.js');
  assert.match(source, /Brain configured/);
  assert.match(source, /Executor configured/);
  assert.match(source, /Executor health/);
  assert.match(source, /Autonomy/);
  assert.doesNotMatch(source, /brainChatUrlW0/);
});

test('mission worker selector uses all tenant workers without runtime filtering', () => {
  const source = read('src/public/app.js');
  const start = source.indexOf('function refreshWorkerOptions()');
  const end = source.indexOf('function openMissionModal()', start);
  const body = source.slice(start, end);
  assert.match(body, /state\.workers/);
  assert.match(body, /worker\.code/);
  assert.doesNotMatch(body, /worker\.workspace_id === workspaceId/);
  assert.doesNotMatch(body, /worker\.project_id === projectId/);
  assert.doesNotMatch(body, /brain_health|executor_health|health_state/);
});
