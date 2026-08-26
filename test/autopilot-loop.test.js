const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAutopilotDecision } = require('../src/services/autopilot');
const { buildCodexHandoff } = require('../src/services/codexHandoff');
const { validateAutopilotHandoff } = require('../runner/shadow-runner');

test('Autopilot loop parses COMPLETE and bounded RETRY decisions', () => {
  assert.equal(parseAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"ok"}</MRAPI_AUTOPILOT>').action, 'COMPLETE');
  const retry = parseAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"fix","allowed_files":["src/services/autopilot.js"],"required_tests":["node --test test\\\\autopilot-loop.test.js"]}}</MRAPI_AUTOPILOT>');
  assert.equal(retry.action, 'RETRY');
  assert.deepEqual(retry.execution_spec.allowed_files, ['src/services/autopilot.js']);
  assert.deepEqual(retry.execution_spec.required_tests, ['node --test test\\autopilot-loop.test.js']);
});

test('Autopilot handoff remains bounded for Runner execution', () => {
  const handoff = buildCodexHandoff({
    tenantId: 'tenant_a',
    task: {
      id: 'task_1',
      tenant_id: 'tenant_a',
      mission_id: 'mission_1',
      worker_id: 'W01',
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      state: 'QUEUED',
      autopilot_phase: 'PROGRAM',
      brain_run_id: 'brain_1',
      brain_output: {
        task_spec: {
          objective: 'Loop',
          instructions: 'Apply exact loop change',
          allowed_files: ['src/services/autopilot.js'],
          required_tests: ['node --test test\\autopilot-loop.test.js'],
          diagnostic_tests: ['node --test']
        }
      }
    },
    mission: { id: 'mission_1', tenant_id: 'tenant_a', workspace_id: 'workspace_1', project_id: 'project_1', autopilot_mode: true, autopilot_phase: 'PROGRAM' },
    brainRun: { id: 'brain_1', tenant_id: 'tenant_a', mission_id: 'mission_1', run_type: 'BRAIN_RUN', state: 'COMPLETED' },
    executor: { id: 'exec_1' },
    executionRunId: 'run_1',
    repositoryPath: 'C:/repo'
  });
  assert.deepEqual(handoff.task_spec.allowed_files, ['src/services/autopilot.js']);
  assert.deepEqual(handoff.task_spec.required_tests, ['node --test test\\autopilot-loop.test.js']);
  assert.equal(validateAutopilotHandoff({ codex_handoff: handoff }).autopilot, true);
});
