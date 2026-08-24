const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('app exposes results API', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src', 'routes', 'results.routes.js'), 'utf8');
  assert.match(app, /createResultsRouter/);
  assert.match(app, /\/api\/results/);
  assert.match(route, /repos\.results\.listByTenant/);
});

test('frontend loads runs and results', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'public', 'app.js'), 'utf8');
  assert.match(app, /api\('\/api\/runs'\)/);
  assert.match(app, /api\('\/api\/results'\)/);
  assert.match(app, /progress_percent/);
  assert.match(app, /setInterval\(loadAll, 5000\)/);
});

test('reports and mission detail are real views', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="view-reports"/);
  assert.doesNotMatch(html, /placeholder-view" id="view-reports"/);
  assert.match(html, /missionDetailModal/);
  assert.match(app, /renderReports/);
  assert.match(app, /openMissionDetail/);
});
