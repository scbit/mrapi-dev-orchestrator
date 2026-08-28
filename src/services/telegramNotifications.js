const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 8000;

function clean(value, max = 1800) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function envConfig(env = process.env) {
  return {
    gatewayUrl: clean(env.TELEGRAM_GATEWAY_URL, 2000).replace(/\/+$/, ''),
    businessId: clean(env.TELEGRAM_BUSINESS_ID || 'scb', 200),
    chatId: clean(env.TELEGRAM_CHAT_ID, 200),
    apiKey: clean(env.TELEGRAM_GATEWAY_API_KEY, 2000),
    uiBaseUrl: clean(env.MRAPI_PUBLIC_BASE_URL || '', 2000).replace(/\/+$/, ''),
    timeoutMs: Math.max(1000, Number(env.TELEGRAM_NOTIFICATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS))
  };
}

function configured(cfg) {
  return Boolean(cfg.gatewayUrl && cfg.businessId && cfg.chatId);
}

function checkpointFromMission(mission = {}) {
  return mission.human_action_checkpoint ||
    mission.current_human_action_checkpoint ||
    mission.human_action ||
    null;
}

function notificationKind(mission = {}) {
  const state = clean(mission.state, 100).toUpperCase();
  if (state === 'NEED_HUMAN_ACTION') return 'HUMAN_ACTION_REQUIRED';
  if (state === 'BLOCKED') return 'MISSION_BLOCKED';
  if (state === 'FAILED') return 'MISSION_FAILED';
  if (state === 'COMPLETED') return 'MISSION_COMPLETED';
  return null;
}

function failureCode(mission = {}) {
  const checkpoint = checkpointFromMission(mission) || {};
  return clean(
    mission.failure_code ||
    mission.error_code ||
    mission.blocker_code ||
    mission.last_error_code ||
    mission.progress_code ||
    checkpoint.blocker_code ||
    checkpoint.requirement_type ||
    '',
    300
  ) || null;
}

