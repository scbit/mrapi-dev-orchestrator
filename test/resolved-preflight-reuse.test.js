const test = require('node:test');
const assert = require('node:assert/strict');
const {
  repositoryCleanMethod,
  canonicalResolvedCheckpoint
} = require('../src/services/resolvedPreflightReuse');

test('repository clean validator aliases are recognized', () => {
  assert.equal(repositoryCleanMethod('git_worktree_clean'), true);
  assert.equal(repositoryCleanMethod('repository-clean'), true);
  assert.equal(repositoryCleanMethod('manual_confirmation'), false);
});

test('canonical checkpoint restores parent id and RESOLVED PASS state', () => {
  const current = {
    checkpoint_id: 'cp_generation_2',
    parent_checkpoint_id: 'cp_generation_1',
    supersedes_checkpoint_id: 'cp_generation_1',
    generation: 2,
    status: 'WAITING_FOR_HUMAN',
    waiting_status: 'WAITING_FOR_HUMAN',
    human_action_required: true,
    validation_method: 'git_worktree_clean',
    mission_id: 'mission_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2'
  };
  const validation = {
    id: 'validation_a',
    checkpoint_id: 'cp_generation_1',
    validator: 'git_worktree_clean',
    status: 'PASS',
    run_id: 'host_run_a',
    result_id: 'host_result_a',
    safe_message: 'Repository worktree is clean.'
  };

  const out = canonicalResolvedCheckpoint(current, validation, 'brain_a');
  assert.equal(out.checkpoint_id, 'cp_generation_1');
  assert.equal(out.status, 'RESOLVED');
  assert.equal(out.waiting_status, 'RESOLVED');
  assert.equal(out.human_action_required, false);
  assert.equal(out.brain_run_id, 'brain_a');
  assert.equal(out.validation_result.ok, true);
  assert.equal(out.validation_result.validation_id, 'validation_a');
  assert.equal(out.repeated_checkpoint_id, 'cp_generation_2');
});
