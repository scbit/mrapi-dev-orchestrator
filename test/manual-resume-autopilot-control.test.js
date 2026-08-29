const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Planner keeps safe manual Resume Autopilot control', () => {
  const source = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  assert.match(source, /MANUAL_RESUME_AUTOPILOT_CONTROL_V1/);
  assert.match(source, /hasUnfinishedAutopilotWork/);
  assert.match(source, /const canStart = approved && !isTerminal\(proposal\) && hasUnfinishedAutopilotWork/);
});

test('Roadmap exposes Start Resume through trusted autopilot endpoint only', () => {
  const html = fs.readFileSync('src/public/roadmap.html', 'utf8');
  const js = fs.readFileSync('src/public/roadmap-page.js', 'utf8');
  assert.match(html, /id="resumeAutopilotButton"/);
  assert.match(js, /MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V1/);
  assert.match(js, /\/api\/roadmaps\/.*\/autopilot/);
  assert.doesNotMatch(js, /\/advance/);
  assert.doesNotMatch(js, /\/milestones\/.*\/state/);
});
