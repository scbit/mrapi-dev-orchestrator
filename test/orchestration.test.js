const test = require('node:test');
const assert = require('node:assert/strict');
const { RUN_TYPES } = require('../src/constants/runTypes');
const { EVIDENCE_TYPES } = require('../src/constants/evidenceTypes');

test('v0.2 includes execution run and evidence primitives', () => {
  assert.ok(RUN_TYPES.includes('EXECUTION_RUN'));
  assert.ok(EVIDENCE_TYPES.includes('LOG'));
  assert.ok(EVIDENCE_TYPES.includes('SCREENSHOT'));
  assert.ok(EVIDENCE_TYPES.includes('TEST_RESULT'));
});

test('runner security env is represented in example config', () => {
  const fs = require('fs');
  const env = fs.readFileSync(require('path').join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /RUNNER_SHARED_SECRET/);
  assert.match(env, /MRAPI_RUNNER_SECRET/);
});
