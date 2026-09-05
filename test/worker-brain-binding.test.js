const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIGURATION_INCOMPLETE,
  READY,
  SOURCE_LEGACY_W01_FALLBACK,
  SOURCE_PERSISTED,
  assertNoSecretBrainBindingFields,
  normalizeBrainChatBinding,
  resolveWorkerBrainBinding
} = require('../src/services/worker-brain-binding');

const DELETE_FIELD = Symbol('delete-field');

function validBinding(overrides = {}) {
  return {
    version: 1,
    provider: 'CHATGPT_WEB',
    chat_binding: 'https://chatgpt.com/c/worker-chat',
    role: 'Planner',
    instructions: 'Use the persisted chat.',
    configuration_state: READY,
    ...overrides
  };
}

function legacyConfig() {
  return {
    chatUrlForWorker(workerId) {
      return workerId === 'W01' ? 'https://chatgpt.com/c/legacy-w01' : null;
    },
    brainChatUrls: {
      W01: 'https://chatgpt.com/c/legacy-w01-from-map'
    }
  };
}

function createFakeDb(initialWorkers) {
  const docs = new Map(Object.entries(initialWorkers).map(([id, data]) => [id, { ...data }]));
  const writes = [];

  function applySet(id, data, options) {
    writes.push({ id, data: { ...data }, options });
    const existing = docs.get(id) || {};
    const next = options?.merge ? { ...existing } : {};
    for (const [key, value] of Object.entries(data)) {
      if (value === DELETE_FIELD) delete next[key];
      else next[key] = value;
    }
    docs.set(id, next);
  }

  return {
    writes,
    constructor: {
      FieldValue: {
        delete: () => DELETE_FIELD
      }
    },
    dataFor(id) {
      return docs.get(id);
    },
    collection(name) {
      assert.equal(name, 'workers');
      return {
        doc(id) {
          return {
            async get() {
              const data = docs.get(id);
              return {
                exists: Boolean(data),
                id,
                data: () => ({ ...data })
              };
            },
            async set(data, options) {
              applySet(id, data, options);
            }
          };
        }
      };
    }
  };
}

test('valid CHATGPT_WEB persisted binding normalizes without losing chat_binding, role or instructions', () => {
  const normalized = normalizeBrainChatBinding({
    version: '1',
    provider: 'CHATGPT_WEB',
    chat_binding: '  https://chatgpt.com/c/abc123  ',
    role: '  Brain Worker  ',
    instructions: '  Stay scoped.  ',
    configuration_state: READY
  });

  assert.deepEqual(normalized, {
    version: 1,
    provider: 'CHATGPT_WEB',
    chat_binding: 'https://chatgpt.com/c/abc123',
    role: 'Brain Worker',
    instructions: 'Stay scoped.',
    configuration_state: READY
  });
});

test('unsupported provider is rejected', () => {
  assert.throws(
    () => normalizeBrainChatBinding(validBinding({ provider: 'OTHER_PROVIDER' })),
    /Unsupported brain chat binding provider/
  );
});

test('missing or blank chat_binding cannot resolve READY', () => {
  const missing = resolveWorkerBrainBinding({
    id: 'W02',
    brain_chat_binding: {
      provider: 'CHATGPT_WEB',
      configuration_state: READY
    }
  }, legacyConfig());
  const blank = resolveWorkerBrainBinding({
    id: 'W02',
    brain_chat_binding: validBinding({ chat_binding: '   ' })
  }, legacyConfig());

  assert.equal(missing.readiness, CONFIGURATION_INCOMPLETE);
  assert.equal(blank.readiness, CONFIGURATION_INCOMPLETE);
});

test('secret-like top-level fields are rejected', () => {
  assert.throws(
    () => assertNoSecretBrainBindingFields({ token: 'do-not-store' }),
    /secret-like field: token/
  );
});

test('secret-like nested fields are rejected', () => {
  assert.throws(
    () => assertNoSecretBrainBindingFields({ metadata: { chrome_session: 'do-not-store' } }),
    /secret-like field: metadata.chrome_session/
  );
});

test('normal opaque ChatGPT chat URL value is not falsely rejected because validation is key-based', () => {
  assert.doesNotThrow(() => normalizeBrainChatBinding(validBinding({
    chat_binding: 'https://chatgpt.com/c/token-looking-opaque-id-secret-123'
  })));
});

test('persisted READY W01 binding takes precedence over legacy W01 config', () => {
  const result = resolveWorkerBrainBinding({
    id: 'W01',
    brain_chat_binding: validBinding({ chat_binding: 'https://chatgpt.com/c/persisted-w01' })
  }, legacyConfig());

  assert.equal(result.source, SOURCE_PERSISTED);
  assert.equal(result.readiness, READY);
  assert.equal(result.binding.chat_binding, 'https://chatgpt.com/c/persisted-w01');
});

test('W01 with no persisted binding resolves legacy W01 fallback and does not mutate or persist it', () => {
  const worker = { id: 'W01', tenant_id: 'tenant-a', permissions: ['run'] };
  const before = structuredClone(worker);
  const result = resolveWorkerBrainBinding(worker, legacyConfig());

  assert.equal(result.source, SOURCE_LEGACY_W01_FALLBACK);
  assert.equal(result.readiness, READY);
  assert.equal(result.binding.chat_binding, 'https://chatgpt.com/c/legacy-w01');
  assert.deepEqual(worker, before);
  assert.equal(Object.prototype.hasOwnProperty.call(worker, 'brain_chat_binding'), false);
});

