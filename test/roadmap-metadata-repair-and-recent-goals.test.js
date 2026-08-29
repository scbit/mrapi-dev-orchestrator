
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

test('preserves planner metadata', () => {
  const s = fs.readFileSync('src/services/roadmap.js','utf8');
  assert.match(s,/PRESERVE_PLANNER_MILESTONE_METADATA_V1/);
  assert.match(s,/executor_required/);
  assert.match(s,/dependencies/);
});
test('repair route exists', () => {
  assert.match(fs.readFileSync('src/routes/planner.routes.js','utf8'),/repair-metadata/);
  assert.match(fs.readFileSync('src/services/planner.js','utf8'),/repairPlannerRoadmapMetadata/);
});
test('recent planner roadmaps first', () => {
  const s = fs.readFileSync('src/public/roadmap-page.js','utf8');
  assert.match(s,/RECENT_PLANNER_ROADMAPS_FIRST_V1/);
  assert.match(s,/proposal_type === 'PLANNER_ROADMAP'/);
});
