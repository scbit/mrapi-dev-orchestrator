const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runnerPath = path.join(repoRoot, 'runner', 'shadow-runner.js');
const runner = fs.readFileSync(runnerPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runner', 'package.json'), 'utf8'));

test('runner version is v0.4.4.17', () => {
  assert.equal(pkg.version, '0.4.4-17');
  assert.match(runner, /runner_version:\s*'v0\.4\.4\.17'/);
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

test('runner exposes Autopilot pre-spawn guard and diagnostic-only verdict policy', () => {
  const { validateAutopilotHandoff, applyExecutorTestVerdict } = require('../runner/shadow-runner');
  assert.throws(() => validateAutopilotHandoff({
    codex_handoff: {
      execution_constraints: { autopilot_phase: 'PROGRAM' },
      task_spec: { instructions: 'x', required_tests: ['node --test test\\x.test.js'] }
    }
  }), /ALLOWED_FILES_REQUIRED/);

  const stdout = `<MRAPI_EXECUTOR_REPORT>${JSON.stringify({
    required_tests_passed: true,
    required_tests: [{ command: 'node --test test\\x.test.js', passed: true }],
    diagnostic_tests: [{ command: 'node --test', passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }],
    diagnostic_only_failure: true
  })}</MRAPI_EXECUTOR_REPORT>`;
  const verdict = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout, stderr: '' }, {
    required_tests: ['node --test test\\x.test.js'],
    diagnostic_tests: ['node --test']
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.executor_report.process_exit_code, 1);
});
