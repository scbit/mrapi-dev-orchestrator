const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('v0.3.1 Runner uses manual Codex app handoff', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );
  assert.match(source, /WAITING_FOR_CODEX/);
  assert.match(source, /CODEX_APP_MANUAL/);
  assert.match(source, /execution_run_id/);
  assert.doesNotMatch(source, /brain-complete/);
  assert.doesNotMatch(source, /runChatGPTWeb/);
  assert.doesNotMatch(source, /runCodexCommand/);
});

test('v0.3.1 stores manual handoff and can record final execution run', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );
  assert.match(source, /phase: 'WAITING_FOR_CODEX'/);
  assert.match(source, /completeManualCodexHandoff/);
  assert.match(source, /executor_mode: 'CODEX_APP_MANUAL'/);
});
