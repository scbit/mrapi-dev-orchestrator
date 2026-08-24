const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Codex desktop handoff contains full Brain instructions and identifiers', () => {
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

test('runner prepares desktop handoff instead of sending only Task ID', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'shadow-runner.js'),
    'utf8'
  );

  assert.match(source, /prepareCodexDesktopHandoff/);
  assert.match(source, /Codex prompt copied to clipboard/);
  assert.match(source, /handoff_file/);
  assert.match(source, /clipboard_ready/);
});

test('Codex app launch is configurable, not hardcoded', () => {
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
