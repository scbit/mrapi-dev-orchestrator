const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRuntimeContinuityVerification,
  testsPassed,
  executionSucceeded,
  resolvedTrustedCheckpoint
} = require('../src/services/trustedVerificationRecovery');

test('recognizes redundant runtime continuity Human Action', () => {
  assert.equal(isRuntimeContinuityVerification({
    checkpoint_type: 'AUTOPILOT_VERIFICATION',
    requirement_type: 'HUMAN_ACTION',
    validation_method: 'manual_runtime_continuity_validation'
  }), true);

  assert.equal(isRuntimeContinuityVerification({
    checkpoint_type: 'PROGRAM_PREFLIGHT',
    requirement_type: 'MANUAL_HUMAN',
    validation_method: 'git_worktree_clean'
  }), false);
});

test('required test evidence must actually pass', () => {
  assert.equal(testsPassed({
    executor_report: {
      required_tests_passed: true,
      required_tests: [{ command: 'node --test', passed: true }]
    }
  }), true);

  assert.equal(testsPassed({
    required_tests: [{ command: 'node --test', passed: false }]
  }), false);
});

test('successful execution evidence is fail-closed', () => {
  const run = { state: 'COMPLETED' };
  assert.equal(executionSucceeded(run, {
    executor_report: {
      success: true,
      process_exit_code: 0,
      process_exited_cleanly: true,
      executor_report: {
        required_tests_passed: true,
        diagnostic_only_failure: false
      }
    }
  }), true);

  assert.equal(executionSucceeded(run, {
    executor_report: {
      success: true,
      process_exit_code: 1,
      executor_report: { required_tests_passed: true }
    }
  }), false);
});

test('automatic resolution remains auditable and is not human confirmation', () => {
  const out = resolvedTrustedCheckpoint(
    {
      checkpoint_id: 'cp_verify',
      status: 'WAITING_FOR_HUMAN',
      waiting_status: 'WAITING_FOR_HUMAN',
      human_action_required: true,
      validation_method: 'manual_runtime_continuity_validation'
    },
    {
      host_validation_id: 'hv1',
      task_id: 'task1',
      execution_run_id: 'exec1',
      verification_brain_run_id: 'verify1'
    }
  );

  assert.equal(out.status, 'RESOLVED');
  assert.equal(out.human_action_required, false);
  assert.equal(out.resolved_by, 'TRUSTED_RUNTIME_EVIDENCE');
  assert.equal(out.validation_result.automatic, true);
  assert.equal(out.validation_result.execution_run_id, 'exec1');
});
