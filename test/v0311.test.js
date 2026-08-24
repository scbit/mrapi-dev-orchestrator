const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('runner recovers abandoned Brain Runs on startup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );
  assert.match(source, /recover-abandoned/);
  assert.match(source, /stale_ms: 120000/);
});

test('orchestrator preserves abandoned run and requeues task', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );
  assert.match(source, /RUNNER_RESTARTED_OR_ABANDONED/);
  assert.match(source, /state: 'QUEUED'/);
  assert.match(source, /BRAIN_RUN_RECOVERED/);
});
