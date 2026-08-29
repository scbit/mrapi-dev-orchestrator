const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

const {
  createPlannerRequest,
  completePlannerBrainRun,
  approvePlannerRoadmap,
  startPlannerRoadmap
} = require('../src/services/planner');
const { recoverMission } = require('../src/services/missionRecovery');
const {
  completeVerificationBrainRun,
  completeGitStageExecutionRun
} = require('../src/services/autopilot');
const {
  completeBrainRun,
  startExecutionRun,
  completeRun
} = require('../src/services/orchestration');

const root = path.join(__dirname, '..');
const tenantId = 'tenant_smoke_autopilot_v2';
const workspaceId = 'workspace_smoke_autopilot_v2';
const projectId = 'project_smoke_autopilot_v2';
const workerId = 'W01';
const executorId = 'executor_smoke_autopilot_v2';

class Snap {
  constructor(id, data, ref = null) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = Boolean(data);
  }
  data() { return this._data ? { ...this._data } : undefined; }
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
  async get() { return new Snap(this.id, this.db.get(this.c, this.id), this); }
  async set(data, options = {}) { this.db.write('set', this.c, this.id, data, options); }
  async update(data) { this.db.write('update', this.c, this.id, data); }
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
  limit(max) { return new Query(this.db, this.c, this.filters, max); }
  async get() {
    let docs = Object.entries(this.db.collections[this.c] || {})
      .filter(([, data]) => this.filters.every((filter) => data[filter.field] === filter.value))
      .map(([id, data]) => new Snap(id, data, new Doc(this.db, this.c, id)));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnap(docs);
  }
}

class Coll extends Query {
  doc(id) { return new Doc(this.db, this.c, id); }
}

class Tx {
  constructor() { this.hasWritten = false; }
  async get(refOrQuery) {
    if (this.hasWritten) throw new Error('FIRESTORE_READ_AFTER_WRITE');
    return refOrQuery.get();
  }
  set(ref, data, options = {}) {
    this.hasWritten = true;
    ref.db.write('set', ref.c || ref.collectionName, ref.id, data, options);
  }
  update(ref, data) {
    this.hasWritten = true;
    ref.db.write('update', ref.c || ref.collectionName, ref.id, data);
  }
}

