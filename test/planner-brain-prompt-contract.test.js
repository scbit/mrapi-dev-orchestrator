const test = require('node:test');
const assert = require('node:assert/strict');
const { brainPrompt } = require('../brain-adapter/lib/prompts');

const cfg = { repoPath: 'C:/repo/mrapi' };

test('Planner Brain uses roadmap-only non-executable prompt', () => {
  const prompt = brainPrompt({
    worker_id: 'W01',
    planning_mode: 'PLANNER_ROADMAP_PROPOSAL',
    planner_request: 'Add automatic Git push and Telegram notifications.',
    brain_context: {
      planner_contract: 'ROADMAP_PROPOSAL_V1',
      natural_language_request: 'Add automatic Git push and Telegram notifications.',
      trusted_scope: {
        tenant_id: 'tenant_a',
        workspace_id: 'workspace_a',
        project_id: 'project_a'
      }
    }
  }, cfg);

  assert.match(prompt, /PLANNER ROADMAP MODE — NON-EXECUTABLE/);
  assert.match(prompt, /<MRAPI_ROADMAP_PROPOSAL>/);
  assert.match(prompt, /"title"/);
  assert.match(prompt, /"objective"/);
  assert.match(prompt, /"summary"/);
  assert.match(prompt, /"milestones"/);
  assert.match(prompt, /Do NOT request Codex/);
  assert.match(prompt, /Do NOT modify repository files/);
  assert.doesNotMatch(prompt, /<MRAPI_CONTROL>/);
  assert.doesNotMatch(prompt, /<MRAPI_PLAN>/);
});

test('Planner revision keeps the same roadmap-only contract', () => {
  const prompt = brainPrompt({
    worker_id: 'W01',
    planning_mode: 'PLANNER_ROADMAP_PROPOSAL',
    brain_context: {
      planner_contract: 'ROADMAP_PROPOSAL_V1',
      revision_contract: 'PLANNER_ROADMAP_REVISION_V1',
      human_revision_feedback: 'Add a human checkpoint before deploy.'
    }
  }, cfg);

  assert.match(prompt, /This is a REVISION/);
  assert.match(prompt, /<MRAPI_ROADMAP_PROPOSAL>/);
  assert.doesNotMatch(prompt, /<MRAPI_CONTROL>/);
});
