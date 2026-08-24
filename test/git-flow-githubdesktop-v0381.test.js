const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const gitFlow = require('../runner/adapters/git-flow');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runner', 'adapters', 'git-flow.js'),
  'utf8'
);

test('Git resolver supports GitHub Desktop bundled Git', () => {
  assert.match(source, /GitHubDesktop/);
  assert.match(source, /app-/);
  assert.match(source, /resources.*app.*git.*cmd.*git\.exe/s);
  assert.match(source, /mingw64.*bin.*git\.exe/s);
});

test('GitHub Desktop app versions are discovered dynamically', () => {
  assert.match(source, /readdirSync/);
  assert.match(source, /localeCompare/);
  assert.doesNotMatch(source, /app-3\.6\.4/);
});

test('GitHub Desktop candidates prefer newest app directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-desktop-git-'));
  const desktop = path.join(root, 'GitHubDesktop');
  fs.mkdirSync(path.join(desktop, 'app-3.6.4', 'resources', 'app', 'git', 'cmd'), { recursive: true });
  fs.mkdirSync(path.join(desktop, 'app-3.7.0', 'resources', 'app', 'git', 'mingw64', 'bin'), { recursive: true });

  try {
    const candidates = gitFlow.githubDesktopGitCandidates({ LOCALAPPDATA: root });
    assert.match(candidates[0], /app-3\.7\.0/);
    assert.match(candidates[0], /resources\\app\\git\\cmd\\git\.exe$/);
    assert.match(candidates[1], /mingw64\\bin\\git\.exe$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('normal Git installations remain supported first', () => {
  assert.match(source, /git\.exe/);
  assert.match(source, /Program Files\\\\Git\\\\cmd\\\\git\.exe/);
});
