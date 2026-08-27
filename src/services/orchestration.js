let FieldValue;
try {
  ({ FieldValue } = require('@google-cloud/firestore'));
} catch {
  FieldValue = { serverTimestamp: () => new Date() };
}
const { RUN_TYPES } = require('../constants/runTypes');
const { EVIDENCE_TYPES } = require('../constants/evidenceTypes');
const { buildCodexHandoff } = require('./codexHandoff');
const {
  queueVerificationBrainRun,
  completeVerificationBrainRun,
  normalizeHumanActionCheckpoint,
  unresolvedHumanActionCheckpoint
} = require('./autopilot');

function getEvidenceBucket() {
  return require('./storage').getEvidenceBucket();
}

function timestamp() {
  return FieldValue.serverTimestamp();
}

function isMissionCancelled(mission) {
  return mission?.state === 'CANCELLED' || mission?.cancellation_requested === true;
}

function sanitizeEventPayload(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (
    typeof value.toDate === 'function' ||
    typeof value.toMillis === 'function' ||
    value === FieldValue
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEventPayload(item));
  }

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sanitizeEventPayload(item);
  }
  return sanitized;
}

async function emitEvent(db, tenantId, type, payload = {}, severity = 'INFO') {
  const ref = db.collection('events').doc();
  await ref.set({
    id: ref.id,
    tenant_id: tenantId,
    type,
    severity,
    payload: sanitizeEventPayload(payload),
    created_at: timestamp()
  });
  return ref.id;
}

async function dispatchMission(db, tenantId, missionId) {
  const missionRef = db.collection('missions').doc(missionId);
  const runRef = db.collection('runs').doc();

  let result;

  await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const mission = { id: missionSnap.id, ...missionSnap.data() };

    if (!['READY', 'PLANNING'].includes(mission.state)) {
      const error = new Error('MISSION_NOT_DISPATCHABLE');
      error.status = 409;
      throw error;
    }

    const existingBrainRunQuery = db.collection('runs')
      .where('tenant_id', '==', tenantId)
      .limit(100);

    const existing = await tx.get(existingBrainRunQuery);
    const existingBrainRun = existing.docs.find((doc) => {
      const data = doc.data();
      return data.mission_id === missionId && data.run_type === 'BRAIN_RUN';
    });
    if (existingBrainRun) {
      const doc = existingBrainRun;
      result = { id: doc.id, ...doc.data(), reused: true };
      return;
    }

    let workerId = mission.preferred_worker_id || null;

    if (!workerId) {
      const projectRef = db.collection('projects').doc(mission.project_id);
      const projectSnap = await tx.get(projectRef);
      if (projectSnap.exists && projectSnap.data().tenant_id === tenantId) {
        const primaryWorkers = projectSnap.data().primary_worker_ids || [];
        workerId = primaryWorkers[0] || null;
      }
    }

    if (!workerId) {
      const error = new Error('NO_WORKER_AVAILABLE_FOR_PROJECT');
      error.status = 409;
      throw error;
    }

    const workerRef = db.collection('workers').doc(workerId);
    const workerSnap = await tx.get(workerRef);
    if (!workerSnap.exists || workerSnap.data().tenant_id !== tenantId) {
      const error = new Error('WORKER_NOT_FOUND');
      error.status = 409;
      throw error;
    }

    const brainRun = {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: missionId,
      task_id: null,
      workspace_id: mission.workspace_id,
      project_id: mission.project_id,
      worker_id: workerId,
      executor_id: null,
      parent_run_id: null,
      objective: mission.objective,
      brain_context: mission.brain_context || null,
      autopilot_mode: mission.autopilot_mode === true,
      autopilot_phase: mission.autopilot_mode === true ? (mission.autopilot_phase || 'PROGRAM') : null,
      roadmap_id: mission.roadmap_id || null,
      milestone_id: mission.milestone_id || null,
      state: 'RUNNING',
      progress_percent: 0,
      progress_message: 'Mission dispatched; Brain Run started',
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(runRef, brainRun);
    tx.update(missionRef, {
      state: 'PLANNING',
      dispatched_at: timestamp(),
      brain_run_id: runRef.id,
      updated_at: timestamp()
    });

    result = brainRun;
  });

  await emitEvent(db, tenantId, 'MISSION_DISPATCHED', {
    mission_id: missionId,
    brain_run_id: result.id,
    worker_id: result.worker_id
  }, 'OPERATIVE');

  return result;
}

async function retryMission(db, tenantId, missionId) {
  const missionRef = db.collection('missions').doc(missionId);
  const runRef = db.collection('runs').doc();
  let result;

  await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const mission = missionSnap.data();
    if (!['FAILED', 'BLOCKED'].includes(mission.state)) {
      const error = new Error('MISSION_RETRY_NOT_ALLOWED');
      error.status = 409;
      throw error;
    }

    if (mission.approved_execution_snapshot_id) {
      const snapshotRef = db.collection('execution_snapshots').doc(mission.approved_execution_snapshot_id);
      const snapshotSnap = await tx.get(snapshotRef);
      if (!snapshotSnap.exists || snapshotSnap.data().tenant_id !== tenantId) {
        const error = new Error('EXECUTION_SNAPSHOT_NOT_FOUND');
        error.status = 409;
        throw error;
      }

      const snapshot = { id: snapshotSnap.id, ...snapshotSnap.data() };
      if (
        mission.current_plan_revision_id &&
        mission.current_plan_revision_id !== snapshot.approved_plan_revision_id
      ) {
        const error = new Error('STALE_EXECUTION_SNAPSHOT_NOT_RETRYABLE');
        error.status = 409;
        throw error;
      }

      const tasksSnap = await tx.get(db.collection('tasks').where('tenant_id', '==', tenantId).limit(200));
      const snapshotTasks = tasksSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((task) => task.mission_id === missionId && task.execution_snapshot_id === snapshot.id);
      const latestTask = snapshotTasks
        .sort((a, b) => Number(b.attempt_count || 0) - Number(a.attempt_count || 0))[0] || null;
      const taskRef = db.collection('tasks').doc();
      const taskSpec = taskSpecFromExecutionSnapshot(snapshot);
      const attempt = Math.max(1, ...snapshotTasks.map((task) => Number(task.attempt_count || 1))) + 1;

      tx.set(taskRef, {
        id: taskRef.id,
        tenant_id: tenantId,
        mission_id: missionId,
        workspace_id: snapshot.workspace_id || mission.workspace_id || null,
        project_id: snapshot.project_id || mission.project_id || null,
        worker_id: snapshot.worker_id || mission.preferred_worker_id,
        title: taskSpec.title,
        objective: taskSpec.objective,
        task_spec: taskSpec,
        priority: mission.priority || 'NORMAL',
        state: 'QUEUED',
        phase: 'EXECUTION_PENDING',
        attempt_count: attempt,
        retry_of_task_id: latestTask?.id || null,
        brain_run_id: mission.brain_run_id || null,
        approved_plan_revision_id: snapshot.approved_plan_revision_id,
        approved_plan_revision_number: snapshot.approved_plan_revision_number,
        execution_snapshot_id: snapshot.id,
        execution_snapshot: snapshot,
        brain_output: {
          objective: taskSpec.objective,
          worker_id: snapshot.worker_id || mission.preferred_worker_id,
          requires_execution: true,
          execution_type: snapshot.execution_type || 'EXECUTOR',
          task_spec: taskSpec,
          execution_constraints: snapshot.execution_constraints || {},
          brain_run_id: mission.brain_run_id || null,
          tenant_id: tenantId,
          workspace_id: snapshot.workspace_id || mission.workspace_id || null,
          project_id: snapshot.project_id || mission.project_id || null,
          mission_id: missionId
        },
        brain_completed_at: timestamp(),
        current_run_id: null,
        claimed_by_executor_id: null,
        created_at: timestamp(),
        updated_at: timestamp()
      });

      tx.set(missionRef, {
        state: 'RUNNING',
        retry_count: Number(mission.retry_count || 0) + 1,
        retry_of_task_id: latestTask?.id || null,
        current_retry_task_id: taskRef.id,
        updated_at: timestamp()
      }, { merge: true });

      result = {
        success: true,
        mode: 'EXECUTION_RETRY',
        mission_id: missionId,
        task_id: taskRef.id,
        execution_snapshot_id: snapshot.id,
        retry_of_task_id: latestTask?.id || null
      };
      return;
    }

    let workerId = mission.preferred_worker_id || null;
    if (!workerId) {
      const projectSnap = await tx.get(db.collection('projects').doc(mission.project_id));
      if (projectSnap.exists && projectSnap.data().tenant_id === tenantId) {
        workerId = (projectSnap.data().primary_worker_ids || [])[0] || null;
      }
    }
    if (!workerId) {
      const error = new Error('NO_WORKER_AVAILABLE_FOR_PROJECT');
      error.status = 409;
      throw error;
    }

    const runsSnap = await tx.get(db.collection('runs').where('tenant_id', '==', tenantId).limit(200));
    const missionRuns = runsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((run) => run.mission_id === missionId);
    const latestRun = missionRuns
      .sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0))[0] || null;
    const attempt = Math.max(1, ...missionRuns.map((run) => Number(run.attempt || 1))) + 1;

    const brainRun = {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: missionId,
      task_id: null,
      workspace_id: mission.workspace_id,
      project_id: mission.project_id,
      worker_id: workerId,
      executor_id: null,
      parent_run_id: null,
      objective: mission.objective,
      state: 'RUNNING',
      progress_percent: 0,
      progress_message: 'Mission retry requested; Brain Run started',
      retry_of_run_id: latestRun?.id || null,
      attempt,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp(),
      created_mission: false
    };

    tx.set(runRef, brainRun);
    tx.set(missionRef, {
      state: 'PLANNING',
      retry_count: Number(mission.retry_count || 0) + 1,
      retry_of_run_id: latestRun?.id || null,
      current_retry_run_id: runRef.id,
      brain_run_id: runRef.id,
      updated_at: timestamp()
    }, { merge: true });

    result = brainRun;
  });

  await emitEvent(db, tenantId, 'MISSION_RETRIED', {
    mission_id: missionId,
    brain_run_id: result.id,
    retry_of_run_id: result.retry_of_run_id
  }, 'OPERATIVE');

  return result;
}

async function cancelMission(db, tenantId, missionId, input = {}) {
  const missionRef = db.collection('missions').doc(missionId);
  const missionSnap = await missionRef.get();

  if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
    const error = new Error('MISSION_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const mission = missionSnap.data();
  if (mission.state === 'CANCELLED') {
    return {
      ok: true,
      mission_id: missionId,
      state: 'CANCELLED',
      created_mission: false
    };
  }

  if (!['READY', 'PLANNING', 'RUNNING', 'BLOCKED'].includes(mission.state)) {
    const error = new Error('MISSION_CANCEL_NOT_ALLOWED');
    error.status = 409;
    throw error;
  }

  await missionRef.set({
    state: 'CANCELLED',
    cancellation_requested: true,
    cancellation_reason: String(input.reason || 'Cancelled by operator').slice(0, 1000),
    cancelled_at: timestamp(),
    updated_at: timestamp()
  }, { merge: true });

  const tasksSnap = await db.collection('tasks').where('tenant_id', '==', tenantId).limit(200).get();
  const missionTasks = tasksSnap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref || db.collection('tasks').doc(doc.id), ...doc.data() }))
    .filter((task) => task.mission_id === missionId);
  for (const task of missionTasks) {
    if (['QUEUED', 'ASSIGNED', 'WAITING', 'BLOCKED'].includes(task.state)) {
      await task.ref.set({
        state: 'SKIPPED',
        phase: 'CANCELLED',
        cancellation_requested: true,
        updated_at: timestamp()
      }, { merge: true });
    } else if (['RUNNING', 'TESTING'].includes(task.state)) {
      await task.ref.set({
        cancellation_requested: true,
        updated_at: timestamp()
      }, { merge: true });
    }
  }

  const runsSnap = await db.collection('runs').where('tenant_id', '==', tenantId).limit(200).get();
  const activeRuns = runsSnap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref || db.collection('runs').doc(doc.id), ...doc.data() }))
    .filter((run) => run.mission_id === missionId && run.state === 'RUNNING');
  for (const run of activeRuns) {
    await run.ref.set({
      cancellation_requested: true,
      progress_message: 'Cancellation requested; runner will stop at safe boundary',
      updated_at: timestamp()
    }, { merge: true });
  }

  const workersSnap = await db.collection('workers').where('tenant_id', '==', tenantId).limit(100).get();
  for (const doc of workersSnap.docs) {
    const worker = doc.data();
    if (worker.current_mission_id === missionId) {
      const workerRef = doc.ref || db.collection('workers').doc(doc.id);
      await workerRef.set({
        state: 'IDLE',
        current_mission_id: null,
        current_task_id: null,
        updated_at: timestamp()
      }, { merge: true });
    }
  }

  await emitEvent(db, tenantId, 'MISSION_CANCELLED', {
    mission_id: missionId,
    reason: input.reason || null
  }, 'WARNING');

  return { ok: true, mission_id: missionId, state: 'CANCELLED', created_mission: false };
}

async function registerExecutor(db, tenantId, input) {
  const executorId = String(input.executor_id || '').trim();
  if (!executorId) {
    const error = new Error('EXECUTOR_ID_REQUIRED');
    error.status = 400;
    throw error;
  }

  const ref = db.collection('executors').doc(executorId);
  const existing = await ref.get();

  const data = {
    id: executorId,
    tenant_id: tenantId,
    name: input.name || 'Codex',
    executor_type: input.executor_type || 'CODEX',
    host_name: input.host_name || 'Shadow',
    host_type: input.host_type || 'HOST',
    runner_version: input.runner_version || 'unknown',
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
    worker_ids: Array.isArray(input.worker_ids) ? input.worker_ids : [],
    state: 'ONLINE',
    last_heartbeat_at: timestamp(),
    updated_at: timestamp(),
    ...(existing.exists ? {} : { created_at: timestamp() })
  };

  await ref.set(data, { merge: true });

  await emitEvent(db, tenantId, 'EXECUTOR_REGISTERED', {
    executor_id: executorId,
    host_name: data.host_name
  }, 'OPERATIVE');

  return { id: executorId, ...(await ref.get()).data() };
}

