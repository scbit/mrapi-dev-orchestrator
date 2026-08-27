const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRoadmapInput,
  nextMilestone,
  containsSensitiveKey
} = require('../src/services/roadmap');

test('roadmap service normalization and dependency selection remain compatible', () => {
  const roadmap = normalizeRoadmapInput({
    title: 'Compatibility Roadmap',
    objective: 'Keep existing roadmap service behavior covered.',
    auto_advance: true,
    milestones: [
      { id: 'm1', title: 'Done', state: 'COMPLETED', order: 1 },
      { id: 'm2', title: 'Ready', state: 'PENDING', order: 2, depends_on: ['m1'] },
      { id: 'm3', title: 'Blocked by m2', state: 'PENDING', order: 3, depends_on: ['m2'] }
    ]
  });

  assert.equal(roadmap.auto_advance, true);
  assert.equal(nextMilestone(roadmap).id, 'm2');
  assert.equal(containsSensitiveKey({ nested: { token: 'secret' } }), true);
});
