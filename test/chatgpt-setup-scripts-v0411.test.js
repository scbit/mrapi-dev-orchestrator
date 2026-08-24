const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromeUserDataDirForWorker } = require('../brain-adapter/lib/config');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('v0.4.1.1 W01-W05 setup scripts exist', () => {
  for (const id of ['w01', 'w02', 'w03', 'w04', 'w05']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'brain-adapter', `setup-${id}-chatgpt-profile.ps1`)), true);
  }
});

test('v0.4.1.1 each setup wrapper references only its matching chat env var', () => {
  for (const id of ['W01', 'W02', 'W03', 'W04', 'W05']) {
    const script = read(`brain-adapter/setup-${id.toLowerCase()}-chatgpt-profile.ps1`);
    assert.match(script, new RegExp(`-WorkerId '${id}'`));
    assert.match(script, new RegExp(`\\$env:MRAPI_${id}_CHAT_URL`));

    for (const other of ['W01', 'W02', 'W03', 'W04', 'W05'].filter((item) => item !== id)) {
      assert.doesNotMatch(script, new RegExp(`MRAPI_${other}_CHAT_URL`));
      assert.doesNotMatch(script, new RegExp(`-WorkerId '${other}'`));
    }
  }
});

test('v0.4.1.1 setup helper uses same deterministic profile paths as runtime', () => {
  const helper = read('brain-adapter/setup-chatgpt-profile.ps1');
  assert.match(helper, /chrome-profiles\\\$WorkerId/);
  assert.match(helper, /--user-data-dir=\$profileDir/);
  assert.match(helper, /--new-window/);
  assert.doesNotMatch(helper, /incognito|headless/i);

  for (const id of ['W01', 'W02', 'W03', 'W04', 'W05']) {
    assert.match(chromeUserDataDirForWorker(id), new RegExp(`brain-adapter[\\\\/]chrome-profiles[\\\\/]${id}$`));
  }
});

test('v0.4.1.1 setup scripts never request or store credentials', () => {
  const helper = read('brain-adapter/setup-chatgpt-profile.ps1');
  assert.match(helper, /never requests, stores, or reads credentials/i);
  assert.doesNotMatch(helper, /password|token|secret/i);
});

test('v0.4.1.1 W04 setup remains worker-specific and env-driven', () => {
  const script = read('brain-adapter/setup-w04-chatgpt-profile.ps1');
  assert.match(script, /\$env:MRAPI_W04_CHAT_URL/);
  assert.doesNotMatch(script, /6a8c60e3-46ec-83e9-97c4-c9834b4c6b24/);
  assert.doesNotMatch(script, /MRAPI_W01_CHAT_URL/);
});