test('malformed persisted W01 binding fails closed and does not fall through to legacy fallback', () => {
  const result = resolveWorkerBrainBinding({
    id: 'W01',
    brain_chat_binding: validBinding({ provider: 'UNSUPPORTED' })
  }, legacyConfig());

  assert.equal(result.source, SOURCE_PERSISTED);
  assert.equal(result.readiness, CONFIGURATION_INCOMPLETE);
  assert.equal(result.binding, null);
});

test('W02 with no binding is CONFIGURATION_INCOMPLETE and never receives W01 fallback', () => {
  const result = resolveWorkerBrainBinding({ id: 'W02' }, legacyConfig());

  assert.equal(result.readiness, CONFIGURATION_INCOMPLETE);
  assert.equal(result.binding, null);
});

test('W02 with CONFIGURATION_INCOMPLETE binding remains incomplete even with a non-empty chat_binding', () => {
  const result = resolveWorkerBrainBinding({
    id: 'W02',
    brain_chat_binding: validBinding({ configuration_state: CONFIGURATION_INCOMPLETE })
  }, legacyConfig());

  assert.equal(result.source, SOURCE_PERSISTED);
  assert.equal(result.readiness, CONFIGURATION_INCOMPLETE);
  assert.equal(result.binding.chat_binding, 'https://chatgpt.com/c/worker-chat');
});

test("W02 READY binding resolves its own chat and not W01's", () => {
  const result = resolveWorkerBrainBinding({
    id: 'W02',
    brain_chat_binding: validBinding({ chat_binding: 'https://chatgpt.com/c/w02-chat' })
  }, legacyConfig());

  assert.equal(result.source, SOURCE_PERSISTED);
  assert.equal(result.readiness, READY);
  assert.equal(result.binding.chat_binding, 'https://chatgpt.com/c/w02-chat');
});

test('Worker identity, Executor, Host, permissions and capabilities are not part of binding resolution and are not mutated', () => {
  const worker = {
    id: 'W02',
    tenant_id: 'tenant-a',
    executor_id: 'executor-1',
    host_id: 'host-1',
    permissions: ['missions:advance'],
    capabilities: ['node:test'],
    brain_chat_binding: validBinding({ chat_binding: 'https://chatgpt.com/c/w02-chat' })
  };
  const before = structuredClone(worker);

  const result = resolveWorkerBrainBinding(worker, legacyConfig());

  assert.equal(result.readiness, READY);
  assert.deepEqual(worker, before);
  assert.equal(result.binding.chat_binding, 'https://chatgpt.com/c/w02-chat');
});

test('WorkersRepository setBrainChatBinding enforces tenant ownership and writes only the additive binding field', async () => {
  const { WorkersRepository } = require('../src/repositories/workers.repository');
  const db = createFakeDb({
    W02: {
      tenant_id: 'tenant-a',
      role: 'executor',
      permissions: ['run'],
      capabilities: ['node'],
      executor_id: 'executor-1',
      host_id: 'host-1'
    }
  });
  const repo = new WorkersRepository(db);

  await assert.rejects(
    () => repo.setBrainChatBinding('W02', 'tenant-b', validBinding()),
    /does not belong to tenant/
  );
  assert.equal(db.writes.length, 0);

  const updated = await repo.setBrainChatBinding('W02', 'tenant-a', validBinding({
    chat_binding: ' https://chatgpt.com/c/w02-persisted '
  }));

  assert.equal(db.writes.length, 1);
  assert.deepEqual(Object.keys(db.writes[0].data), ['brain_chat_binding']);
  assert.deepEqual(db.writes[0].options, { merge: true });
  assert.equal(updated.brain_chat_binding.chat_binding, 'https://chatgpt.com/c/w02-persisted');
  assert.equal(updated.role, 'executor');
  assert.deepEqual(updated.permissions, ['run']);
  assert.deepEqual(updated.capabilities, ['node']);
  assert.equal(updated.executor_id, 'executor-1');
  assert.equal(updated.host_id, 'host-1');
});

test('clearing a binding preserves all unrelated Worker fields', async () => {
  const { WorkersRepository } = require('../src/repositories/workers.repository');
  const db = createFakeDb({
    W02: {
      tenant_id: 'tenant-a',
      role: 'executor',
      permissions: ['run'],
      capabilities: ['node'],
      executor_id: 'executor-1',
      host_id: 'host-1',
      brain_chat_binding: validBinding()
    }
  });
  const repo = new WorkersRepository(db);

  const updated = await repo.clearBrainChatBinding('W02', 'tenant-a');

  assert.equal(db.writes.length, 1);
  assert.deepEqual(Object.keys(db.writes[0].data), ['brain_chat_binding']);
  assert.deepEqual(db.writes[0].options, { merge: true });
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'brain_chat_binding'), false);
  assert.equal(updated.role, 'executor');
  assert.deepEqual(updated.permissions, ['run']);
  assert.deepEqual(updated.capabilities, ['node']);
  assert.equal(updated.executor_id, 'executor-1');
  assert.equal(updated.host_id, 'host-1');
});
