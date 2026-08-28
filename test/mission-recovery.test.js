const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRecoveryContext, recoveryLabel } = require('../src/services/missionRecovery');

function ctx(overrides = {}) {
  return {
    mission: {
      id: 'm1',
      tenant_id: 't1',
      state: 'BLOCKED',
      autopilot_mode: true,
      roadmap_id: 'r1',
      milestone_id: 'ms1',
      ...overrides.mission
    },
    runs: overrides.runs || [],
    tasks: overrides.tasks || [],
    roadmap: overrides.roadmap || {
      id: 'r1',
      tenant_id: 't1',
      milestones: [{ id: 'ms1', state: 'BLOCKED' }]
    },
    milestone: overrides.milestone || { id: 'ms1', state: 'BLOCKED' }
  };
}

test('BRAIN_RESULT_MISSING is classified as Brain replay', () => {
  const result = classifyRecoveryContext(ctx({
    mission: { blocker_code: 'BRAIN_RESULT_MISSING' },
    runs: [{ id: 'br1', run_type: 'BRAIN_RUN', state: 'FAILED' }]
  }));
  assert.equal(result.recoverable, true);
  assert.equal(result.mode, 'BRAIN_REPLAY');
  assert.equal(result.action_label, 'Replay Brain');
});

test('approved execution snapshot is classified as execution retry', () => {
  const result = classifyRecoveryContext(ctx({
    mission: { approved_execution_snapshot_id: 'snap1' },
    runs: [{ id: 'er1', run_type: 'EXECUTION_RUN', state: 'FAILED' }]
  }));
  assert.equal(result.mode, 'EXECUTION_RETRY');
  assert.equal(result.action_label, 'Retry Execution');
});

test('resolved PROGRAM checkpoint without continuation is resume', () => {
  const checkpoint = {
    checkpoint_id: 'cp1',
    status: 'RESOLVED',
    paused_from_phase: 'PROGRAM',
    continuation_task_id: null
  };
  const result = classifyRecoveryContext(ctx({
    mission: {
      state: 'PLANNING',
      human_action_checkpoint: checkpoint
    },
    milestone: {
      id: 'ms1',
      state: 'RUNNING',
      human_action_checkpoint: checkpoint
    }
  }));
  assert.equal(result.mode, 'HUMAN_ACTION_RESUME');
  assert.equal(result.action_label, 'Resume Mission');
});

test('healthy running Mission has no recovery', () => {
  const result = classifyRecoveryContext(ctx({
    mission: { state: 'RUNNING' },
    runs: [{ id: 'br1', run_type: 'BRAIN_RUN', state: 'RUNNING' }]
  }));
  assert.equal(result.recoverable, false);
  assert.equal(result.mode, 'NO_ACTION');
});

test('labels are explicit', () => {
  assert.equal(recoveryLabel('BRAIN_REPLAY'), 'Replay Brain');
  assert.equal(recoveryLabel('EXECUTION_RETRY'), 'Retry Execution');
  assert.equal(recoveryLabel('HUMAN_ACTION_RESUME'), 'Resume Mission');
});