function fingerprintForMission(mission, kind) {
  const checkpoint = checkpointFromMission(mission) || {};
  const parts = [
    mission.tenant_id || '',
    mission.id || '',
    kind || '',
    clean(mission.state, 100).toUpperCase(),
    checkpoint.checkpoint_id || '',
    checkpoint.generation || '',
    failureCode(mission) || ''
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

function missionUrl(cfg, mission) {
  if (!cfg.uiBaseUrl || !mission?.id) return null;
  return `${cfg.uiBaseUrl}/?mission=${encodeURIComponent(mission.id)}`;
}

function buildMessage(cfg, mission, kind) {
  const checkpoint = checkpointFromMission(mission) || {};
  const code = failureCode(mission);
  const objective = clean(mission.objective || mission.title || 'Mission', 420);
  const action = clean(
    checkpoint.user_action ||
    checkpoint.human_action_request ||
    mission.human_action_request ||
    '',
    500
  );

  const icon = {
    HUMAN_ACTION_REQUIRED: '⚠️',
    MISSION_BLOCKED: '🛑',
    MISSION_FAILED: '❌',
    MISSION_COMPLETED: '✅'
  }[kind] || 'ℹ️';

  const title = {
    HUMAN_ACTION_REQUIRED: 'MRAPI necesita ayuda humana',
    MISSION_BLOCKED: 'MRAPI Mission bloqueada',
    MISSION_FAILED: 'MRAPI Mission falló',
    MISSION_COMPLETED: 'MRAPI Mission completada'
  }[kind] || 'MRAPI';

  const lines = [
    `${icon} ${title}`,
    '',
    `Worker: ${clean(mission.preferred_worker_id || mission.worker_id || '-', 120)}`,
    `Mission: ${objective}`,
    `State: ${clean(mission.state || '-', 100)}`,
    code ? `Code: ${code}` : null,
    `Tenant: ${clean(mission.tenant_id || '-', 160)}`,
    `Workspace: ${clean(mission.workspace_id || '-', 160)}`,
    `Project: ${clean(mission.project_id || '-', 160)}`,
    mission.roadmap_id ? `Roadmap: ${clean(mission.roadmap_id, 160)}` : null,
    mission.milestone_id ? `Milestone: ${clean(mission.milestone_id, 160)}` : null,
    action ? '' : null,
    action ? `Acción: ${action}` : null,
    missionUrl(cfg, mission) ? '' : null,
    missionUrl(cfg, mission) ? `Abrir MRAPI: ${missionUrl(cfg, mission)}` : null
  ].filter((line) => line !== null);

  return lines.join('\n').slice(0, 3900);
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function reserveDelivery(db, fingerprint, mission, kind) {
  const ref = db.collection('notification_deliveries').doc(fingerprint);
  const snap = await ref.get();

  if (snap.exists) {
    const existing = snap.data() || {};
    if (existing.status === 'SENT') return { send: false, reason: 'ALREADY_SENT', ref };
    if (existing.status === 'PENDING' && Date.now() - millis(existing.updated_at) < 120000) {
      return { send: false, reason: 'ALREADY_PENDING', ref };
    }
  }

  await ref.set({
    id: fingerprint,
    tenant_id: mission.tenant_id || null,
    workspace_id: mission.workspace_id || null,
    project_id: mission.project_id || null,
    mission_id: mission.id,
    roadmap_id: mission.roadmap_id || null,
    milestone_id: mission.milestone_id || null,
    channel: 'TELEGRAM',
    notification_kind: kind,
    status: 'PENDING',
    attempt_count: Number(snap.exists ? snap.data()?.attempt_count || 0 : 0) + 1,
    updated_at: new Date(),
    created_at: snap.exists ? (snap.data()?.created_at || new Date()) : new Date()
  }, { merge: true });

  return { send: true, ref };
}

async function sendTelegram(cfg, text, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_NOT_AVAILABLE');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

    const response = await fetchImpl(
      `${cfg.gatewayUrl}/telegram/send/${encodeURIComponent(cfg.businessId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatId: cfg.chatId, text }),
        signal: controller.signal
      }
    );

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`TELEGRAM_GATEWAY_${response.status}: ${bodyText.slice(0, 500)}`);
    }

    return bodyText ? JSON.parse(bodyText) : { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyMission({ db, mission, env = process.env, fetchImpl = globalThis.fetch }) {
  try {
    const cfg = envConfig(env);
    if (!configured(cfg)) return { sent: false, skipped: true, reason: 'NOT_CONFIGURED' };

    const kind = notificationKind(mission);
    if (!kind) return { sent: false, skipped: true, reason: 'NOT_NOTIFIABLE' };

    const fingerprint = fingerprintForMission(mission, kind);
    const reservation = await reserveDelivery(db, fingerprint, mission, kind);
    if (!reservation.send) {
      return { sent: false, skipped: true, reason: reservation.reason, fingerprint };
    }

    const text = buildMessage(cfg, mission, kind);

    try {
      const telegramResult = await sendTelegram(cfg, text, fetchImpl);
      await reservation.ref.set({
        status: 'SENT',
        sent_at: new Date(),
        last_error: null,
        telegram_result: telegramResult && typeof telegramResult === 'object'
          ? JSON.parse(JSON.stringify(telegramResult).slice(0, 4000))
          : null,
        updated_at: new Date()
      }, { merge: true });

      return { sent: true, kind, fingerprint };
    } catch (error) {
      await reservation.ref.set({
        status: 'FAILED',
        last_error: clean(error?.message || error, 1000),
        failed_at: new Date(),
        updated_at: new Date()
      }, { merge: true });

      console.error('[MRAPI TELEGRAM]', clean(error?.message || error, 1000));
      return {
        sent: false,
        failed: true,
        kind,
        fingerprint,
        error: clean(error?.message || error, 1000)
      };
    }
  } catch (error) {
    // Observability must never break MRAPI lifecycle.
    console.error('[MRAPI TELEGRAM NOTIFICATION ERROR]', clean(error?.message || error, 1000));
    return { sent: false, failed: true, error: clean(error?.message || error, 1000) };
  }
}

function startMissionTelegramWatcher(db, options = {}) {
  const env = options.env || process.env;
  const cfg = envConfig(env);

  if (!configured(cfg)) {
    console.log('[MRAPI TELEGRAM] disabled: gateway/business/chat not fully configured');
    return () => {};
  }

  const startedAt = new Date();
  let initialized = false;

  console.log('[MRAPI TELEGRAM] mission watcher enabled', {
    businessId: cfg.businessId,
    gatewayUrl: cfg.gatewayUrl,
    startedAt: startedAt.toISOString()
  });

  // Listen to Mission changes directly. This avoids changing Planner/Autopilot/
  // orchestration semantics and keeps Telegram as an observability sidecar.
  const unsubscribe = db.collection('missions').onSnapshot(
    (snapshot) => {
      const changes = snapshot.docChanges();

      // Firestore's first snapshot contains existing documents as "added".
      // Ignore it to avoid sending historical alerts on each Cloud Run start.
      if (!initialized) {
        initialized = true;
        return;
      }

      for (const change of changes) {
        if (!['added', 'modified'].includes(change.type)) continue;
        const mission = { id: change.doc.id, ...change.doc.data() };
        if (!notificationKind(mission)) continue;

        void notifyMission({ db, mission, env }).catch((error) => {
          console.error('[MRAPI TELEGRAM WATCHER ERROR]', clean(error?.message || error, 1000));
        });
      }
    },
    (error) => {
      console.error('[MRAPI TELEGRAM WATCHER SNAPSHOT ERROR]', clean(error?.message || error, 1000));
    }
  );

  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}

module.exports = {
  envConfig,
  configured,
  notificationKind,
  failureCode,
  fingerprintForMission,
  buildMessage,
  sendTelegram,
  notifyMission,
  startMissionTelegramWatcher
};
