const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows Codex resolver prefers the cmd.exe wrapper for codex.cmd', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runner', 'adapters', 'codex-command.js'),
    'utf8'
  );

  const cmdIndex = source.indexOf("commandExists('codex.cmd')");
  const bareIndex = source.indexOf("commandExists('codex')");

  assert.ok(cmdIndex >= 0, 'codex.cmd detection missing');
  assert.ok(bareIndex >= 0, 'bare codex detection missing');
  assert.ok(cmdIndex < bareIndex, 'codex.cmd must be checked first on Windows');

  assert.match(source, /command:\s*'cmd\.exe'/);
  assert.match(source, /'codex\.cmd'/);
  assert.match(source, /'exec'/);
  assert.match(source, /'-'/);
});
