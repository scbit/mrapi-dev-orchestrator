const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePreExecutionWorktree } = require('../runner/shadow-runner');

test('PROGRAM still requires a clean repository', () => {
  assert.throws(() => validatePreExecutionWorktree({
    autopilotPhase: 'PROGRAM',
    beforeStatus: { available: true, text: ' M src/services/autopilot.js\n' },
    allowedFiles: ['src/services/autopilot.js']
  }), /AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION/);
});

test('RETRY may continue on same-mission dirty files when all are allowlisted', () => {
  const out = validatePreExecutionWorktree({
    autopilotPhase: 'RETRY',
    beforeStatus: { available: true, text: ' M src/services/autopilot.js\n?? test/autopilot-v3-loop.test.js\n' },
    allowedFiles: ['src/services/autopilot.js','test/autopilot-v3-loop.test.js']
  });
  assert.equal(out.ok, true);
  assert.equal(out.resumed_retry, true);
  assert.deepEqual(out.unauthorized_files, []);
});

test('RETRY blocks dirty files outside the cumulative Brain scope', () => {
  assert.throws(() => validatePreExecutionWorktree({
    autopilotPhase: 'RETRY',
    beforeStatus: { available: true, text: ' M src/services/autopilot.js\n M src/secret-unrelated.js\n' },
    allowedFiles: ['src/services/autopilot.js']
  }), /AUTOPILOT_REPO_DIRTY_OUTSIDE_RETRY_SCOPE/);
});
