const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('ChatGPT response detection does not depend on assistant message count', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'brain-adapter', 'adapters', 'chatgpt-web.js'),
    'utf8'
  );

  assert.match(source, /previousText/);
  assert.match(source, /text !== previousText/);
  assert.match(source, /assistant response detected/);
  assert.match(source, /assistant response stable/);
  assert.doesNotMatch(source, /previousCount/);
  assert.doesNotMatch(source, /querySelectorAll\(selector\)\.length > previousCount/);
});
