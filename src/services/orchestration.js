const { FieldValue } = require('@google-cloud/firestore');
const { RUN_TYPES } = require('../constants/runTypes');
const { EVIDENCE_TYPES } = require('../constants/evidenceTypes');
const { getEvidenceBucket } = require('./storage');

function timestamp() {
  return FieldValue.serverTimestamp();
}

async function emitEvent(db, tenantId, type, payload = {}, severity = 'INFO') {
  const ref = db.collection('events').doc();
  await ref.set({
    id: ref.id,
    tenant_id: tenantId,
    type,
    severity,
    payload,
    created_at: timestamp()
  });
  return ref.id;
}

async function dispatchMission(db, tenantId, missionId) {
  const missionRef = db.collection('missions').doc(missionId);
  const taskRef = db.collection('tasks').doc();

  let result;

  await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const mission = missionSnap.data();

    if (!['READY', 'PLANNING'].includes(mission.state)) {
      const error = new Error('MISSION_NOT_DISPATCHABLE');
      error.status = 409;
      throw error;
    }

    const existingTaskQuery = db.collection('tasks')
      .where('tenant_id', '==', tenantId)
      .where('mission_id', '==', missionId)
      .limit(1);

    const existing = await tx.get(existingTaskQuery);
    if (!existing.empty) {
      const doc = existing.docs[0];
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

    const task = {
      id: taskRef.id,
      tenant_id: tenantId,
      mission_id: missionId,
      workspace_id: mission.workspace_id,
      project_id: mission.project_id,
      worker_id: workerId,
      title: mission.objective,
      objective: mission.objective,
      priority: mission.priority || 'NORMAL',
      state: 'QUEUED',
      attempt_count: 0,
      current_run_id: null,
      claimed_by_executor_id: null,
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(taskRef, task);
    tx.update(missionRef, {
      state: 'PLANNING',
      dispatched_at: timestamp(),
      updated_at: timestamp()
    });

    result = task;
  });

  await emitEvent(db, tenantId, 'MISSION_DISPATCHED', {
    mission_id: missionId,
    task_id: result.id,
    worker_id: result.worker_id
  }, 'OPERATIVE');

  return result;
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

async function claimNextTask(db, tenantId, executorId) {
  const executorRef = db.collection('executors').doc(executorId);
  const executorSnap = await executorRef.get();

  if (!executorSnap.exists || executorSnap.data().tenant_id !== tenantId) {
    const error = new Error('EXECUTOR_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const executor = executorSnap.data();
  const allowedWorkerIds = executor.worker_ids || [];
  const queued = await db.collection('tasks')
    .where('tenant_id', '==', tenantId)
    .where('state', '==', 'QUEUED')
    .limit(100)
    .get();

  const priorities = { CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
  const candidates = queued.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
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
    const runRef = db.collection('runs').doc();

    try {
      let claimed = null;

      await db.runTransaction(async (tx) => {
        const [taskSnap, workerSnap, missionSnap] = await Promise.all([
          tx.get(taskRef),
          tx.get(workerRef),
          tx.get(missionRef)
        ]);

        if (!taskSnap.exists || taskSnap.data().state !== 'QUEUED') {
          const error = new Error('TASK_ALREADY_CLAIMED');
          error.retryCandidate = true;
          throw error;
        }

        if (!workerSnap.exists || workerSnap.data().tenant_id !== tenantId) {
          const error = new Error('WORKER_NOT_FOUND');
          error.retryCandidate = true;
          throw error;
        }

        if (!['IDLE', 'WAITING'].includes(workerSnap.data().state)) {
          const error = new Error('WORKER_NOT_AVAILABLE');
          error.retryCandidate = true;
          throw error;
        }

        const attempt = Number(taskSnap.data().attempt_count || 0) + 1;

        tx.update(taskRef, {
          state: 'RUNNING',
          phase: 'BRAIN_RUNNING',
          attempt_count: attempt,
          current_run_id: runRef.id,
          brain_run_id: runRef.id,
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
          run_type: 'BRAIN_RUN',
          mission_id: candidate.mission_id,
          task_id: candidate.id,
          worker_id: candidate.worker_id,
          executor_id: executorId,
          host_name: executor.host_name || null,
          state: 'RUNNING',
          attempt,
          progress_percent: 0,
          progress_message: 'Task claimed; ChatGPT Web Brain Run started',
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
          task: { ...candidate, state: 'RUNNING', current_run_id: runRef.id, attempt_count: attempt },
          run: { id: runRef.id, run_type: 'BRAIN_RUN', state: 'RUNNING', attempt }
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
      if (error.retryCandidate) continue;
      throw error;
    }
  }

  return null;
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

    const taskRef = db.collection('tasks').doc(run.task_id);
    const executorRef = db.collection('executors').doc(run.executor_id);
    const outputText = String(input.output_text || '').slice(0, 100000);

    tx.update(runRef, {
      state: 'COMPLETED',
      progress_percent: 100,
      progress_message: 'Brain plan completed',
      output_text: outputText,
      brain_chat_url: input.brain_chat_url || null,
      completed_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      phase: 'EXECUTION_PENDING',
      brain_output: outputText,
      current_run_id: null,
      updated_at: timestamp()
    }, { merge: true });

    tx.set(executorRef, {
      current_run_id: null,
      updated_at: timestamp()
    }, { merge: true });

    result = { task_id: run.task_id, brain_run_id: runId };
  });

  await emitEvent(db, tenantId, 'BRAIN_RUN_COMPLETED', result, 'OPERATIVE');
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

    tx.set(runRef, {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'EXECUTION_RUN',
      mission_id: task.mission_id,
      task_id: taskId,
      worker_id: task.worker_id,
      executor_id: executorId,
      host_name: executorSnap.data().host_name || null,
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

    const success = input.success !== false;
    const taskState = success ? 'DONE' : 'FAILED';
    const missionState = success ? 'COMPLETED' : 'FAILED';

    const taskRef = db.collection('tasks').doc(run.task_id);
    const workerRef = db.collection('workers').doc(run.worker_id);
    const missionRef = db.collection('missions').doc(run.mission_id);
    const executorRef = db.collection('executors').doc(run.executor_id);
    const resultRef = db.collection('results').doc();

    tx.update(runRef, {
      state: success ? 'COMPLETED' : 'FAILED',
      progress_percent: success ? 100 : Number(run.progress_percent || 0),
      progress_message: String(input.summary || (success ? 'Completed' : 'Failed')).slice(0, 2000),
      error: success ? null : String(input.error || 'Execution failed').slice(0, 5000),
      completed_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      state: taskState,
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

    tx.set(missionRef, {
      state: missionState,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

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
      worker_id: run.worker_id,
      executor_id: run.executor_id,
      status: success ? 'SUCCESS' : 'FAILED',
      summary: String(input.summary || '').slice(0, 10000),
      output: input.output || null,
      created_at: timestamp()
    });

    result = {
      success,
      mission_id: run.mission_id,
      task_id: run.task_id,
      run_id: runId,
      result_id: resultRef.id
    };
  });

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

    tx.set(executionRunRef, {
      id: executionRunRef.id,
      tenant_id: tenantId,
      run_type: 'EXECUTION_RUN',
      mission_id: task.mission_id,
      task_id: taskId,
      worker_id: task.worker_id,
      executor_id: task.claimed_by_executor_id || null,
      host_name: 'Shadow',
      executor_mode: 'CODEX_APP_MANUAL',
      state: success ? 'COMPLETED' : 'FAILED',
      progress_percent: success ? 100 : 0,
      progress_message: String(input.summary || '').slice(0, 2000),
      error: success ? null : String(input.error || 'Manual Codex execution failed').slice(0, 5000),
      started_at: timestamp(),
      completed_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    });

    tx.set(taskRef, {
      state: success ? 'DONE' : 'FAILED',
      phase: success ? 'COMPLETED' : 'FAILED',
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

    tx.set(missionRef, {
      state: success ? 'COMPLETED' : 'FAILED',
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(resultRef, {
      id: resultRef.id,
      tenant_id: tenantId,
      mission_id: task.mission_id,
      task_id: taskId,
      run_id: executionRunRef.id,
      worker_id: task.worker_id,
      executor_id: task.claimed_by_executor_id || null,
      status: success ? 'SUCCESS' : 'FAILED',
      summary: String(input.summary || '').slice(0, 10000),
      output: input.output || null,
      created_at: timestamp()
    });

    result = {
      success,
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
  dispatchMission,
  registerExecutor,
  heartbeatExecutor,
  claimNextTask,
  updateRunProgress,
  completeBrainRun,
  startExecutionRun,
  markTaskWaiting,
  addEvidence,
  completeRun
};
