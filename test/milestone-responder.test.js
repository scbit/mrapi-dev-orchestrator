const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { saveMilestoneResponse, listMilestoneResponses } = require('../src/services/milestoneResponse');
const { recoverMission } = require('../src/services/missionRecovery');
const { resolveMilestoneRuntime } = require('../src/services/milestoneRuntime');

class Snap {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() {
    return this._data ? structuredClone(this._data) : undefined;
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
  constructor() {
    this.hasWritten = false;
  }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options) {
    this.hasWritten = true;
    ref.db.write('set', ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    ref.db.write('update', ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor(seed = null) {
    this.collections = seed ? structuredClone(seed) : {};
    this.n = {};
    this.writes = [];
  }
  collection(name) {
    if (!this.collections[name]) this.collections[name] = {};
    return new Coll(this, name);
  }
  next(name) {
    this.n[name] = (this.n[name] || 0) + 1;
    return `${name}_${this.n[name]}`;
  }
  get(name, id) {
    return this.collections[name]?.[id] ? structuredClone(this.collections[name][id]) : null;
  }
  set(name, id, data, options = {}) {
    if (!this.collections[name]) this.collections[name] = {};
    this.collections[name][id] = options.merge
      ? { ...(this.collections[name][id] || {}), ...structuredClone(data) }
      : structuredClone(data);
  }
  write(method, collectionName, id, data, options = {}) {
    this.writes.push({ method, collectionName, id, data: structuredClone(data), options });
    this.set(collectionName, id, data, options);
  }
  update(name, id, data) {
    if (!this.collections[name]?.[id]) throw new Error('NOT_FOUND');
    this.collections[name][id] = { ...this.collections[name][id], ...structuredClone(data) };
  }
  async runTransaction(fn) {
    return fn(new Tx());
  }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function counts(db) {
  return {
    missions: values(db, 'missions').length,
    tasks: values(db, 'tasks').length,
    brainRuns: values(db, 'runs').filter((run) => run.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((run) => run.run_type === 'EXECUTION_RUN').length
  };
}

function evidence(db) {
  return values(db, 'evidence');
}

function seed(db, { withMission = true, roadmap = {}, milestone = {}, mission = {} } = {}) {
  const missionId = withMission ? 'mission_a' : null;
  db.set('roadmaps', 'roadmap_a', {
    id: 'roadmap_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    title: 'Responder Roadmap',
    objective: 'Persist responder text',
    state: 'ACTIVE',
    proposal_type: 'PLANNER_ROADMAP',
    approval_status: 'APPROVED',
    non_executable: false,
    milestones: [
      {
        id: 'm1',
        title: 'One',
        description: 'Original first milestone',
        state: 'BLOCKED',
        order: 1,
        depends_on: [],
        dependencies: [],
        mission_id: missionId,
        human_action_checkpoint: { checkpoint_id: 'cp_a', status: 'WAITING_FOR_HUMAN' },
        ...milestone
      },
      {
        id: 'm2',
        title: 'Two',
        description: 'Later milestone must not change',
        state: 'PENDING',
        order: 2,
        depends_on: ['m1'],
        dependencies: ['m1'],
        acceptance: ['preserve me']
      }
    ],
    ...roadmap
  });
  if (withMission) {
    db.set('missions', missionId, {
      id: missionId,
      tenant_id: 'tenant_a',
      workspace_id: 'workspace_a',
      project_id: 'project_a',
      preferred_worker_id: 'W01',
      objective: 'Same Mission',
      state: 'BLOCKED',
      autopilot_mode: true,
      autopilot_phase: 'PROGRAM',
      roadmap_id: 'roadmap_a',
      milestone_id: 'm1',
      human_action_checkpoint: { checkpoint_id: 'cp_a', status: 'WAITING_FOR_HUMAN' },
      brain_context: {
        existing: 'keep',
        trusted_scope: {
          tenant_id: 'tenant_a',
          workspace_id: 'workspace_a',
          project_id: 'project_a',
          roadmap_id: 'roadmap_a',
          milestone_id: 'm1'
        }
      },
      ...mission
    });
    db.set('runs', 'brain_failed', {
      id: 'brain_failed',
      tenant_id: 'tenant_a',
      run_type: 'BRAIN_RUN',
      mission_id: missionId,
      state: 'FAILED',
      autopilot_phase: 'PROGRAM',
      roadmap_id: 'roadmap_a',
      milestone_id: 'm1',
      attempt: 1,
      created_at: new Date('2026-01-01T00:00:00Z')
    });
  }
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
        for (let index = 0; index < routeParts.length; index += 1) {
          if (routeParts[index].startsWith(':')) params[routeParts[index].slice(1)] = decodeURIComponent(urlParts[index]);
          else if (routeParts[index] !== urlParts[index]) matched = false;
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
      async upsert() { throw new Error('UNEXPECTED_ROADMAP_WRITE'); }
    },
    projects: {
      async getById() { return null; }
    }
  };
}

async function postRespond(db, roadmapId = 'roadmap_a', milestoneId = 'm1', body = { text: 'Ship with the same Mission.' }) {
  const { createRoadmapsRouter } = loadRoadmapsRouterWithMiniExpress();
  const router = createRoadmapsRouter({ db, repos: createRepos(db) });
  const req = {
    method: 'POST',
    url: `/${roadmapId}/milestones/${milestoneId}/respond`,
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

async function assertRejectsStatus(fn, message, status) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.message, message);
    assert.equal(error.status, status);
    return true;
  });
}

test('POST RESPONDER on milestone with existing Mission persists one same-Mission human-response evidence record', async () => {
  const db = new DB();
  seed(db);

  const res = await postRespond(db);
  const records = evidence(db);

  assert.equal(res.statusCode, 201);
  assert.equal(records.length, 1);
  assert.equal(records[0].tenant_id, 'tenant_a');
  assert.equal(records[0].roadmap_id, 'roadmap_a');
  assert.equal(records[0].milestone_id, 'm1');
  assert.equal(records[0].mission_id, 'mission_a');
  assert.equal(records[0].type, 'MILESTONE_HUMAN_RESPONSE');
  assert.equal(records[0].source, 'HUMAN/MILESTONE_RESPONSE');
  assert.equal(res.body.mission_id, 'mission_a');
});

test('saving a response on an existing Mission leaves Mission, Task, Brain Run, and Execution Run counts unchanged', async () => {
  const db = new DB();
  seed(db);
  db.set('tasks', 'task_old', { id: 'task_old', tenant_id: 'tenant_a', mission_id: 'mission_a' });
  db.set('runs', 'exec_old', { id: 'exec_old', tenant_id: 'tenant_a', mission_id: 'mission_a', run_type: 'EXECUTION_RUN' });
  const before = counts(db);

  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Human answer' });

  assert.deepEqual(counts(db), before);
});

test('saving a response on a milestone without mission_id persists null mission_id and creates no Mission', async () => {
  const db = new DB();
  seed(db, { withMission: false });
  const before = counts(db);

  const saved = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Before a Mission exists' });

  assert.equal(saved.mission_id, null);
  assert.equal(evidence(db)[0].mission_id, null);
  assert.deepEqual(counts(db), before);
});

test('unknown Roadmap returns not found and writes nothing', async () => {
  const db = new DB();
  seed(db);

  await assertRejectsStatus(
    () => saveMilestoneResponse(db, 'tenant_a', 'missing', 'm1', { text: 'No write' }),
    'ROADMAP_NOT_FOUND',
    404
  );

  assert.equal(evidence(db).length, 0);
});

test('unknown milestone returns not found and writes nothing', async () => {
  const db = new DB();
  seed(db);

  await assertRejectsStatus(
    () => saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'missing', { text: 'No write' }),
    'MILESTONE_NOT_FOUND',
    404
  );

  assert.equal(evidence(db).length, 0);
});

test('Mission provenance mismatch fails closed and writes no response', async () => {
  const db = new DB();
  seed(db, { mission: { roadmap_id: 'other_roadmap' } });

  await assertRejectsStatus(
    () => saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'No attach' }),
    'MILESTONE_MISSION_PROVENANCE_MISMATCH',
    409
  );

