let FieldValue;
try {
  ({ FieldValue } = require('@google-cloud/firestore'));
} catch {
  FieldValue = { serverTimestamp: () => new Date() };
}
const { RUN_TYPES } = require('../constants/runTypes');
const { EVIDENCE_TYPES } = require('../constants/evidenceTypes');
const { buildCodexHandoff } = require('./codexHandoff');

function getEvidenceBucket() {
  return require('./storage').getEvidenceBucket();
}

function timestamp() {
  return FieldValue.serverTimestamp();
}

function isMissionCancelled(mission) {
  return mission?.state === 'CANCELLED' || mission?.cancellation_requested === true;
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

async function claimNextTask(db, tenantId, executorId, options = {}) {
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

        if (!taskSnap.exists || taskSnap.data().state !== 'QUEUED') {
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
          error.status = 409;
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
          brain_run_id: candidate.brain_run_id,
          parent_run_id: candidate.brain_run_id,
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
            codex_handoff: codexHandoff
          },
          run: {
            id: runRef.id,
            run_type: 'EXECUTION_RUN',
            state: 'RUNNING',
            attempt,
            brain_run_id: candidate.brain_run_id,
            parent_run_id: candidate.brain_run_id
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
      if (error.retryCandidate) continue;
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

function extractTaggedBlock(text, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = String(text || '').match(pattern);
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
  const raw = String(rawResponse || input.output_text || input.summary || '');
  const taggedControl = extractTaggedBlock(raw, 'MRAPI_CONTROL');
  const taggedResult = extractTaggedBlock(raw, 'MRAPI_RESULT');
  const parsedTagged = taggedControl ? findFirstJsonObject(taggedControl) : null;
  const parsedRaw = parsedTagged || findFirstJsonObject(raw);
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

  const taskSpec = input.task_spec && typeof input.task_spec === 'object'
    ? { ...input.task_spec }
    : decision.task_spec && typeof decision.task_spec === 'object'
      ? { ...decision.task_spec }
      : {};

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
    raw_response: raw
  };
}

function brainResultSummary(input, finalResultText) {
  return String(input.summary || finalResultText || 'Brain-only result completed').trim().slice(0, 10000);
}

function brainResultTitle(run, taskSpec) {
  return String(taskSpec?.title || run.objective || 'Brain result').slice(0, 250);
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
      summary: String(input.summary || 'Brain output persisted').slice(0, 10000),
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
      cancelled: missionCancelled || undefined,
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
      cancelled: missionCancelled || undefined,
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
