const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

test('blocked roadmap can reopen even when milestone is already pending', () => {
  const route = fs.readFileSync(path.join(root, 'src/routes/roadmaps.routes.js'), 'utf8');
  assert.match(route, /roadmapOnlyReopen = !reopenedMilestoneId && roadmap\.state === 'BLOCKED'/);
  assert.match(route, /reopened_roadmap_only: roadmapOnlyReopen/);
});

test('reopen still rejects when neither roadmap nor milestone is blocked', () => {
  const route = fs.readFileSync(path.join(root, 'src/routes/roadmaps.routes.js'), 'utf8');
  assert.match(route, /if \(!reopenedMilestoneId && !roadmapOnlyReopen\)/);
  assert.match(route, /NO_BLOCKED_MILESTONE_TO_REOPEN/);
});

test('release version is v0.4.4.5', () => {
  assert.equal(require(path.join(root, 'src/config')).VERSION, 'v0.4.4.5');
});
