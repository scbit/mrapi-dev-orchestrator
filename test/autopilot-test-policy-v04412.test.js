const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCodexPrompt } = require('../runner/adapters/codex-desktop-handoff');
const { parseExecutorReport, applyExecutorTestVerdict } = require('../runner/shadow-runner');

test('Codex handoff separates required tests from diagnostic tests', () => {
  const prompt = buildCodexPrompt({
    task: { id: 't1', codex_handoff: {
      task_id: 't1', execution_run_id: 'r1', repository_path: 'C:/repo',
      task_spec: {
        instructions: 'Apply exact Brain changes.',
        allowed_files: ['src/a.js'],
        required_tests: ['node --test test/a.test.js'],
        diagnostic_tests: ['node --test']
      }
    } },
    executionRun: { id: 'r1' },
    cfg: { repoPath: 'C:/repo' }
  });
  assert.match(prompt, /REQUIRED TESTS — VERDICT SCOPE/);
  assert.match(prompt, /node --test test\/a\.test\.js/);
  assert.match(prompt, /DIAGNOSTIC TESTS — ADVISORY/);
  assert.match(prompt, /Diagnostic failures are advisory/);
  assert.match(prompt, /MRAPI_EXECUTOR_REPORT/);
});

test('diagnostic failures do not fail executor when required tests passed', () => {
  const stdout = `done\n<MRAPI_EXECUTOR_REPORT>\n${JSON.stringify({
    required_tests_passed: true,
    required_tests: [{ command: 'node --test test/a.test.js', passed: true }],
    diagnostic_tests: [{ command: 'node --test', passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }]
  })}\n</MRAPI_EXECUTOR_REPORT>`;
  const result = applyExecutorTestVerdict({ success: true, exitCode: 0, stdout, stderr: '' });
  assert.equal(result.success, true);
  assert.equal(result.executor_report.required_tests_passed, true);
});

test('required test failure fails executor', () => {
  const stdout = `<MRAPI_EXECUTOR_REPORT>${JSON.stringify({ required_tests_passed: false })}</MRAPI_EXECUTOR_REPORT>`;
  const result = applyExecutorTestVerdict({ success: true, exitCode: 0, stdout, stderr: '' });
  assert.equal(result.success, false);
  assert.equal(result.required_tests_failed, true);
  assert.match(result.stderr, /MRAPI_REQUIRED_TESTS_FAILED/);
});

test('executor report parser safely ignores malformed block', () => {
  assert.equal(parseExecutorReport('<MRAPI_EXECUTOR_REPORT>{bad}</MRAPI_EXECUTOR_REPORT>'), null);
});