class DB {
  constructor() {
    this.collections = {};
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
  get(name, id) { return this.collections[name]?.[id] || null; }
  set(name, id, data, options = {}) {
    if (!this.collections[name]) this.collections[name] = {};
    this.collections[name][id] = options.merge
      ? { ...(this.collections[name][id] || {}), ...data }
      : { ...data };
  }
  write(method, collectionName, id, data, options = {}) {
    this.writes.push({ method, collectionName, id, data, options });
    this.set(collectionName, id, data, method === 'update' ? { merge: true } : options);
  }
  update(name, id, data) {
    if (!this.collections[name]?.[id]) throw new Error('NOT_FOUND');
    this.write('update', name, id, data);
  }
  async runTransaction(fn) { return fn(new Tx()); }
}

function values(db, collectionName) {
  return Object.values(db.collections[collectionName] || {});
}

function counts(db) {
  return {
    missions: values(db, 'missions').filter((item) => item.tenant_id === tenantId).length,
    tasks: values(db, 'tasks').filter((item) => item.tenant_id === tenantId).length,
    runs: values(db, 'runs').filter((item) => item.tenant_id === tenantId).length,
    brainRuns: values(db, 'runs').filter((item) => item.tenant_id === tenantId && item.run_type === 'BRAIN_RUN').length,
    executionRuns: values(db, 'runs').filter((item) => item.tenant_id === tenantId && item.run_type === 'EXECUTION_RUN').length
  };
}

function roadmap(db, roadmapId) {
  return db.get('roadmaps', roadmapId);
}

function milestone(db, roadmapId, milestoneId) {
  return roadmap(db, roadmapId).milestones.find((item) => item.id === milestoneId);
}

function roadmapMilestoneMissions(db, roadmapId) {
  const milestoneIds = new Set(['m1', 'm2', 'm3']);
  return values(db, 'missions').filter((mission) =>
    mission.tenant_id === tenantId &&
    mission.roadmap_id === roadmapId &&
    milestoneIds.has(mission.milestone_id)
  );
}

function roadmapMilestoneMissionCount(db, roadmapId) {
  return roadmapMilestoneMissions(db, roadmapId).length;
}

function programBrainRuns(db, missionId) {
  return values(db, 'runs').filter((run) =>
    run.tenant_id === tenantId &&
    run.mission_id === missionId &&
    run.run_type === 'BRAIN_RUN' &&
    run.autopilot_phase === 'PROGRAM'
  );
}

function brainRunsFor(db, missionId) {
  return values(db, 'runs').filter((run) =>
    run.tenant_id === tenantId &&
    run.mission_id === missionId &&
    run.run_type === 'BRAIN_RUN'
  );
}

function tasksFor(db, missionId) {
  return values(db, 'tasks').filter((task) => task.tenant_id === tenantId && task.mission_id === missionId);
}

function executionRunsFor(db, missionId) {
  return values(db, 'runs').filter((run) =>
    run.tenant_id === tenantId &&
    run.mission_id === missionId &&
    run.run_type === 'EXECUTION_RUN'
  );
}

function seedScope(db, { git = false } = {}) {
  db.set('workspaces', workspaceId, { id: workspaceId, tenant_id: tenantId, name: 'Smoke Workspace' });
  db.set('projects', projectId, {
    id: projectId,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    repository_full_name: 'test-only/mrapi-smoke',
    local_path: 'C:/test-only/mrapi-smoke',
    default_branch: 'main',
    default_worker_id: workerId,
    primary_worker_ids: [workerId],
    runtime_context: { git_automation_enabled: git }
  });
  db.set('workers', workerId, { id: workerId, tenant_id: tenantId, state: 'IDLE' });
  db.set('executors', executorId, { id: executorId, tenant_id: tenantId, state: 'ONLINE', host_name: 'smoke-host' });
}

function proposal({ gitM1 = false } = {}) {
  return {
    title: 'Autopilot lifecycle smoke',
    objective: 'Exercise isolated non-production Autopilot continuation.',
    summary: 'A deterministic three milestone smoke for lifecycle ownership.',
    risks: ['Lifecycle idempotency regression'],
    dependencies: ['Trusted Autopilot contracts'],
    assumptions: ['No external resources are used'],
    auto_advance: true,
    milestones: [
      milestoneProposal('m1', [], { git: gitM1 }),
      milestoneProposal('m2', ['m1']),
      milestoneProposal('m3', ['m2'])
    ]
  };
}

function milestoneProposal(id, dependencies, { git = false } = {}) {
  return {
    id,
    title: `${id} smoke milestone`,
    objective: `${id} objective`,
    description: `${id} deterministic test-only work`,
    executor_required: true,
    dependencies,
    risks: [],
    success_criteria: [`${id} completes through trusted lifecycle`],
    ...(git ? { git_automation_enabled: true, autopilot_git_enabled: true } : {})
  };
}

async function createApprovedRoadmap(db, options = {}) {
  seedScope(db, options);
  const request = await createPlannerRequest(db, tenantId, {
    workspace_id: workspaceId,
    project_id: projectId,
    request: 'Create an isolated test-only three milestone Autopilot smoke roadmap.',
    auto_advance: true
  });
  const planned = await completePlannerBrainRun(db, tenantId, request.brain_run_id, {
    proposal: proposal({ gitM1: options.gitM1 === true })
  });
  await approvePlannerRoadmap(db, tenantId, planned.roadmap_id, { approve: true });
  return { request, roadmapId: planned.roadmap_id };
}

function programOutput(label) {
  return `<MRAPI_CONTROL>${JSON.stringify({
    requires_execution: true,
    execution_type: 'CODEX',
    task_spec: {
      title: `${label} bounded work`,
      objective: `${label} bounded work`,
      instructions: `Perform deterministic test-only work for ${label}.`,
      allowed_files: ['test/autopilot-lifecycle-e2e-smoke-v2.test.js'],
      required_tests: ['node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js'],
      success_criteria: ['Required smoke passes'],
      stop_conditions: ['Do not deploy']
    }
  })}</MRAPI_CONTROL>`;
}

function autopilotDecision(action, extra = {}) {
  return `<MRAPI_AUTOPILOT>${JSON.stringify({ action, reason: `${action} smoke`, ...extra })}</MRAPI_AUTOPILOT>`;
}

async function planAndExecute(db, brainRunId, label, { success = true } = {}) {
  const planned = await completeBrainRun(db, tenantId, brainRunId, { output_text: programOutput(label) });
  const started = await startExecutionRun(db, tenantId, planned.task_id, executorId);
  const completed = await completeRun(db, tenantId, started.run.id, {
    success,
    summary: success ? `${label} execution passed` : `${label} execution failed`,
    error: success ? null : `${label} failure`,
    output: {
      required_tests: [{ command: 'node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js', passed: success }],
      executor_report: {
        required_tests: [{ command: 'node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js', passed: success }]
      }
    }
  });
  return { planned, started, completed, verificationRunId: completed.autopilot_verification?.verification_run_id };
}

async function verifyComplete(db, verificationRunId) {
  return completeVerificationBrainRun(db, tenantId, verificationRunId, {
    output_text: autopilotDecision('COMPLETE')
  });
}

async function readRoadmap(handler, roadmapId) {
  return requestJson(handler, 'GET', `/api/roadmaps/${roadmapId}`);
}

async function assertReadOnlyRoadmapRead(db, handler, roadmapId, expected) {
  const beforeCounts = counts(db);
  const beforeWrites = db.writes.length;
  const response = await readRoadmap(handler, roadmapId);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(counts(db), beforeCounts);
  assert.equal(db.writes.length, beforeWrites);
  for (const [milestoneId, missionId] of Object.entries(expected.missionIds || {})) {
    assert.equal(
      response.body.milestone_runtime.find((item) => item.milestone_id === milestoneId)?.mission_id || null,
      missionId || null
    );
    assert.equal(response.body.milestones.find((item) => item.id === milestoneId)?.mission_id || null, missionId || null);
  }
  for (const [milestoneId, state] of Object.entries(expected.states || {})) {
    assert.equal(response.body.milestones.find((item) => item.id === milestoneId)?.state, state);
  }
  assert.equal(response.body.state, expected.roadmapState);
  return response.body;
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

function loadRoute(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function repos(db) {
  return {
    roadmaps: {
      async getById(id) {
        const data = db.get('roadmaps', id);
        return data ? { id, ...data } : null;
      },
      async listByTenant(requestTenantId) {
        return values(db, 'roadmaps').filter((item) => item.tenant_id === requestTenantId);
      },
      async listByProject(requestTenantId, requestedProjectId) {
        return values(db, 'roadmaps').filter((item) =>
          item.tenant_id === requestTenantId && item.project_id === requestedProjectId
        );
      },
      async upsert(id, data, options = { merge: true }) {
        db.write('set', 'roadmaps', id, { id, ...data }, options);
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

function roadmapsApp(db) {
  const { createRoadmapsRouter } = loadRoute('../src/routes/roadmaps.routes');
  const router = createRoadmapsRouter({ db, repos: repos(db) });
  return async (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      req.body = raw ? JSON.parse(raw) : {};
      req.query = Object.fromEntries(new URL(`http://x${req.url}`).searchParams);
      req.header = (name) => req.headers[String(name).toLowerCase()];
      req.tenantId = req.header('x-tenant-id') || tenantId;
      req.url = req.url.replace(/^\/api\/roadmaps/, '') || '/';
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      await router(req, res, (error) => {
        res.statusCode = error?.status || 404;
        res.end(JSON.stringify({ error: error?.message || 'NOT_FOUND' }));
      });
    });
  };
}

async function requestJson(handler, method, routePath, body = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const payload = method === 'GET' ? '' : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-tenant-id': tenantId
        }
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertOrderAndDependencies(db, roadmapId) {
  const milestones = roadmap(db, roadmapId).milestones;
  assert.deepEqual(milestones.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(milestones.map((item) => item.depends_on), [[], ['m1'], ['m2']]);
  assert.deepEqual(milestones.map((item) => item.dependencies), [[], ['m1'], ['m2']]);
}

async function assertBlockedRouteNoWrites(db, handler, method, routePath, body, error) {
  const before = JSON.stringify(db.collections);
  const response = await requestJson(handler, method, routePath, body);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, error);
  assert.equal(JSON.stringify(db.collections), before);
}

test('m5 Autopilot End-to-End Smoke: Planner start, automatic continuation, recovery, reads, and route guards', async () => {
  const db = new DB();
  const { roadmapId } = await createApprovedRoadmap(db);
  const handler = roadmapsApp(db);

  assertOrderAndDependencies(db, roadmapId);
  assert.equal(roadmap(db, roadmapId).auto_advance, true);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 0);

  const start = await startPlannerRoadmap(db, tenantId, roadmapId);
  assert.equal(start.milestone.id, 'm1');
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 1);
  const m1MissionId = start.mission.id;
  const m1BrainRunId = start.brain_run.id;
  assert.equal(milestone(db, roadmapId, 'm1').mission_id, m1MissionId);
  assert.equal(programBrainRuns(db, m1MissionId).length, 1);
  assert.equal(programBrainRuns(db, m1MissionId)[0].id, m1BrainRunId);
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, undefined);
  assert.equal(milestone(db, roadmapId, 'm3').mission_id, undefined);
  await assertReadOnlyRoadmapRead(db, handler, roadmapId, {
    roadmapState: 'ACTIVE',
    states: { m1: 'PLANNING', m2: 'PENDING', m3: 'PENDING' },
    missionIds: { m1: m1MissionId, m2: null, m3: null }
  });

  const repeatStart = await startPlannerRoadmap(db, tenantId, roadmapId);
  assert.equal(repeatStart.reused, true);
  assert.equal(repeatStart.no_new_work, true);
  assert.equal(repeatStart.mission.id, m1MissionId);
  assert.equal(repeatStart.brain_run.id, m1BrainRunId);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 1);
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, undefined);

  const m1Execution = await planAndExecute(db, m1BrainRunId, 'm1');
  const m1Complete = await verifyComplete(db, m1Execution.verificationRunId);
  assert.equal(m1Complete.action, 'COMPLETE');
  assert.equal(m1Complete.continuation_state, 'STARTED');
  assert.equal(milestone(db, roadmapId, 'm1').state, 'COMPLETED');
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 2);
  const m2MissionId = milestone(db, roadmapId, 'm2').mission_id;
  const m2BrainRunId = programBrainRuns(db, m2MissionId)[0].id;
  assert.ok(m2MissionId);
  assert.equal(milestone(db, roadmapId, 'm3').mission_id, undefined);
  await assertReadOnlyRoadmapRead(db, handler, roadmapId, {
    roadmapState: 'ACTIVE',
    states: { m1: 'COMPLETED', m2: 'PLANNING', m3: 'PENDING' },
    missionIds: { m1: m1MissionId, m2: m2MissionId, m3: null }
  });