  assert.equal(evidence(db).length, 0);
});

test('empty or blank text is rejected', async () => {
  const db = new DB();
  seed(db);

  await assertRejectsStatus(
    () => saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: '   ' }),
    'MILESTONE_RESPONSE_TEXT_REQUIRED',
    400
  );

  assert.equal(evidence(db).length, 0);
});

test('optional references are persisted when valid without external fetching', async () => {
  const db = new DB();
  seed(db);

  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', {
    text: 'Use the attached note.',
    references: [
      { type: 'URL', title: 'Spec', url: 'https://example.test/spec', secret: 'drop-me' },
      { evidence_id: 'ev_1', description: 'Existing trusted evidence' }
    ]
  });

  assert.deepEqual(evidence(db)[0].references, [
    { type: 'URL', title: 'Spec', url: 'https://example.test/spec' },
    { evidence_id: 'ev_1', description: 'Existing trusted evidence' }
  ]);
});

test('two responses append two evidence records rather than overwriting the first', async () => {
  const db = new DB();
  seed(db);

  const first = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'First' });
  const second = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Second' });

  assert.notEqual(first.evidence_id, second.evidence_id);
  assert.equal(evidence(db).length, 2);
  assert.deepEqual(evidence(db).map((item) => item.text).sort(), ['First', 'Second']);
});

