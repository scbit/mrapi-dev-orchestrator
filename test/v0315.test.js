const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('runner routes import recovery and manual Codex handlers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'runner.routes.js'),
    'utf8'
  );

  const requireBlock = source.slice(
    source.indexOf("const {"),
    source.indexOf("} = require('../services/orchestration');") + 45
  );

  assert.match(requireBlock, /recoverAbandonedBrainRuns/);
  assert.match(requireBlock, /completeManualCodexHandoff/);
  assert.match(source, /req\.body\.handoff \|\| null/);
});

test('orchestration exports the handlers used by runner routes', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  const exportsBlock = source.slice(source.lastIndexOf('module.exports'));
  assert.match(exportsBlock, /recoverAbandonedBrainRuns/);
  assert.match(exportsBlock, /completeManualCodexHandoff/);
});
