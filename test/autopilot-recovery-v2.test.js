const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { recoverMission } = require('../src/services/missionRecovery');
const {
  continueRoadmapAfterComplete,
  completeVerificationBrainRun
} = require('../src/services/autopilot');
const { queueVerificationBrainRun } = require('../src/services/autopilot');

class Snap {
  constructor(id, data, ref = null) { this.id = id; this._data = data; this.ref = ref; this.exists = Boolean(data); }
  data() { return this._data ? { ...this._data } : undefined; }
}
class QuerySnap { constructor(docs) { this.docs = docs; this.empty = docs.length === 0; } }
class Doc {
  constructor(db, c, id) { this.db = db; this.c = c; this.collectionName = c; this.id = id || db.next(c); }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(d, o = {}) { this.db.set(this.c, this.id, d, o); }
  async update(d) { this.db.update(this.c, this.id, d); }
}
class Query {
  constructor(db, c, filters = [], max = null) { this.db = db; this.c = c; this.collectionName = c; this.filters = filters; this.max = max; }
  where(field, op, value) { assert.equal(op, '=='); return new Query(this.db, this.c, [...this.filters, { field, value }], this.max); }
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, d]) => this.filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => new Snap(id, d, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}
class Coll extends Query { doc(id) { return new Doc(this.db, this.c, id); } }
class Tx {
  constructor() { this.hasWritten = false; }
  async get(x) { if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE'); return x.get(); }
  set(ref, d, o) { this.hasWritten = true; ref.db.set(ref.c || ref.collectionName, ref.id, d, o); }
  update(ref, d) { this.hasWritten = true; ref.db.update(ref.c || ref.collectionName, ref.id, d); }
}
class DB {
  constructor() { this.collections = {}; this.n = {}; }
  collection(c) { if (!this.collections[c]) this.collections[c] = {}; return new Coll(this, c); }
  next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, d, o = {}) { if (!this.collections[c]) this.collections[c] = {}; this.collections[c][id] = o.merge ? { ...(this.collections[c][id] || {}), ...d } : { ...d }; }
  update(c, id, d) { if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND'); this.collections[c][id] = { ...this.collections[c][id], ...d }; }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, c) { return Object.values(db.collections[c] || {}); }
function counts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}
function roadmap(db) { return db.get('roadmaps', 'roadmap_a'); }
function mission(db) { return db.get('missions', 'mission_a'); }
function currentMilestone(db) { return roadmap(db).milestones.find((m) => m.id === 'm1'); }
function nextMilestone(db) { return roadmap(db).milestones.find((m) => m.id === 'm2'); }
function seedBase(db, overrides = {}) {
  db.set('projects', 'project_a', { id: 'project_a', tenant_id: 'tenant_a', workspace_id: 'workspace_a', default_worker_id: 'W01', local_path: 'C:/repo' });
  db.set('workers', 'W01', { id: 'W01', tenant_id: 'tenant_a', state: 'IDLE' });
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    auto_advance: true,
    milestones: [
      { id: 'm1', title: 'Current', state: 'BLOCKED', order: 1, depends_on: [], mission_id: 'mission_a' },
      { id: 'm2', title: 'Next', state: 'PENDING', order: 2, depends_on: ['m1'] }
    ],
    ...(overrides.roadmap || {})
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    objective: 'Recover same mission',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    ...(overrides.mission || {})
  });
}
function seedBrainFailure(db, overrides = {}) {
  seedBase(db, overrides);
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'FAILED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    attempt: 1,
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    ...(overrides.brain || {})
  });
}
function seedExecutionFailure(db, overrides = {}) {
  seedBase(db, { mission: { state: 'FAILED', approved_execution_snapshot_id: 'snapshot_a', current_plan_revision_id: 'plan_a', brain_run_id: 'brain_a', ...(overrides.mission || {}) }, roadmap: overrides.roadmap });
  db.set('execution_snapshots', 'snapshot_a', {
    id: 'snapshot_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    execution_type: 'EXECUTOR',
    approved_plan_revision_id: 'plan_a',
    approved_plan_revision_number: 1,
    execution_spec: { title: 'Retry', objective: 'Retry', instructions: 'Retry same mission.', allowed_files: ['src/services/autopilot.js'], required_tests: ['node --test test/autopilot-recovery-v2.test.js'] }
  });
  db.set('tasks', 'task_failed', { id: 'task_failed', tenant_id: 'tenant_a', mission_id: 'mission_a', state: 'FAILED', execution_snapshot_id: 'snapshot_a', attempt_count: 1, current_run_id: 'exec_failed' });
  db.set('runs', 'exec_failed', { id: 'exec_failed', tenant_id: 'tenant_a', run_type: 'EXECUTION_RUN', mission_id: 'mission_a', task_id: 'task_failed', state: 'FAILED' });
}
function seedResolvedHumanAction(db, status = 'RESOLVED') {
  const checkpoint = { checkpoint_id: 'checkpoint_a', status, waiting_status: status, paused_from_phase: 'PROGRAM', mission_id: 'mission_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', generation: 1 };
  seedBase(db, {
    mission: { state: 'NEED_HUMAN_ACTION', autopilot_phase: 'NEED_HUMAN_ACTION', human_action_required: status !== 'RESOLVED', human_action_checkpoint: checkpoint, brain_run_id: 'brain_a' },
    roadmap: { milestones: [{ id: 'm1', title: 'Current', state: 'NEED_HUMAN_ACTION', order: 1, depends_on: [], mission_id: 'mission_a', human_action_checkpoint: checkpoint }, { id: 'm2', title: 'Next', state: 'PENDING', order: 2, depends_on: ['m1'] }] }
  });
  db.set('runs', 'brain_a', {
    id: 'brain_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'COMPLETED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    worker_id: 'W01',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    brain_output: { objective: 'Resume', worker_id: 'W01', requires_execution: true, execution_type: 'EXECUTOR', task_spec: { title: 'Resume', objective: 'Resume', instructions: 'Resume same mission.', allowed_files: ['src/services/autopilot.js'], required_tests: ['node --test test/autopilot-recovery-v2.test.js'] } }
  });
  return checkpoint;
}
function autopilotComplete(reason = 'verified') {
  return `<MRAPI_AUTOPILOT>${JSON.stringify({ action: 'COMPLETE', reason })}</MRAPI_AUTOPILOT>`;
}

