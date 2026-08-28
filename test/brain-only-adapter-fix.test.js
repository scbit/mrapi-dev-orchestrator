const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasValidAutopilotProgramControl,
  hasValidBrainOnlyProgramControl,
  hasValidExecutorProgramControl
} = require('../brain-adapter/lib/autopilot-contract');

const { trustedExecutorRequired } = require('../brain-adapter/adapters/chatgpt-web');

test('trusted Brain-only response is valid with final MRAPI_RESULT', () => {
  const text = `<MRAPI_CONTROL>
{"requires_execution":false,"execution_type":"BRAIN_ONLY","task_spec":{}}
</MRAPI_CONTROL>
<MRAPI_RESULT>
Brain-only milestone completed successfully.
</MRAPI_RESULT>`;

  assert.equal(hasValidBrainOnlyProgramControl(text), true);
  assert.equal(
    hasValidAutopilotProgramControl(text, { executorRequired: false }),
    true
  );
  assert.equal(hasValidExecutorProgramControl(text), false);
});

test('Brain-only response without final result is invalid', () => {
  const text = `<MRAPI_CONTROL>
{"requires_execution":false,"execution_type":"BRAIN_ONLY","task_spec":{}}
</MRAPI_CONTROL>`;
  assert.equal(
    hasValidAutopilotProgramControl(text, { executorRequired: false }),
    false
  );
});

test('executor repair contract is not accepted for trusted Brain-only milestone', () => {
  const text = `<MRAPI_CONTROL>
{"requires_execution":true,"execution_type":"EXECUTOR","task_spec":{"instructions":"x","allowed_files":["a.js"],"required_tests":["node --test"]}}
</MRAPI_CONTROL>`;
  assert.equal(
    hasValidAutopilotProgramControl(text, { executorRequired: false }),
    false
  );
  assert.equal(
    hasValidAutopilotProgramControl(text, { executorRequired: true }),
    true
  );
});

test('adapter reads executor_required only from trusted Brain context milestone', () => {
  assert.equal(trustedExecutorRequired({
    brain_context: { current_milestone: { executor_required: false } }
  }), false);

  assert.equal(trustedExecutorRequired({
    brain_context: { current_milestone: { executor_required: true } }
  }), true);

  assert.equal(trustedExecutorRequired({}), null);
});
