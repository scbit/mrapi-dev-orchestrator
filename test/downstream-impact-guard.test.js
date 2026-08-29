const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDownstreamImpactProposal,
  latestDownstreamImpactProposal,
  listDownstreamImpactProposals,
  updateDownstreamImpactStatus
} = require('../src/services/downstreamImpact');
const { resolveMilestoneRuntime } = require('../src/services/milestoneRuntime');
const { recoverMission } = require('../src/services/missionRecovery');

class Snap {
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

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class Doc {
  constructor(db, collectionName, id) {
    this.db = db;
    this.c = collectionName;
    this.collectionName = collectionName;
    this.id = id || db.next(collectionName);
  }
  async get() {
    return new Snap(this.id, this.db.get(this.c, this.id), this);
  }
  async set(data, options = {}) {
    this.db.write('set', this.c, this.id, data, options);
  }
  async update(data) {
    this.db.write('update', this.c, this.id, data);
  }
}

class Query {
  constructor(db, collectionName, filters = [], max = null) {
    this.db = db;
    this.c = collectionName;
    this.collectionName = collectionName;
    this.filters = filters;
    this.max = max;
  }
  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.c, [...this.filters, { field, value }], this.max);
  }
  limit(max) {
    return new Query(this.db, this.c, this.filters, max);
  }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snap(id, data, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) {
    return new Doc(this.db, this.c, id);
  }
}

class Tx {
  constructor(db) {
    this.db = db;
    this.hasWritten = false;
  }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options = {}) {
    this.hasWritten = true;
    this.db.write('set', ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    this.db.write('update', ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor() {
    this.collections = {};
    this.n = {};
    this.writes = [];
  }
  collection(name) {
    return new Coll(this, name);
  }
  next(name) {
    this.n[name] = (this.n[name] || 0) + 1;
    return `${name}_${this.n[name]}`;
  }
  get(name, id) {
    return this.collections[name]?.[id] || null;
  }
  set(name, id, data, options = {}) {
    if (!this.collections[name]) this.collections[name] = {};
    this.collections[name][id] = options.merge
      ? { ...(this.collections[name][id] || {}), ...data }
      : { ...data };
  }
  write(method, collectionName, id, data, options = {}) {
    this.writes.push({ method, collectionName, id, data, options });
    this.set(collectionName, id, data, options);
  }
  update(name, id, data) {
    if (!this.collections[name]?.[id]) throw new Error('NOT_FOUND');
    this.collections[name][id] = { ...this.collections[name][id], ...data };
  }
  async runTransaction(fn) {
    return fn(new Tx(this));
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function seed(db, overrides = {}) {
  const roadmap = {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Guard Roadmap',
    objective: 'Protect downstream milestones',
    state: 'ACTIVE',
    milestones: [
      { id: 'm1', title: 'One', objective: 'First', description: 'First desc', state: 'COMPLETED', order: 1, depends_on: [], dependencies: [] },
      { id: 'm2', title: 'Two', objective: 'Current', description: 'Current desc', state: 'BLOCKED', order: 2, depends_on: ['m1'], dependencies: ['m1'], mission_id: 'mission_a' },
      { id: 'm3', title: 'Three', objective: 'Later one', description: 'Later one desc', state: 'PENDING', order: 3, depends_on: ['m2'], dependencies: ['m2'] },
      { id: 'm4', title: 'Four', objective: 'Later two', description: 'Later two desc', state: 'PENDING', order: 4, depends_on: ['m3'], dependencies: ['m3'] }
    ],
    ...(overrides.roadmap || {})
  };
  db.set('roadmaps', roadmap.id, roadmap);
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    objective: 'Recover current milestone',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2',
    brain_context: { existing: 'keep' },
    ...(overrides.mission || {})
  });
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'FAILED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2'
  });
  return roadmap;
}

async function createProposal(db, input = {}) {
  return createDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm2', {
    affected_milestone_ids: ['m3', 'm4'],
    reason: 'Current milestone changes later assumptions.',
    ...input
  });
}

async function assertRejectsWithoutWrites(db, fn, message) {
  const before = clone(db.collections);
  await assert.rejects(fn, (error) => error.message === message);
  assert.deepEqual(clone(db.collections), before);
}

test('creating a proposal persists exact pending downstream-impact evidence and creates no work', async () => {
  const db = new DB();
  seed(db);
  const beforeCounts = counts(db);

  const proposal = await createProposal(db);
  const stored = db.get('evidence', proposal.impact_id);

  assert.equal(stored.status, 'PENDING_APPROVAL');
  assert.equal(stored.type, 'DOWNSTREAM_IMPACT');
  assert.equal(stored.tenant_id, 'tenant_a');
  assert.equal(stored.roadmap_id, 'roadmap_a');
  assert.equal(stored.source_milestone_id, 'm2');
  assert.equal(stored.mission_id, 'mission_a');
  assert.deepEqual(stored.affected_milestone_ids, ['m3', 'm4']);
  assert.equal(stored.reason, 'Current milestone changes later assumptions.');
  assert.equal(stored.approval, null);
  assert.ok(stored.created_at);
  assert.ok(stored.updated_at);
  assert.deepEqual(counts(db), beforeCounts);
});

