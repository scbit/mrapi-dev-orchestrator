const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deterministicBrainRunId,
  recoverResolvedPreBrainProgramContinuation
} = require('../src/services/preBrainHumanActionResume');

class Snap {
  constructor(id, data) { this.id = id; this._data = data; this.exists = Boolean(data); }
  data() { return this._data ? { ...this._data } : undefined; }
}
class QuerySnap { constructor(docs) { this.docs = docs; } }
class Doc {
  constructor(db, c, id) { this.db = db; this.c = c; this.id = id || db.next(c); }
  async get() { return new Snap(this.id, this.db.get(this.c, this.id)); }
  async set(d, o = {}) { this.db.set(this.c, this.id, d, o); }
}
class Query {
  constructor(db, c, filters = [], max = null) { this.db = db; this.c = c; this.filters = filters; this.max = max; }
  where(field, op, value) {
    assert.equal(op, '==');
    return new Query(this.db, this.c, [...this.filters, { field, value }], this.max);
  }
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let rows = Object.entries(this.db.collections[this.c] || {})
      .filter(([, d]) => this.filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => new Snap(id, d));
    if (this.max !== null) rows = rows.slice(0, this.max);
    return new QuerySnap(rows);
  }
}
class Coll extends Query {
  doc(id) { return new Doc(this.db, this.c, id); }
}
class Tx {
  constructor() { this.written = false; }
  async get(x) {
    if (this.written) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return x.get();
  }
  set(ref, data, options = {}) {
    this.written = true;
    ref.db.set(ref.c, ref.id, data, options);
  }
}
class DB {
  constructor() { this.collections = {}; this.n = {}; }
  collection(c) {
    if (!this.collections[c]) this.collections[c] = {};
    return new Coll(this, c);
  }
  next(c) { this.n[c] = (this.n[c] || 0) + 1; return `${c}_${this.n[c]}`; }
  get(c, id) { return this.collections[c]?.[id] || null; }
  set(c, id, data, options = {}) {
    if (!this.collections[c]) this.collections[c] = {};
    const old = this.collections[c][id] || {};
    this.collections[c][id] = options.merge ? { ...old, ...data } : { ...data };
  }
  async runTransaction(fn) { return fn(new Tx()); }
}

function seed(db, resolved = true) {
  const cp = {
    checkpoint_id: 'cp_prebrain',
    status: resolved ? 'RESOLVED' : 'WAITING_FOR_HUMAN',
    waiting_status: resolved ? 'RESOLVED' : 'WAITING_FOR_HUMAN',
    human_action_required: !resolved,
    paused_from_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2',
    mission_id: 'mission_a'
  };
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'ACTIVE',
    milestones: [
      { id: 'm1', state: 'COMPLETED', order: 1 },
      {
        id: 'm2',
        state: resolved ? 'RUNNING' : 'NEED_HUMAN_ACTION',
        order: 2,
        mission_id: 'mission_a',
        human_action_required: !resolved,
        human_action_checkpoint: cp
      }
    ]
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    objective: 'Execute m2 after Human Action.',
    state: resolved ? 'PLANNING' : 'NEED_HUMAN_ACTION',
    autopilot_mode: true,
    autopilot_phase: resolved ? 'PROGRAM' : 'NEED_HUMAN_ACTION',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm2',
    human_action_required: !resolved,
    human_action_checkpoint: cp,
    brain_context: {
      current_milestone: { id: 'm2', executor_required: true }
    }
  });
}

test('resolved pre-Brain checkpoint creates PROGRAM Brain Run on SAME Mission', async () => {
  const db = new DB();
  seed(db, true);

  const out = await recoverResolvedPreBrainProgramContinuation(db, 'tenant_a');
  assert.equal(out.created, true);
  assert.equal(out.mission_id, 'mission_a');

  const runs = Object.values(db.collections.runs || {});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_type, 'BRAIN_RUN');
  assert.equal(runs[0].autopilot_phase, 'PROGRAM');
  assert.equal(runs[0].mission_id, 'mission_a');
  assert.equal(runs[0].state, 'RUNNING');

  assert.equal(Object.values(db.collections.tasks || {}).length, 0);

  const mission = db.get('missions', 'mission_a');
  assert.equal(mission.state, 'PLANNING');
  assert.equal(mission.brain_run_id, runs[0].id);

  const m2 = db.get('roadmaps', 'roadmap_a').milestones[1];
  assert.equal(m2.state, 'PLANNING');
  assert.equal(m2.brain_run_id, runs[0].id);
  assert.equal(
    m2.human_action_checkpoint.continuation_brain_run_id,
    runs[0].id
  );
});

test('recovery is idempotent and creates no duplicate Brain Run', async () => {
  const db = new DB();
  seed(db, true);

  const first = await recoverResolvedPreBrainProgramContinuation(db, 'tenant_a');
  const second = await recoverResolvedPreBrainProgramContinuation(db, 'tenant_a');

  assert.equal(first.created, true);
  assert.equal(second, null);
  assert.equal(Object.values(db.collections.runs || {}).length, 1);
});

test('unresolved Human Action is ignored', async () => {
  const db = new DB();
  seed(db, false);

  const out = await recoverResolvedPreBrainProgramContinuation(db, 'tenant_a');
  assert.equal(out, null);
  assert.equal(Object.values(db.collections.runs || {}).length, 0);
});

test('existing PROGRAM Brain Run leaves post-Brain recovery to existing logic', async () => {
  const db = new DB();
  seed(db, true);
  db.set('runs', 'brain_existing', {
    id: 'brain_existing',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    autopilot_phase: 'PROGRAM',
    state: 'COMPLETED'
  });

  const out = await recoverResolvedPreBrainProgramContinuation(db, 'tenant_a');
  assert.equal(out, null);
  assert.equal(Object.values(db.collections.runs || {}).length, 1);
});

test('deterministic resume Brain Run id is stable per checkpoint', () => {
  assert.equal(
    deterministicBrainRunId('cp_x'),
    deterministicBrainRunId('cp_x')
  );
  assert.notEqual(
    deterministicBrainRunId('cp_x'),
    deterministicBrainRunId('cp_y')
  );
});
