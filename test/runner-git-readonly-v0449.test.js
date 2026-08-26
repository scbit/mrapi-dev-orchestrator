const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createGitReadOnlyGuard, windowsGitCandidates } = require('../runner/adapters/codex-command');

test('git guard allows read-only git diff/status and blocks write/network commands', { skip: process.platform === 'win32' }, () => {
  const guard = createGitReadOnlyGuard(process.env);
  try {
    assert.ok(guard.realGit, 'real git should resolve in test environment');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-readonly-git-test-'));
    try {
      assert.equal(spawnSync(guard.realGit, ['init'], { cwd: repo }).status, 0);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');

      const status = spawnSync('git', ['status', '--short'], { cwd: repo, env: guard.env, encoding: 'utf8' });
      assert.equal(status.status, 0);
      assert.match(status.stdout, /a\.txt/);

      const diff = spawnSync('git', ['diff', '--name-only'], { cwd: repo, env: guard.env, encoding: 'utf8' });
      assert.equal(diff.status, 0);

      const blocked = spawnSync('git', ['add', 'a.txt'], { cwd: repo, env: guard.env, encoding: 'utf8' });
      assert.equal(blocked.status, 73);
      assert.match(blocked.stderr, /MRAPI_GIT_WRITE_BLOCKED/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    guard.cleanup();
  }
});

test('Windows Git candidates include explicit override and GitHub Desktop bundled Git', () => {
  const fakeLocal = 'C:\\Users\\Shadow\\AppData\\Local';
  const candidates = windowsGitCandidates({
    MRAPI_GIT_READ_BINARY: 'D:\\Tools\\git.exe',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: fakeLocal
  });
  assert.equal(candidates[0], 'D:\\Tools\\git.exe');
  assert.ok(candidates.some((item) => item.includes(path.join('Git', 'cmd', 'git.exe'))));
});
