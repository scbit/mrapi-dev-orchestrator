
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

test('preserves Planner milestone contract', () => {
  const s = fs.readFileSync('src/services/roadmap.js','utf8');
  assert.match(s,/PRESERVE_PLANNER_MILESTONE_METADATA_V2/);
  for (const field of ['objective','executor_required','dependencies','risks','success_criteria','mission_id']) {
    assert.match(s,new RegExp(field));
  }
});

test('same Roadmap metadata repair exists', () => {
  assert.match(fs.readFileSync('src/services/planner.js','utf8'),/repairPlannerRoadmapMetadata/);
  assert.match(fs.readFileSync('src/routes/planner.routes.js','utf8'),/repair-metadata/);
});

test('recent Planner Roadmaps first', () => {
  const s = fs.readFileSync('src/public/roadmap-page.js','utf8');
  assert.match(s,/RECENT_PLANNER_ROADMAPS_FIRST_V2/);
  assert.match(s,/proposal_type === 'PLANNER_ROADMAP'/);
});
