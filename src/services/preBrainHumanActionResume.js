const crypto = require('crypto');

function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function checkpointStatus(checkpoint) {
  return clean(checkpoint?.status || checkpoint?.waiting_status || '', 120).toUpperCase();
}

function resumePhase(checkpoint, mission) {
  return clean(
    checkpoint?.paused_from_phase ||
    checkpoint?.resume_phase ||
    mission?.paused_from_phase ||
    'PROGRAM',
    120
  ).toUpperCase() || 'PROGRAM';
}

function deterministicBrainRunId(checkpointId) {
  const digest = crypto
    .createHash('sha256')
    .update(String(checkpointId || ''))
    .digest('hex')
    .slice(0, 24);
  return `brain_human_resume_${digest}`;
}

function terminalMission(state) {
  return ['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']
    .includes(clean(state, 120).toUpperCase());
}

async function findResolvedPreBrainCandidate(db, tenantId) {
  const roadmapsSnap = await db.collection('roadmaps')
    .where('tenant_id', '==', tenantId)
    .limit(200)
    .get();

  for (const roadmapDoc of roadmapsSnap.docs) {
    const roadmap = { id: roadmapDoc.id, ...roadmapDoc.data() };

    for (const milestone of roadmap.milestones || []) {
      const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
      if (!checkpoint) continue;
      if (checkpointStatus(checkpoint) !== 'RESOLVED') continue;
      if (checkpoint.continuation_task_id) continue;
      if (checkpoint.continuation_brain_run_id) continue;
      if (resumePhase(checkpoint) !== 'PROGRAM') continue;
      if (!checkpoint.mission_id || checkpoint.roadmap_id !== roadmap.id) continue;
      if (checkpoint.milestone_id !== milestone.id) continue;

      const missionSnap = await db.collection('missions').doc(checkpoint.mission_id).get();
      if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) continue;

      const mission = { id: missionSnap.id, ...missionSnap.data() };
      if (terminalMission(mission.state)) continue;
      if (mission.roadmap_id !== roadmap.id || mission.milestone_id !== milestone.id) continue;
      if (mission.human_action_required !== false) continue;
      if (clean(mission.autopilot_phase, 120).toUpperCase() !== 'PROGRAM') continue;

      const runsSnap = await db.collection('runs')
        .where('tenant_id', '==', tenantId)
        .limit(300)
        .get();

      const existingProgramBrain = runsSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .find((run) =>
          run.mission_id === mission.id &&
          run.run_type === 'BRAIN_RUN' &&
          clean(run.autopilot_phase, 120).toUpperCase() === 'PROGRAM'
        );

      // If any PROGRAM Brain Run exists, this is not the pre-Brain gap.
      // Existing post-Brain continuation recovery owns that case.
      if (existingProgramBrain) continue;

      return {
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        checkpoint_id: checkpoint.checkpoint_id
      };
    }
  }

  return null;
}

async function dispatchResolvedPreBrainProgram(db, tenantId, scope) {
  const roadmapRef = db.collection('roadmaps').doc(scope.roadmap_id);
  const missionRef = db.collection('missions').doc(scope.mission_id);
  const runRef = db.collection('runs').doc(deterministicBrainRunId(scope.checkpoint_id));
  let result = null;

  await db.runTransaction(async (tx) => {
    // Firestore: all reads before writes.
    const roadmapSnap = await tx.get(roadmapRef);
    const missionSnap = await tx.get(missionRef);
    const runSnap = await tx.get(runRef);
    const runsSnap = await tx.get(
      db.collection('runs').where('tenant_id', '==', tenantId).limit(300)
    );

    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) return;
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) return;

    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const mission = { id: missionSnap.id, ...missionSnap.data() };
    const milestone = (roadmap.milestones || [])
      .find((item) => item.id === scope.milestone_id);

    if (!milestone) return;

    const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
    if (!checkpoint) return;
    if (checkpoint.checkpoint_id !== scope.checkpoint_id) return;
    if (checkpointStatus(checkpoint) !== 'RESOLVED') return;
    if (checkpoint.continuation_task_id) return;
    if (resumePhase(checkpoint, mission) !== 'PROGRAM') return;
    if (terminalMission(mission.state)) return;
    if (mission.human_action_required !== false) return;
    if (mission.roadmap_id !== roadmap.id || mission.milestone_id !== milestone.id) return;
    if (clean(mission.autopilot_phase, 120).toUpperCase() !== 'PROGRAM') return;

    const existingProgramBrain = runsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .find((run) =>
        run.mission_id === mission.id &&
        run.run_type === 'BRAIN_RUN' &&
        clean(run.autopilot_phase, 120).toUpperCase() === 'PROGRAM'
      );

    if (existingProgramBrain) {
      result = {
        created: false,
        reused: true,
        mission_id: mission.id,
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        checkpoint_id: checkpoint.checkpoint_id,
        brain_run_id: existingProgramBrain.id
      };
      return;
    }

    if (runSnap.exists) {
      const run = { id: runSnap.id, ...runSnap.data() };
      result = {
        created: false,
        reused: true,
        mission_id: mission.id,
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        checkpoint_id: checkpoint.checkpoint_id,
        brain_run_id: run.id
      };
      return;
    }

    const brainRun = {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: mission.id,
      task_id: null,
      workspace_id: mission.workspace_id || roadmap.workspace_id || null,
      project_id: mission.project_id || roadmap.project_id || null,
      worker_id: mission.preferred_worker_id || 'W01',
      executor_id: null,
      parent_run_id: null,
      objective: mission.objective || '',
      brain_context: mission.brain_context || null,
      autopilot_mode: true,
      autopilot_phase: 'PROGRAM',
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      state: 'RUNNING',
      progress_percent: 0,
      progress_message: 'Human Action resolved; PROGRAM Brain Run started',
      human_action_checkpoint_id: checkpoint.checkpoint_id,
      resumed_after_human_action: true,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    const updatedCheckpoint = {
      ...checkpoint,
      continuation_brain_run_id: runRef.id,
      updated_at: new Date()
    };

    tx.set(runRef, brainRun);
    tx.set(missionRef, {
      state: 'PLANNING',
      autopilot_phase: 'PROGRAM',
      brain_run_id: runRef.id,
      human_action_required: false,
      human_action_checkpoint: updatedCheckpoint,
      dispatched_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    tx.set(roadmapRef, {
      milestones: (roadmap.milestones || []).map((item) =>
        item.id === milestone.id
          ? {
              ...item,
              state: 'PLANNING',
              brain_run_id: runRef.id,
              human_action_required: false,
              human_action_checkpoint: updatedCheckpoint,
              waiting_status: 'RESOLVED',
              blocked_reason: null,
              updated_at: new Date()
            }
          : item
      ),
      updated_at: timestamp()
    }, { merge: true });

    result = {
      created: true,
      reused: false,
      mission_id: mission.id,
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      checkpoint_id: checkpoint.checkpoint_id,
      brain_run_id: runRef.id
    };
  });

  return result;
}

async function recoverResolvedPreBrainProgramContinuation(db, tenantId) {
  const candidate = await findResolvedPreBrainCandidate(db, tenantId);
  if (!candidate) return null;
  return dispatchResolvedPreBrainProgram(db, tenantId, candidate);
}

module.exports = {
  deterministicBrainRunId,
  findResolvedPreBrainCandidate,
  dispatchResolvedPreBrainProgram,
  recoverResolvedPreBrainProgramContinuation
};
