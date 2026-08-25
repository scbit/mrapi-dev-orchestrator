const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProjectContext,
  normalizeRoadmapInput,
  nextMilestone,
  milestoneCanStart,
  containsSensitiveKey
} = require('../src/services/roadmap');

test('project context keeps stable execution metadata', () => {
  const value = normalizeProjectContext({
    repository_full_name: 'scbit/mrapi-hub',
    local_path: 'C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-hub',
    default_branch: 'main',
    default_worker_id: 'W01',
    reusable_instructions: 'Do not deploy without approval.'
  });
  assert.equal(value.repository_full_name, 'scbit/mrapi-hub');
  assert.equal(value.default_worker_id, 'W01');
  assert.match(value.local_path, /mrapi-hub/);
});

test('project context rejects secrets', () => {
  assert.equal(containsSensitiveKey({ connection: { token: 'x' } }), true);
  assert.throws(() => normalizeProjectContext({ runtime_context: { api_key: 'secret' } }), /must not store credentials/i);
});

test('roadmap normalizes milestones and dependencies', () => {
  const roadmap = normalizeRoadmapInput({
    title: 'Finish W01 Autopilot',
    objective: 'Autonomous development loop',
    state: 'ACTIVE',
    milestones: [
      { id: 'context', title: 'Project Context', state: 'COMPLETED' },
      { id: 'loop', title: 'Autopilot Loop', depends_on: ['context'] }
    ]
  });
  assert.equal(roadmap.milestones.length, 2);
  assert.equal(milestoneCanStart(roadmap.milestones[1], roadmap.milestones), true);
  assert.equal(nextMilestone(roadmap).id, 'loop');
});

test('blocked dependency prevents next milestone', () => {
  const roadmap = normalizeRoadmapInput({
    title: 'X', objective: 'Y', milestones: [
      { id: 'a', title: 'A', state: 'BLOCKED' },
      { id: 'b', title: 'B', depends_on: ['a'] }
    ]
  });
  assert.equal(nextMilestone(roadmap), null);
});
