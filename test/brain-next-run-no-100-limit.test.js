const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/brain.routes.js'), 'utf8');

test('Brain next-run scan is not capped at the first 100 tenant runs', () => {
  const nextRunStart = source.indexOf("router.post('/next-run'");
  const progressStart = source.indexOf("router.post('/runs/:runId/progress'");
  assert.ok(nextRunStart >= 0);
  assert.ok(progressStart > nextRunStart);
  const block = source.slice(nextRunStart, progressStart);
  assert.doesNotMatch(block, /\.limit\(100\)/);
  assert.match(block, /collection\('runs'\)/);
  assert.match(block, /where\('tenant_id',\s*'==',\s*req\.tenantId\)/);
});

test('Brain next-run still filters only unclaimed RUNNING BRAIN_RUNs for allowed workers', () => {
  assert.match(source, /run\.run_type === 'BRAIN_RUN'/);
  assert.match(source, /run\.state === 'RUNNING'/);
  assert.match(source, /!run\.brain_adapter_id/);
  assert.match(source, /workerIds\.includes\(run\.worker_id\)/);
});
