const crypto = require('crypto');

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
    timeoutMs: Math.max(1000, Number(env.TELEGRAM_NOTIFICATION_TIMEOUT_MS || 8000))
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
    checkpoint.blocker_code ||
    checkpoint.requirement_type ||
    '',
    300
  ) || null;
}

function fingerprintForMission(mission, kind) {
  const checkpoint = checkpointFromMission(mission) || {};
  return crypto.createHash('sha256').update([
    mission.tenant_id || '',
    mission.id || '',
    kind || '',
    clean(mission.state, 100).toUpperCase(),
    checkpoint.checkpoint_id || '',
    checkpoint.generation || '',
    failureCode(mission) || ''
  ].join('|')).digest('hex').slice(0, 40);
}

function buildMessage(cfg, mission, kind) {
  const checkpoint = checkpointFromMission(mission) || {};
  const code = failureCode(mission);
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

  const url = cfg.uiBaseUrl && mission.id
    ? `${cfg.uiBaseUrl}/?mission=${encodeURIComponent(mission.id)}`
    : null;

  return [
    `${icon} ${title}`,
    '',
    `Worker: ${clean(mission.preferred_worker_id || mission.worker_id || '-', 120)}`,
    `Mission: ${clean(mission.objective || mission.title || 'Mission', 420)}`,
    `State: ${clean(mission.state || '-', 100)}`,
    code ? `Code: ${code}` : null,
    `Workspace: ${clean(mission.workspace_id || '-', 160)}`,
    `Project: ${clean(mission.project_id || '-', 160)}`,
    mission.roadmap_id ? `Roadmap: ${clean(mission.roadmap_id, 160)}` : null,
    mission.milestone_id ? `Milestone: ${clean(mission.milestone_id, 160)}` : null,
    action ? '' : null,
    action ? `Acción: ${action}` : null,
    url ? '' : null,
    url ? `Abrir MRAPI: ${url}` : null
  ].filter((x) => x !== null).join('\n').slice(0, 3900);
}

async function sendTelegram(cfg, text, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
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
    const body = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`TELEGRAM_GATEWAY_${response.status}: ${body.slice(0, 500)}`);
    return body ? JSON.parse(body) : { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

async function reserveDeliveryAtomic(db, fingerprint, mission, kind) {
  const ref = db.collection('notification_deliveries').doc(fingerprint);
  let reserved = false;
  let reason = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() || {}) : null;

    if (existing?.status === 'SENT') {
      reason = 'ALREADY_SENT';
      return;
    }

    if (existing?.status === 'PENDING') {
      reason = 'ALREADY_PENDING';
      return;
    }

    tx.set(ref, {
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
      attempt_count: Number(existing?.attempt_count || 0) + 1,
      updated_at: new Date(),
      created_at: existing?.created_at || new Date()
    }, { merge: true });

    reserved = true;
  });

  return { reserved, reason, ref };
}

async function notifyMission({ db, mission, env = process.env, fetchImpl = globalThis.fetch }) {
  const cfg = envConfig(env);
  if (!configured(cfg)) return { sent: false, skipped: true, reason: 'NOT_CONFIGURED' };

  const kind = notificationKind(mission);
  if (!kind) return { sent: false, skipped: true, reason: 'NOT_NOTIFIABLE' };

  const fingerprint = fingerprintForMission(mission, kind);
  const reservation = await reserveDeliveryAtomic(db, fingerprint, mission, kind);

  if (!reservation.reserved) {
    return { sent: false, skipped: true, reason: reservation.reason };
  }

  try {
    const result = await sendTelegram(cfg, buildMessage(cfg, mission, kind), fetchImpl);
    await reservation.ref.set({
      status: 'SENT',
      sent_at: new Date(),
      last_error: null,
      updated_at: new Date()
    }, { merge: true });

    console.log('[MRAPI TELEGRAM] sent', { missionId: mission.id, kind });
    return { sent: true, kind, result };
  } catch (error) {
    await reservation.ref.set({
      status: 'FAILED',
      last_error: clean(error?.message || error, 1000),
      failed_at: new Date(),
      updated_at: new Date()
    }, { merge: true });

    console.error('[MRAPI TELEGRAM]', clean(error?.message || error, 1000));
    return { sent: false, failed: true, error: clean(error?.message || error, 1000) };
  }
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function createMissionNotificationSweep(db, options = {}) {
  const startedAt = Date.now();
  let running = false;
  let lastRun = 0;
  const minIntervalMs = Number(options.minIntervalMs || 1200);

  return async function sweep() {
    if (running) return { skipped: true, reason: 'RUNNING' };
    if (Date.now() - lastRun < minIntervalMs) return { skipped: true, reason: 'THROTTLED' };

    running = true;
    lastRun = Date.now();

    try {
      const snap = await db.collection('missions').limit(200).get();
      const candidates = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((mission) => notificationKind(mission))
        .filter((mission) => timestampMs(mission.updated_at || mission.created_at) >= startedAt - 5000);

      for (const mission of candidates) {
        await notifyMission({ db, mission });
      }

      return { scanned: snap.size, candidates: candidates.length };
    } catch (error) {
      console.error('[MRAPI TELEGRAM SWEEP ERROR]', clean(error?.message || error, 1000));
      return { failed: true, error: clean(error?.message || error, 1000) };
    } finally {
      running = false;
    }
  };
}

module.exports = {
  envConfig,
  configured,
  notificationKind,
  failureCode,
  fingerprintForMission,
  buildMessage,
  sendTelegram,
  reserveDeliveryAtomic,
  notifyMission,
  createMissionNotificationSweep
};
