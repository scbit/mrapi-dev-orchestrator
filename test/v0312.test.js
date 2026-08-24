const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('abandoned Brain recovery does not require Firestore composite index', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orchestration.js'),
    'utf8'
  );

  const start = source.indexOf('async function recoverAbandonedBrainRuns');
  const end = source.indexOf('module.exports', start);
  const fn = source.slice(start, end);

  assert.match(fn, /\.where\('tenant_id', '==', tenantId\)/);
  assert.doesNotMatch(fn, /\.where\('run_type'/);
  assert.doesNotMatch(fn, /\.where\('executor_id'/);
  assert.match(fn, /run\.run_type !== 'BRAIN_RUN'/);
  assert.match(fn, /run\.executor_id !== executorId/);
});
