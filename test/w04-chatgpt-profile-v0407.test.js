const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chromeProfileNames,
  chromeUserDataDirForWorker,
  chatUrlForWorker
} = require('../brain-adapter/lib/config');
const { isChatGPTLoginPage } = require('../brain-adapter/adapters/chatgpt-web');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('v0.4.0.7 W01-W05 profile paths are distinct repo-local directories', () => {
  const profiles = ['W01', 'W02', 'W03', 'W04', 'W05'].map((id) => chromeUserDataDirForWorker(id));
  assert.equal(new Set(profiles).size, 5);
  for (const profilePath of profiles) {
    assert.match(profilePath, /brain-adapter[\\/]+chrome-profiles[\\/]+W0[1-5]$/);
    assert.equal(fs.existsSync(profilePath), true);
  }
});

test('v0.4.0.7 W04 maps to chrome-profiles/W04', () => {
  assert.equal(chromeProfileNames.W04, 'W04');
  assert.match(chromeUserDataDirForWorker('W04'), /chrome-profiles[\\/]+W04$/);
});

test('v0.4.0.7 W04 chat URL has no W01 fallback', () => {
  const originalW04 = process.env.MRAPI_W04_CHAT_URL;
  const originalW01 = process.env.MRAPI_W01_CHAT_URL;
  delete process.env.MRAPI_W04_CHAT_URL;
  process.env.MRAPI_W01_CHAT_URL = 'https://chatgpt.com/c/w01-only';
  delete require.cache[require.resolve('../brain-adapter/lib/config')];

  try {
    const fresh = require('../brain-adapter/lib/config');
    assert.throws(() => fresh.chatUrlForWorker('W04'), /BRAIN_CHAT_NOT_CONFIGURED_FOR_W04/);
  } finally {
    if (originalW04 === undefined) delete process.env.MRAPI_W04_CHAT_URL;
    else process.env.MRAPI_W04_CHAT_URL = originalW04;
    if (originalW01 === undefined) delete process.env.MRAPI_W01_CHAT_URL;
    else process.env.MRAPI_W01_CHAT_URL = originalW01;
    delete require.cache[require.resolve('../brain-adapter/lib/config')];
  }
});

test('v0.4.0.7 configured W04 URL is returned explicitly', () => {
  const originalW04 = process.env.MRAPI_W04_CHAT_URL;
  process.env.MRAPI_W04_CHAT_URL = 'https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24';
  delete require.cache[require.resolve('../brain-adapter/lib/config')];

  try {
    const fresh = require('../brain-adapter/lib/config');
    assert.equal(
      fresh.chatUrlForWorker('W04'),
      'https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24'
    );
  } finally {
    if (originalW04 === undefined) delete process.env.MRAPI_W04_CHAT_URL;
    else process.env.MRAPI_W04_CHAT_URL = originalW04;
    delete require.cache[require.resolve('../brain-adapter/lib/config')];
  }
});

test('v0.4.0.7 setup script and runtime use same W04 profile', () => {
  const setup = read('brain-adapter/setup-w04-chatgpt-profile.ps1');
  const helper = read('brain-adapter/setup-chatgpt-profile.ps1');
  const start = read('brain-adapter/start-w04.cmd');
  assert.match(setup, /-WorkerId 'W04'/);
  assert.match(setup, /\$env:MRAPI_W04_CHAT_URL/);
  assert.match(helper, /chrome-profiles\\\$WorkerId/);
  assert.match(start, /chrome-profiles\\W04/);
  assert.match(chromeUserDataDirForWorker('W04'), /chrome-profiles[\\/]+W04$/);
  assert.match(helper, /never requests, stores, or reads credentials/i);
});

test('v0.4.0.7 gitignore excludes persistent profile data', () => {
  assert.match(read('.gitignore'), /brain-adapter\/chrome-profiles\//);
});

test('v0.4.0.7 W04 startup logs say W04 and profile, not hardcoded W01', () => {
  const source = read('brain-adapter/brain-adapter.js');
  assert.match(source, /\$\{id\} chat/);
  assert.match(source, /\$\{id\} profile/);
  assert.doesNotMatch(source, /W01 chat/);
});

test('v0.4.0.7 login page is not accepted as Brain success', async () => {
  const loginPage = {
    url: () => 'https://chatgpt.com/auth/login',
    locator: () => ({ count: async () => 0 })
  };
  const loggedInPage = {
    url: () => 'https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24',
    locator: () => ({ count: async () => 0 })
  };

  assert.equal(await isChatGPTLoginPage(loginPage), true);
  assert.equal(await isChatGPTLoginPage(loggedInPage), false);
  assert.match(read('brain-adapter/adapters/chatgpt-web.js'), /CHATGPT_LOGIN_REQUIRED/);
});
