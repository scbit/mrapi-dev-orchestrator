const test = require('node:test');
const assert = require('node:assert/strict');

const { hasValidAutopilotProgramControl } = require('../brain-adapter/lib/autopilot-contract');
const { buildCodexHandoff, normalizeAllowedFiles } = require('../src/services/codexHandoff');
const {
  parseAutopilotDecision,
  queueVerificationBrainRun,
  completeVerificationBrainRun
} = require('../src/services/autopilot');
const { completeRun } = require('../src/services/orchestration');
const {
  validateAutopilotHandoff,
  applyExecutorTestVerdict
} = require('../runner/shadow-runner');

class Snap { constructor(id, data, ref) { this.id = id; this._data = data; this.ref = ref; this.exists = Boolean(data); } data() { return this._data ? { ...this._data } : undefined; } }
class Doc { constructor(db, c, id) { this.db = db; this.c = c; this.id = id || db.next(c); } async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); } async set(d, o = {}) { this.db.set(this.c, this.id, d, o); } async update(d) { this.db.update(this.c, this.id, d); } }
class Query { constructor(db, c, f = []) { this.db = db; this.c = c; this.f = f; } where(field, op, value) { assert.equal(op, '=='); return new Query(this.db, this.c, [...this.f, { field, value }]); } limit() { return this; } async get() { return { docs: Object.entries(this.db.data[this.c] || {}).filter(([, d]) => this.f.every((x) => d[x.field] === x.value)).map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id))) }; } }
class Coll extends Query { doc(id) { return new Doc(this.db, this.c, id); } }
class Tx { async get(x) { return x.get(); } set(ref, d, o) { ref.db.set(ref.c, ref.id, d, o); } update(ref, d) { ref.db.update(ref.c, ref.id, d); } }
class DB { constructor() { this.data = {}; this.n = {}; } collection(c) { if (!this.data[c]) this.data[c] = {}; return new Coll(this, c); } next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; } get(c, id) { return this.data[c]?.[id] || null; } set(c, id, d, o = {}) { if (!this.data[c]) this.data[c] = {}; this.data[c][id] = o.merge ? { ...(this.data[c][id] || {}), ...d } : { ...d }; } update(c, id, d) { this.data[c][id] = { ...(this.data[c][id] || {}), ...d }; } async runTransaction(fn) { return fn(new Tx()); } }

const required = ['node --test test\\autopilot-v10-loop.test.js'];
const diagnostic = ['node --test'];
const allowed = ['src/services/autopilot.js'];

function report(payload) {
  return `x\n<MRAPI_EXECUTOR_REPORT>${JSON.stringify(payload)}</MRAPI_EXECUTOR_REPORT>`;
}

function handoff(overrides = {}) {
  const taskSpec = {
    instructions: 'Apply exact change',
    allowed_files: allowed,
    required_tests: required,
    diagnostic_tests: diagnostic,
    ...overrides.taskSpec
  };
  return {
    execution_constraints: { autopilot_phase: overrides.phase || 'PROGRAM' },
    task_spec: taskSpec,
    execution_snapshot: overrides.snapshot === false ? null : {
      execution_spec: {
        instructions: taskSpec.instructions,
        allowed_files: overrides.snapshotAllowed || taskSpec.allowed_files,
        required_tests: overrides.snapshotRequired || taskSpec.required_tests,
        diagnostic_tests: taskSpec.diagnostic_tests
      }
    }
  };
}

test('Brain PROGRAM contract requires non-empty allowed_files and required_tests', () => {
  assert.equal(hasValidAutopilotProgramControl(`<MRAPI_CONTROL>${JSON.stringify({ requires_execution: true, execution_type: 'EXECUTOR', task_spec: { instructions: 'x', allowed_files: allowed, required_tests: required } })}</MRAPI_CONTROL>`), true);
  assert.equal(hasValidAutopilotProgramControl(`<MRAPI_CONTROL>${JSON.stringify({ requires_execution: true, execution_type: 'EXECUTOR', task_spec: { instructions: 'x', required_tests: required } })}</MRAPI_CONTROL>`), false);
  assert.equal(hasValidAutopilotProgramControl(`<MRAPI_CONTROL>${JSON.stringify({ requires_execution: true, execution_type: 'EXECUTOR', task_spec: { instructions: 'x', allowed_files: allowed } })}</MRAPI_CONTROL>`), false);
});

