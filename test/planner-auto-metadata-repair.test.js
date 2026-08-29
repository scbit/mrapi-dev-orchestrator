const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Planner auto-repairs incomplete PLANNER_ROADMAP metadata once', () => {
  const source = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  assert.match(source, /PLANNER_AUTO_METADATA_REPAIR_V1/);
  assert.match(source, /proposal_type.*PLANNER_ROADMAP/);
  assert.match(source, /repair-metadata/);
  assert.match(source, /metadataRepairAttempts/);
  assert.match(source, /isProposalRenderable\(proposal\)/);
  assert.match(source, /isReviewComplete\(proposal\)/);
});

test('Repair re-fetches same Planner proposal after successful repair', () => {
  const source = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  assert.match(source, /proposal = await fetch\(\s*'\/api\/planner\/proposals\/'/);
  assert.doesNotMatch(source, /create.*roadmap/i);
});