test('RESPONDER does not mutate Roadmap shape, ordering, dependencies, states, Mission state, or checkpoint', async () => {
  const db = new DB();
  seed(db, { mission: { state: 'WAITING_HUMAN' } });
  const beforeRoadmap = db.get('roadmaps', 'roadmap_a');
  const beforeMission = db.get('missions', 'mission_a');

  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'No roadmap mutation' });

  assert.deepEqual(db.get('roadmaps', 'roadmap_a'), beforeRoadmap);
  assert.equal(db.get('missions', 'mission_a').state, beforeMission.state);
  assert.deepEqual(db.get('missions', 'mission_a').human_action_checkpoint, beforeMission.human_action_checkpoint);
});

test('subsequent BRAIN_REPLAY preserves mission_id and receives scoped human response in additive trusted context', async () => {
  const db = new DB();
  seed(db, { mission: { blocker_code: 'BRAIN_RESULT_MISSING', retry_count: 0 } });
  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Replay with this human context.' });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const run = db.get('runs', replay.brain_run_id);

  assert.equal(replay.mode, 'BRAIN_REPLAY');
  assert.equal(replay.mission_id, 'mission_a');
  assert.equal(run.mission_id, 'mission_a');
  assert.equal(run.brain_context.existing, 'keep');
  assert.equal(run.brain_context.milestone_human_responses.length, 1);
  assert.equal(run.brain_context.milestone_human_responses[0].text, 'Replay with this human context.');
});

test('responses for another tenant, roadmap, milestone, or Mission are not injected into Brain replay context', async () => {
  const db = new DB();
  seed(db, { mission: { blocker_code: 'BRAIN_RESULT_MISSING' } });
  db.set('evidence', 'wrong_tenant', { id: 'wrong_tenant', type: 'MILESTONE_HUMAN_RESPONSE', tenant_id: 'tenant_b', roadmap_id: 'roadmap_a', milestone_id: 'm1', mission_id: 'mission_a', text: 'wrong tenant' });
  db.set('evidence', 'wrong_roadmap', { id: 'wrong_roadmap', type: 'MILESTONE_HUMAN_RESPONSE', tenant_id: 'tenant_a', roadmap_id: 'roadmap_b', milestone_id: 'm1', mission_id: 'mission_a', text: 'wrong roadmap' });
  db.set('evidence', 'wrong_milestone', { id: 'wrong_milestone', type: 'MILESTONE_HUMAN_RESPONSE', tenant_id: 'tenant_a', roadmap_id: 'roadmap_a', milestone_id: 'm2', mission_id: 'mission_a', text: 'wrong milestone' });
  db.set('evidence', 'wrong_mission', { id: 'wrong_mission', type: 'MILESTONE_HUMAN_RESPONSE', tenant_id: 'tenant_a', roadmap_id: 'roadmap_a', milestone_id: 'm1', mission_id: 'mission_b', text: 'wrong mission' });
  await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'right response' });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const responses = db.get('runs', replay.brain_run_id).brain_context.milestone_human_responses;

  assert.deepEqual(responses.map((item) => item.text), ['right response']);
});

