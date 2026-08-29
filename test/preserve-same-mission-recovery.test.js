const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { recoverMission } = require('../src/services/missionRecovery');
const { startNextRoadmapMilestone } = require('../src/services/autopilot');

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
  constructor(db, c, id) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
    this.id = id || db.next(c);
  }
  async get() {
    return new Snap(this.id, this.db.get(this.c, this.id), this);
  }
  async set(data, options = {}) {
    this.db.set(this.c, this.id, data, options);
  }
  async update(data) {
    this.db.update(this.c, this.id, data);
  }
}

class Query {
  constructor(db, c, filters = [], max = null) {
    this.db = db;
    this.c = c;
    this.collectionName = c;
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
  constructor() {
    this.hasWritten = false;
  }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options) {
    this.hasWritten = true;
    ref.db.set(ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    ref.db.update(ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor() {
    this.collections = {};
    this.n = {};
  }
  collection(c) {
    if (!this.collections[c]) this.collections[c] = {};
    return new Coll(this, c);
  }
  next(c) {
    this.n[c] = (this.n[c] || 0) + 1;
    return `${c}_${this.n[c]}`;
  }
  get(c, id) {
    return this.collections[c]?.[id] || null;
  }
  set(c, id, data, options = {}) {
    if (!this.collections[c]) this.collections[c] = {};
    this.collections[c][id] = options.merge
      ? { ...(this.collections[c][id] || {}), ...data }
      : { ...data };
  }
  update(c, id, data) {
    if (!this.collections[c]?.[id]) throw new Error('NOT_FOUND');
    this.collections[c][id] = { ...this.collections[c][id], ...data };
  }
  async runTransaction(fn) {
    return fn(new Tx());
  }
}

function values(db, c) {
  return Object.values(db.collections[c] || {});
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function createMiniExpress() {
  function Router() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const routeParts = route.path.split('/').filter(Boolean);
        const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
        if (routeParts.length !== urlParts.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < routeParts.length; i += 1) {
          if (routeParts[i].startsWith(':')) params[routeParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
          else if (routeParts[i] !== urlParts[i]) matched = false;
        }
        if (!matched) continue;
        req.params = params;
        return route.handler(req, res, next);
      }
      return next();
    };
    for (const method of ['get', 'post', 'put']) {
      router[method] = (routePath, handler) => routes.push({ method: method.toUpperCase(), path: routePath, handler });
    }
    return router;
  }
  return { Router };
}

function loadRoadmapsRouterWithMiniExpress() {
  const resolved = require.resolve('../src/routes/roadmaps.routes');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/roadmaps.routes');
  } finally {
    Module._load = originalLoad;
  }
}

function createRepos(db) {
  return {
    roadmaps: {
      async getById(id) {
        const data = db.get('roadmaps', id);
        return data ? { id, ...data } : null;
      },
      async listByTenant() { return []; },
      async listByProject() { return []; },
      async upsert(id, data) {
        db.set('roadmaps', id, { id, ...data }, { merge: true });
        return { id, ...db.get('roadmaps', id) };
      }
    },
    projects: {
      async getById(id) {
        const data = db.get('projects', id);
        return data ? { id, ...data } : null;
      }
    }
  };
}

async function reopenRoadmap(db, roadmapId, body = {}) {
  const { createRoadmapsRouter } = loadRoadmapsRouterWithMiniExpress();
  const router = createRoadmapsRouter({ db, repos: createRepos(db) });
  const req = {
    method: 'POST',
    url: `/${roadmapId}/reopen`,
    body,
    query: {},
    tenantId: 'tenant_a'
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await router(req, res, (error) => {
    if (error) throw error;
    throw new Error('ROUTE_NOT_FOUND');
  });
  return res;
}

function seedProject(db) {
  db.set('projects', 'project_a', {
    id: 'project_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    default_worker_id: 'W01',
    repository_full_name: 'scbit/mrapi-dev-orchestrator',
    local_path: 'C:/repo'
  });
  db.set('workers', 'W01', {
    id: 'W01',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'IDLE'
  });
}

function seedRoadmap(db, milestones) {
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Recovery Roadmap',
    objective: 'Recover without changing mission identity',
    state: 'BLOCKED',
    milestones
  });
}

