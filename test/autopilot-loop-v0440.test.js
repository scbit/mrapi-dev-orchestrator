const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseAutopilotDecision
} = require('../src/services/autopilot');
const { brainPrompt } = require('../brain-adapter/lib/prompts');

test('verification decision parser accepts COMPLETE', () => {
  const decision = parseAutopilotDecision(`<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"tests passed","execution_spec":null}</MRAPI_AUTOPILOT>`);
  assert.equal(decision.action, 'COMPLETE');
  assert.equal(decision.reason, 'tests passed');
});

test('verification decision parser keeps Brain-authored RETRY instructions', () => {
  const decision = parseAutopilotDecision(`<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"one test failed","execution_spec":{"instructions":"Edit only x.js exactly as specified, then run node --test.","success_criteria":["tests pass"],"stop_conditions":["DO NOT DEPLOY"]}}</MRAPI_AUTOPILOT>`);
  assert.equal(decision.action, 'RETRY');
  assert.match(decision.execution_spec.instructions, /Edit only x\.js/);
  assert.deepEqual(decision.execution_spec.success_criteria, ['tests pass']);
});

test('invalid verification response blocks instead of looping blindly', () => {
  const decision = parseAutopilotDecision('looks fine maybe');
  assert.equal(decision.action, 'BLOCKED');
});

test('verification prompt makes Brain the programmer and Codex hands only', () => {
  const prompt = brainPrompt({
    worker_id: 'W01',
    autopilot_phase: 'VERIFY_EXECUTION',
    roadmap_id: 'r1', milestone_id: 'm1', mission_id: 'mission1',
    executor_report: { success: false, error: 'test failed' }
  }, { repoPath: 'C:/repo' });
  assert.match(prompt, /Brain\. Codex is hands only/i);
  assert.match(prompt, /YOU define the exact correction/i);
  assert.match(prompt, /Codex is hands only/i);
  assert.match(prompt, /MRAPI_AUTOPILOT/);
  assert.match(prompt, /COMPLETE \| RETRY \| BLOCKED/);
});

test('roadmap UI exposes explicit start and real auto-advance language', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/public/roadmap.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src/public/roadmap-page.js'), 'utf8');
  assert.match(html, /START NEXT MILESTONE/);
  assert.match(html, /Auto-advance: after Brain verifies COMPLETE/);
  assert.match(js, /\/advance/);
  assert.match(html, /v0\.4\.4\.0/);
});
