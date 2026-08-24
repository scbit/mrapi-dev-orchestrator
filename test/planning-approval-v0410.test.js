const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  dispatchMission,
  completeBrainRun,
  approveMissionPlan,
  requestMissionPlanChanges,
  getMissionPlan,
  claimNextTask
} = require('../src/services/orchestration');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

class FakeSnapshot {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }

  data() {
    return this._data ? { ...this._data } : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id || db.nextId(collectionName);
  }

  async get() {
    return new FakeSnapshot(this.id, this.db.get(this.collectionName, this.id), this);
  }

  async set(data, options = {}) {
    this.db.set(this.collectionName, this.id, data, options);
  }

  async update(data) {
    this.db.update(this.collectionName, this.id, data);
  }
}

class FakeQuery {
  constructor(db, collectionName, filters = [], max = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.max = max;
  }

  where(field, op, value) {
    assert.equal(op, '==');
    return new FakeQuery(this.db, this.collectionName, [...this.filters, { field, value }], this.max);
  }

  limit(max) {
    return new FakeQuery(this.db, this.collectionName, this.filters, max);
  }

  async get() {
    let docs = Object.entries(this.db.collections[this.collectionName] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new FakeSnapshot(id, data, new FakeDocRef(this.db, this.collectionName, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new FakeQuerySnapshot(docs);
  }
}

class FakeCollection extends FakeQuery {
  constructor(db, collectionName) {
    super(db, collectionName);
  }

  doc(id) {
    return new FakeDocRef(this.db, this.collectionName, id);
  }
}

class FakeTransaction {
  async get(refOrQuery) {
    return refOrQuery.get();
  }

  set(ref, data, options) {
    ref.db.set(ref.collectionName, ref.id, data, options);
  }

  update(ref, data) {
    ref.db.update(ref.collectionName, ref.id, data);
  }
}

class FakeDb {
  constructor() {
    this.collections = {};
    this.counters = {};
    this.failNextApprovedTaskSet = false;
  }

  collection(name) {
    if (!this.collections[name]) this.collections[name] = {};
    return new FakeCollection(this, name);
  }

  nextId(collectionName) {
    this.counters[collectionName] = (this.counters[collectionName] || 0) + 1;
    return `${collectionName}_${this.counters[collectionName]}`;
  }

  get(collectionName, id) {
    return this.collections[collectionName]?.[id] || null;
  }

  set(collectionName, id, data, options = {}) {
    if (this.failNextApprovedTaskSet && collectionName === 'tasks' && data.approved_plan_revision_id) {
      this.failNextApprovedTaskSet = false;
      throw new Error('SIMULATED_TASK_WRITE_FAILURE');
    }
    if (!this.collections[collectionName]) this.collections[collectionName] = {};
    const existing = this.collections[collectionName][id] || {};
    this.collections[collectionName][id] = options.merge ? { ...existing, ...data } : { ...data };
  }

  update(collectionName, id, data) {
    if (!this.collections[collectionName]?.[id]) throw new Error('NOT_FOUND');
    this.collections[collectionName][id] = { ...this.collections[collectionName][id], ...data };
  }

  async runTransaction(fn) {
    return fn(new FakeTransaction());
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function seedPlanningMission(db, workerId = 'W01', missionId = `mission_${workerId}`) {
  db.set('projects', 'project_1', {
    id: 'project_1',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    primary_worker_ids: [workerId]
  });
  db.set('workers', workerId, {
    id: workerId,
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    state: 'IDLE'
  });
  db.set('missions', missionId, {
    id: missionId,
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_1',
    project_id: 'project_1',
    objective: `Plan work for ${workerId}`,
    preferred_worker_id: workerId,
    priority: 'NORMAL',
    state: 'PLANNING',
    planning_mode: 'REQUIRED',
    approval_status: 'PENDING',
    plan_revision_number: 0
  });
}

function planOutput(overrides = {}) {
  const payload = {
    contract: 'MISSION_PLAN_V1',
    objective: overrides.objective || 'Improve the HUB',
    approach: overrides.approach || 'Review the current UI, implement carefully, and verify locally.',
    planned_actions: [
      { title: 'Implement approved change', description: 'Make the requested local change.', executor_required: overrides.requires_execution !== false }
    ],
    expected_deliverables: ['Updated code', 'Test result'],
    risks: ['Regression risk'],
    assumptions: ['Local tests are enough'],
    permissions_required: overrides.permissions_required || [],
    requires_execution: overrides.requires_execution !== false,
    execution_type: overrides.execution_type || (overrides.requires_execution === false ? 'BRAIN_ONLY' : 'EXECUTOR')
  };
  if (overrides.omit_execution_spec !== true) {
    payload.execution_spec = {
      instructions: overrides.instructions || 'Edit the local repository and run node --test.',
      success_criteria: ['Tests pass'],
      stop_conditions: ['Do not deploy']
    };
  }
  return `<MRAPI_PLAN>
${JSON.stringify(payload)}
</MRAPI_PLAN>`;
}

async function readyPlan(db, workerId = 'W01', missionId = `mission_${workerId}`, output = planOutput()) {
  seedPlanningMission(db, workerId, missionId);
  const run = await dispatchMission(db, 'tenant_a', missionId);
  await completeBrainRun(db, 'tenant_a', run.id, { output_text: output });
  return { run, mission: db.get('missions', missionId), plan: values(db, 'mission_plans')[0] };
}

test('v0.4.1.0 planning Brain Run creates revision 1 and no Task before approval', async () => {
  const db = new FakeDb();
  const { run, mission, plan } = await readyPlan(db);

  assert.equal(run.run_type, 'BRAIN_RUN');
  assert.equal(mission.state, 'READY');
  assert.equal(mission.approval_status, 'PENDING');
  assert.equal(mission.plan_revision_number, 1);
  assert.equal(plan.revision, 1);
  assert.equal(plan.status, 'READY');
  assert.equal(values(db, 'tasks').length, 0);
});

test('v0.4.1.0 approval moves Mission running and creates one execution Task idempotently', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_approval');

  const first = await approveMissionPlan(db, 'tenant_a', 'mission_approval', { approved_by: 'test' });
  const second = await approveMissionPlan(db, 'tenant_a', 'mission_approval', { approved_by: 'test' });

  assert.equal(first.success, true);
  assert.equal(db.get('missions', 'mission_approval').state, 'RUNNING');
  assert.equal(db.get('missions', 'mission_approval').approval_status, 'APPROVED');
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(second.reused, true);
  assert.equal(values(db, 'tasks').length, 1);
  assert.match(values(db, 'tasks')[0].task_spec.instructions, /APPROVED PLAN/);
  assert.match(values(db, 'tasks')[0].task_spec.instructions, /node --test/);
});

test('v0.4.1.2 EXECUTOR plan approves, creates one Task, and Runner can claim it', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_executor', planOutput({ execution_type: 'EXECUTOR' }));
  db.set('executors', 'executor_shadow_codex_01', {
    id: 'executor_shadow_codex_01',
    tenant_id: 'tenant_a',
    worker_ids: ['W01'],
    state: 'ONLINE',
    host_name: 'Shadow'
  });
  db.set('worker_profiles', 'profile_W01', {
    id: 'profile_W01',
    tenant_id: 'tenant_a',
    permissions: { allow_git_commit: false, allow_git_push: false }
  });

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_executor', { approved_by: 'test' });
  const tasks = values(db, 'tasks');

  assert.equal(approval.success, true);
  assert.equal(db.get('missions', 'mission_executor').state, 'RUNNING');
  assert.equal(db.get('missions', 'mission_executor').blocked_reason, undefined);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, 'QUEUED');
  assert.equal(tasks[0].brain_output.execution_type, 'EXECUTOR');

  const claim = await claimNextTask(db, 'tenant_a', 'executor_shadow_codex_01', {
    repository_path: 'C:\\repo'
  });
  assert.equal(claim.task.id, tasks[0].id);
  assert.equal(db.get('tasks', tasks[0].id).state, 'RUNNING');
});

test('v0.4.1.2 EXECUTION and CODEX execution types normalize to EXECUTOR', async () => {
  for (const executionType of ['EXECUTION', 'CODEX']) {
    const db = new FakeDb();
    await readyPlan(db, 'W01', `mission_${executionType}`, planOutput({ execution_type: executionType }));

    const approval = await approveMissionPlan(db, 'tenant_a', `mission_${executionType}`, {});

    assert.equal(approval.success, true);
    assert.equal(values(db, 'tasks')[0].brain_output.execution_type, 'EXECUTOR');
    assert.equal(values(db, 'mission_plans')[0].execution_type, 'EXECUTOR');
    assert.equal(values(db, 'mission_plans')[0].execution_type_raw, executionType);
  }
});

test('v0.4.1.2 missing execution_spec blocks with explicit diagnostics', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_missing_spec', planOutput({ omit_execution_spec: true }));

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_missing_spec', {});
  const mission = db.get('missions', 'mission_missing_spec');

  assert.equal(approval.blocked, true);
  assert.equal(approval.blocker_code, 'PLAN_EXECUTION_SPEC_MISSING');
  assert.equal(mission.state, 'BLOCKED');
  assert.equal(mission.blocker_code, 'PLAN_EXECUTION_SPEC_MISSING');
  assert.equal(mission.blocker_stage, 'APPROVAL');
  assert.equal(values(db, 'tasks').length, 0);
});

test('v0.4.1.2 unknown execution type blocks with explicit diagnostics', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_unknown_type', planOutput({ execution_type: 'SHELL_ROBOT' }));

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_unknown_type', {});
  const mission = db.get('missions', 'mission_unknown_type');

  assert.equal(approval.blocked, true);
  assert.equal(approval.blocker_code, 'PLAN_EXECUTION_TYPE_UNKNOWN');
  assert.equal(mission.state, 'BLOCKED');
  assert.equal(mission.blocker_code, 'PLAN_EXECUTION_TYPE_UNKNOWN');
  assert.equal(values(db, 'tasks').length, 0);
});

