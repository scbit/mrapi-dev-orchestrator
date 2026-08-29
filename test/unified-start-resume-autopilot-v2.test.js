const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const read = (file) => fs.readFileSync(file, 'utf8');

test('Planner and Roadmap use the same Autopilot endpoint', () => {
  const plannerUi = read('src/routes/planner.ui.routes.js');
  const roadmapUi = read('src/public/roadmap-page.js');
  assert.match(plannerUi, /\/api\/roadmaps\/.*\/autopilot/);
  assert.match(roadmapUi, /\/api\/roadmaps\/.*\/autopilot/);
  assert.doesNotMatch(roadmapUi, /\/advance`/);
});

test('shared endpoint forbids milestone selection and delegates to planner service', () => {
  const routes = read('src/routes/roadmaps.routes.js');
  assert.match(routes, /router\.post\('\/:roadmapId\/autopilot'/);
  assert.match(routes, /AUTOPILOT_MILESTONE_SELECTION_FORBIDDEN/);
  assert.match(routes, /startPlannerRoadmap/);
});

test('completed historical milestones do not block explicit resume', () => {
  const planner = read('src/services/planner.js');
  assert.match(planner, /const activeMilestone = startedMilestones\.find/);
  assert.match(planner, /if \(activeMilestone\)/);
  assert.match(planner, /return startNextRoadmapMilestone/);
});

test('both UIs expose Start/Resume semantics', () => {
  const plannerUi = read('src/routes/planner.ui.routes.js');
  const roadmapUi = read('src/public/roadmap-page.js');
  const html = read('src/public/roadmap.html');
  assert.match(plannerUi, /Resume Autopilot/);
  assert.match(roadmapUi, /RESUME AUTOPILOT/);
  assert.match(html, /START \/ RESUME AUTOPILOT/);
});