test('proposal creation performs zero mutation to Roadmap and milestone contents', async () => {
  const db = new DB();
  seed(db);
  const beforeRoadmap = clone(db.get('roadmaps', 'roadmap_a'));
  const beforeMission = clone(db.get('missions', 'mission_a'));

  await createProposal(db, { proposed_changes: { m3: { objective: 'Only metadata' } } });

  assert.deepEqual(clone(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
  assert.deepEqual(clone(db.get('missions', 'mission_a')), beforeMission);
});

test('invalid affected milestone IDs fail closed and write nothing', async () => {
  const db = new DB();
  seed(db);

  await assertRejectsWithoutWrites(db, () => createProposal(db, { affected_milestone_ids: ['missing'] }), 'AFFECTED_MILESTONE_NOT_FOUND');
  await assertRejectsWithoutWrites(db, () => createProposal(db, { affected_milestone_ids: ['m2'] }), 'SOURCE_MILESTONE_CANNOT_BE_AFFECTED');
  await assertRejectsWithoutWrites(db, () => createProposal(db, { affected_milestone_ids: ['m1'] }), 'AFFECTED_MILESTONE_NOT_DOWNSTREAM');
  await assertRejectsWithoutWrites(db, () => createProposal(db, { affected_milestone_ids: ['m3', 'm3'] }), 'DUPLICATE_AFFECTED_MILESTONE_ID');
});

test('mission provenance mismatch is rejected and writes nothing', async () => {
  const db = new DB();
  seed(db);
  db.set('missions', 'mission_other', {
    id: 'mission_other',
    tenant_id: 'tenant_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm3'
  });

  await assertRejectsWithoutWrites(
    db,
    () => createProposal(db, { mission_id: 'mission_other' }),
    'MISSION_PROVENANCE_MISMATCH'
  );
});

test('approval changes only proposal status and approval metadata', async () => {
  const db = new DB();
  seed(db);
  const proposal = await createProposal(db);
  const beforeRoadmap = clone(db.get('roadmaps', 'roadmap_a'));
  const beforeMission = clone(db.get('missions', 'mission_a'));
  const beforeCounts = counts(db);

  const approved = await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm2', proposal.impact_id, 'APPROVED', {
    actor: 'human_a'
  });
  const stored = db.get('evidence', proposal.impact_id);

  assert.equal(approved.status, 'APPROVED');
  assert.equal(stored.status, 'APPROVED');
  assert.equal(stored.approved_by, 'human_a');
  assert.equal(stored.approval_source, 'HUMAN');
  assert.ok(stored.approved_at);
  assert.deepEqual(clone(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
  assert.deepEqual(clone(db.get('missions', 'mission_a')), beforeMission);
  assert.deepEqual(counts(db), beforeCounts);
});

test('rejection changes only proposal status and rejection metadata', async () => {
  const db = new DB();
  seed(db);
  const proposal = await createProposal(db);
  const beforeRoadmap = clone(db.get('roadmaps', 'roadmap_a'));

  const rejected = await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm2', proposal.impact_id, 'REJECTED', {
    actor: 'human_b'
  });
  const stored = db.get('evidence', proposal.impact_id);

  assert.equal(rejected.status, 'REJECTED');
  assert.equal(stored.status, 'REJECTED');
  assert.equal(stored.rejected_by, 'human_b');
  assert.equal(stored.rejection_source, 'HUMAN');
  assert.ok(stored.rejected_at);
  assert.deepEqual(clone(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
});

test('milestoneRuntime exposes pending and approved impact status without mutating downstream content', async () => {
  const db = new DB();
  const roadmap = seed(db);
  const proposal = await createProposal(db);

  const pending = await resolveMilestoneRuntime(db, 'tenant_a', roadmap, roadmap.milestones[1]);
  assert.equal(pending.downstream_impact.status, 'PENDING_APPROVAL');
  assert.equal(pending.downstream_impact.approval_required, true);
  assert.deepEqual(pending.downstream_impact.affected_milestone_ids, ['m3', 'm4']);
  assert.equal(pending.downstream_impact.reason, 'Current milestone changes later assumptions.');

  const beforeRoadmap = clone(db.get('roadmaps', 'roadmap_a'));
  await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm2', proposal.impact_id, 'APPROVED');
  const approved = await resolveMilestoneRuntime(db, 'tenant_a', roadmap, roadmap.milestones[1]);

  assert.equal(approved.downstream_impact.status, 'APPROVED');
  assert.equal(approved.downstream_impact.approval_required, false);
  assert.deepEqual(clone(db.get('roadmaps', 'roadmap_a')), beforeRoadmap);
});

test('BRAIN_REPLAY preserves mission_id and receives additive structured downstream-impact context', async () => {
  const db = new DB();
  seed(db);
  await createProposal(db, { affected_milestone_ids: ['m3'], reason: 'm3 must be reviewed.' });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);

  assert.equal(replay.mode, 'BRAIN_REPLAY');
  assert.equal(replay.mission_id, 'mission_a');
  assert.equal(run.mission_id, 'mission_a');
  assert.equal(run.brain_context.existing, 'keep');
  assert.deepEqual(run.brain_context.downstream_impact, {
    detected: true,
    status: 'PENDING_APPROVAL',
    approval_required: true,
    impact_id: 'evidence_1',
    roadmap_id: 'roadmap_a',
    source_milestone_id: 'm2',
    mission_id: 'mission_a',
    affected_milestones: ['m3'],
    affected_milestone_ids: ['m3'],
    reason: 'm3 must be reviewed.'
  });
});

test('foreign downstream-impact proposals are not injected into Brain context', async () => {
  const db = new DB();
  seed(db);
  db.set('evidence', 'wrong_tenant', { id: 'wrong_tenant', type: 'DOWNSTREAM_IMPACT', tenant_id: 'tenant_b', roadmap_id: 'roadmap_a', source_milestone_id: 'm2', mission_id: 'mission_a', status: 'PENDING_APPROVAL', affected_milestone_ids: ['m3'], reason: 'wrong tenant' });
  db.set('evidence', 'wrong_roadmap', { id: 'wrong_roadmap', type: 'DOWNSTREAM_IMPACT', tenant_id: 'tenant_a', roadmap_id: 'roadmap_b', source_milestone_id: 'm2', mission_id: 'mission_a', status: 'PENDING_APPROVAL', affected_milestone_ids: ['m3'], reason: 'wrong roadmap' });
  db.set('evidence', 'wrong_milestone', { id: 'wrong_milestone', type: 'DOWNSTREAM_IMPACT', tenant_id: 'tenant_a', roadmap_id: 'roadmap_a', source_milestone_id: 'm1', mission_id: 'mission_a', status: 'PENDING_APPROVAL', affected_milestone_ids: ['m3'], reason: 'wrong milestone' });
  db.set('evidence', 'wrong_mission', { id: 'wrong_mission', type: 'DOWNSTREAM_IMPACT', tenant_id: 'tenant_a', roadmap_id: 'roadmap_a', source_milestone_id: 'm2', mission_id: 'mission_b', status: 'PENDING_APPROVAL', affected_milestone_ids: ['m3'], reason: 'wrong mission' });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);

  assert.equal(Object.hasOwn(run.brain_context, 'downstream_impact'), false);
});

