const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runnerPath = path.join(repoRoot, 'runner', 'shadow-runner.js');
const runner = fs.readFileSync(runnerPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runner', 'package.json'), 'utf8'));

test('runner version is v0.4.0.3', () => {
  assert.equal(pkg.version, '0.4.0-3');
  assert.match(runner, /runner_version:\s*'v0\.4\.0\.3'/);
});

test('runner uses automatic Codex CLI adapter', () => {
  assert.match(runner, /runCodexCommand/);
  assert.match(runner, /executor_type:\s*'CODEX_CLI_AUTO'/);
  assert.match(runner, /CODEX_EXEC:AUTO/);
});

test('runner builds prompt from validated handoff', () => {
  assert.match(runner, /claim\.codex_handoff/);
  assert.match(runner, /buildCodexPrompt/);
});

test('runner completes the existing execution run', () => {
  assert.match(runner, /\/api\/runner\/runs\/\$\{encodeURIComponent\(runId\)\}\/complete/);
  assert.doesNotMatch(runner, /manual-codex-complete/);
});

test('runner persists execution log evidence', () => {
  assert.match(runner, /type:\s*'LOG'/);
  assert.match(runner, /content_base64/);
});

test('missing CLI waits for setup instead of pretending success', () => {
  assert.match(runner, /CODEX_COMMAND_NOT_FOUND/);
  assert.match(runner, /CODEX_CLI_SETUP_REQUIRED/);
});

test('runner no longer performs abandoned Brain recovery', () => {
  assert.doesNotMatch(runner, /recover-abandoned/);
});