async function heartbeatExecutor(db, tenantId, executorId, payload = {}) {
  const ref = db.collection('executors').doc(executorId);
  const snap = await ref.get();

  if (!snap.exists || snap.data().tenant_id !== tenantId) {
    const error = new Error('EXECUTOR_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  await ref.set({
    state: payload.state || 'ONLINE',
    runner_status: payload.runner_status || null,
    current_run_id: payload.current_run_id || null,
    last_heartbeat_at: timestamp(),
    updated_at: timestamp()
  }, { merge: true });

  return { ok: true, executor_id: executorId };
}

function operationalLog(level, message, fields = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.toLowerCase().includes('secret')) continue;
    clean[key] = value;
  }
  const logger = level === 'error' ? console.error : console.warn;
  logger(message, clean);
}

function normalizeWorkerIds(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function nullIfUndefined(value) {
  return value === undefined ? null : value;
}

function isClaimCandidateError(error) {
  return error?.retryCandidate === true ||
    [
      'TASK_ALREADY_CLAIMED',
      'TASK_BRAIN_NOT_COMPLETE',
      'WORKER_NOT_FOUND',
      'WORKER_NOT_AVAILABLE',
      'MISSION_CANCELLED',
      'CODEX_HANDOFF_TASK_NOT_CLAIMABLE',
      'CODEX_HANDOFF_TASK_SPEC_REQUIRED',
      'CODEX_HANDOFF_BRAIN_RUN_REQUIRED',
      'CODEX_HANDOFF_BRAIN_TENANT_MISMATCH',
      'CODEX_HANDOFF_BRAIN_RUN_TYPE_REQUIRED',
      'CODEX_HANDOFF_BRAIN_NOT_COMPLETED',
      'CODEX_HANDOFF_BRAIN_MISSION_MISMATCH',
      'CODEX_HANDOFF_TASK_TENANT_MISMATCH',
      'CODEX_HANDOFF_TASK_MISSION_MISMATCH',
      'CODEX_HANDOFF_WORKER_REQUIRED',
      'CODEX_HANDOFF_MISSION_REQUIRED',
      'CODEX_HANDOFF_MISSION_TENANT_MISMATCH',
      'CODEX_HANDOFF_SCOPE_REQUIRED',
      'CODEX_HANDOFF_EXECUTION_RUN_REQUIRED',
      'CODEX_HANDOFF_REPOSITORY_PATH_REQUIRED'
    ].includes(error?.message);
}

async function claimNextTask(db, tenantId, executorId, options = {}) {
  const executorRef = db.collection('executors').doc(executorId);
  const executorSnap = await executorRef.get();

  if (!executorSnap.exists || executorSnap.data().tenant_id !== tenantId) {
    const error = new Error('EXECUTOR_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const executor = executorSnap.data();
  const allowedWorkerIds = normalizeWorkerIds(executor.worker_ids);
  const taskSnap = await db.collection('tasks')
    .where('tenant_id', '==', tenantId)
    .limit(200)
    .get();

  const priorities = { CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
  const candidates = taskSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((task) => ['QUEUED', 'ASSIGNED'].includes(task.state))
    .filter((task) => !task.phase || ['EXECUTION_PENDING', 'WAITING_FOR_CODEX'].includes(task.phase))
    .filter((task) => allowedWorkerIds.length === 0 || allowedWorkerIds.includes(task.worker_id))
    .sort((a, b) => {
      const pd = (priorities[b.priority] || 0) - (priorities[a.priority] || 0);
      if (pd) return pd;
      return (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0);
    });

  for (const candidate of candidates) {
    const taskRef = db.collection('tasks').doc(candidate.id);
    const workerRef = db.collection('workers').doc(candidate.worker_id);
    const missionRef = db.collection('missions').doc(candidate.mission_id);
    const brainRunRef = candidate.brain_run_id ? db.collection('runs').doc(candidate.brain_run_id) : null;
    const runRef = db.collection('runs').doc();

    try {
      let claimed = null;

      await db.runTransaction(async (tx) => {
        const [taskSnap, workerSnap, missionSnap, brainRunSnap] = await Promise.all([
          tx.get(taskRef),
          tx.get(workerRef),
          tx.get(missionRef),
          brainRunRef ? tx.get(brainRunRef) : Promise.resolve(null)
        ]);

        if (!taskSnap.exists || !['QUEUED', 'ASSIGNED'].includes(taskSnap.data().state)) {
          const error = new Error('TASK_ALREADY_CLAIMED');
          error.retryCandidate = true;
          throw error;
        }

        const task = taskSnap.data();
        if (task.brain_run_id && !task.brain_completed_at) {
          const error = new Error('TASK_BRAIN_NOT_COMPLETE');
          error.retryCandidate = true;
          throw error;
        }

        if (task.brain_run_id && (
          !brainRunSnap.exists ||
          brainRunSnap.data().tenant_id !== tenantId ||
          brainRunSnap.data().run_type !== 'BRAIN_RUN' ||
          brainRunSnap.data().state !== 'COMPLETED'
        )) {
          const error = new Error('TASK_BRAIN_NOT_COMPLETE');
          error.retryCandidate = true;
          throw error;
        }

        if (!workerSnap.exists || workerSnap.data().tenant_id !== tenantId) {
          const error = new Error('WORKER_NOT_FOUND');
          error.retryCandidate = true;
          throw error;
        }

        if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
          const error = new Error('CODEX_HANDOFF_MISSION_REQUIRED');
          error.retryCandidate = true;
          throw error;
        }

        if (!['IDLE', 'WAITING'].includes(workerSnap.data().state)) {
          const error = new Error('WORKER_NOT_AVAILABLE');
          error.retryCandidate = true;
          throw error;
        }

        const worker = workerSnap.data();
        const profileId = worker.profile_id || task.worker_profile_id || `profile_${task.worker_id}`;
        const profileSnap = profileId
          ? await tx.get(db.collection('worker_profiles').doc(profileId))
          : null;
        const workerProfile = profileSnap?.exists && profileSnap.data().tenant_id === tenantId
          ? { id: profileSnap.id, ...profileSnap.data() }
          : null;

        const attempt = Number(taskSnap.data().attempt_count || 0) + 1;
        const mission = missionSnap.exists ? { id: missionSnap.id, ...missionSnap.data() } : null;
        if (mission.state === 'CANCELLED' || mission.cancellation_requested) {
          const error = new Error('MISSION_CANCELLED');
          error.retryCandidate = true;
          throw error;
        }
        const brainRun = brainRunSnap?.exists ? { id: brainRunSnap.id, ...brainRunSnap.data() } : null;
        const taskBrainRunId = nullIfUndefined(task.brain_run_id);
        const codexHandoff = buildCodexHandoff({
          tenantId,
          task: { id: taskSnap.id, ...task },
          mission,
          brainRun,
          workerProfile,
          executor: { id: executorId, ...executor },
          executionRunId: runRef.id,
          repositoryPath: options.repository_path ||
            options.repositoryPath ||
            process.env.MRAPI_REPO_PATH ||
            'LOCAL_REPOSITORY_NOT_PROVIDED'
        });

        tx.update(taskRef, {
          state: 'RUNNING',
          phase: 'EXECUTION_RUNNING',
          workspace_id: codexHandoff.workspace_id,
          project_id: codexHandoff.project_id,
          attempt_count: attempt,
          current_run_id: runRef.id,
          execution_run_id: runRef.id,
          codex_handoff: codexHandoff,
          claimed_by_executor_id: executorId,
          claimed_at: timestamp(),
          updated_at: timestamp()
        });

        tx.update(workerRef, {
          state: 'BUSY',
          current_mission_id: candidate.mission_id,
          current_task_id: candidate.id,
          updated_at: timestamp()
        });

        if (missionSnap.exists) {
          tx.update(missionRef, {
            state: 'RUNNING',
            started_at: missionSnap.data().started_at || timestamp(),
            updated_at: timestamp()
          });
        }

        tx.set(runRef, {
          id: runRef.id,
          tenant_id: tenantId,
          run_type: 'EXECUTION_RUN',
          mission_id: candidate.mission_id,
          task_id: candidate.id,
          workspace_id: codexHandoff.workspace_id,
          project_id: codexHandoff.project_id,
          worker_id: candidate.worker_id,
          executor_id: executorId,
          host_name: executor.host_name || null,
          brain_run_id: taskBrainRunId,
          parent_run_id: taskBrainRunId,
          codex_handoff: codexHandoff,
          state: 'RUNNING',
          attempt,
          progress_percent: 0,
          progress_message: 'Task claimed; Codex Execution Run started',
          started_at: timestamp(),
          created_at: timestamp(),
          updated_at: timestamp()
        });

        tx.set(executorRef, {
          state: 'ONLINE',
          current_run_id: runRef.id,
          last_heartbeat_at: timestamp(),
          updated_at: timestamp()
        }, { merge: true });

        claimed = {
          task: {
            ...candidate,
            state: 'RUNNING',
            workspace_id: codexHandoff.workspace_id,
            project_id: codexHandoff.project_id,
            current_run_id: runRef.id,
            execution_run_id: runRef.id,
            attempt_count: attempt,
            brain_run_id: nullIfUndefined(candidate.brain_run_id),
            codex_handoff: codexHandoff
          },
          run: {
            id: runRef.id,
            run_type: 'EXECUTION_RUN',
            state: 'RUNNING',
            attempt,
            brain_run_id: taskBrainRunId,
            parent_run_id: taskBrainRunId
          },
          codex_handoff: codexHandoff
        };
      });

      if (claimed) {
        await emitEvent(db, tenantId, 'TASK_CLAIMED', {
          task_id: candidate.id,
          mission_id: candidate.mission_id,
          worker_id: candidate.worker_id,
          executor_id: executorId,
          run_id: claimed.run.id
        }, 'OPERATIVE');

        return claimed;
      }
    } catch (error) {
      if (error.message === 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED') {
        await taskRef.set({
          state: 'BLOCKED',
          phase: 'BLOCKED',
          blocked_reason: 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED',
          blocker_code: 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED',
          blocker_message: 'Executor task is missing Brain-defined allowed_files. Stale or unsafe task was blocked before execution.',
          blocker_stage: 'HANDOFF',
          updated_at: timestamp()
        }, { merge: true });
        if (candidate.mission_id) {
          await missionRef.set({
            state: 'BLOCKED',
            blocked_reason: 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED',
            block_reason: 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED',
            blocker_code: 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED',
            blocker_message: 'Executor task is missing Brain-defined allowed_files. Create a fresh Brain run/milestone attempt.',
            blocker_stage: 'HANDOFF',
            blocker_task_id: candidate.id,
            updated_at: timestamp()
          }, { merge: true });
        }
        await emitEvent(db, tenantId, 'CODEX_HANDOFF_ALLOWED_FILES_REQUIRED', {
          task_id: candidate.id,
          mission_id: candidate.mission_id || null,
          worker_id: candidate.worker_id || null,
          executor_id: executorId
        }, 'WARNING');
        operationalLog('warn', '[RUNNER CLAIM BLOCKED]', {
          endpoint: '/api/runner/next-task',
          action: 'unsafe_stale_task_blocked',
          tenant_id: tenantId,
          executor_id: executorId,
          task_id: candidate.id,
          mission_id: candidate.mission_id || null,
          error: error.message
        });
        continue;
      }
      if (error.message === 'EXECUTION_SNAPSHOT_MISMATCH') {
        await taskRef.set({
          state: 'BLOCKED',
          phase: 'BLOCKED',
          blocked_reason: 'EXECUTION_SNAPSHOT_MISMATCH',
          blocker_code: 'EXECUTION_SNAPSHOT_MISMATCH',
          blocker_message: 'Task identity does not match its immutable execution snapshot.',
          blocker_stage: 'EXECUTION',
          updated_at: timestamp()
        }, { merge: true });
        if (candidate.mission_id) {
          await missionRef.set({
            state: 'BLOCKED',
            blocked_reason: 'EXECUTION_SNAPSHOT_MISMATCH',
            block_reason: 'EXECUTION_SNAPSHOT_MISMATCH',
            blocker_code: 'EXECUTION_SNAPSHOT_MISMATCH',
            blocker_message: 'Task identity does not match its immutable execution snapshot.',
            blocker_stage: 'EXECUTION',
            blocker_task_id: candidate.id,
            updated_at: timestamp()
          }, { merge: true });
        }
        await emitEvent(db, tenantId, 'EXECUTION_SNAPSHOT_MISMATCH', {
          task_id: candidate.id,
          mission_id: candidate.mission_id || null,
          worker_id: candidate.worker_id || null,
          executor_id: executorId
        }, 'WARNING');
        continue;
      }
      if (isClaimCandidateError(error)) {
        operationalLog('warn', '[RUNNER CLAIM SKIP]', {
          endpoint: '/api/runner/next-task',
          action: 'claim_candidate_skipped',
          tenant_id: tenantId,
          executor_id: executorId,
          worker_ids: allowedWorkerIds,
          task_id: candidate.id,
          mission_id: candidate.mission_id || null,
          worker_id: candidate.worker_id || null,
          error: error.message
        });
        continue;
      }
      throw error;
    }
  }

  return null;
}

function parseBoolean(value) {
  if (value === false || String(value).toLowerCase() === 'false') return false;
  if (value === true || String(value).toLowerCase() === 'true') return true;
  return undefined;
}

function normalizeFinalResult(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (typeof value.summary === 'string') return value.summary.trim();
    return JSON.stringify(value, null, 2).trim();
  }
  return String(value).trim();
}

function normalizeBrainTransportText(text) {
  return String(text || '').replace(/\\([<>_])/g, '$1');
}

function escapeInvalidJsonBackslashes(text) {
  const source = String(text || '');
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = source[i + 1];
    if (next === undefined) {
      out += '\\\\';
      continue;
    }
    // Preserve valid JSON escapes atomically. This is important for Windows paths
    // already encoded as C:\\\\Users\\\\Shadow: treating the second slash of \\\\ as
    // a new invalid escape would corrupt the JSON into \\\\\\U.
    if ('"\\\\/bfnrtu'.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    // A single transport backslash before a non-JSON escape (for example \a in
    // test\\autopilot...) must become a literal backslash inside the JSON string.
    out += '\\\\' + next;
    i += 1;
  }
  return out;
}

function extractTaggedBlock(text, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = normalizeBrainTransportText(text).match(pattern);
  return match ? match[1].trim() : '';
}

function findFirstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = source.slice(start, index + 1);
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { parsed, start, end: index + 1, jsonText };
          }
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function removeBrainControlText(text) {
  const source = String(text || '');
  const withoutTags = source
    .replace(/<MRAPI_CONTROL>[\s\S]*?<\/MRAPI_CONTROL>/gi, '')
    .replace(/<MRAPI_RESULT>/gi, '')
    .replace(/<\/MRAPI_RESULT>/gi, '')
    .trim();
  const json = findFirstJsonObject(withoutTags);
  if (!json) return withoutTags.trim();
  return `${withoutTags.slice(0, json.start)}${withoutTags.slice(json.end)}`.trim();
}

function hasMeaningfulText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/.test(value);
}

