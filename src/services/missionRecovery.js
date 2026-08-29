const { resumeAutopilotProgramAfterHumanAction, retryMission } = require('./orchestration');
const { listMilestoneResponses } = require('./milestoneResponse');
const { latestDownstreamImpactProposal } = require('./downstreamImpact');

function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function checkpointStatus(checkpoint) {
  return clean(checkpoint?.status || checkpoint?.waiting_status, 100).toUpperCase();
}

function recoveryConflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function recoveryState(value) {
  return clean(value, 120).toUpperCase();
}

function activeWorkState(value) {
  return ['QUEUED', 'ASSIGNED', 'WAITING', 'RUNNING', 'TESTING', 'PENDING'].includes(recoveryState(value));
}

function terminalWorkState(value) {
  return ['COMPLETED', 'DONE', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(recoveryState(value));
}

function validateRecoveryProvenance({ tenantId, mission, roadmap, milestone }) {
  if (!mission || mission.tenant_id !== tenantId) {
    throw recoveryConflict('RECOVERY_MISSION_TENANT_MISMATCH');
  }
  if (!mission.roadmap_id || !mission.milestone_id) {
    throw recoveryConflict('RECOVERY_MISSION_ROADMAP_PROVENANCE_REQUIRED');
  }
  if (!roadmap) {
    throw recoveryConflict('RECOVERY_ROADMAP_NOT_FOUND');
  }
  if (roadmap.tenant_id !== tenantId) {
    throw recoveryConflict('RECOVERY_ROADMAP_TENANT_MISMATCH');
  }
  if (mission.roadmap_id !== roadmap.id) {
    throw recoveryConflict('RECOVERY_MISSION_ROADMAP_MISMATCH');
  }
  if (!milestone) {
    throw recoveryConflict('RECOVERY_MILESTONE_NOT_FOUND');
  }
  if (mission.milestone_id !== milestone.id) {
    throw recoveryConflict('RECOVERY_MISSION_MILESTONE_MISMATCH');
  }
  if (milestone.mission_id && milestone.mission_id !== mission.id) {
    throw recoveryConflict('RECOVERY_MILESTONE_MISSION_MISMATCH');
  }
}

function missionCheckpoint(mission, roadmap, milestone) {
  return mission?.human_action_checkpoint ||
    milestone?.human_action_checkpoint ||
    milestone?.human_action ||
    null;
}

function recoveryLabel(mode) {
  return {
    BRAIN_REPLAY: 'Replay Brain',
    EXECUTION_RETRY: 'Retry Execution',
    HUMAN_ACTION_RESUME: 'Resume Mission',
    NO_ACTION: 'No recovery needed'
  }[mode] || 'Recover Mission';
}

function sortLatest(items) {
  return [...items].sort((a, b) => {
    const bt = toMillis(b.updated_at || b.completed_at || b.started_at || b.created_at);
    const at = toMillis(a.updated_at || a.completed_at || a.started_at || a.created_at);
    return bt - at;
  });
}

async function loadRecoveryContext(db, tenantId, missionId) {
  const missionRef = db.collection('missions').doc(missionId);
  const missionSnap = await missionRef.get();
  if (!missionSnap.exists) {
    const error = new Error('MISSION_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const mission = { id: missionSnap.id, ...missionSnap.data() };
  if (mission.tenant_id !== tenantId) {
    throw recoveryConflict('RECOVERY_MISSION_TENANT_MISMATCH');
  }

  const [runsSnap, tasksSnap, roadmapSnap] = await Promise.all([
    db.collection('runs').where('tenant_id', '==', tenantId).limit(300).get(),
    db.collection('tasks').where('tenant_id', '==', tenantId).limit(300).get(),
    mission.roadmap_id ? db.collection('roadmaps').doc(mission.roadmap_id).get() : Promise.resolve(null)
  ]);

  const runs = sortLatest(
    runsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((run) => run.mission_id === missionId)
  );
  const tasks = sortLatest(
    tasksSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((task) => task.mission_id === missionId)
  );

  const roadmap = roadmapSnap?.exists && roadmapSnap.data().tenant_id === tenantId
    ? { id: roadmapSnap.id, ...roadmapSnap.data() }
    : null;
  const milestone = roadmap
    ? (roadmap.milestones || []).find((item) => item.id === mission.milestone_id) || null
    : null;

  if (mission.autopilot_mode === true || mission.roadmap_id || mission.milestone_id) {
    validateRecoveryProvenance({ tenantId, mission, roadmap, milestone });
  }

  return { mission, runs, tasks, roadmap, milestone };
}

function classifyRecoveryContext(context) {
  const { mission, runs, tasks, roadmap, milestone } = context;
  const state = clean(mission.state, 100).toUpperCase();
  const activeReplayRun = runs.find((run) => (
    run.run_type === 'BRAIN_RUN' &&
    run.recovery_replay === true &&
    run.mission_id === mission.id &&
    activeWorkState(run.state)
  )) || null;
  if (activeReplayRun) {
    return {
      recoverable: true,
      mode: 'BRAIN_REPLAY',
      action_label: recoveryLabel('BRAIN_REPLAY'),
      reason: 'BRAIN_REPLAY_ALREADY_ACTIVE',
      active_run_id: activeReplayRun.id,
      reused_active: true,
      latest_run_id: activeReplayRun.retry_of_run_id || activeReplayRun.parent_run_id || null
    };
  }

  const activeRetryTask = tasks.find((task) => (
    task.mission_id === mission.id &&
    (task.autopilot_phase === 'RETRY' || task.id === mission.current_retry_task_id || task.id === mission.current_task_id) &&
    activeWorkState(task.state) &&
    (
      mission.approved_execution_snapshot_id
        ? task.execution_snapshot_id === mission.approved_execution_snapshot_id
        : task.autopilot_phase === 'RETRY'
    )
  )) || null;
  if (activeRetryTask && ['RUNNING', 'BLOCKED', 'FAILED', 'RETRYABLE'].includes(state)) {
    return {
      recoverable: true,
      mode: 'EXECUTION_RETRY',
      action_label: recoveryLabel('EXECUTION_RETRY'),
      reason: 'EXECUTION_RETRY_ALREADY_ACTIVE',
      active_task_id: activeRetryTask.id,
      reused_active: true,
      latest_run_id: activeRetryTask.current_run_id || activeRetryTask.execution_run_id || null
    };
  }

  const latestRun = runs[0] || null;
  const latestBrainRun = runs.find((run) => run.run_type === 'BRAIN_RUN') || null;
  const latestExecutionRun = runs.find((run) => run.run_type === 'EXECUTION_RUN') || null;
  const activeRun = runs.find((run) => activeWorkState(run.state)) || null;
  const checkpoint = missionCheckpoint(mission, roadmap, milestone);
  const checkpointState = checkpointStatus(checkpoint);

  const activeResumeTask = checkpoint?.checkpoint_id
    ? tasks.find((task) => (
        task.mission_id === mission.id &&
        task.human_action_checkpoint_id === checkpoint.checkpoint_id &&
        activeWorkState(task.state)
      )) || null
    : null;
  if (activeResumeTask) {
    return {
      recoverable: true,
      mode: 'HUMAN_ACTION_RESUME',
      action_label: recoveryLabel('HUMAN_ACTION_RESUME'),
      reason: 'HUMAN_ACTION_RESUME_ALREADY_ACTIVE',
      checkpoint_id: checkpoint.checkpoint_id || null,
      active_task_id: activeResumeTask.id,
      reused_active: true,
      failure_stage: 'HUMAN_ACTION'
    };
  }

  if (activeRun && !['BLOCKED', 'FAILED'].includes(state)) {
    return {
      recoverable: false,
      mode: 'NO_ACTION',
      action_label: recoveryLabel('NO_ACTION'),
      reason: 'MISSION_HAS_ACTIVE_RUN',
      active_run_id: activeRun.id,
      active_run_type: activeRun.run_type
    };
  }

  const resumePhase = clean(
    checkpoint?.paused_from_phase ||
    checkpoint?.resume_phase ||
    mission.paused_from_phase ||
    '',
    120
  ).toUpperCase() || 'PROGRAM';

  if (mission.autopilot_mode === true && checkpoint && !['COMPLETED', 'CANCELLED'].includes(state)) {
    if (['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION'].includes(checkpointState) || ['NEED_HUMAN_ACTION', 'WAITING_FOR_HUMAN'].includes(state)) {
      return {
        recoverable: true,
        mode: 'HUMAN_ACTION_RESUME',
        action_label: recoveryLabel('HUMAN_ACTION_RESUME'),
        reason: 'HUMAN_ACTION_CHECKPOINT_WAITING',
        checkpoint_id: checkpoint.checkpoint_id || null,
        failure_stage: 'HUMAN_ACTION'
      };
    }
    if (checkpointState === 'RESOLVED' && !checkpoint.continuation_task_id && resumePhase === 'PROGRAM') {
      return {
        recoverable: true,
        mode: 'HUMAN_ACTION_RESUME',
        action_label: recoveryLabel('HUMAN_ACTION_RESUME'),
        reason: 'RESOLVED_PROGRAM_CHECKPOINT_WITHOUT_CONTINUATION',
        checkpoint_id: checkpoint.checkpoint_id || null,
        failure_stage: 'HUMAN_ACTION'
      };
    }
  }

  if (['BLOCKED', 'FAILED', 'RETRYABLE'].includes(state)) {
    if (mission.approved_execution_snapshot_id) {
      return {
        recoverable: true,
        mode: 'EXECUTION_RETRY',
        action_label: recoveryLabel('EXECUTION_RETRY'),
        reason: mission.blocker_code || mission.failure_code || 'EXECUTION_RETRY_AVAILABLE',
        failure_stage: 'EXECUTION',
        failure_code: mission.blocker_code || mission.failure_code || null,
        latest_run_id: latestExecutionRun?.id || latestRun?.id || null
      };
    }

    const brainFailure = (
      latestBrainRun?.state === 'FAILED' ||
      latestRun?.run_type === 'BRAIN_RUN' ||
      clean(mission.blocker_code, 200).startsWith('BRAIN_') ||
      clean(mission.failure_code, 200).startsWith('BRAIN_') ||
      !latestExecutionRun
    );

    if (brainFailure) {
      return {
        recoverable: true,
        mode: 'BRAIN_REPLAY',
        action_label: recoveryLabel('BRAIN_REPLAY'),
        reason: mission.blocker_code || mission.failure_code || latestBrainRun?.error || 'BRAIN_REPLAY_AVAILABLE',
        failure_stage: 'BRAIN',
        failure_code: mission.blocker_code || mission.failure_code || null,
        latest_run_id: latestBrainRun?.id || latestRun?.id || null
      };
    }

    return {
      recoverable: true,
      mode: 'BRAIN_REPLAY',
      action_label: recoveryLabel('BRAIN_REPLAY'),
      reason: mission.blocker_code || mission.failure_code || 'SAFE_REPLAN_REQUIRED',
      failure_stage: 'BRAIN',
      failure_code: mission.blocker_code || mission.failure_code || null,
      latest_run_id: latestRun?.id || null
    };
  }

  // Crash-safe replay: PLANNING but no active Brain/Task and the latest Brain
  // attempt is already terminal.
  if (
    state === 'PLANNING' &&
    !activeRun &&
    latestBrainRun &&
    ['FAILED', 'COMPLETED'].includes(clean(latestBrainRun.state, 100).toUpperCase()) &&
    !tasks.some((task) => ['QUEUED', 'ASSIGNED', 'RUNNING'].includes(clean(task.state, 100).toUpperCase()))
  ) {
    return {
      recoverable: true,
      mode: 'BRAIN_REPLAY',
      action_label: recoveryLabel('BRAIN_REPLAY'),
      reason: 'PLANNING_WITHOUT_ACTIVE_BRAIN_OR_TASK',
      failure_stage: 'BRAIN',
      latest_run_id: latestBrainRun.id
    };
  }

  return {
    recoverable: false,
    mode: 'NO_ACTION',
    action_label: recoveryLabel('NO_ACTION'),
    reason: 'MISSION_STATE_HEALTHY_OR_TERMINAL'
  };
}

async function getMissionRecoveryStatus(db, tenantId, missionId) {
  const context = await loadRecoveryContext(db, tenantId, missionId);
  const classification = classifyRecoveryContext(context);
  return {
    mission_id: missionId,
    mission_state: context.mission.state,
    ...classification
  };
}

async function resolveProgramBrainRunId(db, tenantId, context) {
  const { mission, milestone, runs } = context;
  const checkpoint = missionCheckpoint(mission, context.roadmap, milestone);
  const candidates = [
    checkpoint?.brain_run_id,
    milestone?.brain_run_id,
    mission.brain_run_id
  ].filter(Boolean);

  for (const id of candidates) {
    const run = runs.find((item) => item.id === id);
    if (
      run &&
      run.tenant_id === tenantId &&
      run.mission_id === mission.id &&
      run.run_type === 'BRAIN_RUN' &&
      clean(run.autopilot_phase, 120).toUpperCase() === 'PROGRAM'
    ) {
      return run.id;
    }
  }

  const programRun = runs.find((run) => (
    run.run_type === 'BRAIN_RUN' &&
    clean(run.autopilot_phase, 120).toUpperCase() === 'PROGRAM'
  ));
  return programRun?.id || null;
}

async function replayAutopilotBrain(db, tenantId, context) {
  const { mission, roadmap, milestone } = context;
  const missionRef = db.collection('missions').doc(mission.id);
  const roadmapRef = roadmap ? db.collection('roadmaps').doc(roadmap.id) : null;
  const newRunRef = db.collection('runs').doc();
  const milestoneHumanResponses = mission.roadmap_id && mission.milestone_id
    ? await listMilestoneResponses(db, tenantId, mission.roadmap_id, mission.milestone_id, {
        missionId: mission.id,
        includePremission: true
      })
    : [];
  const downstreamImpactProposal = mission.roadmap_id && mission.milestone_id
    ? await latestDownstreamImpactProposal(db, tenantId, mission.roadmap_id, mission.milestone_id, {
        missionId: mission.id
      })
    : null;
  let result = null;

  await db.runTransaction(async (tx) => {
    const freshMissionSnap = await tx.get(missionRef);
    if (!freshMissionSnap.exists || freshMissionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }
    const freshMission = { id: freshMissionSnap.id, ...freshMissionSnap.data() };

    const runsSnap = await tx.get(db.collection('runs').where('tenant_id', '==', tenantId).limit(300));
    const missionRuns = sortLatest(
      runsSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((run) => run.mission_id === mission.id)
    );

    const activeBrain = missionRuns.find((run) => (
      run.run_type === 'BRAIN_RUN' && run.state === 'RUNNING'
    ));
    if (activeBrain) {
      result = {
        success: true,
        mode: 'BRAIN_REPLAY',
        reused: true,
        mission_id: mission.id,
        brain_run_id: activeBrain.id
      };
      return;
    }

    if (freshMission.recovery_active_run_id) {
      const existingRef = db.collection('runs').doc(freshMission.recovery_active_run_id);
      const existingSnap = await tx.get(existingRef);
      if (
        existingSnap.exists &&
        existingSnap.data().tenant_id === tenantId &&
        existingSnap.data().mission_id === mission.id &&
        existingSnap.data().state === 'RUNNING'
      ) {
        result = {
          success: true,
          mode: 'BRAIN_REPLAY',
          reused: true,
          mission_id: mission.id,
          brain_run_id: existingSnap.id
        };
        return;
      }
    }

    // Firestore requires every transaction read to happen before the first write.
    // Read the Roadmap now, before tx.set(newRunRef) / tx.set(missionRef).
    let freshRoadmap = null;
    let freshMilestone = null;
    if (roadmapRef && milestone) {
      const roadmapSnap = await tx.get(roadmapRef);
      if (roadmapSnap.exists && roadmapSnap.data().tenant_id === tenantId) {
        freshRoadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
        freshMilestone = (freshRoadmap.milestones || []).find((item) => item.id === freshMission.milestone_id) || null;
      }
    }
    validateRecoveryProvenance({
      tenantId,
      mission: freshMission,
      roadmap: freshRoadmap,
      milestone: freshMilestone
    });

    const latestBrain = missionRuns.find((run) => run.run_type === 'BRAIN_RUN') || null;
    const attempt = Math.max(
      Number(freshMission.retry_count || 0),
      ...missionRuns.filter((run) => run.run_type === 'BRAIN_RUN').map((run) => Number(run.attempt || 1)),
      1
    ) + 1;

    const autopilotPhase = clean(
      latestBrain?.autopilot_phase ||
      freshMission.autopilot_phase ||
      'PROGRAM',
      120
    ).toUpperCase();

    const baseBrainContext = freshMission.brain_context || latestBrain?.brain_context || null;
    const brainContext = baseBrainContext && typeof baseBrainContext === 'object' && !Array.isArray(baseBrainContext)
      ? { ...baseBrainContext, milestone_human_responses: milestoneHumanResponses }
      : { milestone_human_responses: milestoneHumanResponses };
    if (['PENDING_APPROVAL', 'APPROVED'].includes(downstreamImpactProposal?.status)) {
      brainContext.downstream_impact = {
        detected: true,
        status: downstreamImpactProposal.status,
        approval_required: downstreamImpactProposal.status === 'PENDING_APPROVAL',
        impact_id: downstreamImpactProposal.impact_id,
        roadmap_id: downstreamImpactProposal.roadmap_id,
        source_milestone_id: downstreamImpactProposal.source_milestone_id,
        mission_id: downstreamImpactProposal.mission_id,
        affected_milestones: downstreamImpactProposal.affected_milestone_ids,
        affected_milestone_ids: downstreamImpactProposal.affected_milestone_ids,
        reason: downstreamImpactProposal.reason
      };
    }

    const brainRun = {
      id: newRunRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: mission.id,
      task_id: null,
      workspace_id: freshMission.workspace_id || null,
      project_id: freshMission.project_id || null,
      worker_id: freshMission.preferred_worker_id || latestBrain?.worker_id || 'W01',
      executor_id: null,
      parent_run_id: latestBrain?.id || null,
      retry_of_run_id: latestBrain?.id || null,
      objective: freshMission.objective,
      brain_context: brainContext,
      autopilot_mode: freshMission.autopilot_mode === true,
      autopilot_phase: autopilotPhase,
      roadmap_id: freshMission.roadmap_id || null,
      milestone_id: freshMission.milestone_id || null,
      state: 'RUNNING',
      attempt,
      progress_percent: 0,
      progress_message: 'Mission recovery: Brain replay started',
      recovery_replay: true,
      recovery_mode: 'BRAIN_REPLAY',
      recovery_generation: attempt,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(newRunRef, brainRun);
    tx.set(missionRef, {
      state: 'PLANNING',
      brain_run_id: newRunRef.id,
      recovery_active_run_id: newRunRef.id,
      current_retry_run_id: newRunRef.id,
      retry_of_run_id: latestBrain?.id || null,
      retry_count: Number(freshMission.retry_count || 0) + 1,
      blocked_reason: null,
      block_reason: null,
      blocker_code: null,
      blocker_message: null,
      failure_code: null,
      completed_at: null,
      updated_at: timestamp()
    }, { merge: true });

    if (freshRoadmap && milestone) {
      tx.set(roadmapRef, {
        state: freshRoadmap.state === 'BLOCKED' ? 'ACTIVE' : freshRoadmap.state,
        milestones: (freshRoadmap.milestones || []).map((item) => item.id === milestone.id
          ? {
              ...item,
              state: 'PLANNING',
              mission_id: mission.id,
              brain_run_id: newRunRef.id,
              blocked_reason: null,
              blocker_code: null,
              updated_at: new Date()
            }
          : item),
        updated_at: timestamp()
      }, { merge: true });
    }

    result = {
      success: true,
      mode: 'BRAIN_REPLAY',
      reused: false,
      mission_id: mission.id,
      brain_run_id: newRunRef.id,
      retry_of_run_id: latestBrain?.id || null
    };
  });

  return result;
}

async function recoverHumanActionContinuation(db, tenantId, context) {
  const { mission, roadmap, milestone } = context;
  const checkpoint = missionCheckpoint(mission, roadmap, milestone);
  const brainRunId = await resolveProgramBrainRunId(db, tenantId, context);

  if (['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION'].includes(checkpointStatus(checkpoint))) {
    return {
      success: false,
      mode: 'HUMAN_ACTION_RESUME',
      reused: true,
      no_new_work: true,
      state: 'NEED_HUMAN_ACTION',
      mission_id: mission.id,
      roadmap_id: roadmap?.id || mission.roadmap_id || null,
      milestone_id: milestone?.id || mission.milestone_id || null,
      checkpoint_id: checkpoint?.checkpoint_id || null,
      reason: 'HUMAN_ACTION_CHECKPOINT_NOT_RESOLVED'
    };
  }

  if (!roadmap || !milestone || !checkpoint?.checkpoint_id || !brainRunId) {
    const error = new Error('HUMAN_ACTION_RECOVERY_PROVENANCE_INCOMPLETE');
    error.status = 409;
    throw error;
  }

  return resumeAutopilotProgramAfterHumanAction(db, tenantId, {
    mission_id: mission.id,
    roadmap_id: roadmap.id,
    milestone_id: milestone.id,
    brain_run_id: brainRunId,
    checkpoint_id: checkpoint.checkpoint_id
  });
}

function reusedRetryWork(context) {
  const { mission, tasks, runs } = context;
  const task = tasks.find((item) => (
    item.mission_id === mission.id &&
    activeWorkState(item.state) &&
    (
      item.id === mission.current_retry_task_id ||
      item.autopilot_phase === 'RETRY' ||
      (mission.approved_execution_snapshot_id && item.execution_snapshot_id === mission.approved_execution_snapshot_id)
    )
  )) || null;
  if (!task) return null;
  const run = runs.find((item) => (
    item.run_type === 'EXECUTION_RUN' &&
    item.mission_id === mission.id &&
    item.task_id === task.id &&
    !terminalWorkState(item.state)
  )) || null;
  return {
    success: true,
    mode: 'EXECUTION_RETRY',
    reused: true,
    no_new_work: true,
    mission_id: mission.id,
    roadmap_id: mission.roadmap_id || null,
    milestone_id: mission.milestone_id || null,
    task_id: task.id,
    execution_run_id: run?.id || task.current_run_id || task.execution_run_id || null,
    retry_of_task_id: task.retry_of_task_id || null,
    retry_of_run_id: task.retry_of_run_id || run?.retry_of_run_id || null
  };
}

async function recoverMission(db, tenantId, missionId) {
  const context = await loadRecoveryContext(db, tenantId, missionId);
  const classification = classifyRecoveryContext(context);

  if (!classification.recoverable) {
    return {
      success: true,
      mission_id: missionId,
      mode: 'NO_ACTION',
      reused: true,
      reason: classification.reason
    };
  }

  if (classification.mode === 'HUMAN_ACTION_RESUME') {
    const result = await recoverHumanActionContinuation(db, tenantId, context);
    return {
      success: true,
      mode: 'HUMAN_ACTION_RESUME',
      mission_id: missionId,
      ...result
    };
  }

  if (classification.mode === 'EXECUTION_RETRY') {
    const reused = reusedRetryWork(context);
    if (reused) return reused;
    const result = await retryMission(db, tenantId, missionId);
    if (result.task_id) {
      await db.collection('missions').doc(missionId).set({
        current_task_id: result.task_id,
        updated_at: timestamp()
      }, { merge: true });
    }
    return {
      success: true,
      mode: 'EXECUTION_RETRY',
      mission_id: missionId,
      roadmap_id: context.mission.roadmap_id || null,
      milestone_id: context.mission.milestone_id || null,
      task_id: result.task_id || null,
      execution_run_id: result.execution_run_id || null,
      reused: result.reused === true,
      no_new_work: result.no_new_work === true,
      result
    };
  }

  if (classification.mode === 'BRAIN_REPLAY') {
    if (context.mission.autopilot_mode === true) {
      return replayAutopilotBrain(db, tenantId, context);
    }
    const result = await retryMission(db, tenantId, missionId);
    return {
      success: true,
      mode: 'BRAIN_REPLAY',
      mission_id: missionId,
      result
    };
  }

  return {
    success: true,
    mission_id: missionId,
    mode: 'NO_ACTION',
    reused: true
  };
}

module.exports = {
  recoveryLabel,
  classifyRecoveryContext,
  getMissionRecoveryStatus,
  recoverMission,
  replayAutopilotBrain,
  recoverHumanActionContinuation
};
