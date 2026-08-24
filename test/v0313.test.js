const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('orchestration uses the canonical timestamp helper', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /\bts\(\)/);
  assert.match(source, /function timestamp\(\)/);
  assert.match(source, /RUNNER_RESTARTED_OR_ABANDONED/);
  assert.match(source, /state: 'QUEUED'/);
});
