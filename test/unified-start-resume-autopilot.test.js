const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('Planner and Roadmap UIs use same Autopilot endpoint', () => {
  const plannerUi = read('src/routes/planner.ui.routes.js');
  const roadmapUi = read('src/public/roadmap-page.js');
  assert.match(plannerUi, /\/api\/roadmaps\/.*\/autopilot/);
  assert.match(roadmapUi, /\/api\/roadmaps\/.*\/autopilot/);
  assert.doesNotMatch(roadmapUi, /\/advance`/);
});

test('Roadmap backend autopilot endpoint forbids manual milestone selection', () => {
  const routes = read('src/routes/roadmaps.routes.js');
  assert.match(routes, /router\.post\('\/:roadmapId\/autopilot'/);
  assert.match(routes, /AUTOPILOT_MILESTONE_SELECTION_FORBIDDEN/);
  assert.match(routes, /startPlannerRoadmap/);
  assert.doesNotMatch(routes, /startNextRoadmapMilestone/);
  assert.doesNotMatch(routes, /dispatchMission/);
});

test('Planner service reuses only active or recoverable work', () => {
  const planner = read('src/services/planner.js');
  assert.match(planner, /const activeMilestone = startedMilestones\.find/);
  assert.match(planner, /if \(activeMilestone\)/);
  assert.match(planner, /return startNextRoadmapMilestone/);
});

test('Roadmap UI exposes Start Resume Autopilot label', () => {
  const html = read('src/public/roadmap.html');
  assert.match(html, /START \/ RESUME AUTOPILOT/);
});
