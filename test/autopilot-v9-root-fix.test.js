const test = require('node:test');
const assert = require('node:assert/strict');
const { hasValidAutopilotProgramControl } = require('../brain-adapter/lib/autopilot-contract');
const { buildCodexHandoff } = require('../src/services/codexHandoff');
const { applyExecutorTestVerdict } = require('../runner/shadow-runner');

test('PROGRAM contract is invalid without required_tests even when allowed_files exists', () => {
  const text = `<MRAPI_CONTROL>${JSON.stringify({
    requires_execution: true,
    execution_type: 'EXECUTOR',
    task_spec: {
      instructions: 'Apply exact changes',
      allowed_files: ['src/services/autopilot.js'],
      required_tests: []
    }
  })}</MRAPI_CONTROL>`;
  assert.equal(hasValidAutopilotProgramControl(text), false);
});

test('PROGRAM contract is valid only with non-empty allowed_files and required_tests', () => {
  const text = `<MRAPI_CONTROL>${JSON.stringify({
    requires_execution: true,
    execution_type: 'EXECUTOR',
    task_spec: {
      instructions: 'Apply exact changes',
      allowed_files: ['src/services/autopilot.js'],
      required_tests: ['node --test test/autopilot-loop.test.js']
    }
  })}</MRAPI_CONTROL>`;
  assert.equal(hasValidAutopilotProgramControl(text), true);
});

test('Autopilot Codex handoff rejects missing required_tests before Shadow execution', () => {
  assert.throws(() => buildCodexHandoff({
    tenantId: 'tenant_a',
    task: {
      id: 'task_1', tenant_id: 'tenant_a', mission_id: 'mission_1', worker_id: 'W01',
      workspace_id: 'workspace_scb', project_id: 'project_scb_development', state: 'QUEUED',
      brain_run_id: 'brain_1',
      brain_output: { task_spec: { objective: 'V9', instructions: 'Do it', allowed_files: ['src/a.js'], required_tests: [] } }
    },
    mission: { id: 'mission_1', tenant_id: 'tenant_a', workspace_id: 'workspace_scb', project_id: 'project_scb_development', autopilot_mode: true, autopilot_phase: 'PROGRAM' },
    brainRun: { id: 'brain_1', tenant_id: 'tenant_a', mission_id: 'mission_1', run_type: 'BRAIN_RUN', state: 'COMPLETED' },
    executor: { id: 'exec_1' }, executionRunId: 'run_1', repositoryPath: 'C:/repo'
  }), /CODEX_HANDOFF_REQUIRED_TESTS_REQUIRED/);
});

test('diagnostic-only nonzero Codex exit is accepted when explicit required tests all passed', () => {
  const stdout = `<MRAPI_EXECUTOR_REPORT>${JSON.stringify({
    required_tests_passed: true,
    required_tests: [
      { command: 'node --test test/a.test.js', passed: true },
      { command: 'node --test test/b.test.js', passed: true }
    ],
    diagnostic_tests: [{ command: 'node --test', passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }]
  })}</MRAPI_EXECUTOR_REPORT>`;
  const result = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout, stderr: '' });
  assert.equal(result.success, true);
  assert.equal(result.diagnostic_only_failure, true);
});

test('empty required test report cannot turn a nonzero Codex exit into success', () => {
  const stdout = `<MRAPI_EXECUTOR_REPORT>${JSON.stringify({ required_tests_passed: true, required_tests: [] })}</MRAPI_EXECUTOR_REPORT>`;
  const result = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout, stderr: '' });
  assert.equal(result.success, false);
});
