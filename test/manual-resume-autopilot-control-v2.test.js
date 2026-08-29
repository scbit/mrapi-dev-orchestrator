const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Planner has manual safe Resume Autopilot control', () => {
  const s = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  assert.match(s, /MANUAL_RESUME_AUTOPILOT_CONTROL_V2/);
  assert.match(s, /manualAutopilotHasUnfinished/);
  assert.match(s, /manualAutopilotAvailable/);
  assert.match(s, /\/autopilot/);
});

test('Roadmap has safe Start Resume Autopilot button', () => {
  const html = fs.readFileSync('src/public/roadmap.html', 'utf8');
  const js = fs.readFileSync('src/public/roadmap-page.js', 'utf8');

  assert.match(html, /id="resumeAutopilotButton"/);
  assert.match(js, /MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V2/);
  assert.match(js, /syncManualAutopilotControl/);
  assert.match(js, /\/api\/roadmaps\/.*\/autopilot/);

  // Never restore old direct lifecycle controls.
  assert.doesNotMatch(js, /\/api\/roadmaps\/.*\/advance/);
  assert.doesNotMatch(js, /\/milestones\/.*\/state/);
});

test('Manual control does not choose milestone', () => {
  const js = fs.readFileSync('src/public/roadmap-page.js', 'utf8');
  const block = js.slice(js.indexOf("$('#resumeAutopilotButton')"), js.indexOf("$('#reopenRoadmapButton')"));
  assert.doesNotMatch(block, /milestone_id/);
});
