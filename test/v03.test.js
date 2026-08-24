const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('v0.3 contains separate Brain and Codex adapters', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'runner', 'adapters', 'chatgpt-web.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'runner', 'adapters', 'codex-command.js')));
});

test('v0.3 orchestration contains Brain before execution primitives', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'orchestration.js'), 'utf8');
  assert.match(source, /run_type: 'BRAIN_RUN'/);
  assert.match(source, /run_type: 'EXECUTION_RUN'/);
  assert.match(source, /completeBrainRun/);
  assert.match(source, /startExecutionRun/);
});

test('Codex prompt explicitly forbids GCP and deploy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runner', 'lib', 'prompts.js'), 'utf8');
  assert.match(source, /Do not access GCP/);
  assert.match(source, /Do not deploy/);
  assert.match(source, /HUMAN MANUAL DEPLOY/);
});
