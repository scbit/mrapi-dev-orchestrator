const test = require('node:test');
const assert = require('node:assert/strict');

const {
  run,
  parseStatusFiles,
  verifyAllowedChanges
} = require('../runner/adapters/git-flow');

test('run preserves leading porcelain status space so first filename is not corrupted', () => {
  const result = run(process.execPath, [
    '-e',
    "process.stdout.write(' M runner/shadow-runner.js\\n?? test/new-file.test.js\\n')"
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.stdout.startsWith(' M runner/shadow-runner.js'), true);

  const files = parseStatusFiles(result.stdout);
  assert.deepEqual(files, [
    'runner/shadow-runner.js',
    'test/new-file.test.js'
  ]);
});

test('scope validator accepts allowlisted first modified file with leading porcelain space', () => {
  const status = ' M runner/shadow-runner.js\n?? test/new-file.test.js';
  const verdict = verifyAllowedChanges(status, [
    'runner/shadow-runner.js',
    'test/new-file.test.js'
  ]);

  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unauthorized_files, []);
});