test('v0.4.1.2 task creation exception persists blocker diagnostics', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_task_failure');
  db.failNextApprovedTaskSet = true;

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_task_failure', {});
  const mission = db.get('missions', 'mission_task_failure');

  assert.equal(approval.blocked, true);
  assert.equal(approval.blocker_code, 'TASK_CREATION_FAILED');
  assert.equal(mission.state, 'BLOCKED');
  assert.equal(mission.blocker_stage, 'TASK_CREATION');
  assert.equal(mission.blocker_message, 'SIMULATED_TASK_WRITE_FAILURE');
});

test('v0.4.1.2 approval retry recovers an approved plan without duplicating Task', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_partial_approval');
  const plan = values(db, 'mission_plans')[0];
  db.set('missions', 'mission_partial_approval', {
    state: 'RUNNING',
    approval_status: 'APPROVED',
    approved_plan_revision_id: plan.id
  }, { merge: true });

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_partial_approval', {});

  assert.equal(approval.success, true);
  assert.equal(values(db, 'tasks').length, 1);
  assert.equal(values(db, 'tasks')[0].approved_plan_revision_id, plan.id);
});

test('v0.4.1.0 request changes preserves revision 1 and revision 2 returns ready', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W02', 'mission_changes');

  const change = await requestMissionPlanChanges(db, 'tenant_a', 'mission_changes', {
    message: 'No deploy; make a backup first.'
  });
  assert.equal(change.requested_revision, 2);
  assert.equal(db.get('missions', 'mission_changes').state, 'PLANNING');
  assert.equal(values(db, 'mission_plans')[0].status, 'SUPERSEDED');

  const secondRun = db.get('runs', change.brain_run_id);
  await completeBrainRun(db, 'tenant_a', secondRun.id, {
    output_text: planOutput({ instructions: 'Make a backup first, then run local tests.' })
  });

  const plans = values(db, 'mission_plans').sort((a, b) => a.revision - b.revision);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].revision, 1);
  assert.equal(plans[0].status, 'SUPERSEDED');
  assert.equal(plans[1].revision, 2);
  assert.equal(db.get('runs', secondRun.id).state, 'COMPLETED');
  assert.equal(db.get('missions', 'mission_changes').state, 'READY');
  assert.equal(db.get('missions', 'mission_changes').approval_status, 'PENDING');
});