test('A/B BRAIN_REPLAY preserves exact identity, creates a new Brain Run, and no Mission', async () => {
  const db = new DB();
  seedBrainFailure(db);
  const before = counts(db);
  const out = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', out.brain_run_id);
  assert.equal(out.mode, 'BRAIN_REPLAY');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(run.tenant_id, 'tenant_a');
  assert.equal(run.roadmap_id, 'roadmap_a');
  assert.equal(run.milestone_id, 'm1');
  assert.equal(run.mission_id, 'mission_a');
  assert.equal(run.retry_of_run_id, 'brain_failed');
  assert.equal(run.recovery_mode, 'BRAIN_REPLAY');
  assert.equal(counts(db).missions, before.missions);
  assert.equal(counts(db).brainRuns, before.brainRuns + 1);
});

test('C repeated BRAIN_REPLAY while active reuses same Brain Run', async () => {
  const db = new DB();
  seedBrainFailure(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const after = counts(db);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.equal(second.mode, 'BRAIN_REPLAY');
  assert.equal(second.reused, true);
  assert.equal(second.brain_run_id, first.brain_run_id);
  assert.deepEqual(counts(db), after);
});

test('D terminal prior replay does not block later replay generation', async () => {
  const db = new DB();
  seedBrainFailure(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  db.set('runs', first.brain_run_id, { state: 'FAILED' }, { merge: true });
  db.set('missions', 'mission_a', { state: 'BLOCKED', blocker_code: 'BRAIN_AGAIN' }, { merge: true });
  db.set('roadmaps', 'roadmap_a', { milestones: [{ ...currentMilestone(db), state: 'BLOCKED' }, nextMilestone(db)] }, { merge: true });
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.notEqual(second.brain_run_id, first.brain_run_id);
  assert.equal(counts(db).missions, 1);
  assert.equal(counts(db).brainRuns, 3);
});

test('E/F/G EXECUTION_RETRY creates same-Mission retry Task and reuses active work', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  const before = counts(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const after = counts(db);
  const task = db.get('tasks', first.task_id);
  assert.equal(first.mode, 'EXECUTION_RETRY');
  assert.equal(task.mission_id, 'mission_a');
  assert.equal(task.retry_of_task_id, 'task_failed');
  assert.equal(counts(db).missions, before.missions);
  assert.equal(after.tasks, before.tasks + 1);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.equal(second.reused, true);
  assert.equal(second.task_id, first.task_id);
  assert.deepEqual(counts(db), after);
});

test('H failed retry leaves same Mission recoverable and does not create later milestone Mission', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  db.set('tasks', first.task_id, { state: 'FAILED' }, { merge: true });
  db.set('missions', 'mission_a', { state: 'FAILED' }, { merge: true });
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(nextMilestone(db).mission_id, undefined);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.equal(second.mode, 'EXECUTION_RETRY');
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(nextMilestone(db).mission_id, undefined);
});

test('I HUMAN_ACTION_RESUME before resolution creates no work and preserves NEED_HUMAN_ACTION', async () => {
  const db = new DB();
  seedResolvedHumanAction(db, 'WAITING_FOR_HUMAN');
  const before = counts(db);
  const out = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.equal(out.mode, 'HUMAN_ACTION_RESUME');
  assert.equal(out.no_new_work, true);
  assert.equal(mission(db).state, 'NEED_HUMAN_ACTION');
  assert.deepEqual(counts(db), before);
});

test('J/K/L HUMAN_ACTION_RESUME after trusted resolution preserves lineage and is idempotent', async () => {
  const db = new DB();
  const checkpoint = seedResolvedHumanAction(db);
  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const after = counts(db);
  const task = db.get('tasks', first.task_id);
  const updated = currentMilestone(db).human_action_checkpoint;
  assert.equal(first.mission_id, 'mission_a');
  assert.equal(first.roadmap_id, 'roadmap_a');
  assert.equal(first.milestone_id, 'm1');
  assert.equal(task.mission_id, 'mission_a');
  assert.equal(task.human_action_checkpoint_id, checkpoint.checkpoint_id);
  assert.equal(updated.checkpoint_id, checkpoint.checkpoint_id);
  assert.equal(updated.generation, 1);
  assert.equal(updated.continuation_task_id, first.task_id);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');
  assert.equal(second.reused, true);
  assert.equal(second.task_id, first.task_id);
  assert.deepEqual(counts(db), after);
});

test('M/N/O/P/Q provenance mismatches fail closed without replacement Mission or rewrite', async () => {
  for (const mutate of [
    (db) => db.set('roadmaps', 'roadmap_a', { milestones: [{ ...currentMilestone(db), mission_id: 'other_mission' }, nextMilestone(db)] }, { merge: true }),
    (db) => db.set('missions', 'mission_a', { tenant_id: 'tenant_b' }, { merge: true }),
    (db) => db.set('missions', 'mission_a', { roadmap_id: 'other_roadmap' }, { merge: true }),
    (db) => db.set('missions', 'mission_a', { milestone_id: 'other_milestone' }, { merge: true })
  ]) {
    const db = new DB();
    seedBrainFailure(db);
    mutate(db);
    const beforeCounts = counts(db);
    const beforeMission = JSON.stringify(db.get('missions', 'mission_a'));
    const beforeMilestoneMissionId = currentMilestone(db)?.mission_id;
    await assert.rejects(() => recoverMission(db, 'tenant_a', 'mission_a'), /RECOVERY_/);
    assert.deepEqual(counts(db), beforeCounts);
    assert.equal(JSON.stringify(db.get('missions', 'mission_a')), beforeMission);
    assert.equal(currentMilestone(db)?.mission_id, beforeMilestoneMissionId);
    assert.equal(values(db, 'missions').length, 1);
  }
});

test('R recoverable current milestone blocks later advancement while unresolved', async () => {
  for (const state of ['BLOCKED', 'FAILED', 'WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION', 'RETRYABLE']) {
    const db = new DB();
    seedBase(db, { roadmap: { milestones: [{ id: 'm0', title: 'Done', state: 'COMPLETED', order: 0 }, { id: 'm1', title: 'Current', state, order: 1, depends_on: ['m0'], mission_id: 'mission_a' }, { id: 'm2', title: 'Next', state: 'PENDING', order: 2, depends_on: ['m1'] }] } });
    const out = await continueRoadmapAfterComplete(db, 'tenant_a', 'roadmap_a', 'm0', { mission_id: 'mission_a' });
    assert.notEqual(out.continuation_state, 'STARTED');
    assert.equal(values(db, 'missions').length, 1);
    assert.equal(roadmap(db).milestones[2].mission_id, undefined);
  }
});

test('S/T recovery handlers do not directly call roadmap continuation authority', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/missionRecovery.js'), 'utf8');
  assert.equal(source.includes('startNextRoadmapMilestone'), false);
  assert.equal(source.includes('continueRoadmapAfterComplete'), false);
});