function parseBrainResponse(rawResponse, input = {}) {
  const rawOriginal = String(rawResponse || input.output_text || input.summary || '');
  const raw = normalizeBrainTransportText(rawOriginal);
  const taggedControl = extractTaggedBlock(raw, 'MRAPI_CONTROL');
  const taggedResult = extractTaggedBlock(raw, 'MRAPI_RESULT');
  let parsedTagged = taggedControl ? findFirstJsonObject(taggedControl) : null;
  if (!parsedTagged && taggedControl) {
    parsedTagged = findFirstJsonObject(escapeInvalidJsonBackslashes(taggedControl));
  }
  let parsedRaw = parsedTagged || findFirstJsonObject(raw);
  if (!parsedRaw) {
    parsedRaw = findFirstJsonObject(escapeInvalidJsonBackslashes(raw));
  }
  const decision = parsedRaw?.parsed || {};

  const inputRequiresExecution = parseBoolean(input.requires_execution);
  const decisionRequiresExecution = parseBoolean(decision.requires_execution);
  const requiresExecution = inputRequiresExecution !== undefined
    ? inputRequiresExecution
    : decisionRequiresExecution !== undefined
      ? decisionRequiresExecution
      : true;

  const executionType = input.execution_type ||
    decision.execution_type ||
    (requiresExecution ? 'CODEX' : 'BRAIN_ONLY');

  const inputTaskSpec = input.task_spec && typeof input.task_spec === 'object'
    ? input.task_spec
    : {};
  const decisionTaskSpec = decision.task_spec && typeof decision.task_spec === 'object'
    ? decision.task_spec
    : {};
  // The Brain response is authoritative. Adapter-supplied task_spec is only a fallback.
  // This is critical for Autopilot fields such as allowed_files.
  const taskSpec = { ...inputTaskSpec, ...decisionTaskSpec };

  let finalResultText = taggedResult ||
    normalizeFinalResult(input.final_result) ||
    normalizeFinalResult(decision.final_result);

  if (!hasMeaningfulText(finalResultText) && !parsedTagged && parsedRaw && parsedRaw.end < raw.length) {
    finalResultText = removeBrainControlText(raw.slice(parsedRaw.end));
  }

  if (!hasMeaningfulText(finalResultText) && !requiresExecution && typeof taskSpec.instructions === 'string') {
    finalResultText = removeBrainControlText(taskSpec.instructions);
  }

  if (typeof taskSpec.instructions === 'string') {
    taskSpec.instructions = removeBrainControlText(taskSpec.instructions);
    if (!requiresExecution && taskSpec.instructions === finalResultText) {
      delete taskSpec.instructions;
    }
  }

  return {
    requires_execution: requiresExecution,
    execution_type: executionType,
    task_spec: taskSpec,
    final_result_text: hasMeaningfulText(finalResultText) ? String(finalResultText).trim() : '',
    raw_response: rawOriginal
  };
}

function brainResultSummary(input, finalResultText) {
  return String(input.summary || finalResultText || 'Brain-only result completed').trim().slice(0, 10000);
}

function brainResultTitle(run, taskSpec) {
  return String(taskSpec?.title || run.objective || 'Brain result').slice(0, 250);
}

function roadmapMilestonesWithState(roadmap, milestoneId, state, extra = {}) {
  let found = false;
  const milestones = (roadmap?.milestones || []).map((item) => {
    if (item.id !== milestoneId) return item;
    found = true;
    return { ...item, state, ...extra, updated_at: new Date() };
  });
  if (!found) {
    const error = new Error('MILESTONE_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  return milestones;
}

async function getAutopilotRoadmapForRun(tx, db, tenantId, mission, run) {
  if (mission.autopilot_mode !== true || !mission.roadmap_id || !mission.milestone_id) return null;
  const roadmapRef = db.collection('roadmaps').doc(mission.roadmap_id);
  const roadmapSnap = await tx.get(roadmapRef);
  if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
    const error = new Error('ROADMAP_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
  const milestone = (roadmap.milestones || []).find((item) => item.id === (mission.milestone_id || run.milestone_id));
  if (!milestone) {
    const error = new Error('MILESTONE_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  return { roadmapRef, roadmap, milestone };
}

function roadmapCompletedAfter(milestones) {
  return milestones.every((item) => ['COMPLETED', 'SKIPPED'].includes(item.state));
}

function cleanPreflightText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function normalizeStructuredPrerequisites(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (typeof value === 'object') return [value];
  return [];
}

function localPathFromProject(project = {}) {
  const runtime = project.runtime_context && typeof project.runtime_context === 'object'
    ? project.runtime_context
    : {};
  return String(runtime.repository_path || runtime.local_path || project.repository_path || project.local_path || '').trim();
}

function structuredPreflightSources({ brainOutput, mission, milestone, project }) {
  const taskSpec = brainOutput?.task_spec && typeof brainOutput.task_spec === 'object' ? brainOutput.task_spec : {};
  return {
    taskSpec,
    prerequisites: [
      ...normalizeStructuredPrerequisites(taskSpec.prerequisites),
      ...normalizeStructuredPrerequisites(taskSpec.execution_prerequisites),
      ...normalizeStructuredPrerequisites(taskSpec.preflight),
      ...normalizeStructuredPrerequisites(milestone?.prerequisites),
      ...normalizeStructuredPrerequisites(milestone?.execution_prerequisites),
      ...normalizeStructuredPrerequisites(mission?.execution_prerequisites),
      ...normalizeStructuredPrerequisites(project?.execution_prerequisites)
    ]
  };
}

function explicitStringList(...values) {
  return values.flatMap((value) => Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean);
}

function capabilityIsUnavailable(name, project = {}, mission = {}) {
  const contexts = [
    mission.capabilities,
    mission.permissions,
    mission.access,
    project.capabilities,
    project.permissions,
    project.access,
    project.runtime_context?.capabilities,
    project.runtime_context?.permissions,
    project.runtime_context?.access
  ].filter((item) => item && typeof item === 'object');
  for (const context of contexts) {
    if (Object.prototype.hasOwnProperty.call(context, name)) {
      return context[name] === false || context[name] === 'unavailable' || context[name] === 'denied';
    }
  }
  return false;
}

function checkpointForMissingPreflight({ tenantId, mission, run, roadmap, milestone, project, blocker }) {
  const existing = unresolvedHumanActionCheckpoint(milestone);
  return normalizeHumanActionCheckpoint({
    tenant_id: tenantId,
    roadmap_id: roadmap?.id || mission.roadmap_id || run.roadmap_id || null,
    milestone_id: milestone?.id || mission.milestone_id || run.milestone_id || null,
    mission_id: mission.id || run.mission_id || null,
    checkpoint_type: 'PROGRAM_PREFLIGHT',
    requirement_type: blocker.requirement_type,
    human_action_request: blocker.human_action_request,
    user_action: blocker.user_action,
    action_location: blocker.action_location,
    validation_method: blocker.validation_method,
    validation_metadata: blocker.validation_metadata,
    reason: blocker.reason,
    blocker_code: blocker.blocker_code,
    requirement_key: blocker.requirement_key
  }, existing);
}

function deterministicProgramPreflight({ tenantId, brainOutput, mission, run, roadmap, milestone, project }) {
  const { taskSpec, prerequisites } = structuredPreflightSources({ brainOutput, mission, milestone, project });
  const repositoryRequired = taskSpec.requires_repository === true || taskSpec.repository_required === true ||
    prerequisites.some((item) => ['REPOSITORY_LOCAL_PATH', 'REPOSITORY', 'LOCAL_PATH'].includes(String(item.type || item.requirement_type || '').toUpperCase()));
  if (repositoryRequired && !localPathFromProject(project)) {
    return checkpointForMissingPreflight({
      tenantId, mission, run, roadmap, milestone, project,
      blocker: {
        requirement_type: 'REPOSITORY_LOCAL_PATH',
        blocker_code: 'PROGRAM_PREFLIGHT_REPOSITORY_LOCAL_PATH_REQUIRED',
        human_action_request: 'A repository local path is required before Executor work can be created.',
        user_action: 'Configure the project repository local path for this workspace.',
        action_location: 'project.runtime_context.repository_path',
        validation_method: 'project_repository_local_path_present',
        validation_metadata: { project_id: project?.id || mission.project_id || null },
        reason: 'Missing configured repository local path.',
        requirement_key: 'repository_local_path'
      }
    });
  }

  const envVars = explicitStringList(taskSpec.required_env_vars, taskSpec.required_environment_variables)
    .concat(prerequisites.flatMap((item) => {
      const type = String(item.type || item.requirement_type || '').toUpperCase();
      if (!['ENV_VAR', 'ENVIRONMENT_VARIABLE', 'ENVIRONMENT_VARIABLES'].includes(type)) return [];
      return explicitStringList(item.names, item.env_vars, item.variables, item.required_env_vars);
    }));
  const missingEnv = [...new Set(envVars)].find((name) => !process.env[name]);
  if (missingEnv) {
    return checkpointForMissingPreflight({
      tenantId, mission, run, roadmap, milestone, project,
      blocker: {
        requirement_type: 'ENV_VAR',
        blocker_code: 'PROGRAM_PREFLIGHT_ENV_VAR_REQUIRED',
        human_action_request: `Environment variable ${missingEnv} must be configured before Executor work can be created.`,
        user_action: `Set ${missingEnv} in the execution environment, then retry this milestone.`,
        action_location: 'process.env',
        validation_method: 'environment_variable_present',
        validation_metadata: { env_var_name: missingEnv },
        reason: `Missing required environment variable ${missingEnv}.`,
        requirement_key: `env:${missingEnv}`
      }
    });
  }

  for (const prerequisite of prerequisites) {
    const type = String(prerequisite.type || prerequisite.requirement_type || '').toUpperCase();
    const name = String(prerequisite.name || prerequisite.capability || prerequisite.permission || prerequisite.access || '').trim();
    if (['CAPABILITY', 'PERMISSION', 'ACCESS'].includes(type) && name && capabilityIsUnavailable(name, project, mission)) {
      return checkpointForMissingPreflight({
        tenantId, mission, run, roadmap, milestone, project,
        blocker: {
          requirement_type: type,
          blocker_code: `PROGRAM_PREFLIGHT_${type}_UNAVAILABLE`,
          human_action_request: cleanPreflightText(prerequisite.human_action_request || `${type.toLowerCase()} ${name} is unavailable.`),
          user_action: cleanPreflightText(prerequisite.user_action || `Grant or enable ${name}, then retry this milestone.`),
          action_location: cleanPreflightText(prerequisite.action_location || name),
          validation_method: cleanPreflightText(prerequisite.validation_method || 'structured_context_reports_available'),
          validation_metadata: { name },
          reason: `${type} ${name} is unavailable.`,
          requirement_key: `${type}:${name}`
        }
      });
    }
    if (['EXTERNAL_ACCESS', 'MANUAL_HUMAN', 'MANUAL_DEPLOY'].includes(type)) {
      return checkpointForMissingPreflight({
        tenantId, mission, run, roadmap, milestone, project,
        blocker: {
          requirement_type: type,
          blocker_code: `PROGRAM_PREFLIGHT_${type}_REQUIRED`,
          human_action_request: cleanPreflightText(prerequisite.human_action_request || prerequisite.request || `${type} prerequisite must be completed by a human.`),
          user_action: cleanPreflightText(prerequisite.user_action || 'Complete the declared prerequisite, then retry this milestone.'),
          action_location: cleanPreflightText(prerequisite.action_location || prerequisite.location || 'external'),
          validation_method: cleanPreflightText(prerequisite.validation_method || 'manual_confirmation'),
          validation_metadata: sanitizePreflightMetadata(prerequisite.validation_metadata || { name: prerequisite.name || null }),
          reason: cleanPreflightText(prerequisite.reason || `${type} prerequisite is required.`),
          requirement_key: `${type}:${prerequisite.name || prerequisite.action_location || prerequisite.human_action_request || ''}`
        }
      });
    }
  }

  return null;
}

function sanitizePreflightMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|private[_-]?key|value/i.test(key)) continue;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) out[key] = item;
  }
  return out;
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : String(item?.title || item?.description || '')).filter(Boolean)
    : [];
}

