const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAllowedGitStatusChanges,
  validateAutopilotHandoff,
  applyExecutorTestVerdict
} = require('../runner/shadow-runner');

const allowedFiles = [
  'runner/shadow-runner.js',
  'test/autopilot-complete-validation.test.js'
];

const requiredTests = [
  'node --test test\\autopilot-complete-validation.test.js'
];

const diagnosticTests = [
  'node --test'
];

function autopilotClaim({ taskSpec = {}, snapshotSpec = taskSpec } = {}) {
  return {
    codex_handoff: {
      task_spec: taskSpec,
      execution_snapshot: {
        execution_spec: snapshotSpec
      },
      execution_constraints: {
        autopilot_phase: 'PROGRAM'
      }
    }
  };
}

function executorReport(report) {
  return `<MRAPI_EXECUTOR_REPORT>${JSON.stringify(report)}</MRAPI_EXECUTOR_REPORT>`;
}

test('Runner file-scope validation preserves Git porcelain paths exactly', () => {
  const statusText = [
    ' M runner/shadow-runner.js',
    ' M src/services/autopilot.js',
    '?? test/autopilot-complete-validation.test.js'
  ].join('\n');

  const result = validateAllowedGitStatusChanges(statusText, [
    ...allowedFiles,
    'src/services/autopilot.js'
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_files, [
    'runner/shadow-runner.js',
    'src/services/autopilot.js',
    'test/autopilot-complete-validation.test.js'
  ]);
  assert.ok(!result.changed_files.includes('unner/shadow-runner.js'));
  assert.ok(!result.changed_files.includes('rc/services/autopilot.js'));
});

test('Runner file-scope validation evaluates rename destination without broadening scope', () => {
  const allowedRename = validateAllowedGitStatusChanges(
    'R  src/old-autopilot.js -> src/services/autopilot.js',
    ['src/services/autopilot.js']
  );
  assert.equal(allowedRename.ok, true);
  assert.deepEqual(allowedRename.changed_files, ['src/services/autopilot.js']);

  const unauthorized = validateAllowedGitStatusChanges(
    ' M package.json',
    allowedFiles
  );
  assert.equal(unauthorized.ok, false);
  assert.deepEqual(unauthorized.unauthorized_files, ['package.json']);
});

test('bounded Autopilot contract keeps allowed files and required tests authoritative', () => {
  assert.ok(allowedFiles.length > 0);
  assert.ok(requiredTests.length > 0);
  assert.notDeepEqual(requiredTests, diagnosticTests);

  const valid = validateAutopilotHandoff(autopilotClaim({
    taskSpec: {
      allowed_files: allowedFiles,
      required_tests: requiredTests,
      diagnostic_tests: diagnosticTests
    }
  }));
  assert.equal(valid.ok, true);
  assert.equal(valid.autopilot, true);
  assert.deepEqual(valid.allowed_files, allowedFiles);
  assert.deepEqual(valid.required_tests, requiredTests);

  assert.throws(
    () => validateAutopilotHandoff(autopilotClaim({
      taskSpec: {
        allowed_files: [],
        required_tests: requiredTests
      }
    })),
    /MRAPI_RUNNER_AUTOPILOT_ALLOWED_FILES_EMPTY/
  );

  assert.throws(
    () => validateAutopilotHandoff(autopilotClaim({
      taskSpec: {
        allowed_files: allowedFiles,
        required_tests: []
      }
    })),
    /MRAPI_RUNNER_AUTOPILOT_REQUIRED_TESTS_EMPTY/
  );
});

test('diagnostic failure stays advisory when required tests pass', () => {
  const result = applyExecutorTestVerdict({
    success: false,
    exitCode: 1,
    stdout: executorReport({
      required_tests_passed: true,
      required_tests: [
        { command: requiredTests[0], passed: true }
      ],
      diagnostic_tests: [
        {
          command: diagnosticTests[0],
          passed: false,
          classification: 'PRE_EXISTING_OR_UNRELATED'
        }
      ],
      diagnostic_only_failure: true
    }),
    stderr: ''
  }, {
    required_tests: requiredTests,
    diagnostic_tests: diagnosticTests
  });

  assert.equal(result.success, true);
  assert.equal(result.required_tests_failed, false);
  assert.equal(result.diagnostic_only_failure, true);
  assert.equal(result.executor_report.diagnostic_tests[0].classification, 'PRE_EXISTING_OR_UNRELATED');
});
