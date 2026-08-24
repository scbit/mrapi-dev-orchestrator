const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('recovery and manual Codex functions are exported', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  const exportsBlock = source.slice(source.lastIndexOf('module.exports'));
  assert.match(exportsBlock, /completeManualCodexHandoff/);
  assert.match(exportsBlock, /recoverAbandonedBrainRuns/);
});

test('runner recovery endpoint exists', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'runner.routes.js'),
    'utf8'
  );

  assert.match(source, /recover-abandoned/);
  assert.match(source, /recoverAbandonedBrainRuns/);
});