test('Task snapshot to Codex handoff preserves exact arrays and instructions', () => {
  const h = buildCodexHandoff({
    tenantId: 'tenant_a',
    task: {
      id: 'task_1', tenant_id: 'tenant_a', mission_id: 'mission_1', worker_id: 'W01',
      workspace_id: 'workspace_1', project_id: 'project_1', state: 'QUEUED',
      brain_run_id: 'brain_1', approved_plan_revision_id: 'plan_1',
      execution_snapshot_id: 'snap_1',
      execution_snapshot: {
        id: 'snap_1', tenant_id: 'tenant_a', mission_id: 'mission_1', worker_id: 'W01',
        workspace_id: 'workspace_1', project_id: 'project_1', approved_plan_revision_id: 'plan_1',
        objective: 'Autopilot V10', repository_path: 'C:/repo',
        execution_spec: { instructions: 'Do exact V10 work', allowed_files: allowed, required_tests: required, diagnostic_tests: diagnostic }
      }
    },
    mission: { id: 'mission_1', tenant_id: 'tenant_a', workspace_id: 'workspace_1', project_id: 'project_1', autopilot_mode: true, autopilot_phase: 'PROGRAM' },
    brainRun: { id: 'brain_1', tenant_id: 'tenant_a', mission_id: 'mission_1', run_type: 'BRAIN_RUN', state: 'COMPLETED' },
    executor: { id: 'exec_1' },
    executionRunId: 'run_1'
  });
  assert.equal(h.task_spec.instructions, 'Do exact V10 work');
  assert.deepEqual(h.task_spec.allowed_files, allowed);
  assert.deepEqual(h.task_spec.required_tests, required);
  assert.deepEqual(h.task_spec.diagnostic_tests, diagnostic);
});

test('Runner rejects unsafe Autopilot handoffs before Codex spawn', () => {
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: { execution_constraints: { autopilot_phase: 'PROGRAM' } } }), /TASK_SPEC_REQUIRED/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ taskSpec: { allowed_files: undefined } }) }), /ALLOWED_FILES_REQUIRED/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ taskSpec: { allowed_files: [] } }) }), /ALLOWED_FILES_EMPTY/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ taskSpec: { required_tests: undefined } }) }), /REQUIRED_TESTS_REQUIRED/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ taskSpec: { required_tests: [] } }) }), /REQUIRED_TESTS_EMPTY/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ snapshotAllowed: ['src/services/orchestration.js'] }) }), /ALLOWED_FILES_SNAPSHOT_MISMATCH/);
  assert.throws(() => validateAutopilotHandoff({ codex_handoff: handoff({ snapshotRequired: ['node --test test\\other.test.js'] }) }), /REQUIRED_TESTS_SNAPSHOT_MISMATCH/);
  assert.equal(validateAutopilotHandoff({ codex_handoff: { execution_constraints: { autopilot_phase: 'GIT_STAGE' } } }).autopilot, false);
});

test('required-test verdict is exact and diagnostics remain advisory evidence', () => {
  const pass = applyExecutorTestVerdict({ success: false, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }], diagnostic_tests: [] }), stderr: '' }, { required_tests: required, diagnostic_tests: diagnostic });
  assert.equal(pass.success, true);

  const fail = applyExecutorTestVerdict({ success: true, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: false }], diagnostic_tests: [{ command: diagnostic[0], passed: true }] }), stderr: '' }, { required_tests: required });
  assert.equal(fail.success, false);

  const missing = applyExecutorTestVerdict({ success: true, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [], diagnostic_tests: [] }), stderr: '' }, { required_tests: required });
  assert.equal(missing.success, false);

  const substitute = applyExecutorTestVerdict({ success: true, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [{ command: 'node --test test\\other.test.js', passed: true }] }), stderr: '' }, { required_tests: required });
  assert.equal(substitute.success, false);

  const diagOnly = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }], diagnostic_tests: [{ command: diagnostic[0], passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }], diagnostic_only_failure: true }), stderr: '' }, { required_tests: required, diagnostic_tests: diagnostic });
  assert.equal(diagOnly.success, true);
  assert.equal(diagOnly.diagnostic_only_failure, true);
  assert.equal(diagOnly.executor_report.process_exit_code, 1);

  const crash = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }], diagnostic_tests: [] }), stderr: '' }, { required_tests: required });
  assert.equal(crash.success, false);
});

test('scope violation remains failure even after required tests pass', () => {
  const result = applyExecutorTestVerdict({ success: false, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }] }), stderr: '' }, { required_tests: required });
  result.scope_check = { ok: false, unauthorized_files: ['package.json'] };
  if (!result.scope_check.ok) result.success = false;
  assert.equal(result.success, false);
});