test('U/V/W/X recovered same Mission can verify COMPLETE and m2 continues once only when enabled', async () => {
  const db = new DB();
  seedExecutionFailure(db);
  const retry = await recoverMission(db, 'tenant_a', 'mission_a');
  const verify = await queueVerificationBrainRun(db, 'tenant_a', {
    success: true,
    mission_id: 'mission_a',
    task_id: retry.task_id,
    run_id: 'retry_exec_pass',
    result_id: 'retry_result',
    summary: 'retry passed',
    output: { required_tests: [{ command: 'node --test test/autopilot-recovery-v2.test.js', passed: true }] }
  });
  const complete = await completeVerificationBrainRun(db, 'tenant_a', verify.verification_run_id, { output_text: autopilotComplete() });
  assert.equal(complete.action, 'COMPLETE');
  assert.equal(complete.next_milestone_id, 'm2');
  assert.equal(values(db, 'missions').length, 2);
  const replay = await completeVerificationBrainRun(db, 'tenant_a', verify.verification_run_id, { output_text: autopilotComplete() });
  assert.equal(replay.replayed, true);
  assert.equal(values(db, 'missions').length, 2);

  const disabled = new DB();
  seedExecutionFailure(disabled, { roadmap: { auto_advance: false } });
  const retryDisabled = await recoverMission(disabled, 'tenant_a', 'mission_a');
  const verifyDisabled = await queueVerificationBrainRun(disabled, 'tenant_a', { success: true, mission_id: 'mission_a', task_id: retryDisabled.task_id, run_id: 'exec', result_id: 'result', summary: 'ok', output: {} });
  const completeDisabled = await completeVerificationBrainRun(disabled, 'tenant_a', verifyDisabled.verification_run_id, { output_text: autopilotComplete() });
  assert.equal(completeDisabled.continuation_state, 'DISABLED');
  assert.equal(values(disabled, 'missions').length, 1);
});

