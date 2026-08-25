const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('main control room exposes Projects and Roadmap navigation', () => {
  const html = read('src/public/index.html');
  assert.match(html, /id="projectsContextNav"/);
  assert.match(html, /id="roadmapNav"/);
  assert.match(html, /v0\.4\.4\.0/);
});

test('control room navigation links to integrated context and roadmap page', () => {
  const js = read('src/public/app.js');
  assert.match(js, /roadmap\.html#project-context/);
  assert.match(js, /roadmap\.html#roadmap/);
});

test('roadmap page exposes milestone state controls', () => {
  const html = read('src/public/roadmap.html');
  const js = read('src/public/roadmap-page.js');
  assert.match(html, /id="milestoneStateEditor"/);
  assert.match(js, /milestone-state-select/);
  assert.match(js, /Next executable milestone/);
});
