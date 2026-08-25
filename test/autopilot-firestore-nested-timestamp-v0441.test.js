const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('roadmap milestone arrays use concrete timestamps, not Firestore serverTimestamp sentinels', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/services/autopilot.js'), 'utf8');
  assert.match(source, /function milestoneTimestamp\(\) \{[\s\S]*return new Date\(\)/);
  assert.match(source, /updated_at: milestoneTimestamp\(\)/);
  assert.match(source, /started_at: milestoneTimestamp\(\)/);
  assert.match(source, /completed_at: milestoneTimestamp\(\)/);
  assert.doesNotMatch(source, /started_at: timestamp\(\)\s*\n\s*\}\),/);
});
