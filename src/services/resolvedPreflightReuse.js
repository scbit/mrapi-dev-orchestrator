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

function normalizedValidationMethod(value) {
  return clean(value, 500).toLowerCase().replace(/[\s-]+/g, '_');
}

function repositoryCleanMethod(value) {
  return [
    'repository_clean',
    'repository_worktree_clean',
    'worktree_clean',
    'git_worktree_clean'
  ].includes(normalizedValidationMethod(value));
}

function sameScope(validation, roadmap, milestone, mission) {
  return (
    validation.roadmap_id === roadmap.id &&
    validation.milestone_id === milestone.id &&
    validation.mission_id === mission.id
  );
}

function canonicalResolvedCheckpoint(current, passedValidation, brainRunId) {
  const canonicalId = current.parent_checkpoint_id ||
    current.supersedes_checkpoint_id ||
    passedValidation.checkpoint_id;

  return {
    ...current,
    checkpoint_id: canonicalId,
    parent_checkpoint_id: null,
    supersedes_checkpoint_id: null,
    generation: Math.max(1, Number(current.generation || 1) - 1),
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    human_action_required: false,
    brain_run_id: brainRunId || current.brain_run_id || null,
    resolved_at: current.resolved_at || passedValidation.completed_at || new Date(),
    resolved_by: 'REUSED_PRIOR_HOST_VALIDATION',
    last_validation_at: passedValidation.completed_at || new Date(),
    last_validation_message: passedValidation.safe_message || 'Prior repository-clean validation reused.',
    validation_result: {
      ok: true,
      method: normalizedValidationMethod(passedValidation.validator),
      checked_at: passedValidation.completed_at || new Date(),
      validation_id: passedValidation.id,
      run_id: passedValidation.run_id || null,
      result_id: passedValidation.result_id || null,
      reused: true
    },
    repeated_checkpoint_id: current.checkpoint_id,
    reused_prior_validation_id: passedValidation.id,
    updated_at: new Date()
  };
}

