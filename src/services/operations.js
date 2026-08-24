function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function heartbeatHealth(lastHeartbeatAt, nowMs = Date.now()) {
  const heartbeatMs = toMillis(lastHeartbeatAt);
  if (!heartbeatMs) return { state: 'OFFLINE', age_ms: null, age_seconds: null };

  const ageMs = Math.max(0, nowMs - heartbeatMs);
  const ageSeconds = Math.round(ageMs / 1000);
  if (ageMs <= 45000) return { state: 'ONLINE', age_ms: ageMs, age_seconds: ageSeconds };
  if (ageMs <= 120000) return { state: 'STALE', age_ms: ageMs, age_seconds: ageSeconds };
  return { state: 'OFFLINE', age_ms: ageMs, age_seconds: ageSeconds };
}

function withHeartbeatHealth(item, nowMs = Date.now()) {
  const health = heartbeatHealth(item?.last_heartbeat_at, nowMs);
  return {
    ...item,
    health_state: health.state,
    heartbeat_age_ms: health.age_ms,
    heartbeat_age_seconds: health.age_seconds
  };
}

function workerHealth(worker, { brainAdapters = [], executors = [] } = {}) {
  const workerId = worker.id || worker.code;
  const brain = brainAdapters.find((item) => (item.worker_ids || []).includes(workerId));
  const executor = executors.find((item) => (item.worker_ids || []).includes(workerId));
  const brainState = brain?.health_state || 'OFFLINE';
  const executorState = executor?.health_state || 'OFFLINE';

  let status = 'READY';
  if (worker.state === 'BLOCKED') status = 'BLOCKED';
  else if (worker.current_mission_id || worker.current_task_id || worker.state === 'BUSY') status = 'BUSY';
  else if (brainState === 'OFFLINE' || executorState === 'OFFLINE') status = 'OFFLINE';
  else if (brainState === 'STALE' || executorState === 'STALE') status = 'DEGRADED';

  return {
    ...worker,
    operational_status: status,
    brain_health: brainState,
    executor_health: executorState,
    active_mission_id: worker.current_mission_id || null,
    active_task_id: worker.current_task_id || null
  };
}

function makeAttentionItem({ severity, entityType, entityId, message, timestamp, actionHint }) {
  return {
    severity,
    entity_type: entityType,
    entity_id: entityId,
    message,
    timestamp,
    action_hint: actionHint
  };
}

function needAttention({ missions = [], tasks = [], executors = [], brainAdapters = [], results = [] } = {}) {
  const items = [];

  for (const mission of missions) {
    if (['FAILED', 'BLOCKED'].includes(mission.state)) {
      items.push(makeAttentionItem({
        severity: mission.state === 'FAILED' ? 'HIGH' : 'MEDIUM',
        entityType: 'MISSION',
        entityId: mission.id,
        message: `Mission ${mission.state.toLowerCase()}: ${mission.objective || mission.id}`,
        timestamp: mission.updated_at || mission.completed_at || mission.created_at || null,
        actionHint: 'Review error, then Retry or Cancel.'
      }));
    }
  }

  for (const task of tasks) {
    if (['FAILED', 'BLOCKED'].includes(task.state)) {
      items.push(makeAttentionItem({
        severity: task.state === 'FAILED' ? 'HIGH' : 'MEDIUM',
        entityType: 'TASK',
        entityId: task.id,
        message: `Task ${task.state.toLowerCase()}: ${task.title || task.id}`,
        timestamp: task.updated_at || task.created_at || null,
        actionHint: 'Open the Mission detail and retry if appropriate.'
      }));
    }
  }

  for (const executor of executors) {
    if (['STALE', 'OFFLINE'].includes(executor.health_state)) {
      items.push(makeAttentionItem({
        severity: executor.health_state === 'OFFLINE' ? 'HIGH' : 'MEDIUM',
        entityType: 'EXECUTOR',
        entityId: executor.id,
        message: `Executor ${executor.name || executor.id} is ${executor.health_state.toLowerCase()}.`,
        timestamp: executor.last_heartbeat_at || null,
        actionHint: 'Restart Shadow Runner if it should be online.'
      }));
    }
  }

  for (const adapter of brainAdapters) {
    if (['STALE', 'OFFLINE'].includes(adapter.health_state)) {
      items.push(makeAttentionItem({
        severity: adapter.health_state === 'OFFLINE' ? 'HIGH' : 'MEDIUM',
        entityType: 'BRAIN_ADAPTER',
        entityId: adapter.id,
        message: `Brain Adapter ${adapter.id} is ${adapter.health_state.toLowerCase()}.`,
        timestamp: adapter.last_heartbeat_at || null,
        actionHint: 'Restart Brain Adapter if W01 should be available.'
      }));
    }
  }

  for (const result of results) {
    const git = result.output?.git;
    if (git?.error) {
      items.push(makeAttentionItem({
        severity: 'HIGH',
        entityType: 'GIT',
        entityId: result.run_id || result.id,
        message: `Git failed: ${git.error}`,
        timestamp: result.created_at || null,
        actionHint: 'Fix Git state and retry the Mission if needed.'
      }));
    }
    if (result.status === 'FAILED' && result.error) {
      items.push(makeAttentionItem({
        severity: 'HIGH',
        entityType: 'EXECUTION',
        entityId: result.run_id || result.id,
        message: String(result.error || result.summary || 'Execution failed').slice(0, 220),
        timestamp: result.created_at || null,
        actionHint: 'Open technical details, then Retry if appropriate.'
      }));
    }
  }

  return items.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
}

module.exports = {
  heartbeatHealth,
  withHeartbeatHealth,
  workerHealth,
  needAttention,
  toMillis
};
