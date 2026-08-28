function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

function clean(value, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function sortLatest(items) {
  return [...items].sort((a, b) =>
    toMillis(b.updated_at || b.completed_at || b.created_at) -
    toMillis(a.updated_at || a.completed_at || a.created_at)
  );
}

function defaultCorrectionInstruction(failureCode) {
  const code = clean(failureCode, 300).toUpperCase();

  if (code === 'BRAIN_RESULT_MISSING') {
    return [
      'The previous Brain attempt failed with BRAIN_RESULT_MISSING.',
      'Correct the prior response instead of repeating it.',
      'Return a complete final Brain result in the canonical MRAPI format required by this Mission.',
      'Do not stop at analysis, planning notes, or an incomplete response.',
      'If this milestone is Brain-only, do not create Executor work; produce the final Brain-only result and satisfy the milestone success criteria.'
    ].join(' ');
  }

  return [
    `The previous Brain attempt failed${code ? ` with ${code}` : ''}.`,
    'Review the previous failure and produce a corrected result.',
    'Do not repeat the same malformed or incomplete response.',
    'Preserve the existing Mission, Roadmap, Milestone, permissions, and trusted scope.'
  ].join(' ');
}

function buildCorrectiveRecoveryContext({
  mission,
  latestBrain,
  failureCode,
  manualInstruction
}) {
  const automaticInstruction = defaultCorrectionInstruction(failureCode);
  const operatorInstruction = clean(manualInstruction, 6000) || null;
  const priorOutput = clean(
    latestBrain?.output_text ||
    latestBrain?.output ||
    latestBrain?.summary ||
    latestBrain?.progress_message ||
    '',
    16000
  ) || null;
  const priorError = clean(latestBrain?.error || mission?.blocker_message || '', 6000) || null;

  const recovery = {
    contract: 'MRAPI_CORRECTIVE_RECOVERY_V1',
    failure_code: clean(failureCode, 300) || null,
    previous_brain_run_id: latestBrain?.id || null,
    previous_attempt: Number(latestBrain?.attempt || mission?.retry_count || 0),
    previous_error: priorError,
    previous_output_excerpt: priorOutput,
    automatic_instruction: automaticInstruction,
    operator_instruction: operatorInstruction,
    requirements: [
      'Correct the previous failure; do not blindly repeat the previous answer.',
      'Preserve trusted scope, Mission, Roadmap and Milestone identity.',
      'Do not expand permissions or execution scope.',
      'Produce the canonical result expected by the current Brain phase.'
    ]
  };

  const base = mission?.brain_context && typeof mission.brain_context === 'object'
    ? mission.brain_context
    : {};

  const existingInstructions = Array.isArray(base.instructions)
    ? base.instructions.map((item) => clean(item, 4000)).filter(Boolean)
    : [];

  return {
    ...base,
    recovery,
    instructions: [
      ...existingInstructions,
      automaticInstruction,
      ...(operatorInstruction ? [`OPERATOR RECOVERY INSTRUCTION: ${operatorInstruction}`] : [])
    ].slice(-30)
  };
}

function correctiveObjective(originalObjective, recoveryContext) {
  const recovery = recoveryContext?.recovery || {};
  return [
    clean(originalObjective, 50000),
    '',
    'RECOVERY CORRECTION',
    recovery.automatic_instruction || '',
    recovery.operator_instruction
      ? `OPERATOR INSTRUCTION: ${recovery.operator_instruction}`
      : ''
  ].filter(Boolean).join('\n');
}

async function loadContext(db, tenantId, missionId) {
  const missionRef = db.collection('missions').doc(missionId);
  const missionSnap = await missionRef.get();
  if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
    const error = new Error('MISSION_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const mission = { id: missionSnap.id, ...missionSnap.data() };
  const [runsSnap, roadmapSnap] = await Promise.all([
    db.collection('runs').where('tenant_id', '==', tenantId).limit(300).get(),
    mission.roadmap_id
      ? db.collection('roadmaps').doc(mission.roadmap_id).get()
      : Promise.resolve(null)
  ]);

  const runs = sortLatest(
    runsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((run) => run.mission_id === missionId)
  );

  const roadmap = roadmapSnap?.exists && roadmapSnap.data().tenant_id === tenantId
    ? { id: roadmapSnap.id, ...roadmapSnap.data() }
    : null;
  const milestone = roadmap
    ? (roadmap.milestones || []).find((item) => item.id === mission.milestone_id) || null
    : null;

  return { mission, runs, roadmap, milestone };
}

async function correctiveBrainRecovery(db, tenantId, missionId, input = {}) {
  const initial = await loadContext(db, tenantId, missionId);
  const failureCode = clean(
    input.failure_code ||
    initial.mission.blocker_code ||
    initial.mission.failure_code ||
    'BRAIN_RECOVERY',
    300
  );
  const manualInstruction = clean(input.recovery_instruction, 6000);

  const missionRef = db.collection('missions').doc(missionId);
  const roadmapRef = initial.roadmap
    ? db.collection('roadmaps').doc(initial.roadmap.id)
    : null;
  const newRunRef = db.collection('runs').doc();
  let result = null;

  await db.runTransaction(async (tx) => {
    // ALL READS FIRST.
    const freshMissionSnap = await tx.get(missionRef);
    if (!freshMissionSnap.exists || freshMissionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const runsSnap = await tx.get(
      db.collection('runs').where('tenant_id', '==', tenantId).limit(300)
    );

    let freshRoadmap = null;
    if (roadmapRef && initial.milestone) {
      const roadmapSnap = await tx.get(roadmapRef);
      if (roadmapSnap.exists && roadmapSnap.data().tenant_id === tenantId) {
        freshRoadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
      }
    }

    const freshMission = { id: freshMissionSnap.id, ...freshMissionSnap.data() };
    const missionRuns = sortLatest(
      runsSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((run) => run.mission_id === missionId)
    );

    const activeBrain = missionRuns.find((run) =>
      run.run_type === 'BRAIN_RUN' && run.state === 'RUNNING'
    );
    if (activeBrain) {
      result = {
        success: true,
        mode: 'BRAIN_CORRECTIVE_REPLAY',
        reused: true,
        mission_id: missionId,
        brain_run_id: activeBrain.id
      };
      return;
    }

    const latestBrain = missionRuns.find((run) => run.run_type === 'BRAIN_RUN') || null;
    const attempt = Math.max(
      Number(freshMission.retry_count || 0),
      ...missionRuns
        .filter((run) => run.run_type === 'BRAIN_RUN')
        .map((run) => Number(run.attempt || 1)),
      1
    ) + 1;

    const recoveryContext = buildCorrectiveRecoveryContext({
      mission: freshMission,
      latestBrain,
      failureCode,
      manualInstruction
    });

    const phase = clean(
      latestBrain?.autopilot_phase ||
      freshMission.autopilot_phase ||
      'PROGRAM',
      120
    ).toUpperCase();

    const brainRun = {
      id: newRunRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: missionId,
      task_id: null,
      workspace_id: freshMission.workspace_id || null,
      project_id: freshMission.project_id || null,
      worker_id: freshMission.preferred_worker_id || latestBrain?.worker_id || 'W01',
      executor_id: null,
      parent_run_id: latestBrain?.id || null,
      retry_of_run_id: latestBrain?.id || null,
      objective: correctiveObjective(freshMission.objective, recoveryContext),
      brain_context: recoveryContext,
      autopilot_mode: freshMission.autopilot_mode === true,
      autopilot_phase: phase,
      roadmap_id: freshMission.roadmap_id || null,
      milestone_id: freshMission.milestone_id || null,
      state: 'RUNNING',
      attempt,
      progress_percent: 0,
      progress_message: 'Mission recovery: corrective Brain replay started',
      recovery_replay: true,
      corrective_recovery: true,
      recovery_failure_code: failureCode || null,
      recovery_instruction: manualInstruction || null,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    // WRITES ONLY AFTER ALL READS.
    tx.set(newRunRef, brainRun);
    tx.set(missionRef, {
      state: 'PLANNING',
      brain_run_id: newRunRef.id,
      recovery_active_run_id: newRunRef.id,
      current_retry_run_id: newRunRef.id,
      retry_of_run_id: latestBrain?.id || null,
      retry_count: Number(freshMission.retry_count || 0) + 1,
      last_recovery_mode: 'BRAIN_CORRECTIVE_REPLAY',
      last_recovery_failure_code: failureCode || null,
      last_recovery_instruction: manualInstruction || null,
      blocked_reason: null,
      block_reason: null,
      blocker_code: null,
      blocker_message: null,
      failure_code: null,
      completed_at: null,
      updated_at: timestamp()
    }, { merge: true });

    if (freshRoadmap && initial.milestone) {
      tx.set(roadmapRef, {
        state: freshRoadmap.state === 'BLOCKED' ? 'ACTIVE' : freshRoadmap.state,
        milestones: (freshRoadmap.milestones || []).map((item) =>
          item.id === initial.milestone.id
            ? {
                ...item,
                state: 'PLANNING',
                mission_id: missionId,
                brain_run_id: newRunRef.id,
                blocked_reason: null,
                blocker_code: null,
                recovery_attempt: attempt,
                updated_at: new Date()
              }
            : item
        ),
        updated_at: timestamp()
      }, { merge: true });
    }

    result = {
      success: true,
      mode: 'BRAIN_CORRECTIVE_REPLAY',
      reused: false,
      mission_id: missionId,
      brain_run_id: newRunRef.id,
      retry_of_run_id: latestBrain?.id || null,
      attempt,
      failure_code: failureCode || null,
      operator_instruction_applied: Boolean(manualInstruction)
    };
  });

  return result;
}

module.exports = {
  defaultCorrectionInstruction,
  buildCorrectiveRecoveryContext,
  correctiveObjective,
  correctiveBrainRecovery
};