test('Y recovered COMPLETE requiring Git stage waits until Git stage completion', async () => {
  const db = new DB();
  seedExecutionFailure(db, { mission: { git_automation_enabled: true } });
  const retry = await recoverMission(db, 'tenant_a', 'mission_a');
  db.set('tasks', retry.task_id, { task_spec: { allowed_files: ['src/services/autopilot.js'] } }, { merge: true });
  const verify = await queueVerificationBrainRun(db, 'tenant_a', { success: true, mission_id: 'mission_a', task_id: retry.task_id, run_id: 'exec_git', result_id: 'result_git', summary: 'ok', output: {} });
  const out = await completeVerificationBrainRun(db, 'tenant_a', verify.verification_run_id, { output_text: autopilotComplete() });
  assert.equal(out.action, 'GIT_STAGE');
  assert.equal(out.continuation_state, 'GIT_STAGE_PENDING');
  assert.equal(nextMilestone(db).mission_id, undefined);
  assert.equal(values(db, 'missions').length, 1);
});

test('Z Mission count remains unchanged during replay/retry/resume and changes only after trusted continuation', async () => {
  const replayDb = new DB();
  seedBrainFailure(replayDb);
  const replayBefore = counts(replayDb).missions;
  await recoverMission(replayDb, 'tenant_a', 'mission_a');
  assert.equal(counts(replayDb).missions, replayBefore);

  const retryDb = new DB();
  seedExecutionFailure(retryDb);
  const retryBefore = counts(retryDb).missions;
  await recoverMission(retryDb, 'tenant_a', 'mission_a');
  assert.equal(counts(retryDb).missions, retryBefore);

  const resumeDb = new DB();
  seedResolvedHumanAction(resumeDb);
  const resumeBefore = counts(resumeDb).missions;
  await recoverMission(resumeDb, 'tenant_a', 'mission_a');
  assert.equal(counts(resumeDb).missions, resumeBefore);
});
