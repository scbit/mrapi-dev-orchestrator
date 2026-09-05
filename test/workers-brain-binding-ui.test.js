const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function createMiniExpress() {
  function Router() {
    const routes = [];

    function add(method, pattern, handlers) {
      routes.push({ method, pattern, handlers });
    }

    async function router(req, res, next) {
      const route = routes.find((item) => item.method === req.method && matchRoute(item.pattern, req.url));
      if (!route) return next();
      req.params = matchRoute(route.pattern, req.url).params;
      let index = 0;
      const run = async (error) => {
        if (error) return next(error);
        const handler = route.handlers[index++];
        if (!handler) return undefined;
        return handler(req, res, run);
      };
      return run();
    }

    router.get = (pattern, ...handlers) => add('GET', pattern, handlers);
    router.patch = (pattern, ...handlers) => add('PATCH', pattern, handlers);
    return router;
  }

  return { Router };
}

function matchRoute(pattern, url) {
  const pathOnly = String(url || '/').split('?')[0] || '/';
  const patternParts = pattern.split('/').filter(Boolean);
  const urlParts = pathOnly.split('/').filter(Boolean);
  if (patternParts.length !== urlParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const urlPart = decodeURIComponent(urlParts[index]);
    if (patternPart.startsWith(':')) params[patternPart.slice(1)] = urlPart;
    else if (patternPart !== urlPart) return null;
  }
  return { params };
}

function loadWorkersRouterWithMiniExpress() {
  const resolved = require.resolve('../src/routes/workers.routes');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/workers.routes');
  } finally {
    Module._load = originalLoad;
  }
}

async function callRoute(router, { method = 'GET', url = '/', tenantId = 'tenant_a', body = {} } = {}) {
  const req = { method, url, tenantId, body };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  await router(req, res, (error) => {
    if (error) throw error;
    res.statusCode = 404;
    res.body = { error: 'NOT_FOUND' };
  });
  return res;
}

function readyBinding(overrides = {}) {
  return {
    version: 1,
    provider: 'CHATGPT_WEB',
    chat_binding: 'https://chatgpt.com/c/w02-ready',
    role: 'Brain operator',
    instructions: 'Use the configured chat.',
    configuration_state: 'READY',
    ...overrides
  };
}

function createRepos(initialWorkers) {
  const workers = new Map(Object.entries(initialWorkers).map(([id, value]) => [id, { ...value }]));
  const writes = [];

  return {
    writes,
    workers: {
      async listByTenant(tenantId) {
        return [...workers.entries()]
          .filter(([, worker]) => worker.tenant_id === tenantId)
          .map(([id, worker]) => ({ id, ...worker }));
      },
      async getById(workerId) {
        const worker = workers.get(workerId);
        return worker ? { id: workerId, ...worker } : null;
      },
      async setBrainChatBinding(workerId, tenantId, binding) {
        const worker = workers.get(workerId);
        if (!worker || worker.tenant_id !== tenantId) throw new Error('Worker not found');
        writes.push({ workerId, tenantId, binding });
        const updated = { ...worker, brain_chat_binding: { ...binding } };
        workers.set(workerId, updated);
        return { id: workerId, ...updated };
      }
    }
  };
}

function routerFor(initialWorkers) {
  const repos = createRepos(initialWorkers);
  const { createWorkersRouter } = loadWorkersRouterWithMiniExpress();
  return { repos, router: createWorkersRouter({ repos }) };
}

