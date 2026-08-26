const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAutopilotDecision } = require('../src/services/autopilot');
const { buildCodexHandoff } = require('../src/services/codexHandoff');

test('escaped verification MRAPI_AUTOPILOT parses after ChatGPT transport escaping', () => {
  const output = String.raw`\<MRAPI\_AUTOPILOT>
{
  "action": "COMPLETE",
  "reason": "required tests passed",
  "execution\_spec": null
}
\</MRAPI\_AUTOPILOT>`;
  const parsed = parseAutopilotDecision(output);
  assert.equal(parsed.action, 'COMPLETE');
  assert.equal(parsed.reason, 'required tests passed');
});

test('escaped RETRY preserves allowed_files and required_tests including Windows-style test command', () => {
  const output = String.raw`\<MRAPI\_AUTOPILOT>
{
  "action": "RETRY",
  "reason": "bounded correction",
  "execution\_spec": {
    "instructions": "Apply exact correction",
    "allowed\_files": ["src/services/autopilot.js"],
    "required\_tests": ["node --test test\autopilot-v8-loop.test.js"],
    "diagnostic\_tests": ["node --test"]
  }
}
\</MRAPI\_AUTOPILOT>`;
  const parsed = parseAutopilotDecision(output);
  assert.equal(parsed.action, 'RETRY');
  assert.deepEqual(parsed.execution_spec.allowed_files, ['src/services/autopilot.js']);
  assert.deepEqual(parsed.execution_spec.required_tests, ['node --test test\\autopilot-v8-loop.test.js']);
  assert.deepEqual(parsed.execution_spec.diagnostic_tests, ['node --test']);
});

test('Codex handoff preserves required and diagnostic tests from Brain task_spec', () => {
  const handoff = buildCodexHandoff({
    tenantId: 'tenant_a',
    task: {
      id: 'task_1',
      tenant_id: 'tenant_a',
      mission_id: 'mission_1',
      worker_id: 'W01',
      workspace_id: 'workspace_scb',
      project_id: 'project_scb_development',
      state: 'QUEUED',
      brain_run_id: 'brain_1',
      brain_output: {
        task_spec: {
          objective: 'Autopilot V8',
          instructions: 'Apply exact changes',
          allowed_files: ['src/services/autopilot.js'],
          required_tests: ['node --test test/autopilot-v8-loop.test.js'],
          diagnostic_tests: ['node --test']
        }
      }
    },
    mission: {
      id: 'mission_1',
      tenant_id: 'tenant_a',
      workspace_id: 'workspace_scb',
      project_id: 'project_scb_development',
      autopilot_mode: true,
      autopilot_phase: 'PROGRAM'
    },
    brainRun: {
      id: 'brain_1',
      tenant_id: 'tenant_a',
      mission_id: 'mission_1',
      run_type: 'BRAIN_RUN',
      state: 'COMPLETED',
      autopilot_phase: 'PROGRAM'
    },
    executor: { id: 'exec_1', host_name: 'Shadow' },
    executionRunId: 'run_1',
    repositoryPath: 'C:/repo'
  });
  assert.deepEqual(handoff.task_spec.allowed_files, ['src/services/autopilot.js']);
  assert.deepEqual(handoff.task_spec.required_tests, ['node --test test/autopilot-v8-loop.test.js']);
  assert.deepEqual(handoff.task_spec.diagnostic_tests, ['node --test']);
});
