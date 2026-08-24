const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows Codex CLI uses cmd.exe wrapper for codex.cmd', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-command.js'),
    'utf8'
  );

  assert.match(source, /command:\s*'cmd\.exe'/);
  assert.match(source, /'\/d'/);
  assert.match(source, /'\/s'/);
  assert.match(source, /'\/c'/);
  assert.match(source, /'codex\.cmd'/);
  assert.match(source, /'exec'/);
  assert.match(source, /'-'/);
});

test('Windows wrapper is checked before bare codex', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-command.js'),
    'utf8'
  );

  const cmdIndex = source.indexOf("commandExists('codex.cmd')");
  const bareIndex = source.indexOf("commandExists('codex')");
  assert.ok(cmdIndex >= 0);
  assert.ok(bareIndex >= 0);
  assert.ok(cmdIndex < bareIndex);
});