test('GET /api/workers read model is tenant scoped and separates Worker, Brain, Executor, Host, capabilities and permissions', async () => {
  const { router } = routerFor({
    W01: {
      tenant_id: 'tenant_a',
      code: 'W01',
      name: 'Worker One',
      role: 'primary',
      status: 'IDLE',
      executor_id: 'executor_1',
      host_id: 'host_1',
      current_mission_id: 'mission_1',
      capabilities: ['node:test'],
      permissions: { deploy: false },
      brain_chat_binding: readyBinding({ chat_binding: 'https://chatgpt.com/c/w01' })
    },
    W02: { tenant_id: 'tenant_b', code: 'W02', name: 'Other Tenant' }
  });

  const res = await callRoute(router, { url: '/', tenantId: 'tenant_a' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1);
  const worker = res.body.items[0];
  assert.equal(worker.id, 'W01');
  assert.equal(worker.operational_presentation.worker_name, 'Worker One');
  assert.equal(worker.operational_presentation.role, 'primary');
  assert.equal(worker.operational_presentation.brain_runtime_config.provider, 'CHATGPT_WEB');
  assert.equal(worker.operational_presentation.executor, 'executor_1');
  assert.equal(worker.operational_presentation.host, 'host_1');
  assert.equal(worker.operational_presentation.current_mission, 'mission_1');
  assert.deepEqual(worker.operational_presentation.capabilities, ['node:test']);
  assert.deepEqual(worker.operational_presentation.permissions, { deploy: false });
});

test('GET /api/workers/:workerId enforces tenant isolation', async () => {
  const { router } = routerFor({ W02: { tenant_id: 'tenant_b', code: 'W02' } });
  const res = await callRoute(router, { url: '/W02', tenantId: 'tenant_a' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'WORKER_NOT_FOUND');
});

test('configuration and runtime presentation follow trusted Worker state rules', async () => {
  const { router } = routerFor({
    W02: { tenant_id: 'tenant_a', code: 'W02', name: 'Worker Two' },
    W03: { tenant_id: 'tenant_a', code: 'W03', brain_chat_binding: readyBinding() },
    W04: { tenant_id: 'tenant_a', code: 'W04', configuration_status: 'HUMAN_ACTION_REQUIRED' }
  });

  const res = await callRoute(router, { url: '/', tenantId: 'tenant_a' });
  const byId = Object.fromEntries(res.body.items.map((worker) => [worker.id, worker]));
  assert.equal(byId.W02.configuration_status, 'CONFIGURATION_INCOMPLETE');
  assert.equal(byId.W02.operational_presentation.runtime_status, 'UNKNOWN');
  assert.equal(byId.W03.configuration_status, 'READY');
  assert.equal(byId.W04.configuration_status, 'HUMAN_ACTION_REQUIRED');
});

test('PATCH accepts only CHATGPT_WEB non-secret binding fields and forces CONFIGURATION_INCOMPLETE', async () => {
  const { router, repos } = routerFor({
    W02: {
      tenant_id: 'tenant_a',
      code: 'W02',
      name: 'Worker Two',
      status: 'IDLE',
      executor_id: 'executor_1',
      host_id: 'host_1',
      capabilities: ['node'],
      permissions: { git_write: false }
    }
  });

  const res = await callRoute(router, {
    method: 'PATCH',
    url: '/W02/brain-chat-binding',
    tenantId: 'tenant_a',
    body: {
      provider: 'CHATGPT_WEB',
      chat_binding: ' https://chatgpt.com/c/w02-configured ',
      role: 'Brain',
      instructions: 'Use this chat.'
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(repos.writes.length, 1);
  assert.deepEqual(Object.keys(repos.writes[0].binding).sort(), [
    'chat_binding',
    'configuration_state',
    'instructions',
    'provider',
    'role',
    'version'
  ].sort());
  assert.equal(repos.writes[0].binding.configuration_state, 'CONFIGURATION_INCOMPLETE');
  assert.equal(res.body.configuration_status, 'CONFIGURATION_INCOMPLETE');
  assert.equal(res.body.status, 'IDLE');
  assert.equal(res.body.executor_id, 'executor_1');
  assert.equal(res.body.host_id, 'host_1');
  assert.deepEqual(res.body.capabilities, ['node']);
  assert.deepEqual(res.body.permissions, { git_write: false });
});

test('PATCH rejects configuration_state READY and immutable or lifecycle Worker fields', async () => {
  const { router } = routerFor({ W02: { tenant_id: 'tenant_a', code: 'W02' } });
  const forbiddenFields = [
    'configuration_state',
    'id',
    'worker_id',
    'code',
    'name',
    'status',
    'executor',
    'executor_id',
    'host',
    'current_mission',
    'current_mission_id',
    'capabilities',
    'permissions',
    'tenant_id',
    'lifecycle'
  ];

  for (const field of forbiddenFields) {
    const res = await callRoute(router, {
      method: 'PATCH',
      url: '/W02/brain-chat-binding',
      body: {
        provider: 'CHATGPT_WEB',
        chat_binding: 'https://chatgpt.com/c/w02',
        [field]: field === 'configuration_state' ? 'READY' : 'mutate'
      }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'BRAIN_BINDING_FIELDS_NOT_ALLOWED');
    assert.deepEqual(res.body.fields, [field]);
  }
});

test('PATCH rejects unsupported provider, blank chat_binding, secret-like fields and cross-tenant writes', async () => {
  const { router, repos } = routerFor({ W02: { tenant_id: 'tenant_a', code: 'W02' } });

  assert.equal((await callRoute(router, {
    method: 'PATCH',
    url: '/W02/brain-chat-binding',
    body: { provider: 'OTHER', chat_binding: 'https://chatgpt.com/c/w02' }
  })).body.error, 'UNSUPPORTED_BRAIN_BINDING_PROVIDER');

  assert.equal((await callRoute(router, {
    method: 'PATCH',
    url: '/W02/brain-chat-binding',
    body: { provider: 'CHATGPT_WEB', chat_binding: '   ' }
  })).body.error, 'BRAIN_CHAT_BINDING_REQUIRED');

  assert.equal((await callRoute(router, {
    method: 'PATCH',
    url: '/W02/brain-chat-binding',
    body: { provider: 'CHATGPT_WEB', chat_binding: 'https://chatgpt.com/c/w02', token: 'secret' }
  })).body.error, 'BRAIN_BINDING_SECRET_FIELDS_NOT_ALLOWED');

  const mismatch = await callRoute(router, {
    method: 'PATCH',
    url: '/W02/brain-chat-binding',
    tenantId: 'tenant_b',
    body: { provider: 'CHATGPT_WEB', chat_binding: 'https://chatgpt.com/c/w02' }
  });
  assert.equal(mismatch.statusCode, 404);
  assert.equal(mismatch.body.error, 'WORKER_NOT_FOUND');
  assert.equal(repos.writes.length, 0);
});

test('Worker responses redact secret-like fixture fields from binding payloads', async () => {
  const { router } = routerFor({
    W02: {
      tenant_id: 'tenant_a',
      code: 'W02',
      brain_chat_binding: {
        provider: 'CHATGPT_WEB',
        chat_binding: 'https://chatgpt.com/c/w02',
        token: 'do-not-return',
        nested: { browser_session: 'do-not-return' }
      }
    }
  });

  const res = await callRoute(router, { url: '/W02', tenantId: 'tenant_a' });
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /do-not-return|token|browser_session/);
});

test('static Workers UI exposes required concepts and bounded Brain binding save path', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/public/index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../src/public/styles.css'), 'utf8');

  for (const label of ['Worker', 'Brain / Chat', 'Executor', 'Host', 'Current Mission', 'Capabilities', 'Permissions', 'Configuration', 'Runtime']) {
    assert.match(`${appSource}\n${html}`, new RegExp(label.replace(/[ /]/g, '[ /]'), 'i'));
  }

  const saveHandler = appSource.match(/async function submitWorkerBrainBinding[\s\S]+?\n}\n/);
  assert.ok(saveHandler);
  assert.match(saveHandler[0], /\/api\/workers\/\$\{encodeURIComponent\(workerId\)\}\/brain-chat-binding/);
  assert.doesNotMatch(saveHandler[0], /\/advance|human-action|ready|complete|autopilot|planner/);
  assert.match(saveHandler[0], /CONFIGURATION_INCOMPLETE/);
  assert.doesNotMatch(saveHandler[0], /READY/);
  assert.match(styles, /worker-config-note|workerBrainFormMessage/);
  assert.match(html, /workerBrainProvider[\s\S]+CHATGPT_WEB/);
});
