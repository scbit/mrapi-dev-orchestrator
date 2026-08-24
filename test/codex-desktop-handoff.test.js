const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Codex desktop handoff adapter remains available as optional fallback', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-desktop-handoff.js'),
    'utf8'
  );

  assert.match(source, /BRAIN INSTRUCTIONS/);
  assert.match(source, /TASK ID/);
  assert.match(source, /EXECUTION RUN ID/);
  assert.match(source, /BRAIN RUN ID/);
  assert.match(source, /Set-Clipboard/);
  assert.match(source, /Do not deploy/);
});

test('v0.3.4 runner uses CLI auto instead of desktop handoff', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );

  assert.match(source, /CODEX_CLI_AUTO/);
  assert.match(source, /runCodexCommand/);
  assert.match(source, /buildCodexPrompt/);
  assert.doesNotMatch(source, /prepareCodexDesktopHandoff/);
  assert.doesNotMatch(source, /Codex prompt copied to clipboard/);
});

test('Codex desktop fallback launch remains configurable, not hardcoded', () => {
  const config = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'lib', 'config.js'),
    'utf8'
  );
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-desktop-handoff.js'),
    'utf8'
  );

  assert.match(config, /MRAPI_CODEX_APP_COMMAND/);
  assert.match(adapter, /MRAPI_CODEX_APP_COMMAND_NOT_SET/);
  assert.doesNotMatch(adapter, /OpenAI\.ChatGPT/);
});
