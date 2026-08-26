const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasValidAutopilotProgramControl,
  hasValidAutopilotDecision
} = require('../brain-adapter/lib/autopilot-contract');

test('PROGRAM contract requires non-empty allowed_files and required_tests', () => {
  const valid = '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"apply exact change","allowed_files":["src/a.js"],"required_tests":["node --test test/a.test.js"]}}</MRAPI_CONTROL>';
  const missingAllowed = '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"apply exact change","required_tests":["node --test test/a.test.js"]}}</MRAPI_CONTROL>';
  const missingTests = '<MRAPI_CONTROL>{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"apply exact change","allowed_files":["src/a.js"]}}</MRAPI_CONTROL>';
  assert.equal(hasValidAutopilotProgramControl(valid), true);
  assert.equal(hasValidAutopilotProgramControl(missingAllowed), false);
  assert.equal(hasValidAutopilotProgramControl(missingTests), false);
});

test('verification contract still accepts COMPLETE RETRY BLOCKED', () => {
  assert.equal(hasValidAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"ok","execution_spec":null}</MRAPI_AUTOPILOT>'), true);
  assert.equal(hasValidAutopilotDecision('<MRAPI_AUTOPILOT>{"action":"NOPE"}</MRAPI_AUTOPILOT>'), false);
});

test('PROGRAM contract accepts ChatGPT markdown-escaped tags and keys', () => {
  const escaped = String.raw`\<MRAPI\_CONTROL>
{
  "requires\_execution": true,
  "execution\_type": "EXECUTOR",
  "task\_spec": {
    "allowed\_files": ["src/services/autopilot.js"],
    "required\_tests": ["node --test test\autopilot-v6-loop.test.js"],
    "instructions": "apply exact change"
  }
}
\</MRAPI\_CONTROL>`;
  assert.equal(hasValidAutopilotProgramControl(escaped), true);
});


test('PROGRAM contract preserves valid doubled backslashes in Windows paths while repairing invalid JSON path escapes', () => {
  const captured = String.raw`\<MRAPI\_CONTROL>
{
  "requires\_execution": true,
  "execution\_type": "EXECUTOR",
  "task\_spec": {
    "allowed\_files": ["src/services/autopilot.js"],
    "required\_tests": ["node --test test\autopilot-v7-loop.test.js"],
    "instructions": "CONTEXT\\nRepository: C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-dev-orchestrator\\nTESTS\\nnode --test test\autopilot-v7-loop.test.js"
  }
}
\</MRAPI\_CONTROL>`;
  assert.equal(hasValidAutopilotProgramControl(captured), true);
});