test('v0.4.1.0 cannot request changes after execution starts', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W03', 'mission_running');
  await approveMissionPlan(db, 'tenant_a', 'mission_running', {});

  await assert.rejects(
    () => requestMissionPlanChanges(db, 'tenant_a', 'mission_running', { message: 'Change it' }),
    /PLAN_CHANGE_NOT_ALLOWED/
  );
});

test('v0.4.1.0 Brain-only approval completes without fake Task', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W04', 'mission_brain_only_plan', planOutput({ requires_execution: false }));

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_brain_only_plan', {});

  assert.equal(approval.requires_execution, false);
  assert.equal(db.get('missions', 'mission_brain_only_plan').state, 'COMPLETED');
  assert.equal(values(db, 'tasks').length, 0);
  assert.equal(values(db, 'results')[0].result_type, 'BRAIN_RESULT');
});

test('v0.4.1.0 missing high-risk permission blocks approval', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W05', 'mission_permission', planOutput({
    permissions_required: ['production deploy permission']
  }));

  const approval = await approveMissionPlan(db, 'tenant_a', 'mission_permission', {});

  assert.equal(approval.blocked, true);
  assert.equal(db.get('missions', 'mission_permission').state, 'BLOCKED');
  assert.equal(db.get('missions', 'mission_permission').blocked_reason, 'PERMISSION_REQUIRED');
  assert.equal(values(db, 'tasks').length, 0);
});

