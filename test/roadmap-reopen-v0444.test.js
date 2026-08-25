const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('roadmap API exposes explicit reopen path for blocked milestone', () => {
  const route = read('src/routes/roadmaps.routes.js');
  assert.match(route, /\/:roadmapId\/reopen/);
  assert.match(route, /state: 'ACTIVE'/);
  assert.match(route, /state: 'PENDING'/);
  assert.match(route, /mission_id: null/);
  assert.match(route, /NO_BLOCKED_MILESTONE_TO_REOPEN/);
});

test('roadmap UI exposes reopen action only for blocked work', () => {
  const html = read('src/public/roadmap.html');
  const js = read('src/public/roadmap-page.js');
  assert.match(html, /id="reopenRoadmapButton"/);
  assert.match(html, /REOPEN BLOCKED MILESTONE/);
  assert.match(js, /reopenRoadmapButton/);
  assert.match(js, /\/reopen/);
  assert.match(js, /Next executable milestone/);
});

test('release version is v0.4.4.6', () => {
  assert.match(read('src/config/index.js'), /v0\.4\.4\.6/);
  assert.match(read('src/public/roadmap.html'), /v0\.4\.4\.6/);
});