test('without a downstream-impact proposal BRAIN_REPLAY does not fabricate context', async () => {
  const db = new DB();
  seed(db);

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);

  assert.equal(replay.mode, 'BRAIN_REPLAY');
  assert.equal(run.brain_context.existing, 'keep');
  assert.equal(Object.hasOwn(run.brain_context, 'downstream_impact'), false);
});

test('Roadmap ID, milestone IDs, ordering, dependencies and later fields stay deep-equal after detection', async () => {
  const db = new DB();
  seed(db);
  const before = clone(db.get('roadmaps', 'roadmap_a'));

  await createProposal(db, { affected_milestone_ids: ['m3'] });

  const after = clone(db.get('roadmaps', 'roadmap_a'));
  assert.equal(after.id, before.id);
  assert.deepEqual(after.milestones.map((item) => item.id), before.milestones.map((item) => item.id));
  assert.deepEqual(after.milestones.map((item) => item.order), before.milestones.map((item) => item.order));
  assert.deepEqual(after.milestones.map((item) => item.depends_on), before.milestones.map((item) => item.depends_on));
  assert.deepEqual(after.milestones.slice(2), before.milestones.slice(2));
  assert.deepEqual(after, before);
});

test('refresh and re-read from persisted DB preserves proposal status', async () => {
  const db = new DB();
  seed(db);
  const pending = await createProposal(db);
  assert.equal((await latestDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm2', { missionId: 'mission_a' })).status, 'PENDING_APPROVAL');

  await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm2', pending.impact_id, 'APPROVED');
  assert.equal((await latestDownstreamImpactProposal(db, 'tenant_a', 'roadmap_a', 'm2', { missionId: 'mission_a' })).status, 'APPROVED');

  const second = await createProposal(db, { affected_milestone_ids: ['m4'], reason: 'Second proposal.' });
  await updateDownstreamImpactStatus(db, 'tenant_a', 'roadmap_a', 'm2', second.impact_id, 'REJECTED');
  const all = await listDownstreamImpactProposals(db, 'tenant_a', 'roadmap_a', 'm2', { missionId: 'mission_a' });

  assert.deepEqual(all.map((item) => item.status).sort(), ['APPROVED', 'REJECTED']);
});