function normalizePlannedActions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') {
      return { title: item, description: item, executor_required: true };
    }
    return {
      title: String(item?.title || item?.description || 'Planned action').trim(),
      description: String(item?.description || item?.title || '').trim(),
      executor_required: item?.executor_required !== false
    };
  }).filter((item) => item.title || item.description);
}

function normalizeMissionPlan(rawResponse, input = {}, brainOutput = {}) {
  const raw = String(rawResponse || input.output_text || input.summary || '');
  const taggedPlan = extractTaggedBlock(raw, 'MRAPI_PLAN');
  const parsed = findFirstJsonObject(taggedPlan || raw);
  const source = parsed?.parsed && parsed.parsed.contract === 'MISSION_PLAN_V1'
    ? parsed.parsed
    : {};
  const hasMissionPlanContract = source.contract === 'MISSION_PLAN_V1';
  const taskSpec = brainOutput.task_spec || {};
  const sourceExecutionSpec = source.execution_spec && typeof source.execution_spec === 'object'
    ? source.execution_spec
    : null;
  const executionSpec = source.execution_spec && typeof source.execution_spec === 'object'
    ? source.execution_spec
    : hasMissionPlanContract
      ? {
          instructions: '',
          success_criteria: [],
          stop_conditions: []
        }
      : {
        instructions: taskSpec.instructions || brainOutput.final_result_text || raw,
        success_criteria: [],
        stop_conditions: []
      };

  const requiresExecution = parseBoolean(source.requires_execution);
  const fallbackRequiresExecution = brainOutput.requires_execution !== false;

  const planRequiresExecution = requiresExecution === undefined ? fallbackRequiresExecution : requiresExecution;
  const executionType = normalizeExecutionType(
    source.execution_type || brainOutput.execution_type || (planRequiresExecution ? 'EXECUTOR' : 'BRAIN_ONLY'),
    planRequiresExecution
  );

  return {
    contract: 'MISSION_PLAN_V1',
    objective: String(source.objective || brainOutput.objective || input.objective || '').trim(),
    approach: String(source.approach || taskSpec.objective || brainOutput.objective || 'Review the Mission and execute after approval.').trim(),
    planned_actions: normalizePlannedActions(source.planned_actions).length
      ? normalizePlannedActions(source.planned_actions)
      : [{ title: taskSpec.title || 'Execute approved Mission', description: executionSpec.instructions || '', executor_required: fallbackRequiresExecution }],
    expected_deliverables: arrayOfStrings(source.expected_deliverables),
    risks: arrayOfStrings(source.risks),
    assumptions: arrayOfStrings(source.assumptions),
    permissions_required: arrayOfStrings(source.permissions_required),
    requires_execution: planRequiresExecution,
    execution_type: executionType.value,
    execution_type_raw: executionType.raw,
    execution_type_error: executionType.error,
    execution_spec: {
      instructions: String(executionSpec.instructions || taskSpec.instructions || brainOutput.final_result_text || '').trim(),
      allowed_files: arrayOfStrings(executionSpec.allowed_files || taskSpec.allowed_files),
      required_tests: arrayOfStrings(executionSpec.required_tests || taskSpec.required_tests),
      diagnostic_tests: arrayOfStrings(executionSpec.diagnostic_tests || taskSpec.diagnostic_tests),
      success_criteria: arrayOfStrings(executionSpec.success_criteria),
      stop_conditions: arrayOfStrings(executionSpec.stop_conditions)
    },
    execution_spec_missing: hasMissionPlanContract && planRequiresExecution && !sourceExecutionSpec
  };
}

function normalizeExecutionType(value, requiresExecution = true) {
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  if (requiresExecution === false) {
    return {
      value: 'BRAIN_ONLY',
      raw: raw || 'BRAIN_ONLY',
      error: upper && upper !== 'BRAIN_ONLY' ? 'PLAN_EXECUTION_TYPE_UNKNOWN' : null
    };
  }
  if (['EXECUTOR', 'EXECUTION', 'CODEX'].includes(upper)) {
    return {
      value: 'EXECUTOR',
      raw: raw || upper,
      error: null
    };
  }
  return {
    value: upper || null,
    raw: raw || null,
    error: 'PLAN_EXECUTION_TYPE_UNKNOWN'
  };
}

function executionTextForPermissionCheck(plan) {
  return [
    plan?.execution_spec?.instructions,
    ...(Array.isArray(plan?.planned_actions) ? plan.planned_actions.map((item) => `${item?.title || ''} ${item?.description || ''}`) : []),
    ...(Array.isArray(plan?.expected_deliverables) ? plan.expected_deliverables : [])
  ].filter(Boolean).join('\n');
}