test('pre-Mission response is discoverable after legitimate Mission creation without mutating original evidence', async () => {
  const db = new DB();
  seed(db, { withMission: false });
  const saved = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Pre-Mission context' });
  const originalEvidence = db.get('evidence', saved.evidence_id);
  db.set('roadmaps', 'roadmap_a', {
    ...db.get('roadmaps', 'roadmap_a'),
    milestones: db.get('roadmaps', 'roadmap_a').milestones.map((item) => item.id === 'm1' ? { ...item, mission_id: 'mission_a' } : item)
  });
  db.set('missions', 'mission_a', {
    id: 'mission_a',
    tenant_id: 'tenant_a',
    workspace_id: 'workspace_a',
    project_id: 'project_a',
    state: 'BLOCKED',
    autopilot_mode: true,
    autopilot_phase: 'PROGRAM',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1'
  });
  db.set('runs', 'brain_failed', { id: 'brain_failed', tenant_id: 'tenant_a', run_type: 'BRAIN_RUN', mission_id: 'mission_a', state: 'FAILED', autopilot_phase: 'PROGRAM' });

  const replay = await recoverMission(db, 'tenant_a', 'mission_a');
  const responses = db.get('runs', replay.brain_run_id).brain_context.milestone_human_responses;

  assert.equal(db.get('evidence', saved.evidence_id).mission_id, null);
  assert.deepEqual(db.get('evidence', saved.evidence_id), originalEvidence);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].text, 'Pre-Mission context');
});

test('milestoneRuntime exposes latest scoped human response without replacing latest_evidence or recovery', async () => {
  const db = new DB();
  seed(db);
  db.set('evidence', 'other_evidence', {
    id: 'other_evidence',
    tenant_id: 'tenant_a',
    type: 'LOG',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    mission_id: 'mission_a',
    title: 'ordinary evidence',
    created_at: new Date('2026-01-03T00:00:00Z')
  });
  db.set('evidence', 'human_old', {
    id: 'human_old',
    tenant_id: 'tenant_a',
    type: 'MILESTONE_HUMAN_RESPONSE',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    mission_id: 'mission_a',
    text: 'old',
    created_at: new Date('2026-01-01T00:00:00Z')
  });
  db.set('evidence', 'human_new', {
    id: 'human_new',
    tenant_id: 'tenant_a',
    type: 'MILESTONE_HUMAN_RESPONSE',
    roadmap_id: 'roadmap_a',
    milestone_id: 'm1',
    mission_id: 'mission_a',
    text: 'new',
    created_at: new Date('2026-01-02T00:00:00Z')
  });
  const roadmap = db.get('roadmaps', 'roadmap_a');

  const runtime = await resolveMilestoneRuntime(db, 'tenant_a', roadmap, roadmap.milestones[0]);

  assert.equal(runtime.latest_evidence.id, 'other_evidence');
  assert.equal(runtime.latest_human_response.id, 'human_new');
  assert.equal(runtime.latest_human_response.text, 'new');
  assert.equal(runtime.human_response_count, 2);
  assert.equal(runtime.recovery.mode, 'BRAIN_REPLAY');
});

test('refresh-style re-read from persisted DB returns the same response without in-memory state', async () => {
  const db = new DB();
  seed(db);
  const saved = await saveMilestoneResponse(db, 'tenant_a', 'roadmap_a', 'm1', { text: 'Durable response' });
  const reloaded = new DB(db.collections);

  const responses = await listMilestoneResponses(reloaded, 'tenant_a', 'roadmap_a', 'm1', {
    missionId: 'mission_a',
    includePremission: true
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].evidence_id, saved.evidence_id);
  assert.equal(responses[0].text, 'Durable response');
}
);
