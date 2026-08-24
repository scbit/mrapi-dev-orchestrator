const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('app mounts independent brain router', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(source, /createBrainRouter/);
  assert.match(source, /\/api\/brain/);
});

test('brain adapter does not import or execute Codex', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'brain-adapter', 'brain-adapter.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /codex/i);
  assert.match(source, /runChatGPTWeb/);
  assert.match(source, /\/api\/brain\/next-run/);
});

test('brain route claims only BRAIN_RUN records', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'brain.routes.js'),
    'utf8'
  );
  assert.match(source, /run\.run_type === 'BRAIN_RUN'/);
  assert.match(source, /run\.state === 'RUNNING'/);
  assert.match(source, /completeBrainRun/);
});


test('brain route enriches legacy Brain Run objective from Mission', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'brain.routes.js'),
    'utf8'
  );
  assert.match(source, /mission\\.objective/);
  assert.match(source, /Brain Run missing mission objective; released/);
});


test('ChatGPT adapter detects completed assistant response without relying on long text stability', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'brain-adapter', 'adapters', 'chatgpt-web.js'),
    'utf8'
  );
  assert.match(source, /waitForAssistantCompletion/);
  assert.match(source, /stop-button/);
  assert.match(source, /unchangedFor >= 2/);
  assert.doesNotMatch(source, /waitForStableAssistant/);
});
