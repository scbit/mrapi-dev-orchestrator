const fs = require('fs');
const path = require('path');

const root = process.cwd();
const autopilotPath = path.join(root, 'src', 'services', 'autopilot.js');
const testPath = path.join(root, 'test', 'roadmap-terminal-mission-restart.test.js');

if (!fs.existsSync(autopilotPath)) {
  throw new Error('Run this from the mrapi-dev-orchestrator repository root.');
}

let source = fs.readFileSync(autopilotPath, 'utf8');

const helperAnchor = `function milestoneWithState(roadmap, milestoneId, state, extra = {}) {`;
const helperInsert = `const TERMINAL_MISSION_STATES = new Set(['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']);

function linkedMissionBlocksFreshStart(mission, tenantId) {
  if (!mission) return false;
  if (mission.tenant_id !== tenantId) return true;
  return !TERMINAL_MISSION_STATES.has(String(mission.state || '').toUpperCase());
}

`;

if (!source.includes('function linkedMissionBlocksFreshStart(')) {
  if (!source.includes(helperAnchor)) {
    throw new Error('PATCH_ABORTED: autopilot.js helper anchor not found. No files changed.');
  }
  source = source.replace(helperAnchor, helperInsert + helperAnchor);
}

const oldGuard = `    if (milestone.mission_id) {
      const error = new Error('MILESTONE_ALREADY_HAS_MISSION'); error.status = 409; throw error;
    }
`;

const newGuard = `    if (milestone.mission_id) {
      const linkedMissionRef = db.collection('missions').doc(milestone.mission_id);
      const linkedMissionSnap = await tx.get(linkedMissionRef);
      const linkedMission = linkedMissionSnap.exists
        ? { id: linkedMissionSnap.id, ...linkedMissionSnap.data() }
        : null;

      // A PENDING milestone may be started again after its previous Mission reached
      // a terminal state. Keep historical Mission/Runs for audit; only active/non-terminal
      // linkage blocks a fresh Mission. Missing linked Missions are treated as stale linkage.
      if (linkedMissionBlocksFreshStart(linkedMission, tenantId)) {
        const error = new Error('MILESTONE_ALREADY_HAS_MISSION'); error.status = 409; throw error;
      }
    }
`;

if (!source.includes(newGuard)) {
  if (!source.includes(oldGuard)) {
    throw new Error('PATCH_ABORTED: exact MILESTONE_ALREADY_HAS_MISSION guard not found. No files changed.');
  }
  source = source.replace(oldGuard, newGuard);
}

const oldExports = `module.exports = {
  AUTOPILOT_ACTIONS,
  parseAutopilotDecision,
  startNextRoadmapMilestone,
  queueVerificationBrainRun,
  completeVerificationBrainRun
};`;

const newExports = `module.exports = {
  AUTOPILOT_ACTIONS,
  TERMINAL_MISSION_STATES,
  linkedMissionBlocksFreshStart,
  parseAutopilotDecision,
  startNextRoadmapMilestone,
  queueVerificationBrainRun,
  completeVerificationBrainRun
};`;

if (!source.includes('linkedMissionBlocksFreshStart,\n  parseAutopilotDecision')) {
  if (!source.includes(oldExports)) {
    throw new Error('PATCH_ABORTED: module.exports anchor not found. No files changed.');
  }
  source = source.replace(oldExports, newExports);
}

const testSource = `const test = require('node:test');
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
`;

fs.writeFileSync(autopilotPath, source, 'utf8');
fs.writeFileSync(testPath, testSource, 'utf8');

console.log('PATCH OK');
console.log('Changed: src/services/autopilot.js');
console.log('Added:   test/roadmap-terminal-mission-restart.test.js');
console.log('Next run: node --test test\\\\roadmap-terminal-mission-restart.test.js');

// Remove this one-time patcher so it does not become a repository change.
try { fs.unlinkSync(__filename); } catch {}