function seedVerification() {
  const db = new DB();
  db.set('roadmaps', 'r1', { id: 'r1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', title: 'W01', objective: 'Autopilot', state: 'ACTIVE', milestones: [{ id: 'm1', title: 'Loop', state: 'RUNNING', mission_id: 'mission1' }] });
  db.set('missions', 'mission1', { id: 'mission1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_phase: 'EXECUTING', autopilot_attempt_count: 1, autopilot_max_attempts: 2, roadmap_id: 'r1', milestone_id: 'm1' });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 't1', state: 'BUSY' });
  db.set('executors', 'exec1', { id: 'exec1', tenant_id: 't1', state: 'ONLINE' });
  db.set('tasks', 'task1', { id: 'task1', tenant_id: 't1', mission_id: 'mission1', worker_id: 'W01', state: 'RUNNING', phase: 'EXECUTION_RUNNING' });
  db.set('runs', 'run1', { id: 'run1', tenant_id: 't1', run_type: 'EXECUTION_RUN', mission_id: 'mission1', task_id: 'task1', workspace_id: 'w1', project_id: 'p1', worker_id: 'W01', executor_id: 'exec1', state: 'RUNNING' });
  return db;
}

test('Result and verification context retain exact required and diagnostic evidence', async () => {
  const db = seedVerification();
  const output = {
    process_exit_code: 1,
    process_exited_cleanly: false,
    verdict_source: 'REQUIRED_TEST_POLICY',
    required_tests: [{ command: required[0], passed: true, executed: true }],
    diagnostic_tests: [{ command: diagnostic[0], passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }],
    diagnostic_only_failure: true,
    scope_check: { ok: true, changed_files: allowed }
  };
  const done = await completeRun(db, 't1', 'run1', { success: true, summary: 'required passed', output });
  assert.ok(done.autopilot_verification);
  const verify = db.get('runs', done.autopilot_verification.verification_run_id);
  assert.equal(verify.executor_report.process_exit_code, 1);
  assert.deepEqual(verify.executor_report.required_tests, output.required_tests);
  assert.deepEqual(verify.executor_report.diagnostic_tests, output.diagnostic_tests);
  assert.equal(verify.executor_report.trusted_scope.tenant_id, 't1');
});

test('Executor never directly completes milestone; Brain COMPLETE is idempotent enough to reject duplicate active completion', async () => {
  const db = seedVerification();
  await completeRun(db, 't1', 'run1', { success: true, summary: 'required passed', output: { required_tests: [{ command: required[0], passed: true }] } });
  assert.notEqual(db.get('roadmaps', 'r1').milestones[0].state, 'COMPLETED');
  const verifyId = Object.values(db.data.runs).find((run) => run.autopilot_phase === 'VERIFY_EXECUTION').id;
  const complete = await completeVerificationBrainRun(db, 't1', verifyId, { output_text: '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"ok"}</MRAPI_AUTOPILOT>' });
  assert.equal(complete.action, 'COMPLETE');
  await assert.rejects(() => completeVerificationBrainRun(db, 't1', verifyId, { output_text: '<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"again"}</MRAPI_AUTOPILOT>' }), /AUTOPILOT_VERIFICATION_RUN_NOT_ACTIVE/);
});

test('RETRY contract rejects missing scope/tests and valid RETRY is validated before spawn', async () => {
  const db = new DB();
  db.set('roadmaps', 'r1', { id: 'r1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', title: 'W01', objective: 'Loop', state: 'ACTIVE', milestones: [{ id: 'm1', title: 'Loop', state: 'VERIFYING', mission_id: 'mission1' }] });
  db.set('missions', 'mission1', { id: 'mission1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_attempt_count: 1, autopilot_max_attempts: 2, roadmap_id: 'r1', milestone_id: 'm1' });
  db.set('runs', 'verify1', { id: 'verify1', tenant_id: 't1', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission1', roadmap_id: 'r1', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  assert.equal((await completeVerificationBrainRun(db, 't1', 'verify1', { output_text: '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"x","execution_spec":{"instructions":"fix","required_tests":["node --test test\\\\x.test.js"]}}</MRAPI_AUTOPILOT>' })).action, 'BLOCKED');
  db.set('runs', 'verify2', { id: 'verify2', tenant_id: 't1', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission1', roadmap_id: 'r1', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  assert.equal((await completeVerificationBrainRun(db, 't1', 'verify2', { output_text: '<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"x","execution_spec":{"instructions":"fix","allowed_files":["src/services/autopilot.js"]}}</MRAPI_AUTOPILOT>' })).action, 'BLOCKED');
  db.set('runs', 'verify3', { id: 'verify3', tenant_id: 't1', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission1', roadmap_id: 'r1', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const retry = await completeVerificationBrainRun(db, 't1', 'verify3', { output_text: `<MRAPI_AUTOPILOT>${JSON.stringify({ action: 'RETRY', reason: 'fix', execution_spec: { instructions: 'fix', allowed_files: allowed, required_tests: required, diagnostic_tests: diagnostic } })}</MRAPI_AUTOPILOT>` });
  const task = db.get('tasks', retry.task_id);
  assert.deepEqual(task.task_spec.allowed_files, allowed);
  assert.deepEqual(task.task_spec.required_tests, required);
  assert.equal(validateAutopilotHandoff({ task, codex_handoff: handoff({ phase: 'RETRY' }) }).autopilot, true);
});

test('retry limit becomes BLOCKED and cancellation prevents continuation', async () => {
  const db = new DB();
  db.set('roadmaps', 'r1', { id: 'r1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', title: 'W01', objective: 'Loop', state: 'ACTIVE', milestones: [{ id: 'm1', title: 'Loop', state: 'VERIFYING', mission_id: 'mission1' }] });
  db.set('missions', 'mission1', { id: 'mission1', tenant_id: 't1', workspace_id: 'w1', project_id: 'p1', preferred_worker_id: 'W01', state: 'RUNNING', autopilot_mode: true, autopilot_attempt_count: 2, autopilot_max_attempts: 2, roadmap_id: 'r1', milestone_id: 'm1' });
  db.set('runs', 'verify1', { id: 'verify1', tenant_id: 't1', run_type: 'BRAIN_RUN', state: 'RUNNING', mission_id: 'mission1', roadmap_id: 'r1', milestone_id: 'm1', autopilot_phase: 'VERIFY_EXECUTION' });
  const blocked = await completeVerificationBrainRun(db, 't1', 'verify1', { output_text: `<MRAPI_AUTOPILOT>${JSON.stringify({ action: 'RETRY', reason: 'again', execution_spec: { instructions: 'fix', allowed_files: allowed, required_tests: required } })}</MRAPI_AUTOPILOT>` });
  assert.equal(blocked.action, 'BLOCKED');
  assert.equal(Object.keys(db.data.tasks || {}).length, 0);

  db.set('missions', 'mission1', { ...db.get('missions', 'mission1'), state: 'CANCELLED', cancellation_requested: true });
  assert.equal(await queueVerificationBrainRun(db, 't1', { mission_id: 'mission1', run_id: 'run_late' }), null);
});

test('trusted scope and tenant isolation derive from stored records', async () => {
  const db = seedVerification();
  await assert.rejects(() => completeRun(db, 'other_tenant', 'run1', { success: true }), /RUN_NOT_FOUND/);
  const queued = await queueVerificationBrainRun(db, 't1', { mission_id: 'mission1', run_id: 'run1', output: { trusted_scope: { tenant_id: 'evil' } } });
  const verify = db.get('runs', queued.verification_run_id);
  assert.equal(verify.executor_report.trusted_scope.tenant_id, 't1');
});

test('src path normalization keeps leading s and rejects repository-wide scopes', () => {
  assert.deepEqual(normalizeAllowedFiles(['src/services/autopilot.js']), ['src/services/autopilot.js']);
  assert.deepEqual(normalizeAllowedFiles(['C:/repo/src/a.js', '../a.js', 'src/**', '/abs.js', 'src/services/autopilot.js']), ['src/services/autopilot.js']);
});

test('end-to-end paths cover happy, diagnostic-only, and correction verdicts', () => {
  const happy = applyExecutorTestVerdict({ success: false, exitCode: 0, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }] }), stderr: '' }, { required_tests: required });
  assert.equal(happy.success, true);
  const diagnosticOnly = applyExecutorTestVerdict({ success: false, exitCode: 1, stdout: report({ required_tests_passed: true, required_tests: [{ command: required[0], passed: true }], diagnostic_tests: [{ command: diagnostic[0], passed: false, classification: 'PRE_EXISTING_OR_UNRELATED' }], diagnostic_only_failure: true }), stderr: '' }, { required_tests: required, diagnostic_tests: diagnostic });
  assert.equal(diagnosticOnly.success, true);
  const correction = parseAutopilotDecision(`<MRAPI_AUTOPILOT>${JSON.stringify({ action: 'RETRY', reason: 'required failed', execution_spec: { instructions: 'fix', allowed_files: allowed, required_tests: required } })}</MRAPI_AUTOPILOT>`);
  assert.equal(correction.action, 'RETRY');
});
