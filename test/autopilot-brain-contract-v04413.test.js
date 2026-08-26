const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasValidAutopilotProgramControl,
  hasValidAutopilotDecision
} = require('../brain-adapter/lib/autopilot-contract');

test('PROGRAM contract requires non-empty allowed_files', () => {
  const valid = '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"apply exact change","allowed_files":["src/a.js"]}}</MRAPI_CONTROL>';
  const missing = '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"apply exact change"}}</MRAPI_CONTROL>';
  assert.equal(hasValidAutopilotProgramControl(valid), true);
  assert.equal(hasValidAutopilotProgramControl(missing), false);
});

test('verification contract still accepts COMPLETE RETRY BLOCKED', () => {
  assert.equal(hasValidAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"ok","execution_spec":null}</MRAPI_AUTOPILOT>'), true);
  assert.equal(hasValidAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"NOPE"}</MRAPI_AUTOPILOT>'), false);
});