function seedMission(db, overrides = {}) {
  db.set('missions', overrides.id || 'mission_a', {
    id: overrides.id || 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    preferred_worker_id: 'W01',
    objective: 'Recover this mission',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    ...overrides
  });
}

test('reopening a blocked milestone preserves mission_id and creates no work', async () => {
  const db = new DB();
  seedRoadmap(db, [
    { id: 'm1', title: 'Recoverable', state: 'BLOCKED', order: 1, depends_on: [], mission_id: 'mission_a', blocker_code: 'BRAIN_RESULT_MISSING' },
    { id: 'm2', title: 'Later', state: 'PENDING', order: 2, depends_on: ['m1'] }
  ]);
  seedMission(db, { blocker_code: 'BRAIN_RESULT_MISSING' });
  db.set('tasks', 'task_old', { id: 'task_old', tenant_id: 'tenant_a', mission_id: 'mission_a', state: 'FAILED' });
  db.set('runs', 'brain_old', { id: 'brain_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'BRAIN_RUN', state: 'FAILED' });
  db.set('runs', 'exec_old', { id: 'exec_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'EXECUTION_RUN', state: 'FAILED' });
  const before = counts(db);

  const res = await reopenRoadmap(db, 'roadmap_a', { milestone_id: 'm1' });
  const roadmap = db.get('roadmaps', 'roadmap_a');
  const milestone = roadmap.milestones.find((item) => item.id === 'm1');

  assert.equal(res.statusCode, 200);
  assert.equal(milestone.mission_id, 'mission_a');
  assert.equal(milestone.state, 'BLOCKED');
  assert.deepEqual(counts(db), before);
});

test('roadmap-only reopen does not clear mission_id, milestone ids, or dependencies', async () => {
  const db = new DB();
  const milestones = [
    { id: 'm1', title: 'Pending recoverable', state: 'PENDING', order: 1, depends_on: [], mission_id: 'mission_a' },
    { id: 'm2', title: 'Dependent', state: 'PENDING', order: 2, depends_on: ['m1'], dependencies: ['m1'] }
  ];
  seedRoadmap(db, milestones);
  const before = counts(db);

  const res = await reopenRoadmap(db, 'roadmap_a');
  const roadmap = db.get('roadmaps', 'roadmap_a');

  assert.equal(res.statusCode, 200);
  assert.equal(roadmap.milestones[0].mission_id, 'mission_a');
  assert.deepEqual(roadmap.milestones.map((item) => item.id), ['m1', 'm2']);
  assert.deepEqual(roadmap.milestones[1].depends_on, ['m1']);
  assert.deepEqual(roadmap.milestones[1].dependencies, ['m1']);
  assert.deepEqual(counts(db), before);
});

test('BRAIN_REPLAY uses the same mission and reuses an active replay run', async () => {
  const db = new DB();
  seedRoadmap(db, [{ id: 'm1', title: 'Recover Brain', state: 'BLOCKED', order: 1, depends_on: [], mission_id: 'mission_a' }]);
  seedMission(db, { blocker_code: 'BRAIN_RESULT_MISSING', retry_count: 0 });
  db.set('runs', 'brain_failed', {
    id: 'brain_failed',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'FAILED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    attempt: 1
  });
  const beforeMissions = counts(db).missions;

  const first = await recoverMission(db, 'tenant_a', 'mission_a');
  const afterFirst = counts(db);
  const second = await recoverMission(db, 'tenant_a', 'mission_a');

  assert.equal(first.mode, 'BRAIN_REPLAY');
  assert.equal(first.mission_id, 'mission_a');
  assert.equal(db.get('runs', first.brain_run_id).mission_id, 'mission_a');
  assert.equal(afterFirst.missions, beforeMissions);
  assert.equal(afterFirst.brainRuns, 2);
  assert.equal(second.reused, true);
  assert.equal(second.mode, 'NO_ACTION');
  assert.equal(second.reason, 'MISSION_HAS_ACTIVE_RUN');
  assert.equal(counts(db).brainRuns, 2);
  assert.equal(counts(db).missions, beforeMissions);
});

test('EXECUTION_RETRY creates retry work under the same mission only', async () => {
  const db = new DB();
  seedMission(db, {
    state: 'FAILED',
    approved_execution_snapshot_id: 'snapshot_a',
    current_plan_revision_id: 'plan_a',
    brain_run_id: 'brain_a'
  });
  db.set('execution_snapshots', 'snapshot_a', {
    id: 'snapshot_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    worker_id: 'W01',
    objective: 'Retry bounded execution',
    execution_type: 'EXECUTOR',
    approved_plan_revision_id: 'plan_a',
    approved_plan_revision_number: 1,
    execution_spec: {
      title: 'Retry work',
      instructions: 'Retry the same approved work.',
      allowed_files: ['src/services/orchestration.js'],
      required_tests: ['node --test test/preserve-same-mission-recovery.test.js']
    }
  });
  db.set('tasks', 'task_failed', {
    id: 'task_failed',
    tenant_id: 'tenant_a',
    mission_id: 'mission_a',
    execution_snapshot_id: 'snapshot_a',
    attempt_count: 1,
    state: 'FAILED'
  });
  const before = counts(db);

  const out = await recoverMission(db, 'tenant_a', 'mission_a');
  const task = db.get('tasks', out.result.task_id);

  assert.equal(out.mode, 'EXECUTION_RETRY');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(task.mission_id, 'mission_a');
  assert.equal(task.retry_of_task_id, 'task_failed');
  assert.equal(counts(db).missions, before.missions);
  assert.equal(counts(db).tasks, before.tasks + 1);
});

test('HUMAN_ACTION_RESUME preserves mission, roadmap, and milestone provenance', async () => {
  const db = new DB();
  const checkpoint = {
    checkpoint_id: 'checkpoint_a',
    status: 'RESOLVED',
    paused_from_phase: 'PROGRAM',
    mission_id: 'mission_a',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  };
  seedRoadmap(db, [{ id: 'm1', title: 'Needs input', state: 'NEED_HUMAN_ACTION', order: 1, depends_on: [], mission_id: 'mission_a', human_action_checkpoint: checkpoint }]);
  seedMission(db, {
    state: 'PLANNING',
    human_action_required: false,
    human_action_checkpoint: checkpoint
  });
  db.set('runs', 'brain_a', {
    id: 'brain_a',
    tenant_id: 'tenant_a',
    run_type: 'BRAIN_RUN',
    mission_id: 'mission_a',
    state: 'COMPLETED',
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    worker_id: 'W01',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    brain_output: {
      objective: 'Continue after human action',
      worker_id: 'W01',
      requires_execution: true,
      execution_type: 'EXECUTOR',
      task_spec: { title: 'Continue', objective: 'Continue', instructions: 'Continue same mission.' }
    }
  });
  const before = counts(db);

  const out = await recoverMission(db, 'tenant_a', 'mission_a');
  const task = db.get('tasks', out.task_id);
  const updatedCheckpoint = db.get('roadmaps', 'roadmap_a').milestones[0].human_action_checkpoint;

  assert.equal(out.mode, 'HUMAN_ACTION_RESUME');
  assert.equal(out.mission_id, 'mission_a');
  assert.equal(out.roadmap_id, 'roadmap_a');
  assert.equal(out.milestone_id, 'm1');
  assert.equal(task.mission_id, 'mission_a');
  assert.equal(updatedCheckpoint.continuation_task_id, out.task_id);
  assert.equal(counts(db).missions, before.missions);
});

test('untouched pending milestone without mission_id still creates a first mission', async () => {
  const db = new DB();
  seedProject(db);
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'First Start',
    objective: 'Start first milestone',
    state: 'ACTIVE',
    owner_worker_id: 'W01',
    milestones: [{ id: 'm1', title: 'First', state: 'PENDING', order: 1, depends_on: [] }]
  });

  const started = await startNextRoadmapMilestone(db, 'tenant_a', 'roadmap_a');

  assert.equal(started.milestone.id, 'm1');
  assert.ok(started.mission.id);
  assert.equal(values(db, 'missions').length, 1);
  assert.equal(db.get('roadmaps', 'roadmap_a').milestones[0].mission_id, started.mission.id);
});