test('v0.4.1.0 tenant isolation protects plan APIs', async () => {
  const db = new FakeDb();
  await readyPlan(db, 'W01', 'mission_tenant');

  await assert.rejects(() => getMissionPlan(db, 'tenant_b', 'mission_tenant'), /MISSION_NOT_FOUND/);
  await assert.rejects(() => approveMissionPlan(db, 'tenant_b', 'mission_tenant', {}), /MISSION_NOT_FOUND/);
  await assert.rejects(
    () => requestMissionPlanChanges(db, 'tenant_b', 'mission_tenant', { message: 'Change' }),
    /MISSION_NOT_FOUND/
  );
});

test('v0.4.1.2 UI renders blocked diagnostics and legacy fallback reason', () => {
  const source = read('src/public/app.js');
  assert.match(source, /renderBlockerDiagnostics/);
  assert.match(source, /blocker_code/);
  assert.match(source, /Source stage:/);
  assert.match(source, /Block reason unavailable - inspect event\/run history/);
});

test('v0.4.1.2 Brain adapter returns after a stable valid plan response', () => {
  const source = read('brain-adapter/adapters/chatgpt-web.js');
  assert.match(source, /assistant response stable/);
  assert.match(source, /return lastText/);
  assert.doesNotMatch(source, /waitForUser|another user message|REQUEST CHANGES.*wait/i);
  assert.match(read('brain-adapter/lib/prompts.js'), /execution_type must be EXECUTOR/);
  assert.doesNotMatch(read('brain-adapter/lib/prompts.js'), /execution_type must be CODEX/);
});

test('v0.4.1.0 planning approval is common to W01-W05', async () => {
  for (const workerId of ['W01', 'W02', 'W03', 'W04', 'W05']) {
    const db = new FakeDb();
    await readyPlan(db, workerId, `mission_${workerId}`);
    const approval = await approveMissionPlan(db, 'tenant_a', `mission_${workerId}`, {});
    assert.equal(approval.success, true);
    assert.equal(values(db, 'tasks')[0].worker_id, workerId);
  }
});
