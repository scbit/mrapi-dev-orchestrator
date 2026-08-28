const test = require('node:test');
const assert = require('node:assert/strict');

const {
  notificationKind,
  fingerprintForMission,
  buildMessage,
  notifyMission
} = require('../src/services/telegramNotifications');

class Doc {
  constructor(id, store) {
    this.id = id;
    this.store = store;
  }
  async get() {
    const value = this.store.get(this.id);
    return { exists: value !== undefined, id: this.id, data: () => value };
  }
  async set(value, options = {}) {
    const prior = this.store.get(this.id) || {};
    this.store.set(this.id, options.merge ? { ...prior, ...value } : value);
  }
}

class Collection {
  constructor(store) { this.store = store; }
  doc(id) { return new Doc(id, this.store); }
}

class FakeDb {
  constructor() {
    this.stores = new Map();
  }
  collection(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return new Collection(this.stores.get(name));
  }
}

function env() {
  return {
    TELEGRAM_GATEWAY_URL: 'https://telegram.example',
    TELEGRAM_BUSINESS_ID: 'scb',
    TELEGRAM_CHAT_ID: '12345',
    TELEGRAM_GATEWAY_API_KEY: 'secret',
    MRAPI_PUBLIC_BASE_URL: 'https://mrapi.example'
  };
}

test('notifies only target Mission states', () => {
  assert.equal(notificationKind({ state: 'NEED_HUMAN_ACTION' }), 'HUMAN_ACTION_REQUIRED');
  assert.equal(notificationKind({ state: 'BLOCKED' }), 'MISSION_BLOCKED');
  assert.equal(notificationKind({ state: 'FAILED' }), 'MISSION_FAILED');
  assert.equal(notificationKind({ state: 'COMPLETED' }), 'MISSION_COMPLETED');
  assert.equal(notificationKind({ state: 'RUNNING' }), null);
});

test('Human Action message includes requested action', () => {
  const mission = {
    id: 'm1',
    tenant_id: 't1',
    workspace_id: 'w1',
    project_id: 'p1',
    preferred_worker_id: 'W01',
    state: 'NEED_HUMAN_ACTION',
    objective: 'Test mission',
    human_action_checkpoint: {
      checkpoint_id: 'cp1',
      user_action: 'Clean repository and press LISTO.'
    }
  };
  const text = buildMessage(
    { uiBaseUrl: 'https://mrapi.example' },
    mission,
    'HUMAN_ACTION_REQUIRED'
  );
  assert.match(text, /necesita ayuda humana/i);
  assert.match(text, /Clean repository and press LISTO/);
  assert.match(text, /W01/);
});

test('fingerprint deduplicates same state/checkpoint', () => {
  const mission = {
    id: 'm1',
    tenant_id: 't1',
    state: 'BLOCKED',
    blocker_code: 'BRAIN_RESULT_MISSING'
  };
  assert.equal(
    fingerprintForMission(mission, 'MISSION_BLOCKED'),
    fingerprintForMission(mission, 'MISSION_BLOCKED')
  );
});

test('notify sends exactly once', async () => {
  const db = new FakeDb();
  let sends = 0;

  const mission = {
    id: 'm1',
    tenant_id: 't1',
    workspace_id: 'w1',
    project_id: 'p1',
    preferred_worker_id: 'W01',
    state: 'BLOCKED',
    blocker_code: 'BRAIN_RESULT_MISSING',
    objective: 'Brain-only baseline'
  };

  const fetchImpl = async (_url, options) => {
    sends += 1;
    assert.equal(options.headers['x-api-key'], 'secret');
    const body = JSON.parse(options.body);
    assert.equal(body.chatId, '12345');
    assert.match(body.text, /BRAIN_RESULT_MISSING/);
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ok: true, messageId: 1 }); }
    };
  };

  const first = await notifyMission({ db, mission, env: env(), fetchImpl });
  const second = await notifyMission({ db, mission, env: env(), fetchImpl });

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'ALREADY_SENT');
  assert.equal(sends, 1);
});

test('Telegram failure never throws into MRAPI lifecycle', async () => {
  const db = new FakeDb();
  const mission = {
    id: 'm1',
    tenant_id: 't1',
    state: 'FAILED',
    objective: 'Failure test'
  };

  const result = await notifyMission({
    db,
    mission,
    env: env(),
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() { return 'gateway down'; }
    })
  });

  assert.equal(result.sent, false);
  assert.equal(result.failed, true);
});