function stripNegatedPermissionLines(text) {
  return String(text || '')
    .split(/\r?\n|[.;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(?:\bno\b|\bnot\b|do not|don't|without|forbidden|never|prohibited|must not|should not|no publicar|no desplegar|sin publicar|sin deploy)/i.test(line))
    .join('\n');
}

function requiredPermissionBlocker(plan) {
  const permissions = Array.isArray(plan?.permissions_required) ? plan.permissions_required : [];
  if (!permissions.length) return null;

  const positiveExecutionText = stripNegatedPermissionLines(executionTextForPermissionCheck(plan));
  const checks = [
    {
      permission: 'allow_deploy',
      permissionPattern: /(?:allow_deploy|deploy|deployment|desplegar)/i,
      actionPattern: /(?:\bdeploy\b|\bdeployment\b|\bdesplegar\b)/i
    },
    {
      permission: 'allow_publish',
      permissionPattern: /(?:allow_publish|publish|publishing|publicar)/i,
      actionPattern: /(?:\bpublish(?:ing)?\b|\bpublicar\b)/i
    },
    {
      permission: 'allow_modify_production_data',
      permissionPattern: /(?:allow_modify_production_data|production destructive|modify production|datos? de producci[oó]n)/i,
      actionPattern: /(?:production destructive|modify production|delete production|datos? de producci[oó]n)/i
    }
  ];

  for (const check of checks) {
    const permissionLines = permissions
      .map((item) => String(item || '').trim())
      .filter((item) => check.permissionPattern.test(item));
    if (!permissionLines.length) continue;

    // A prohibition such as "Do not publish" is a stop condition, not a request
    // for permission. Only block when the approved execution actually intends to
    // perform the privileged action.
    if (!check.actionPattern.test(positiveExecutionText)) continue;

    return {
      code: 'PERMISSION_REQUIRED',
      message: `Execution requires explicit permission: ${check.permission}.`,
      stage: 'APPROVAL',
      permission: check.permission
    };
  }

  return null;
}

function validateExecutionPlan(plan) {
  if (plan.requires_execution === false) return null;
  const executionType = normalizeExecutionType(plan.execution_type, true);
  if (executionType.error) {
    return {
      code: 'PLAN_EXECUTION_TYPE_UNKNOWN',
      message: `Unknown execution type: ${executionType.raw || 'missing'}`,
      stage: 'APPROVAL'
    };
  }
  if (
    plan.execution_spec_missing === true ||
    !plan.execution_spec ||
    typeof plan.execution_spec !== 'object' ||
    !hasMeaningfulText(plan.execution_spec.instructions)
  ) {
    return {
      code: 'PLAN_EXECUTION_SPEC_MISSING',
      message: 'Approved execution plan is missing execution_spec.instructions.',
      stage: 'APPROVAL'
    };
  }
  return null;
}

function blockMissionForApproval(tx, missionRef, plan, input, blocker) {
  tx.set(missionRef, {
    state: 'BLOCKED',
    approval_status: input.approval_status || 'APPROVED',
    approved_plan_revision_id: plan?.id || null,
    approved_at: timestamp(),
    approved_by: input.approved_by || 'operator',
    block_reason: blocker.code,
    blocked_reason: blocker.code,
    blocker_code: blocker.code,
    blocker_message: String(blocker.message || blocker.code).slice(0, 2000),
    blocker_stage: blocker.stage || 'APPROVAL',
    blocker_source_stage: blocker.stage || 'APPROVAL',
    blocker_plan_revision_id: plan?.id || null,
    blocker_brain_run_id: plan?.brain_run_id || null,
    updated_at: timestamp()
  }, { merge: true });
}

function projectRuntimeContext(project = {}) {
  const runtime = project.runtime_context && typeof project.runtime_context === 'object'
    ? project.runtime_context
    : {};
  const repositoryPath = String(
    runtime.repository_path ||
    runtime.local_path ||
    project.repository_path ||
    project.local_path ||
    ''
  ).trim();

  return {
    ...runtime,
    repository_path: repositoryPath || null,
    local_path: repositoryPath || null,
    project_id: project.id || null,
    project_name: project.name || null
  };
}

function executionSpecRequiresRepository(plan) {
  const spec = plan.execution_spec && typeof plan.execution_spec === 'object'
    ? plan.execution_spec
    : {};
  if (spec.requires_repository === true || spec.repository_required === true) return true;
  const targetType = String(spec.target_type || spec.target || '').toUpperCase();
  if (['CODE', 'REPOSITORY', 'REPO', 'APP'].includes(targetType)) return true;
  const text = [
    spec.instructions,
    plan.objective,
    plan.approach,
    ...(plan.planned_actions || []).map((item) => `${item.title || ''} ${item.description || ''}`)
  ].filter(Boolean).join('\n');
  return /\b(code|repository|repo|source code|local tests|node --test|npm(?:\.cmd)? test|git|commit|push)\b/i.test(text);
}

function artifactExpectationsFromPlan(plan) {
  const text = [
    plan.objective,
    plan.approach,
    plan.execution_spec?.instructions,
    ...(plan.expected_deliverables || [])
  ].filter(Boolean).join('\n');
  const artifactTypes = [];
  if (/\bpdf\b/i.test(text)) artifactTypes.push('PDF');
  if (/\b(csv|spreadsheet|xlsx|excel)\b/i.test(text)) artifactTypes.push('SPREADSHEET');
  if (/\b(image|png|jpg|jpeg|screenshot)\b/i.test(text)) artifactTypes.push('IMAGE');
  return {
    evidence_required: true,
    artifact_required: artifactTypes.length > 0,
    artifact_types: artifactTypes
  };
}

function createExecutionSnapshot({ snapshotRef, tenantId, mission, plan, project }) {
  const runtimeContext = projectRuntimeContext(project);
  const requiresRepository = executionSpecRequiresRepository(plan);
  const artifactExpectations = artifactExpectationsFromPlan(plan);

  return {
    id: snapshotRef.id,
    tenant_id: tenantId,
    workspace_id: plan.workspace_id || mission.workspace_id || null,
    project_id: plan.project_id || mission.project_id || null,
    mission_id: mission.id,
    worker_id: plan.worker_id || mission.preferred_worker_id || null,
    approved_plan_revision_id: plan.id,
    approved_plan_revision_number: Number(plan.revision || mission.plan_revision_number || 0),
    objective: plan.objective || mission.objective || '',
    execution_type: normalizeExecutionType(plan.execution_type, true).value,
    execution_spec: {
      ...(plan.execution_spec || {}),
      instructions: String(plan.execution_spec?.instructions || '').trim()
    },
    permissions: Array.isArray(plan.permissions_required) ? [...plan.permissions_required] : [],
    project_runtime_context: runtimeContext,
    repository_required: requiresRepository,
    repository_path: requiresRepository ? runtimeContext.repository_path : null,
    task_workspace_path: requiresRepository ? null : `MRAPI_TASK_WORKSPACE/${mission.id}/${snapshotRef.id}`,
    artifact_expectations: artifactExpectations,
    execution_constraints: {
      no_gcp: true,
      no_cloud_run: true,
      no_deploy: true,
      deployment: 'HUMAN_MANUAL_DEPLOY',
      repository_required: requiresRepository
    },
    created_at: timestamp()
  };
}

function taskSpecFromExecutionSnapshot(snapshot) {
  const spec = snapshot.execution_spec && typeof snapshot.execution_spec === 'object'
    ? snapshot.execution_spec
    : {};
  return {
    title: String(spec.title || snapshot.objective || 'Approved execution task').trim(),
    objective: String(snapshot.objective || '').trim(),
    instructions: String(spec.instructions || '').trim(),
    allowed_files: Array.isArray(spec.allowed_files) ? [...spec.allowed_files] : [],
    required_tests: Array.isArray(spec.required_tests) ? [...spec.required_tests] : [],
    diagnostic_tests: Array.isArray(spec.diagnostic_tests) ? [...spec.diagnostic_tests] : [],
    success_criteria: Array.isArray(spec.success_criteria) ? [...spec.success_criteria] : [],
    stop_conditions: Array.isArray(spec.stop_conditions) ? [...spec.stop_conditions] : []
  };
}

function planSummary(plan) {
  return [
    plan.objective,
    plan.approach,
    ...(plan.planned_actions || []).map((action) => `${action.title}: ${action.description}`),
    ...(plan.expected_deliverables || []).map((item) => `Deliverable: ${item}`)
  ].filter(Boolean).join('\n').slice(0, 10000);
}

function taskSpecFromPlan(plan, mission) {
  const instructions = [
    `MISSION OBJECTIVE\n${mission.objective || plan.objective || ''}`,
    `APPROVED PLAN\n${planSummary(plan)}`,
    `EXECUTION INSTRUCTIONS\n${plan.execution_spec?.instructions || plan.approach || ''}`,
    plan.execution_spec?.success_criteria?.length ? `SUCCESS CRITERIA\n${plan.execution_spec.success_criteria.map((item) => `- ${item}`).join('\n')}` : '',
    plan.execution_spec?.stop_conditions?.length ? `STOP CONDITIONS\n${plan.execution_spec.stop_conditions.map((item) => `- ${item}`).join('\n')}` : '',
    plan.permissions_required?.length ? `PERMISSIONS\n${plan.permissions_required.map((item) => `- ${item}`).join('\n')}` : '',
    'DEPLOY\nHUMAN MANUAL DEPLOY - DO NOT DEPLOY.'
  ].filter(Boolean).join('\n\n');

  return {
    title: plan.planned_actions?.[0]?.title || mission.objective || 'Approved Mission execution',
    objective: plan.objective || mission.objective || '',
    instructions,
    allowed_files: Array.isArray(plan.execution_spec?.allowed_files) ? [...plan.execution_spec.allowed_files] : [],
    required_tests: Array.isArray(plan.execution_spec?.required_tests) ? [...plan.execution_spec.required_tests] : [],
    diagnostic_tests: Array.isArray(plan.execution_spec?.diagnostic_tests) ? [...plan.execution_spec.diagnostic_tests] : [],
    success_criteria: Array.isArray(plan.execution_spec?.success_criteria) ? [...plan.execution_spec.success_criteria] : [],
    stop_conditions: Array.isArray(plan.execution_spec?.stop_conditions) ? [...plan.execution_spec.stop_conditions] : [],
    approved_plan: plan
  };
}

function buildBrainOutput(run, input = {}) {
  const parsed = parseBrainResponse(input.output_text || input.summary || '', input);
  const decision = parsed;

  let taskSpec = input.task_spec && typeof input.task_spec === 'object'
    ? { ...input.task_spec, ...(decision.task_spec || {}) }
    : decision.task_spec && typeof decision.task_spec === 'object'
      ? decision.task_spec
      : {
          title: input.title || run.objective || 'Execution task',
          objective: input.objective || run.objective || '',
          instructions: input.output_text || input.instructions || ''
        };
  if (!Object.keys(taskSpec).length && decision.requires_execution !== false) {
    taskSpec = {
      title: input.title || run.objective || 'Execution task',
      objective: input.objective || run.objective || '',
      instructions: input.instructions || input.output_text || ''
    };
  }

  const executionConstraints = input.execution_constraints && typeof input.execution_constraints === 'object'
    ? input.execution_constraints
    : {
        no_gcp: true,
        no_cloud_run: true,
        no_deploy: true,
        deployment: 'HUMAN_MANUAL_DEPLOY'
      };

  return {
    objective: input.objective || run.objective || taskSpec.objective || '',
    worker_id: input.worker_id || run.worker_id || null,
    requires_execution: decision.requires_execution,
    execution_type: input.execution_type || decision.execution_type || 'CODEX',
    final_result: input.final_result || null,
    final_result_text: decision.final_result_text,
    raw_response: decision.raw_response,
    task_spec: taskSpec,
    execution_constraints: executionConstraints,
    brain_run_id: run.id,
    tenant_id: run.tenant_id,
    workspace_id: run.workspace_id || null,
    project_id: run.project_id || null,
    mission_id: run.mission_id || null
  };
}

async function updateRunProgress(db, tenantId, runId, input) {
  const runRef = db.collection('runs').doc(runId);
  const snap = await runRef.get();

  if (!snap.exists || snap.data().tenant_id !== tenantId) {
    const error = new Error('RUN_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const progress = Math.max(0, Math.min(100, Number(input.progress_percent || 0)));

  await runRef.set({
    progress_percent: progress,
    progress_message: String(input.message || '').slice(0, 2000),
    updated_at: timestamp()
  }, { merge: true });

  return { ok: true, run_id: runId, progress_percent: progress };
}

function sanitizeFilename(name) {
  return String(name || 'evidence.bin')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
}

async function addEvidence(db, tenantId, runId, input) {
  const runRef = db.collection('runs').doc(runId);
  const runSnap = await runRef.get();

  if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
    const error = new Error('RUN_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const type = String(input.type || '').toUpperCase();
  if (!EVIDENCE_TYPES.includes(type)) {
    const error = new Error('INVALID_EVIDENCE_TYPE');
    error.status = 400;
    throw error;
  }

  const run = runSnap.data();
  const evidenceRef = db.collection('evidence').doc();
  let storage = null;

  if (input.content_base64) {
    const buffer = Buffer.from(String(input.content_base64), 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      const error = new Error('EVIDENCE_TOO_LARGE');
      error.status = 413;
      throw error;
    }

    const filename = sanitizeFilename(input.filename);
    const objectPath = [
      tenantId,
      run.mission_id || 'no-mission',
      run.task_id || 'no-task',
      runId,
      evidenceRef.id,
      filename
    ].join('/');

    const file = getEvidenceBucket().file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: {
        contentType: input.content_type || 'application/octet-stream',
        metadata: {
          tenant_id: tenantId,
          run_id: runId,
          evidence_id: evidenceRef.id
        }
      }
    });

    storage = {
      bucket: getEvidenceBucket().name,
      object_path: objectPath,
      gs_uri: `gs://${getEvidenceBucket().name}/${objectPath}`,
      size_bytes: buffer.length,
      content_type: input.content_type || 'application/octet-stream',
      filename
    };
  }

  const evidence = {
    id: evidenceRef.id,
    tenant_id: tenantId,
    type,
    mission_id: run.mission_id || null,
    task_id: run.task_id || null,
    run_id: runId,
    workspace_id: run.workspace_id || null,
    project_id: run.project_id || null,
    brain_run_id: run.brain_run_id || run.parent_run_id || (run.run_type === 'BRAIN_RUN' ? runId : null),
    worker_id: run.worker_id || null,
    executor_id: run.executor_id || null,
    title: String(input.title || input.filename || type).slice(0, 250),
    description: String(input.description || '').slice(0, 5000),
    url: input.url || null,
    storage,
    created_at: timestamp()
  };

  await evidenceRef.set(evidence);

  await emitEvent(db, tenantId, 'EVIDENCE_ADDED', {
    evidence_id: evidenceRef.id,
    run_id: runId,
    type
  }, 'INFO');

  return evidence;
}


async function completeBrainRun(db, tenantId, runId, input) {
  const runRef = db.collection('runs').doc(runId);
  const preflight = await runRef.get();
  if (preflight.exists && preflight.data().tenant_id === tenantId && preflight.data().autopilot_phase === 'VERIFY_EXECUTION') {
    return completeVerificationBrainRun(db, tenantId, runId, input || {});
  }
  if (preflight.exists && preflight.data().tenant_id === tenantId && preflight.data().planning_mode === 'PLANNER_ROADMAP_PROPOSAL') {
    const { completePlannerBrainRun } = require('./planner');
    return completePlannerBrainRun(db, tenantId, runId, input || {});
  }
  let result;

  await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
      const error = new Error('RUN_NOT_FOUND'); error.status = 404; throw error;
    }

    const run = runSnap.data();
    if (run.run_type !== 'BRAIN_RUN' || run.state !== 'RUNNING') {
      const error = new Error('BRAIN_RUN_NOT_ACTIVE'); error.status = 409; throw error;
    }

    const missionRef = db.collection('missions').doc(run.mission_id);
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
    }

    if (isMissionCancelled(missionSnap.data())) {
      tx.update(runRef, {
        state: 'FAILED',
        progress_percent: Number(run.progress_percent || 0),
        progress_message: 'Brain completion ignored because Mission is cancelled',
        error: 'MISSION_CANCELLED',
        completed_at: timestamp(),
        updated_at: timestamp()
      });
      result = {
        cancelled: true,
        success: false,
        mission_id: run.mission_id,
        brain_run_id: runId,
        error: 'MISSION_CANCELLED'
      };
      return;
    }

    const taskRef = run.task_id
      ? db.collection('tasks').doc(run.task_id)
      : db.collection('tasks').doc();
    const resultRef = db.collection('results').doc();
    const executorRef = run.executor_id ? db.collection('executors').doc(run.executor_id) : null;
    const outputText = String(input.output_text || '').slice(0, 100000);
    const brainOutput = buildBrainOutput({ id: runId, ...run }, { ...input, output_text: outputText });
    const taskSpec = brainOutput.task_spec || {};
    const mission = missionSnap.data();
    const autopilotRoadmap = await getAutopilotRoadmapForRun(tx, db, tenantId, mission, run);
    let project = null;
    if (mission.project_id || run.project_id) {
      const projectSnap = await tx.get(db.collection('projects').doc(mission.project_id || run.project_id));
      if (projectSnap.exists && projectSnap.data().tenant_id === tenantId) {
        project = { id: projectSnap.id, ...projectSnap.data() };
      }
    }

    if (mission.planning_mode === 'REQUIRED' && mission.approval_status !== 'APPROVED') {
      const revision = Number(mission.plan_revision_number || 0) + 1;
      const planRef = db.collection('mission_plans').doc();
      const plan = normalizeMissionPlan(outputText, input, brainOutput);

      tx.update(runRef, {
        state: 'COMPLETED',
        progress_percent: 100,
        progress_message: `Mission plan revision ${revision} ready`,
        output_text: outputText,
        brain_output: brainOutput,
        brain_chat_url: input.brain_chat_url || null,
        completed_at: timestamp(),
        updated_at: timestamp()
      });

      tx.set(planRef, {
        id: planRef.id,
        tenant_id: tenantId,
        workspace_id: run.workspace_id || mission.workspace_id || null,
        project_id: run.project_id || mission.project_id || null,
        mission_id: run.mission_id,
        worker_id: run.worker_id || mission.preferred_worker_id || null,
        revision,
        status: 'READY',
        objective: plan.objective || mission.objective || '',
        approach: plan.approach,
        planned_actions: plan.planned_actions,
        expected_deliverables: plan.expected_deliverables,
        risks: plan.risks,
        assumptions: plan.assumptions,
        permissions_required: plan.permissions_required,
        requires_execution: plan.requires_execution,
        execution_type: plan.execution_type,
        execution_type_raw: plan.execution_type_raw,
        execution_type_error: plan.execution_type_error,
        execution_spec: plan.execution_spec,
        execution_spec_missing: plan.execution_spec_missing,
        user_change_request: mission.pending_change_request || null,
        brain_run_id: runId,
        raw_response: outputText,
        created_at: timestamp(),
        updated_at: timestamp()
      });

      if (mission.current_plan_revision_id) {
        tx.set(db.collection('mission_plans').doc(mission.current_plan_revision_id), {
          status: 'SUPERSEDED',
          updated_at: timestamp()
        }, { merge: true });
      }

      tx.set(missionRef, {
        state: 'READY',
        approval_status: 'PENDING',
        current_plan_revision_id: planRef.id,
        plan_revision_number: revision,
        pending_change_request: null,
        brain_run_id: runId,
        updated_at: timestamp()
      }, { merge: true });

      result = {
        success: true,
        mission_id: run.mission_id,
        brain_run_id: runId,
        plan_revision_id: planRef.id,
        revision,
        requires_approval: true
      };
      return;
    }

    if (brainOutput.requires_execution === false) {
      if (!hasMeaningfulText(brainOutput.final_result_text)) {
        tx.update(runRef, {
          state: 'FAILED',
          progress_percent: Number(run.progress_percent || 0),
          progress_message: 'Brain-only result missing final user-facing answer',
          error: 'BRAIN_RESULT_MISSING',
          output_text: outputText,
          brain_output: brainOutput,
          brain_chat_url: input.brain_chat_url || null,
          completed_at: timestamp(),
          updated_at: timestamp()
        });

        tx.set(missionRef, {
          state: 'BLOCKED',
          block_reason: 'BRAIN_RESULT_MISSING',
          updated_at: timestamp()
        }, { merge: true });
        if (autopilotRoadmap) {
          tx.set(autopilotRoadmap.roadmapRef, {
            milestones: roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'BLOCKED', {
              blocked_reason: 'BRAIN_RESULT_MISSING',
              brain_run_id: runId
            }),
            state: 'BLOCKED',
            updated_at: timestamp()
          }, { merge: true });
        }

        result = {
          success: false,
          mission_id: run.mission_id,
          task_id: null,
          brain_run_id: runId,
          requires_execution: false,
          error: 'BRAIN_RESULT_MISSING'
        };
        return;
      }

      const finalResultText = brainOutput.final_result_text;
      tx.update(runRef, {
        state: 'COMPLETED',
        progress_percent: 100,
        progress_message: brainResultSummary(input, finalResultText).slice(0, 2000),
        output_text: outputText,
        brain_output: brainOutput,
        brain_chat_url: input.brain_chat_url || null,
        completed_at: timestamp(),
        updated_at: timestamp()
      });

      tx.set(resultRef, {
        id: resultRef.id,
        tenant_id: tenantId,
        mission_id: run.mission_id,
        task_id: null,
        run_id: runId,
        workspace_id: run.workspace_id || null,
        project_id: run.project_id || null,
        worker_id: brainOutput.worker_id,
        executor_id: run.executor_id || null,
        brain_run_id: runId,
        run_type: 'BRAIN_RUN',
        source_run_type: 'BRAIN_RUN',
        status: 'SUCCESS',
        result_type: 'BRAIN_RESULT',
        title: brainResultTitle(run, taskSpec),
        summary: brainResultSummary(input, finalResultText),
        content: finalResultText,
        text: finalResultText,
        output: brainOutput,
        created_at: timestamp()
      });

      tx.set(missionRef, {
        state: 'COMPLETED',
        brain_run_id: runId,
        brain_output_result_id: resultRef.id,
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
      if (autopilotRoadmap) {
        const milestones = roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'COMPLETED', {
          brain_run_id: runId,
          brain_output_result_id: resultRef.id,
          result_id: resultRef.id,
          completed_at: new Date()
        });
        tx.set(autopilotRoadmap.roadmapRef, {
          milestones,
          state: roadmapCompletedAfter(milestones) ? 'COMPLETED' : autopilotRoadmap.roadmap.state,
          updated_at: timestamp()
        }, { merge: true });
      }

      if (executorRef) {
        tx.set(executorRef, {
          current_run_id: null,
          updated_at: timestamp()
        }, { merge: true });
      }

      result = {
        mission_id: run.mission_id,
        task_id: null,
        brain_run_id: runId,
        result_id: resultRef.id,
        brain_output: brainOutput,
        requires_execution: false
      };
      return;
    }

    if (mission.autopilot_mode === true && String(run.autopilot_phase || mission.autopilot_phase || '') === 'PROGRAM') {
      const allowedFiles = Array.isArray(taskSpec.allowed_files)
        ? taskSpec.allowed_files.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (allowedFiles.length === 0) {
        tx.update(runRef, {
          state: 'FAILED',
          progress_percent: Number(run.progress_percent || 0),
          progress_message: 'Autopilot Brain package missing allowed_files',
          error: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED',
          output_text: outputText,
          brain_output: brainOutput,
          brain_chat_url: input.brain_chat_url || null,
          completed_at: timestamp(),
          updated_at: timestamp()
        });
        tx.set(missionRef, {
          state: 'BLOCKED',
          block_reason: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED',
          blocked_reason: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED',
          blocker_code: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED',
          blocker_message: 'W01 Brain did not provide a non-empty task_spec.allowed_files after automatic contract repair. No Executor task was created.',
          blocker_stage: 'BRAIN_CONTRACT',
          updated_at: timestamp()
        }, { merge: true });
        if (autopilotRoadmap) {
          tx.set(autopilotRoadmap.roadmapRef, {
            milestones: roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'BLOCKED', {
              blocked_reason: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED',
              brain_run_id: runId
            }),
            state: 'BLOCKED',
            updated_at: timestamp()
          }, { merge: true });
        }
        result = {
          success: false,
          mission_id: run.mission_id,
          task_id: null,
          brain_run_id: runId,
          error: 'BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED'
        };
        return;
      }
      const requiredTests = Array.isArray(taskSpec.required_tests)
        ? taskSpec.required_tests.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (requiredTests.length === 0) {
        tx.update(runRef, {
          state: 'FAILED',
          progress_percent: Number(run.progress_percent || 0),
          progress_message: 'Autopilot Brain package missing required_tests',
          error: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED',
          output_text: outputText,
          brain_output: brainOutput,
          brain_chat_url: input.brain_chat_url || null,
          completed_at: timestamp(),
          updated_at: timestamp()
        });
        tx.set(missionRef, {
          state: 'BLOCKED',
          block_reason: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED',
          blocked_reason: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED',
          blocker_code: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED',
          blocker_message: 'W01 Brain did not provide non-empty task_spec.required_tests after automatic contract repair. No Executor task was created.',
          blocker_stage: 'BRAIN_CONTRACT',
          updated_at: timestamp()
        }, { merge: true });
        if (autopilotRoadmap) {
          tx.set(autopilotRoadmap.roadmapRef, {
            milestones: roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'BLOCKED', {
              blocked_reason: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED',
              brain_run_id: runId
            }),
            state: 'BLOCKED',
            updated_at: timestamp()
          }, { merge: true });
        }
        result = {
          success: false,
          mission_id: run.mission_id,
          task_id: null,
          brain_run_id: runId,
          error: 'BRAIN_AUTOPILOT_REQUIRED_TESTS_REQUIRED'
        };
        return;
      }

      const checkpoint = deterministicProgramPreflight({
        tenantId,
        brainOutput,
        mission: { id: run.mission_id, ...mission },
        run: { id: runId, ...run },
        roadmap: autopilotRoadmap?.roadmap || null,
        milestone: autopilotRoadmap?.milestone || null,
        project
      });
      if (checkpoint) {
        tx.update(runRef, {
          state: 'COMPLETED',
          progress_percent: 100,
          progress_message: 'Autopilot PROGRAM preflight requires human action',
          output_text: outputText,
          brain_output: brainOutput,
          brain_chat_url: input.brain_chat_url || null,
          completed_at: timestamp(),
          updated_at: timestamp()
        });
        tx.set(missionRef, {
          state: 'NEED_HUMAN_ACTION',
          autopilot_phase: 'NEED_HUMAN_ACTION',
          brain_run_id: runId,
          human_action_required: true,
          human_action_checkpoint: checkpoint,
          blocker_code: checkpoint.blocker_code,
          blocker_message: checkpoint.human_action_request,
          updated_at: timestamp()
        }, { merge: true });
        if (autopilotRoadmap) {
          tx.set(autopilotRoadmap.roadmapRef, {
            milestones: roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'NEED_HUMAN_ACTION', {
              mission_id: run.mission_id,
              brain_run_id: runId,
              human_action_required: true,
              human_action_checkpoint: checkpoint,
              waiting_status: checkpoint.waiting_status,
              blocked_reason: checkpoint.blocker_code
            }),
            updated_at: timestamp()
          }, { merge: true });
        }
        result = {
          success: false,
          action: 'NEED_HUMAN_ACTION',
          mission_id: run.mission_id,
          task_id: null,
          brain_run_id: runId,
          requires_execution: true,
          checkpoint_id: checkpoint.checkpoint_id,
          human_action_checkpoint: checkpoint,
          error: checkpoint.blocker_code
        };
        return;
      }
    }

    tx.update(runRef, {
      state: 'COMPLETED',
      progress_percent: 100,
      progress_message: 'Brain plan completed',
      output_text: outputText,
      brain_output: brainOutput,
      brain_chat_url: input.brain_chat_url || null,
      completed_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      id: taskRef.id,
      tenant_id: tenantId,
      mission_id: run.mission_id,
      workspace_id: run.workspace_id || null,
      project_id: run.project_id || null,
      worker_id: brainOutput.worker_id,
      title: taskSpec.title || brainOutput.objective,
      objective: taskSpec.objective || brainOutput.objective,
      task_spec: taskSpec,
      priority: input.priority || 'NORMAL',
      state: 'QUEUED',
      phase: 'EXECUTION_PENDING',
      autopilot_phase: mission.autopilot_mode === true ? (mission.autopilot_phase || 'PROGRAM') : null,
      attempt_count: 0,
      brain_run_id: runId,
      brain_output: brainOutput,
      brain_completed_at: timestamp(),
      current_run_id: null,
      claimed_by_executor_id: null,
      created_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(resultRef, {
      id: resultRef.id,
      tenant_id: tenantId,
      mission_id: run.mission_id,
      task_id: taskRef.id,
      run_id: runId,
      workspace_id: run.workspace_id || null,
      project_id: run.project_id || null,
      worker_id: brainOutput.worker_id,
      executor_id: run.executor_id || null,
      status: 'SUCCESS',
      result_type: 'BRAIN_OUTPUT',
      summary: String(input.summary || 'Brain output persisted').slice(0, 10000),
      output: brainOutput,
      created_at: timestamp()
    });

    tx.set(missionRef, {
      state: 'PLANNING',
      brain_run_id: runId,
      brain_output_result_id: resultRef.id,
      current_task_id: taskRef.id,
      ...(mission.autopilot_mode === true ? {
        autopilot_allowed_files: Array.isArray(taskSpec.allowed_files) ? taskSpec.allowed_files : []
      } : {}),
      updated_at: timestamp()
    }, { merge: true });
    if (autopilotRoadmap) {
      tx.set(autopilotRoadmap.roadmapRef, {
        milestones: roadmapMilestonesWithState(autopilotRoadmap.roadmap, autopilotRoadmap.milestone.id, 'RUNNING', {
          mission_id: run.mission_id,
          brain_run_id: runId
        }),
        updated_at: timestamp()
      }, { merge: true });
    }

    if (executorRef) {
      tx.set(executorRef, {
        current_run_id: null,
        updated_at: timestamp()
      }, { merge: true });
    }

    result = {
      mission_id: run.mission_id,
      task_id: taskRef.id,
      brain_run_id: runId,
      result_id: resultRef.id,
      brain_output: brainOutput
    };
  });

  await emitEvent(
    db,
    tenantId,
    result.success === false ? 'BRAIN_RUN_FAILED' : 'BRAIN_RUN_COMPLETED',
    result,
    result.success === false ? 'WARNING' : 'OPERATIVE'
  );
  return result;
}

