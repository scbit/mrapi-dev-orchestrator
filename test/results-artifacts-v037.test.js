const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const runner = require('../runner/shadow-runner');

test('app mounts evidence route', () => {
  const s = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.match(s, /createEvidenceRouter/);
  assert.match(s, /app\.use\('\/api\/evidence',\s*createEvidenceRouter\(\{\s*repos\s*\}\)\)/);
});

test('evidence route is tenant scoped', () => {
  const s = fs.readFileSync(path.join(root, 'src/routes/evidence.routes.js'), 'utf8');
  assert.match(s, /listByTenant\(req\.tenantId\)/);
  assert.match(s, /evidence\.tenant_id !== req\.tenantId/);
  assert.match(s, /getEvidenceBucket/);
});

test('runner scans task artifact directory for uploadable files', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'artifacts-'));
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'pdf');
  fs.writeFileSync(path.join(nested, 'data.csv'), 'a,b\n1,2\n');

  try {
    const files = runner.listArtifactFiles(dir).map((file) => path.relative(dir, file).replace(/\\/g, '/'));
    assert.deepEqual(files, ['nested/data.csv', 'report.pdf']);
    assert.equal(runner.contentTypeForFile('report.pdf'), 'application/pdf');
    assert.equal(runner.contentTypeForFile('data.csv'), 'text/csv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner artifact upload contract uses existing evidence endpoint', () => {
  const s = fs.readFileSync(path.join(root, 'runner/shadow-runner.js'), 'utf8');
  assert.match(s, /ARTIFACT_UPLOAD:AUTO/);
  assert.match(s, /MAX_ARTIFACT_FILES\s*=\s*20/);
  assert.match(s, /MAX_ARTIFACT_BYTES\s*=\s*10 \* 1024 \* 1024/);
  assert.match(s, /\/api\/runner\/runs\/\$\{encodeURIComponent\(runId\)\}\/evidence/);
  assert.match(s, /type:\s*'FILE'/);
  assert.match(s, /content_base64/);
  assert.match(s, /fs\.rmSync\(dir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/);
});

test('results UI separates summary and technical details', () => {
  const s = fs.readFileSync(path.join(root, 'src/public/artifact-ui.js'), 'utf8');
  assert.match(s, /FINAL RESULT/);
  assert.match(s, /Technical details/);
  assert.match(s, /\/api\/evidence/);
});

test('index exposes artifact UI and real evidence view', () => {
  const s = fs.readFileSync(path.join(root, 'src/public/index.html'), 'utf8');
  assert.match(s, /\/progress\.css[\s\S]*\/artifact-ui\.css/);
  assert.match(s, /id="evidenceList" class="report-list"/);
  assert.match(s, /\/app\.js[\s\S]*\/artifact-ui\.js/);
  assert.match(s, /v(?:0\.3\.(?:7|9)-alpha\.0|0\.4\.0-alpha\.0|0\.4\.0\.[12345])/);
});
