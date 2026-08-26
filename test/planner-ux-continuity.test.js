const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src/public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src/public/app.js'), 'utf8');
const plannerUi = fs.readFileSync(path.join(root, 'src/routes/planner.ui.routes.js'), 'utf8');
const plannerService = fs.readFileSync(path.join(root, 'src/services/planner.js'), 'utf8');

test('Planner is reachable from primary navigation', () => {
  assert.match(indexHtml, /id="plannerNav">Planner<\/button>/);
  assert.match(appJs, /document\.querySelector\(['"]#plannerNav['"]\)/);
  assert.match(appJs, /window\.location\.href\s*=\s*['"]\/planner['"]/);
});

test('Planner restores active request after reload', () => {
  assert.match(plannerUi, /mrapi\.planner\.active\.v1/);
  assert.match(plannerUi, /persistPlannerState\(\)/);
  assert.match(plannerUi, /restorePlannerState\(\)/);
  assert.match(plannerUi, /clearPersistedPlannerState\(\)/);
  assert.match(plannerUi, /Restored active Planner request/);
  assert.match(plannerUi, /loadProposal\(\)/);
});

test('Planner intake is non-executable and creates a running Brain Run directly', () => {
  assert.match(plannerService, /planning_mode:\s*'PLANNER_ROADMAP_PROPOSAL'/);
  assert.match(plannerService, /run_type:\s*'BRAIN_RUN'/);
  assert.match(plannerService, /state:\s*'RUNNING'/);
  assert.match(plannerService, /non_executable:\s*true/);
});
