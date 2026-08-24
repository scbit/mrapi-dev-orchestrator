const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('current Runner keeps Brain separate and uses automatic Codex CLI execution', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );

  assert.match(source, /CODEX_CLI_AUTO/);
  assert.match(source, /runCodexCommand/);
  assert.match(source, /executionRun\.id/);
  assert.doesNotMatch(source, /brain-complete/);
  assert.doesNotMatch(source, /runChatGPTWeb/);
  assert.doesNotMatch(source, /CODEX_APP_MANUAL/);
});

test('legacy manual completion remains server-side for backward compatibility', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  assert.match(source, /completeManualCodexHandoff/);
  assert.match(source, /phase: 'WAITING_FOR_CODEX'/);
  assert.match(source, /executor_mode: 'CODEX_APP_MANUAL'/);
});
