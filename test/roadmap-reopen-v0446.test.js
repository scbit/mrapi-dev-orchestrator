const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('roadmap-only reopen clears stale Mission linkage from pending milestones', () => {
  const route = read('src/routes/roadmaps.routes.js');
  assert.match(route, /item\.state === 'PENDING' && item\.mission_id/);
  assert.match(route, /mission_id: null/);
  assert.match(route, /verification_brain_run_id: null/);
  assert.match(route, /milestones: reopenedMilestones/);
});

test('reopen preserves historical Mission Runs by only clearing roadmap linkage', () => {
  const route = read('src/routes/roadmaps.routes.js');
  assert.match(route, /historical Mission\/Runs remain persisted independently for audit/);
  assert.doesNotMatch(route, /db\.collection\('missions'\).*delete/);
});

test('release version is v0.4.4.6', () => {
  assert.equal(require(path.join(root, 'src/config')).VERSION, 'v0.4.4.6');
});
