const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL_MISSION_STATES,
  linkedMissionBlocksFreshStart
} = require('../src/services/autopilot');

test('terminal linked Missions do not block a fresh PENDING milestone attempt', () => {
  for (const state of ['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    assert.equal(
      linkedMissionBlocksFreshStart({ tenant_id: 'tenant_a', state }, 'tenant_a'),
      false,
      state
    );
  }
});

test('active linked Missions still block duplicate milestone execution', () => {
  for (const state of ['DRAFT', 'READY', 'PLANNING', 'RUNNING']) {
    assert.equal(
      linkedMissionBlocksFreshStart({ tenant_id: 'tenant_a', state }, 'tenant_a'),
      true,
      state
    );
  }
});

test('missing stale linkage can be replaced but cross-tenant linkage remains blocked', () => {
  assert.equal(linkedMissionBlocksFreshStart(null, 'tenant_a'), false);
  assert.equal(
    linkedMissionBlocksFreshStart({ tenant_id: 'tenant_b', state: 'CANCELLED' }, 'tenant_a'),
    true
  );
  assert.deepEqual(
    [...TERMINAL_MISSION_STATES].sort(),
    ['BLOCKED', 'CANCELLED', 'COMPLETED', 'FAILED'].sort()
  );
});