async function recoverRepeatedResolvedRepositoryPreflight(db, tenantId) {
  const [roadmapsSnap, validationsSnap, runsSnap] = await Promise.all([
    db.collection('roadmaps').where('tenant_id', '==', tenantId).limit(200).get(),
    db.collection('host_validations').where('tenant_id', '==', tenantId).limit(300).get(),
    db.collection('runs').where('tenant_id', '==', tenantId).limit(400).get()
  ]);

  const validations = validationsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const runs = runsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  for (const roadmapDoc of roadmapsSnap.docs) {
    const roadmap = { id: roadmapDoc.id, ...roadmapDoc.data() };

    for (const milestone of roadmap.milestones || []) {
      const current = milestone?.human_action_checkpoint || milestone?.human_action || null;
      if (!current) continue;
      if (!['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION'].includes(checkpointStatus(current))) continue;
      if (!repositoryCleanMethod(current.validation_method)) continue;

      const priorCheckpointId = current.parent_checkpoint_id || current.supersedes_checkpoint_id || null;
      if (!priorCheckpointId || priorCheckpointId === current.checkpoint_id) continue;
      if (!current.mission_id) continue;

      const missionSnap = await db.collection('missions').doc(current.mission_id).get();
      if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) continue;
      const mission = { id: missionSnap.id, ...missionSnap.data() };

      if (
        mission.roadmap_id !== roadmap.id ||
        mission.milestone_id !== milestone.id
      ) continue;

      const priorPass = validations.find((validation) =>
        validation.checkpoint_id === priorCheckpointId &&
        String(validation.status || validation.state || '').toUpperCase() === 'PASS' &&
        repositoryCleanMethod(validation.validator) &&
        sameScope(validation, roadmap, milestone, mission)
      );
      if (!priorPass) continue;

      // The repeat is only safe to reuse if no Executor work happened after the PASS.
      const missionExecutionRuns = runs.filter((run) =>
        run.mission_id === mission.id &&
        run.run_type === 'EXECUTION_RUN' &&
        ['RUNNING', 'COMPLETED', 'FAILED'].includes(String(run.state || '').toUpperCase())
      );
      if (missionExecutionRuns.length > 0) continue;

      const completedProgramBrain = [...runs]
        .filter((run) =>
          run.mission_id === mission.id &&
          run.run_type === 'BRAIN_RUN' &&
          String(run.autopilot_phase || '').toUpperCase() === 'PROGRAM' &&
          String(run.state || '').toUpperCase() === 'COMPLETED'
        )
        .sort((a, b) => Number(b.attempt || 0) - Number(a.attempt || 0))[0] || null;

      if (!completedProgramBrain) continue;

      const roadmapRef = db.collection('roadmaps').doc(roadmap.id);
      const missionRef = db.collection('missions').doc(mission.id);
      let repaired = null;

      await db.runTransaction(async (tx) => {
        const freshRoadmapSnap = await tx.get(roadmapRef);
        const freshMissionSnap = await tx.get(missionRef);
        if (!freshRoadmapSnap.exists || freshRoadmapSnap.data().tenant_id !== tenantId) return;
        if (!freshMissionSnap.exists || freshMissionSnap.data().tenant_id !== tenantId) return;

        const freshRoadmap = { id: freshRoadmapSnap.id, ...freshRoadmapSnap.data() };
        const freshMilestone = (freshRoadmap.milestones || []).find((item) => item.id === milestone.id);
        const freshCurrent = freshMilestone?.human_action_checkpoint || freshMilestone?.human_action || null;
        if (!freshCurrent || freshCurrent.checkpoint_id !== current.checkpoint_id) return;
        if (!['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION'].includes(checkpointStatus(freshCurrent))) return;
        if (!repositoryCleanMethod(freshCurrent.validation_method)) return;

        const resolved = canonicalResolvedCheckpoint(
          freshCurrent,
          priorPass,
          completedProgramBrain.id
        );

        tx.set(roadmapRef, {
          milestones: (freshRoadmap.milestones || []).map((item) =>
            item.id === milestone.id
              ? {
                  ...item,
                  state: 'RUNNING',
                  brain_run_id: completedProgramBrain.id,
                  human_action_required: false,
                  human_action_checkpoint: resolved,
                  waiting_status: 'RESOLVED',
                  blocked_reason: null,
                  updated_at: new Date()
                }
              : item
          ),
          updated_at: timestamp()
        }, { merge: true });

        tx.set(missionRef, {
          state: 'PLANNING',
          autopilot_phase: 'PROGRAM',
          brain_run_id: completedProgramBrain.id,
          human_action_required: false,
          human_action_checkpoint: resolved,
          blocker_code: null,
          blocker_message: null,
          updated_at: timestamp()
        }, { merge: true });

        repaired = {
          reused: true,
          mode: 'REUSE_RESOLVED_REPOSITORY_PREFLIGHT',
          roadmap_id: roadmap.id,
          milestone_id: milestone.id,
          mission_id: mission.id,
          brain_run_id: completedProgramBrain.id,
          checkpoint_id: resolved.checkpoint_id,
          repeated_checkpoint_id: current.checkpoint_id,
          validation_id: priorPass.id
        };
      });

      if (!repaired) continue;

      // Existing post-Brain continuation code now owns Task creation.
      const { resumeAutopilotProgramAfterHumanAction } = require('./orchestration');
      return resumeAutopilotProgramAfterHumanAction(db, tenantId, {
        mission_id: repaired.mission_id,
        roadmap_id: repaired.roadmap_id,
        milestone_id: repaired.milestone_id,
        brain_run_id: repaired.brain_run_id,
        checkpoint_id: repaired.checkpoint_id
      });
    }
  }

  return null;
}

module.exports = {
  normalizedValidationMethod,
  repositoryCleanMethod,
  canonicalResolvedCheckpoint,
  recoverRepeatedResolvedRepositoryPreflight
};
