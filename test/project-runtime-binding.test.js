const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runtimeBinding, runtimeMissing, runtimeReady, projectRuntimePayload
} = require('../src/services/projectRuntime');

test('runtime binding is fail closed when repo is missing', () => {
  const p = { runtime_context: { host_name: 'Shadow', binding_state: 'READY' } };
  assert.deepEqual(runtimeMissing(p), ['repository_full_name', 'repository_path']);
  assert.equal(runtimeReady(p), false);
});

test('configured project runtime becomes READY', () => {
  const out = projectRuntimePayload({
    repository_full_name: 'scbit/mrapi-scb-supervisor',
    repository_path: 'C:\\Users\\Shadow\\Documents\\GitHub\\mrapi-scb-supervisor',
    host_name: 'Shadow',
    default_branch: 'main'
  }, {});
  assert.equal(out.runtime_binding_state, 'READY');
  assert.equal(runtimeReady(out), true);
  assert.equal(runtimeBinding(out).repository_full_name, 'scbit/mrapi-scb-supervisor');
});

test('path remains project-specific', () => {
  const a = projectRuntimePayload({ repository_full_name:'scbit/a', repository_path:'C:\\GitHub\\a', host_name:'Shadow' }, {});
  const b = projectRuntimePayload({ repository_full_name:'scbit/b', repository_path:'C:\\GitHub\\b', host_name:'Shadow' }, {});
  assert.notEqual(runtimeBinding(a).repository_path, runtimeBinding(b).repository_path);
});