  await assertBlockedRouteNoWrites(
    db,
    handler,
    'POST',
    `/api/roadmaps/${roadmapId}/advance`,
    { milestone_id: 'm2' },
    'ROADMAP_LIFECYCLE_MANAGED_BY_AUTOPILOT'
  );
  await assertBlockedRouteNoWrites(
    db,
    handler,
    'POST',
    `/api/roadmaps/${roadmapId}/milestones/m2/state`,
    { state: 'COMPLETED' },
    'ROADMAP_MILESTONE_STATE_MANAGED_BY_AUTOPILOT'
  );

  const m2FailedExecution = await planAndExecute(db, m2BrainRunId, 'm2', { success: false });
  const retryDecision = await completeVerificationBrainRun(db, tenantId, m2FailedExecution.verificationRunId, {
    output_text: autopilotDecision('RETRY', {
      execution_spec: {
        instructions: 'Retry m2 through same Mission.',
        allowed_files: ['test/autopilot-lifecycle-e2e-smoke-v2.test.js'],
        required_tests: ['node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js'],
        success_criteria: ['Retry required smoke passes'],
        stop_conditions: ['Do not deploy']
      }
    })
  });
  assert.equal(retryDecision.action, 'RETRY');
  assert.equal(retryDecision.mission_id, m2MissionId);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 2);
  assert.equal(milestone(db, roadmapId, 'm3').mission_id, undefined);

  const beforeRecovery = counts(db);
  const recovery = await recoverMission(db, tenantId, m2MissionId);
  assert.equal(recovery.mode, 'EXECUTION_RETRY');
  assert.equal(recovery.reused, true);
  assert.equal(recovery.mission_id, m2MissionId);
  assert.equal(recovery.roadmap_id, roadmapId);
  assert.equal(recovery.milestone_id, 'm2');
  assert.equal(db.get('tasks', recovery.task_id).mission_id, m2MissionId);
  assert.deepEqual(counts(db), beforeRecovery);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 2);
  assert.notEqual(roadmap(db, roadmapId).state, 'COMPLETED');
  await assertReadOnlyRoadmapRead(db, handler, roadmapId, {
    roadmapState: 'ACTIVE',
    states: { m1: 'COMPLETED', m2: 'RUNNING', m3: 'PENDING' },
    missionIds: { m1: m1MissionId, m2: m2MissionId, m3: null }
  });

  const recoveryAgain = await recoverMission(db, tenantId, m2MissionId);
  assert.equal(recoveryAgain.reused, true);
  assert.equal(recoveryAgain.task_id, recovery.task_id);
  assert.deepEqual(counts(db), beforeRecovery);

  const retryRun = await startExecutionRun(db, tenantId, recovery.task_id, executorId);
  const retryDone = await completeRun(db, tenantId, retryRun.run.id, {
    success: true,
    summary: 'm2 retry execution passed',
    output: {
      required_tests: [{ command: 'node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js', passed: true }],
      executor_report: {
        required_tests: [{ command: 'node --test test/autopilot-lifecycle-e2e-smoke-v2.test.js', passed: true }]
      }
    }
  });
  const m2Complete = await verifyComplete(db, retryDone.autopilot_verification.verification_run_id);
  assert.equal(m2Complete.action, 'COMPLETE');
  assert.equal(m2Complete.continuation_state, 'STARTED');
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, m2MissionId);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 3);
  const m3MissionId = milestone(db, roadmapId, 'm3').mission_id;
  const m3BrainRunId = programBrainRuns(db, m3MissionId)[0].id;
  assert.ok(m3MissionId);
  assert.equal(milestone(db, roadmapId, 'm2').state, 'COMPLETED');
  await assertReadOnlyRoadmapRead(db, handler, roadmapId, {
    roadmapState: 'ACTIVE',
    states: { m1: 'COMPLETED', m2: 'COMPLETED', m3: 'PLANNING' },
    missionIds: { m1: m1MissionId, m2: m2MissionId, m3: m3MissionId }
  });

  const countsAfterM3Start = counts(db);
  const m2Replay = await verifyComplete(db, retryDone.autopilot_verification.verification_run_id);
  assert.equal(m2Replay.replayed, true);
  assert.equal(m2Replay.continuation_state, 'ALREADY_RUNNING');
  assert.deepEqual(counts(db), countsAfterM3Start);
  assert.equal(programBrainRuns(db, m3MissionId).length, 1);
  assert.equal(programBrainRuns(db, m3MissionId)[0].id, m3BrainRunId);

  const m3Execution = await planAndExecute(db, m3BrainRunId, 'm3');
  const m3Complete = await verifyComplete(db, m3Execution.verificationRunId);
  assert.equal(m3Complete.action, 'COMPLETE');
  assert.equal(m3Complete.continuation_state, 'ROADMAP_COMPLETED');
  assert.match(roadmap(db, roadmapId).state, /^COMPLETE(D)?$/);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 3);
  await assertReadOnlyRoadmapRead(db, handler, roadmapId, {
    roadmapState: 'COMPLETED',
    states: { m1: 'COMPLETED', m2: 'COMPLETED', m3: 'COMPLETED' },
    missionIds: { m1: m1MissionId, m2: m2MissionId, m3: m3MissionId }
  });

  const terminalCounts = counts(db);
  const terminalReplay = await verifyComplete(db, m3Execution.verificationRunId);
  assert.equal(terminalReplay.replayed, true);
  assert.equal(terminalReplay.continuation_state, 'ROADMAP_COMPLETED');
  assert.match(roadmap(db, roadmapId).state, /^COMPLETE(D)?$/);
  assert.deepEqual(counts(db), terminalCounts);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 3);
  assertOrderAndDependencies(db, roadmapId);
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, m2MissionId);
});

