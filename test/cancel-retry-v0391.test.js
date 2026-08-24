const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('cancel/retry routes operate on existing mission id', () => {
  const src = read('src/routes/missions.routes.js');
  assert.match(src, /:missionId\/cancel/);
  assert.match(src, /:missionId\/retry/);
  const retryRoute = src.slice(src.indexOf("router.post('/:missionId/retry'"), src.indexOf("router.post('/:missionId/cancel'"));
  const cancelRoute = src.slice(src.indexOf("router.post('/:missionId/cancel'"), src.indexOf("router.post('/',"));
  assert.doesNotMatch(retryRoute, /repos\.missions\.create/);
  assert.doesNotMatch(cancelRoute, /repos\.missions\.create/);
  assert.match(retryRoute, /req\.params\.missionId/);
  assert.match(cancelRoute, /req\.params\.missionId/);
});

test('cancel and retry UI buttons are explicit non-submit buttons', () => {
  const src = read('src/public/app.js');
  assert.match(src, /type="button"[^>]*cancel-mission-button|cancel-mission-button[^>]*type="button"/);
  assert.match(src, /type="button"[^>]*retry-button|retry-button[^>]*type="button"/);
});

test('orchestration protects cancelled mission from resurrection', () => {
  const src = read('src/services/orchestration.js');
  assert.match(src, /CANCELLED/);
  assert.match(src, /cancellation_requested/);
});
