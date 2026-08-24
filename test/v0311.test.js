const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('execution Runner no longer owns abandoned Brain Run recovery', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /recover-abandoned/);
  assert.doesNotMatch(source, /stale_ms: 120000/);
});

test('orchestrator preserves legacy abandoned Brain recovery capability', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  assert.match(source, /RUNNER_RESTARTED_OR_ABANDONED/);
  assert.match(source, /state: 'QUEUED'/);
  assert.match(source, /BRAIN_RUN_RECOVERED/);
});