test('Planner UI preserves initial start, trusted reads, and recovery controls without lifecycle authority', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/planner.ui.routes.js'), 'utf8');
  assert.match(source, /id="startAutopilot"/);
  assert.match(source, /\/api\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/autopilot'/);
  assert.doesNotMatch(source, /\/api\/roadmaps\/' \+ encodeURIComponent\([^)]*\) \+ '\/advance/);
  assert.doesNotMatch(source, /\/milestones\/' \+ encodeURIComponent\([^)]*\) \+ '\/state/);
  assert.match(source, /Replay Brain/);
  assert.match(source, /Retry Execution/);
  assert.match(source, /Resume/);
  assert.match(source, /await loadProposal\(\);/);
  assert.doesNotMatch(source, /state\.proposal\.milestones\s*=/);
  assert.doesNotMatch(source, /state\.proposal\.state\s*=/);
});

test('Git-stage compatibility gates automatic continuation until Git completion and remains idempotent', async () => {
  const db = new DB();
  const { roadmapId } = await createApprovedRoadmap(db, { git: true, gitM1: true });

  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 0);
  const started = await startPlannerRoadmap(db, tenantId, roadmapId);
  const m1MissionId = started.mission.id;
  const m1BrainRunId = started.brain_run.id;
  const m1Execution = await planAndExecute(db, m1BrainRunId, 'git m1');
  const gated = await verifyComplete(db, m1Execution.verificationRunId);
  assert.equal(gated.action, 'GIT_STAGE');
  assert.equal(gated.continuation_state, 'GIT_STAGE_PENDING');
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, undefined);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 1);

  const gitTask = tasksFor(db, m1MissionId).find((task) => task.autopilot_phase === 'GIT_STAGE');
  assert.ok(gitTask);
  const gitRun = await startExecutionRun(db, tenantId, gitTask.id, executorId);
  const completed = await completeGitStageExecutionRun(db, tenantId, gitRun.run.id, {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: false, commit_sha: 'smoke123' } }
  });
  assert.equal(completed.continuation_state, 'STARTED');
  assert.equal(milestone(db, roadmapId, 'm1').state, 'COMPLETED');
  assert.equal(milestone(db, roadmapId, 'm2').state, 'PLANNING');
  const m2MissionId = milestone(db, roadmapId, 'm2').mission_id;
  assert.ok(m2MissionId);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 2);

  const afterGitCounts = counts(db);
  const replay = await completeGitStageExecutionRun(db, tenantId, gitRun.run.id, {
    success: true,
    output: { git: { classification: 'SUCCESS', committed: true, pushed: false, commit_sha: 'smoke123' } }
  });
  assert.equal(replay.continuation_state, 'ALREADY_RUNNING');
  assert.equal(milestone(db, roadmapId, 'm2').mission_id, m2MissionId);
  assert.equal(roadmapMilestoneMissionCount(db, roadmapId), 2);
  assert.equal(counts(db).missions, afterGitCounts.missions);
  assert.equal(counts(db).tasks, afterGitCounts.tasks);
  assert.equal(counts(db).runs, afterGitCounts.runs);
});