async function getMissionPlan(db, tenantId, missionId) {
  const missionSnap = await db.collection('missions').doc(missionId).get();
  if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
    const error = new Error('MISSION_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const plansSnap = await db.collection('mission_plans')
    .where('tenant_id', '==', tenantId)
    .limit(200)
    .get();
  const plans = plansSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((plan) => plan.mission_id === missionId)
    .sort((a, b) => Number(a.revision || 0) - Number(b.revision || 0));
  const current = plans.find((plan) => plan.id === missionSnap.data().current_plan_revision_id) ||
    plans[plans.length - 1] ||
    null;

  return {
    mission: { id: missionSnap.id, ...missionSnap.data() },
    current_plan: current,
    revisions: plans
  };
}

async function requestMissionPlanChanges(db, tenantId, missionId, input = {}) {
  const message = String(input.message || '').trim();
  if (!message) {
    const error = new Error('CHANGE_REQUEST_REQUIRED');
    error.status = 400;
    throw error;
  }

  const missionRef = db.collection('missions').doc(missionId);
  const runRef = db.collection('runs').doc();
  let result;

  await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const mission = missionSnap.data();
    if (['RUNNING', 'COMPLETED', 'CANCELLED'].includes(mission.state)) {
      const error = new Error('PLAN_CHANGE_NOT_ALLOWED');
      error.status = 409;
      throw error;
    }
    if (mission.approval_status !== 'PENDING' || !mission.current_plan_revision_id) {
      const error = new Error('PLAN_NOT_READY');
      error.status = 409;
      throw error;
    }

    const currentPlanRef = db.collection('mission_plans').doc(mission.current_plan_revision_id);
    const currentPlanSnap = await tx.get(currentPlanRef);
    if (!currentPlanSnap.exists || currentPlanSnap.data().tenant_id !== tenantId) {
      const error = new Error('PLAN_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const workerId = currentPlanSnap.data().worker_id || mission.preferred_worker_id;
    tx.set(currentPlanRef, {
      status: 'SUPERSEDED',
      updated_at: timestamp()
    }, { merge: true });

    const brainRun = {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: missionId,
      task_id: null,
      workspace_id: mission.workspace_id || null,
      project_id: mission.project_id || null,
      worker_id: workerId,
      executor_id: null,
      parent_run_id: null,
      objective: [
        mission.objective || '',
        '',
        'PREVIOUS PLAN SUMMARY',
        planSummary(currentPlanSnap.data()),
        '',
        'REQUESTED CHANGES',
        message
      ].join('\n').slice(0, 20000),
      state: 'RUNNING',
      progress_percent: 0,
      progress_message: 'Plan changes requested; Brain Run started',
      planning_revision: Number(mission.plan_revision_number || currentPlanSnap.data().revision || 1) + 1,
      change_request: message,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(runRef, brainRun);
    tx.set(missionRef, {
      state: 'PLANNING',
      approval_status: 'CHANGES_REQUESTED',
      pending_change_request: message,
      brain_run_id: runRef.id,
      updated_at: timestamp()
    }, { merge: true });

    result = {
      success: true,
      mission_id: missionId,
      brain_run_id: runRef.id,
      requested_revision: brainRun.planning_revision
    };
  });

  await emitEvent(db, tenantId, 'MISSION_PLAN_CHANGES_REQUESTED', {
    mission_id: missionId,
    brain_run_id: result.brain_run_id,
    requested_revision: result.requested_revision
  }, 'OPERATIVE');

  return result;
}

async function approveMissionPlan(db, tenantId, missionId, input = {}) {
  const missionRef = db.collection('missions').doc(missionId);
  let result;

  try {
    await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const mission = missionSnap.data();
    const tasksSnap = await tx.get(db.collection('tasks').where('tenant_id', '==', tenantId).limit(200));
    const existingTask = tasksSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .find((task) => task.mission_id === missionId && task.approved_plan_revision_id);

    if ((mission.approval_status === 'APPROVED' || mission.state === 'RUNNING') && existingTask) {
      result = {
        success: true,
        reused: true,
        mission_id: missionId,
        task_id: existingTask?.id || null,
        plan_revision_id: mission.approved_plan_revision_id || mission.current_plan_revision_id || null
      };
      return;
    }

    const recoveringApprovedPlan = mission.approval_status === 'APPROVED' &&
      !existingTask &&
      (mission.approved_plan_revision_id || mission.current_plan_revision_id);

    if (
      !recoveringApprovedPlan &&
      (mission.state !== 'READY' || mission.approval_status !== 'PENDING' || !mission.current_plan_revision_id)
    ) {
      const error = new Error('MISSION_PLAN_NOT_APPROVABLE');
      error.status = 409;
      throw error;
    }

    const planRevisionId = recoveringApprovedPlan
      ? mission.approved_plan_revision_id || mission.current_plan_revision_id
      : mission.current_plan_revision_id;
    const planRef = db.collection('mission_plans').doc(planRevisionId);
    const planSnap = await tx.get(planRef);
    if (!planSnap.exists || planSnap.data().tenant_id !== tenantId || planSnap.data().mission_id !== missionId) {
      const error = new Error('PLAN_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const plan = { id: planSnap.id, ...planSnap.data() };

    // Firestore requires every transaction read to happen before the first write.
    // Keep project lookup in the read phase; otherwise real Firestore throws
    // "Firestore transactions require all reads to be executed before all writes"
    // even though the in-memory test transaction permits it.
    const projectId = plan.project_id || mission.project_id || null;
    let project = { id: projectId };
    if (projectId) {
      const projectRef = db.collection('projects').doc(projectId);
      const projectSnap = await tx.get(projectRef);
      project = projectSnap.exists && projectSnap.data().tenant_id === tenantId
        ? { id: projectSnap.id, ...projectSnap.data() }
        : { id: projectId };
    }

    tx.set(planRef, {
      status: 'APPROVED',
      approved_at: timestamp(),
      approved_by: input.approved_by || 'operator',
      updated_at: timestamp()
    }, { merge: true });

    const permissionBlocker = requiredPermissionBlocker(plan);
    if (permissionBlocker) {
      blockMissionForApproval(tx, missionRef, plan, input, permissionBlocker);
      result = {
        success: false,
        blocked: true,
        error: permissionBlocker.code,
        blocker_code: permissionBlocker.code,
        blocker_message: permissionBlocker.message,
        required_permission: permissionBlocker.permission || null,
        mission_id: missionId,
        plan_revision_id: plan.id
      };
      return;
    }

    const executionBlocker = validateExecutionPlan(plan);
    if (executionBlocker) {
      blockMissionForApproval(tx, missionRef, plan, input, executionBlocker);
      tx.set(planRef, {
        status: 'BLOCKED',
        approval_status: 'APPROVED',
        blocker_code: executionBlocker.code,
        blocker_message: executionBlocker.message,
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: false,
        blocked: true,
        error: executionBlocker.code,
        blocker_code: executionBlocker.code,
        blocker_message: executionBlocker.message,
        mission_id: missionId,
        plan_revision_id: plan.id
      };
      return;
    }

    const snapshotRef = db.collection('execution_snapshots').doc();
    const executionSnapshot = createExecutionSnapshot({
      snapshotRef,
      tenantId,
      mission,
      plan,
      project
    });

    if (executionSnapshot.repository_required && !executionSnapshot.repository_path) {
      const blocker = {
        code: 'PROJECT_RUNTIME_CONTEXT_MISSING',
        message: 'Project runtime context is missing repository/local_path for a code execution task.',
        stage: 'APPROVAL'
      };
      blockMissionForApproval(tx, missionRef, plan, input, blocker);
      tx.set(planRef, {
        status: 'BLOCKED',
        blocker_code: blocker.code,
        blocker_message: blocker.message,
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: false,
        blocked: true,
        error: blocker.code,
        blocker_code: blocker.code,
        blocker_message: blocker.message,
        mission_id: missionId,
        plan_revision_id: plan.id
      };
      return;
    }

    if (plan.requires_execution === false) {
      const resultRef = db.collection('results').doc();
      tx.set(resultRef, {
        id: resultRef.id,
        tenant_id: tenantId,
        mission_id: missionId,
        task_id: null,
        run_id: plan.brain_run_id || null,
        workspace_id: plan.workspace_id || mission.workspace_id || null,
        project_id: plan.project_id || mission.project_id || null,
        worker_id: plan.worker_id || mission.preferred_worker_id || null,
        brain_run_id: plan.brain_run_id || null,
        source_run_type: 'BRAIN_RUN',
        status: 'SUCCESS',
        result_type: 'BRAIN_RESULT',
        title: plan.objective || mission.objective || 'Approved Brain result',
        summary: planSummary(plan),
        content: planSummary(plan),
        text: planSummary(plan),
        output: { approved_plan: plan },
        created_at: timestamp()
      });

      tx.set(missionRef, {
        state: 'COMPLETED',
        approval_status: 'APPROVED',
        approved_plan_revision_id: plan.id,
        approved_at: timestamp(),
        approved_by: input.approved_by || 'operator',
        completed_at: timestamp(),
        result_id: resultRef.id,
        updated_at: timestamp()
      }, { merge: true });

      result = {
        success: true,
        mission_id: missionId,
        task_id: null,
        result_id: resultRef.id,
        plan_revision_id: plan.id,
        requires_execution: false
      };
      return;
    }

    const taskRef = db.collection('tasks').doc();
    const taskSpec = taskSpecFromPlan(plan, mission);
    try {
      tx.set(snapshotRef, executionSnapshot);
      tx.set(taskRef, {
        id: taskRef.id,
        tenant_id: tenantId,
        mission_id: missionId,
        workspace_id: plan.workspace_id || mission.workspace_id || null,
        project_id: plan.project_id || mission.project_id || null,
        worker_id: plan.worker_id || mission.preferred_worker_id,
        title: taskSpec.title,
        objective: taskSpec.objective,
        task_spec: taskSpec,
        priority: mission.priority || 'NORMAL',
        state: 'QUEUED',
        phase: 'EXECUTION_PENDING',
        attempt_count: 0,
        brain_run_id: plan.brain_run_id || null,
        approved_plan_revision_id: plan.id,
        approved_plan_revision_number: executionSnapshot.approved_plan_revision_number,
        execution_snapshot_id: snapshotRef.id,
        execution_snapshot: executionSnapshot,
        brain_output: {
          objective: taskSpec.objective,
          worker_id: plan.worker_id || mission.preferred_worker_id,
          requires_execution: true,
          execution_type: normalizeExecutionType(plan.execution_type, true).value,
          task_spec: taskSpec,
          execution_constraints: executionSnapshot.execution_constraints,
          brain_run_id: plan.brain_run_id || null,
          tenant_id: tenantId,
          workspace_id: plan.workspace_id || mission.workspace_id || null,
          project_id: plan.project_id || mission.project_id || null,
          mission_id: missionId
        },
        brain_completed_at: timestamp(),
        current_run_id: null,
        claimed_by_executor_id: null,
        created_at: timestamp(),
        updated_at: timestamp()
      });
    } catch (error) {
      error.approvalStage = 'TASK_CREATION';
      error.planRevisionId = plan.id;
      error.brainRunId = plan.brain_run_id || null;
      throw error;
    }

    tx.set(missionRef, {
      state: 'RUNNING',
      approval_status: 'APPROVED',
      approved_plan_revision_id: plan.id,
      approved_plan_revision_number: executionSnapshot.approved_plan_revision_number,
      approved_execution_snapshot_id: snapshotRef.id,
      approved_at: timestamp(),
      approved_by: input.approved_by || 'operator',
      updated_at: timestamp()
    }, { merge: true });

    result = {
      success: true,
      mission_id: missionId,
      task_id: taskRef.id,
      plan_revision_id: plan.id,
      execution_snapshot_id: snapshotRef.id,
      requires_execution: true
    };
  });
  } catch (error) {
    if (error.approvalStage === 'TASK_CREATION') {
      const missionSnap = await missionRef.get();
      const mission = missionSnap.exists && missionSnap.data().tenant_id === tenantId
        ? missionSnap.data()
        : {};
      await missionRef.set({
        state: 'BLOCKED',
        block_reason: 'TASK_CREATION_FAILED',
        blocked_reason: 'TASK_CREATION_FAILED',
        blocker_code: 'TASK_CREATION_FAILED',
        blocker_message: String(error.message || 'Task creation failed').slice(0, 2000),
        blocker_stage: 'TASK_CREATION',
        blocker_source_stage: 'TASK_CREATION',
        blocker_plan_revision_id: error.planRevisionId || mission.approved_plan_revision_id || mission.current_plan_revision_id || null,
        blocker_brain_run_id: error.brainRunId || mission.brain_run_id || null,
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: false,
        blocked: true,
        error: 'TASK_CREATION_FAILED',
        blocker_code: 'TASK_CREATION_FAILED',
        blocker_message: String(error.message || 'Task creation failed').slice(0, 2000),
        mission_id: missionId,
        plan_revision_id: error.planRevisionId || null,
        brain_run_id: error.brainRunId || null
      };
    } else {
      throw error;
    }
  }

  await emitEvent(db, tenantId, 'MISSION_PLAN_APPROVED', result, result.blocked ? 'WARNING' : 'OPERATIVE');
  return result;
}

async function startExecutionRun(db, tenantId, taskId, executorId) {
  const taskRef = db.collection('tasks').doc(taskId);
  const executorRef = db.collection('executors').doc(executorId);
  const runRef = db.collection('runs').doc();
  let result;

  await db.runTransaction(async (tx) => {
    const taskSnap = await tx.get(taskRef);
    const executorSnap = await tx.get(executorRef);

    if (!taskSnap.exists || taskSnap.data().tenant_id !== tenantId) {
      const error = new Error('TASK_NOT_FOUND'); error.status = 404; throw error;
    }
    if (!executorSnap.exists || executorSnap.data().tenant_id !== tenantId) {
      const error = new Error('EXECUTOR_NOT_FOUND'); error.status = 404; throw error;
    }

    const task = taskSnap.data();
    if (task.phase !== 'EXECUTION_PENDING') {
      const error = new Error('TASK_NOT_READY_FOR_EXECUTION'); error.status = 409; throw error;
    }
    const missionSnap = await tx.get(db.collection('missions').doc(task.mission_id));
    if (
      !missionSnap.exists ||
      missionSnap.data().tenant_id !== tenantId ||
      isMissionCancelled(missionSnap.data())
    ) {
      const error = new Error('MISSION_CANCELLED');
      error.status = 409;
      throw error;
    }

    tx.set(runRef, {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'EXECUTION_RUN',
      mission_id: task.mission_id,
      task_id: taskId,
      workspace_id: task.workspace_id || null,
      project_id: task.project_id || null,
      worker_id: task.worker_id,
      executor_id: executorId,
      host_name: executorSnap.data().host_name || null,
      brain_run_id: task.brain_run_id || null,
      parent_run_id: task.brain_run_id || null,
      state: 'RUNNING',
      attempt: task.attempt_count || 1,
      progress_percent: 0,
      progress_message: 'Codex Execution Run started',
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    });

    tx.update(taskRef, {
      phase: 'EXECUTION_RUNNING',
      execution_run_id: runRef.id,
      current_run_id: runRef.id,
      updated_at: timestamp()
    });

    tx.set(executorRef, { current_run_id: runRef.id, updated_at: timestamp() }, { merge: true });

    result = {
      task: { id: taskId, ...task, phase: 'EXECUTION_RUNNING', execution_run_id: runRef.id },
      run: { id: runRef.id, run_type: 'EXECUTION_RUN', state: 'RUNNING' }
    };
  });

  await emitEvent(db, tenantId, 'EXECUTION_RUN_STARTED', {
    task_id: taskId, execution_run_id: result.run.id, executor_id: executorId
  }, 'OPERATIVE');

  return result;
}

async function markTaskWaiting(db, tenantId, taskId, message, handoff = null) {
  const taskRef = db.collection('tasks').doc(taskId);
  const snap = await taskRef.get();
  if (!snap.exists || snap.data().tenant_id !== tenantId) {
    const error = new Error('TASK_NOT_FOUND'); error.status = 404; throw error;
  }

  const task = snap.data();
  await taskRef.set({
    state: 'WAITING',
    phase: 'WAITING_FOR_CODEX',
    waiting_reason: String(message || '').slice(0, 5000),
    handoff: handoff || null,
    updated_at: timestamp()
  }, { merge: true });

  if (task.worker_id) {
    await db.collection('workers').doc(task.worker_id).set({
      state: 'WAITING',
      updated_at: timestamp()
    }, { merge: true });
  }

  await emitEvent(db, tenantId, 'TASK_WAITING_FOR_CODEX', {
    task_id: taskId,
    reason: String(message || '').slice(0, 1000),
    handoff_type: handoff?.type || null
  }, 'WARNING');

  return {
    ok: true,
    task_id: taskId,
    state: 'WAITING',
    phase: 'WAITING_FOR_CODEX'
  };
}

async function completeRun(db, tenantId, runId, input) {
  const runRef = db.collection('runs').doc(runId);

  let result;

  await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
      const error = new Error('RUN_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const run = runSnap.data();
    if (run.state !== 'RUNNING') {
      const error = new Error('RUN_NOT_ACTIVE');
      error.status = 409;
      throw error;
    }

    if (run.run_type === 'BRAIN_RUN') {
      const success = input.success !== false;
      const missionRef = db.collection('missions').doc(run.mission_id);
      const missionSnap = await tx.get(missionRef);
      if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
        const error = new Error('MISSION_NOT_FOUND');
        error.status = 404;
        throw error;
      }

      if (isMissionCancelled(missionSnap.data())) {
        tx.update(runRef, {
          state: 'FAILED',
          progress_percent: Number(run.progress_percent || 0),
          progress_message: 'Run completion ignored because Mission is cancelled',
          error: 'MISSION_CANCELLED',
          completed_at: timestamp(),
          updated_at: timestamp()
        });

        result = {
          success: false,
          cancelled: true,
          mission_id: run.mission_id,
          brain_run_id: runId,
          error: 'MISSION_CANCELLED'
        };
        return;
      }

      if (!success) {
        tx.update(runRef, {
          state: 'FAILED',
          progress_percent: Number(run.progress_percent || 0),
          progress_message: String(input.summary || 'Brain Run failed').slice(0, 2000),
          error: String(input.error || 'Brain Run failed').slice(0, 5000),
          completed_at: timestamp(),
          updated_at: timestamp()
        });

        tx.set(missionRef, {
          state: 'FAILED',
          updated_at: timestamp()
        }, { merge: true });

        result = {
          success: false,
          mission_id: run.mission_id,
          brain_run_id: runId
        };
        return;
      }

      const taskRef = run.task_id
        ? db.collection('tasks').doc(run.task_id)
        : db.collection('tasks').doc();
      const resultRef = db.collection('results').doc();
      const executorRef = run.executor_id ? db.collection('executors').doc(run.executor_id) : null;
      const outputText = String(input.output_text || input.summary || '').slice(0, 100000);
    const brainOutput = buildBrainOutput({ id: runId, ...run }, { ...input, output_text: outputText });
    const taskSpec = brainOutput.task_spec || {};

      if (brainOutput.requires_execution === false) {
        if (!hasMeaningfulText(brainOutput.final_result_text)) {
          tx.update(runRef, {
            state: 'FAILED',
            progress_percent: Number(run.progress_percent || 0),
            progress_message: 'Brain-only result missing final user-facing answer',
            error: 'BRAIN_RESULT_MISSING',
            output_text: outputText,
            brain_output: brainOutput,
            completed_at: timestamp(),
            updated_at: timestamp()
          });

          tx.set(missionRef, {
            state: 'BLOCKED',
            block_reason: 'BRAIN_RESULT_MISSING',
            updated_at: timestamp()
          }, { merge: true });

          result = {
            success: false,
            mission_id: run.mission_id,
            task_id: null,
            brain_run_id: runId,
            requires_execution: false,
            error: 'BRAIN_RESULT_MISSING'
          };
          return;
        }

        const finalResultText = brainOutput.final_result_text;
        tx.update(runRef, {
          state: 'COMPLETED',
          progress_percent: 100,
          progress_message: brainResultSummary(input, finalResultText).slice(0, 2000),
          output_text: outputText,
          brain_output: brainOutput,
          completed_at: timestamp(),
          updated_at: timestamp()
        });

        tx.set(resultRef, {
          id: resultRef.id,
          tenant_id: tenantId,
          mission_id: run.mission_id,
          task_id: null,
          run_id: runId,
          workspace_id: run.workspace_id || null,
          project_id: run.project_id || null,
          worker_id: brainOutput.worker_id,
          executor_id: run.executor_id || null,
          brain_run_id: runId,
          run_type: 'BRAIN_RUN',
          source_run_type: 'BRAIN_RUN',
          status: 'SUCCESS',
          result_type: 'BRAIN_RESULT',
          title: brainResultTitle(run, taskSpec),
          summary: brainResultSummary(input, finalResultText),
          content: finalResultText,
          text: finalResultText,
          output: brainOutput,
          created_at: timestamp()
        });

        tx.set(missionRef, {
          state: 'COMPLETED',
          brain_run_id: runId,
          brain_output_result_id: resultRef.id,
          completed_at: timestamp(),
          updated_at: timestamp()
        }, { merge: true });

        if (executorRef) {
          tx.set(executorRef, {
            state: 'ONLINE',
            current_run_id: null,
            last_heartbeat_at: timestamp(),
            updated_at: timestamp()
          }, { merge: true });
        }

        result = {
          success: true,
          mission_id: run.mission_id,
          task_id: null,
          brain_run_id: runId,
          result_id: resultRef.id,
          requires_execution: false
        };
        return;
      }

      tx.update(runRef, {
        state: 'COMPLETED',
        progress_percent: 100,
        progress_message: String(input.summary || 'Brain plan completed').slice(0, 2000),
        output_text: outputText,
        brain_output: brainOutput,
        completed_at: timestamp(),
        updated_at: timestamp()
      });

      tx.set(taskRef, {
        id: taskRef.id,
        tenant_id: tenantId,
        mission_id: run.mission_id,
        workspace_id: run.workspace_id || null,
        project_id: run.project_id || null,
        worker_id: brainOutput.worker_id,
        title: taskSpec.title || brainOutput.objective,
        objective: taskSpec.objective || brainOutput.objective,
        priority: input.priority || 'NORMAL',
        state: 'QUEUED',
        phase: 'EXECUTION_PENDING',
        attempt_count: 0,
        brain_run_id: runId,
        brain_output: brainOutput,
        brain_completed_at: timestamp(),
        current_run_id: null,
        claimed_by_executor_id: null,
        created_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });

      tx.set(resultRef, {
        id: resultRef.id,
        tenant_id: tenantId,
        mission_id: run.mission_id,
        task_id: taskRef.id,
        run_id: runId,
        workspace_id: run.workspace_id || null,
        project_id: run.project_id || null,
        worker_id: brainOutput.worker_id,
        executor_id: run.executor_id || null,
        status: 'SUCCESS',
        result_type: 'BRAIN_OUTPUT',
        summary: String(input.summary || '').slice(0, 10000),
        output: brainOutput,
        created_at: timestamp()
      });

      tx.set(missionRef, {
        state: 'PLANNING',
        brain_run_id: runId,
        brain_output_result_id: resultRef.id,
        updated_at: timestamp()
      }, { merge: true });

      if (executorRef) {
        tx.set(executorRef, {
          state: 'ONLINE',
          current_run_id: null,
          last_heartbeat_at: timestamp(),
          updated_at: timestamp()
        }, { merge: true });
      }

      result = {
        success: true,
        mission_id: run.mission_id,
        task_id: taskRef.id,
        brain_run_id: runId,
        result_id: resultRef.id
      };
      return;
    }

    const success = input.success !== false;
    const taskState = success ? 'DONE' : 'FAILED';
    const missionState = success ? 'COMPLETED' : 'FAILED';

    const taskRef = db.collection('tasks').doc(run.task_id);
    const workerRef = db.collection('workers').doc(run.worker_id);
    const missionRef = db.collection('missions').doc(run.mission_id);
    const executorRef = db.collection('executors').doc(run.executor_id);
    const resultRef = db.collection('results').doc();
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }
    const missionCancelled = isMissionCancelled(missionSnap.data());

    tx.update(runRef, {
      state: missionCancelled ? 'FAILED' : (success ? 'COMPLETED' : 'FAILED'),
      progress_percent: success ? 100 : Number(run.progress_percent || 0),
      progress_message: String(missionCancelled ? 'Execution completion ignored because Mission is cancelled' : (input.summary || (success ? 'Completed' : 'Failed'))).slice(0, 2000),
      error: missionCancelled ? 'MISSION_CANCELLED' : (success ? null : String(input.error || 'Execution failed').slice(0, 5000)),
      completed_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      state: missionCancelled ? 'SKIPPED' : taskState,
      phase: missionCancelled ? 'CANCELLED' : (success ? 'COMPLETED' : 'FAILED'),
      current_run_id: runId,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(workerRef, {
      state: 'IDLE',
      current_mission_id: null,
      current_task_id: null,
      updated_at: timestamp()
    }, { merge: true });

    if (!missionCancelled) {
      tx.set(missionRef, {
        state: missionState,
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
    }

    tx.set(executorRef, {
      state: 'ONLINE',
      current_run_id: null,
      last_heartbeat_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(resultRef, {
      id: resultRef.id,
      tenant_id: tenantId,
      mission_id: run.mission_id,
      task_id: run.task_id,
      run_id: runId,
      workspace_id: run.workspace_id || null,
      project_id: run.project_id || null,
      brain_run_id: run.brain_run_id || run.parent_run_id || null,
      worker_id: run.worker_id,
      executor_id: run.executor_id,
      status: missionCancelled ? 'FAILED' : (success ? 'SUCCESS' : 'FAILED'),
      result_type: 'EXECUTION_OUTPUT',
      summary: String(missionCancelled ? 'Execution ignored because Mission is cancelled' : (input.summary || '')).slice(0, 10000),
      output: input.output || null,
      created_at: timestamp()
    });

    result = {
      success: missionCancelled ? false : success,
      cancelled: missionCancelled === true,
      mission_id: run.mission_id,
      task_id: run.task_id,
      run_id: runId,
      result_id: resultRef.id
    };
  });

  const verification = await queueVerificationBrainRun(db, tenantId, {
    ...result,
    summary: input.summary || '',
    output: input.output || null,
    error: input.error || null
  });
  if (verification) {
    result = { ...result, autopilot_verification: verification };
  }

  await emitEvent(db, tenantId, result.success ? 'RUN_COMPLETED' : 'RUN_FAILED', result,
    result.success ? 'OPERATIVE' : 'WARNING');

  return result;
}

async function completeManualCodexHandoff(db, tenantId, taskId, input) {
  const taskRef = db.collection('tasks').doc(taskId);
  let result;

  await db.runTransaction(async (tx) => {
    const taskSnap = await tx.get(taskRef);
    if (!taskSnap.exists || taskSnap.data().tenant_id !== tenantId) {
      const error = new Error('TASK_NOT_FOUND'); error.status = 404; throw error;
    }

    const task = taskSnap.data();
    if (task.phase !== 'WAITING_FOR_CODEX') {
      const error = new Error('TASK_NOT_WAITING_FOR_CODEX'); error.status = 409; throw error;
    }

    const success = input.success !== false;
    const executionRunRef = db.collection('runs').doc();
    const resultRef = db.collection('results').doc();
    const missionRef = db.collection('missions').doc(task.mission_id);
    const workerRef = db.collection('workers').doc(task.worker_id);
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
    }
    const missionCancelled = isMissionCancelled(missionSnap.data());

    tx.set(executionRunRef, {
      id: executionRunRef.id,
      tenant_id: tenantId,
      run_type: 'EXECUTION_RUN',
      mission_id: task.mission_id,
      task_id: taskId,
      workspace_id: task.workspace_id || null,
      project_id: task.project_id || null,
      worker_id: task.worker_id,
      executor_id: task.claimed_by_executor_id || null,
      host_name: 'Shadow',
      executor_mode: 'CODEX_APP_MANUAL',
      brain_run_id: task.brain_run_id || null,
      parent_run_id: task.brain_run_id || null,
      state: missionCancelled ? 'FAILED' : (success ? 'COMPLETED' : 'FAILED'),
      progress_percent: success ? 100 : 0,
      progress_message: String(missionCancelled ? 'Manual completion ignored because Mission is cancelled' : (input.summary || '')).slice(0, 2000),
      error: missionCancelled ? 'MISSION_CANCELLED' : (success ? null : String(input.error || 'Manual Codex execution failed').slice(0, 5000)),
      started_at: timestamp(),
      completed_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      state: missionCancelled ? 'SKIPPED' : (success ? 'DONE' : 'FAILED'),
      phase: missionCancelled ? 'CANCELLED' : (success ? 'COMPLETED' : 'FAILED'),
      execution_run_id: executionRunRef.id,
      current_run_id: executionRunRef.id,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(workerRef, {
      state: 'IDLE',
      current_mission_id: null,
      current_task_id: null,
      updated_at: timestamp()
    }, { merge: true });

    if (!missionCancelled) {
      tx.set(missionRef, {
        state: success ? 'COMPLETED' : 'FAILED',
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
    }

    tx.set(resultRef, {
      id: resultRef.id,
      tenant_id: tenantId,
      mission_id: task.mission_id,
      task_id: taskId,
      run_id: executionRunRef.id,
      workspace_id: task.workspace_id || null,
      project_id: task.project_id || null,
      brain_run_id: task.brain_run_id || null,
      worker_id: task.worker_id,
      executor_id: task.claimed_by_executor_id || null,
      status: missionCancelled ? 'FAILED' : (success ? 'SUCCESS' : 'FAILED'),
      summary: String(missionCancelled ? 'Manual completion ignored because Mission is cancelled' : (input.summary || '')).slice(0, 10000),
      output: input.output || null,
      created_at: timestamp()
    });

    result = {
      success: missionCancelled ? false : success,
      cancelled: missionCancelled === true,
      mission_id: task.mission_id,
      task_id: taskId,
      execution_run_id: executionRunRef.id,
      result_id: resultRef.id
    };
  });

  await emitEvent(
    db,
    tenantId,
    result.success ? 'MANUAL_CODEX_COMPLETED' : 'MANUAL_CODEX_FAILED',
    result,
    result.success ? 'OPERATIVE' : 'WARNING'
  );

  return result;
}

async function recoverAbandonedBrainRuns(db, tenantId, executorId, staleMs = 120000) {
  const now = Date.now();
  // Keep recovery index-free: use the existing tenant isolation query,
  // then filter run_type/executor/state in application code. This avoids
  // requiring a new Firestore composite index just for Runner recovery.
  const runsSnap = await db.collection('runs')
    .where('tenant_id', '==', tenantId)
    .get();

  const recovered = [];

  for (const doc of runsSnap.docs) {
    const run = doc.data();
    if (run.run_type !== 'BRAIN_RUN') continue;
    if (run.executor_id !== executorId) continue;
    if (!['RUNNING', 'CLAIMED'].includes(run.state)) continue;

    const updated = run.updated_at?.toDate ? run.updated_at.toDate().getTime() : 0;
    if (updated && now - updated < staleMs) continue;

    const taskRef = db.collection('tasks').doc(run.task_id);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) continue;
    const task = taskSnap.data();
    if (task.tenant_id !== tenantId) continue;
    if (task.current_run_id && task.current_run_id !== doc.id) continue;

    await db.runTransaction(async (tx) => {
      tx.set(doc.ref, {
        state: 'FAILED',
        error: 'RUNNER_RESTARTED_OR_ABANDONED',
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });

      tx.set(taskRef, {
        state: 'QUEUED',
        phase: 'BRAIN_QUEUED',
        current_run_id: null,
        claimed_by_executor_id: null,
        waiting_reason: null,
        updated_at: timestamp()
      }, { merge: true });

      if (task.worker_id) {
        tx.set(db.collection('workers').doc(task.worker_id), {
          state: 'IDLE',
          current_task_id: null,
          current_mission_id: null,
          updated_at: timestamp()
        }, { merge: true });
      }
    });

    await emitEvent(db, tenantId, 'BRAIN_RUN_RECOVERED', {
      abandoned_run_id: doc.id,
      task_id: run.task_id,
      executor_id: executorId
    }, 'WARNING');

    recovered.push({ run_id: doc.id, task_id: run.task_id });
  }

  return { recovered };
}

module.exports = {
  emitEvent,
  sanitizeEventPayload,
  dispatchMission,
  getMissionPlan,
  requestMissionPlanChanges,
  approveMissionPlan,
  retryMission,
  cancelMission,
  registerExecutor,
  heartbeatExecutor,
  claimNextTask,
  updateRunProgress,
  completeBrainRun,
  startExecutionRun,
  markTaskWaiting,
  addEvidence,
  completeRun,
  completeManualCodexHandoff,
  recoverAbandonedBrainRuns,
  parseBrainResponse
};
