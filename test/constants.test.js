const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORKER_STATES,
  MISSION_STATES,
  TASK_STATES,
  SYSTEM_STATES
} = require('../src/constants/states');
const { RUN_TYPES } = require('../src/constants/runTypes');
const { EVIDENCE_TYPES } = require('../src/constants/evidenceTypes');

test('required state enums are present', () => {
  assert.deepEqual(WORKER_STATES, ['IDLE','BUSY','WAITING','BLOCKED','DRAINING','STOPPED','OFFLINE']);
  assert.ok(MISSION_STATES.includes('READY'));
  assert.ok(MISSION_STATES.includes('RUNNING'));
  assert.ok(TASK_STATES.includes('TESTING'));
  assert.deepEqual(SYSTEM_STATES, ['RUNNING','DRAINING','STOPPED']);
});

test('run and evidence types preserve history model', () => {
  assert.ok(RUN_TYPES.includes('BRAIN_RUN'));
  assert.ok(RUN_TYPES.includes('EXECUTION_RUN'));
  assert.ok(RUN_TYPES.includes('DEPLOY_RUN'));
  assert.ok(EVIDENCE_TYPES.includes('SCREENSHOT'));
  assert.ok(EVIDENCE_TYPES.includes('TEST_RESULT'));
  assert.ok(EVIDENCE_TYPES.includes('DEPLOY_RESULT'));
});
