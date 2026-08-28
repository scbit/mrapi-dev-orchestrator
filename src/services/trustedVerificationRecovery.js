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

function upper(value) {
  return clean(value, 300).toUpperCase();
}

function normalizedMethod(value) {
  return clean(value, 500).toLowerCase().replace(/[\s-]+/g, '_');
}

function isRepositoryCleanMethod(value) {
  return [
    'repository_clean',
    'repository_worktree_clean',
    'worktree_clean',
    'git_worktree_clean'
  ].includes(normalizedMethod(value));
}

function isRuntimeContinuityVerification(checkpoint) {
  const method = normalizedMethod(checkpoint?.validation_method);
  const type = upper(checkpoint?.checkpoint_type || checkpoint?.type);
  const requirement = upper(checkpoint?.requirement_type);
  return (
    method === 'manual_runtime_continuity_validation' ||
    (
      type === 'AUTOPILOT_VERIFICATION' &&
      ['HUMAN_ACTION', 'MANUAL_HUMAN', 'MANUAL_ACTION'].includes(requirement) &&
      /runtime|continuity|records|verify|verification/i.test(
        [
          checkpoint?.human_action_request,
          checkpoint?.user_action,
          checkpoint?.reason
        ].filter(Boolean).join(' ')
      )
    )
  );
}

function testsPassed(report) {
  const nested = report?.executor_report && typeof report.executor_report === 'object'
    ? report.executor_report
    : {};
  if (nested.required_tests_passed === true) return true;

  const tests = Array.isArray(report?.required_tests)
    ? report.required_tests
    : Array.isArray(nested.required_tests)
      ? nested.required_tests
      : [];

  return tests.length > 0 && tests.every((item) => item?.passed === true);
}

function executionSucceeded(executionRun, verificationRun) {
  const report = verificationRun?.executor_report || {};
  if (!executionRun || upper(executionRun.state) !== 'COMPLETED') return false;
  if (report.success !== true) return false;
  if (!testsPassed(report)) return false;

  const nested = report.executor_report && typeof report.executor_report === 'object'
    ? report.executor_report
    : {};
  if (nested.required_tests_passed === false) return false;
  if (report.diagnostic_only_failure === true || nested.diagnostic_only_failure === true) return false;

  const exit = report.process_exit_code;
  if (exit !== null && exit !== undefined && Number(exit) !== 0) return false;
  if (report.process_exited_cleanly === false) return false;

  return true;
}

function resolvedTrustedCheckpoint(checkpoint, evidence) {
  const now = new Date();
  return {
    ...checkpoint,
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    human_action_required: false,
    resolved_at: now,
    resolved_by: 'TRUSTED_RUNTIME_EVIDENCE',
    last_validation_at: now,
    last_validation_message:
      'Automatically resolved from persisted Host Validation PASS, continuation Task, successful EXECUTION_RUN and required test evidence.',
    validation_result: {
      ok: true,
      method: 'trusted_runtime_evidence',
      checked_at: now,
      host_validation_id: evidence.host_validation_id,
      execution_run_id: evidence.execution_run_id,
      task_id: evidence.task_id,
      verification_brain_run_id: evidence.verification_brain_run_id,
      automatic: true
    },
    updated_at: now
  };
}

async function recoverTrustedVerificationCompletion(db, tenantId) {
  const [roadmapsSnap, runsSnap, tasksSnap, validationsSnap] = await Promise.all([
    db.collection('roadmaps').where('tenant_id', '==', tenantId).limit(200).get(),
    db.collection('runs').where('tenant_id', '==', tenantId).limit(500).get(),
    db.collection('tasks').where('tenant_id', '==', tenantId).limit(300).get(),
    db.collection('host_validations').where('tenant_id', '==', tenantId).limit(300).get()
  ]);

  const runs = runsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const tasks = tasksSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const validations = validationsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  for (const roadmapDoc of roadmapsSnap.docs) {
    const roadmap = { id: roadmapDoc.id, ...roadmapDoc.data() };

    for (const milestone of roadmap.milestones || []) {
      if (upper(milestone.state) !== 'NEED_HUMAN_ACTION') continue;

      const checkpoint = milestone.human_action_checkpoint || milestone.human_action || null;
      if (!checkpoint || checkpoint.human_action_required !== true) continue;
      if (!isRuntimeContinuityVerification(checkpoint)) continue;
      if (!checkpoint.mission_id) continue;

      const missionRef = db.collection('missions').doc(checkpoint.mission_id);
      const missionSnap = await missionRef.get();
      if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) continue;
      const mission = { id: missionSnap.id, ...missionSnap.data() };

      if (
        mission.roadmap_id !== roadmap.id ||
        mission.milestone_id !== milestone.id ||
        upper(mission.state) !== 'NEED_HUMAN_ACTION'
      ) continue;

      const missionTasks = tasks.filter((task) => task.mission_id === mission.id);
      const continuationTasks = missionTasks.filter((task) =>
        task.human_action_checkpoint_id ||
        task.id === mission.current_task_id
      );
      if (continuationTasks.length !== 1) continue;
      const task = continuationTasks[0];
      if (!['DONE', 'COMPLETED'].includes(upper(task.state))) continue;

      const executionRuns = runs.filter((run) =>
        run.mission_id === mission.id &&
        run.run_type === 'EXECUTION_RUN' &&
        run.task_id === task.id
      );
      if (executionRuns.length !== 1) continue;
      const executionRun = executionRuns[0];

      const verificationRuns = runs.filter((run) =>
        run.mission_id === mission.id &&
        run.run_type === 'BRAIN_RUN' &&
        upper(run.autopilot_phase) === 'VERIFY_EXECUTION' &&
        run.parent_execution_run_id === executionRun.id
      );
      if (verificationRuns.length !== 1) continue;
      const verificationRun = verificationRuns[0];
      if (upper(verificationRun.state) !== 'COMPLETED') continue;
      if (upper(verificationRun.autopilot_decision?.action) !== 'NEED_HUMAN_ACTION') continue;
      if (!executionSucceeded(executionRun, verificationRun)) continue;

      const passedRepositoryValidation = validations.find((validation) =>
        validation.mission_id === mission.id &&
        validation.roadmap_id === roadmap.id &&
        validation.milestone_id === milestone.id &&
        upper(validation.status || validation.state) === 'PASS' &&
        isRepositoryCleanMethod(validation.validator)
      );
      if (!passedRepositoryValidation) continue;

      const evidence = {
        host_validation_id: passedRepositoryValidation.id,
        execution_run_id: executionRun.id,
        task_id: task.id,
        verification_brain_run_id: verificationRun.id
      };
      const resolved = resolvedTrustedCheckpoint(checkpoint, evidence);

      let result = null;
      await db.runTransaction(async (tx) => {
        const freshRoadmapSnap = await tx.get(db.collection('roadmaps').doc(roadmap.id));
        const freshMissionSnap = await tx.get(missionRef);
        const freshVerificationSnap = await tx.get(db.collection('runs').doc(verificationRun.id));

        if (!freshRoadmapSnap.exists || freshRoadmapSnap.data().tenant_id !== tenantId) return;
        if (!freshMissionSnap.exists || freshMissionSnap.data().tenant_id !== tenantId) return;
        if (!freshVerificationSnap.exists || freshVerificationSnap.data().tenant_id !== tenantId) return;

        const freshRoadmap = { id: freshRoadmapSnap.id, ...freshRoadmapSnap.data() };
        const freshMilestone = (freshRoadmap.milestones || []).find((item) => item.id === milestone.id);
        const freshCheckpoint = freshMilestone?.human_action_checkpoint || freshMilestone?.human_action || null;

        if (!freshCheckpoint || freshCheckpoint.checkpoint_id !== checkpoint.checkpoint_id) return;
        if (upper(freshMilestone.state) !== 'NEED_HUMAN_ACTION') return;
        if (!isRuntimeContinuityVerification(freshCheckpoint)) return;

        const completedMilestones = (freshRoadmap.milestones || []).map((item) =>
          item.id === milestone.id
            ? {
                ...item,
                state: 'COMPLETED',
                human_action_required: false,
                human_action_checkpoint: resolved,
                waiting_status: 'RESOLVED',
                blocked_reason: null,
                verification_brain_run_id: verificationRun.id,
                completed_at: new Date(),
                trusted_verification_override: true,
                updated_at: new Date()
              }
            : item
        );
        const roadmapComplete = completedMilestones.every((item) =>
          ['COMPLETED', 'SKIPPED'].includes(upper(item.state))
        );

        tx.set(db.collection('roadmaps').doc(roadmap.id), {
          milestones: completedMilestones,
          state: roadmapComplete ? 'COMPLETED' : freshRoadmap.state,
          updated_at: timestamp()
        }, { merge: true });

        tx.set(missionRef, {
          state: 'COMPLETED',
          autopilot_phase: 'COMPLETED',
          human_action_required: false,
          human_action_checkpoint: resolved,
          blocker_code: null,
          blocker_message: null,
          trusted_verification_override: true,
          completed_at: timestamp(),
          updated_at: timestamp()
        }, { merge: true });

        tx.set(db.collection('runs').doc(verificationRun.id), {
          trusted_verification_override: {
            applied: true,
            reason:
              'Redundant manual runtime continuity confirmation bypassed because persisted runtime evidence already proved success.',
            host_validation_id: passedRepositoryValidation.id,
            task_id: task.id,
            execution_run_id: executionRun.id,
            applied_at: new Date()
          },
          updated_at: timestamp()
        }, { merge: true });

        result = {
          success: true,
          action: 'COMPLETE',
          mode: 'TRUSTED_VERIFY_AUTO_COMPLETE',
          roadmap_id: roadmap.id,
          milestone_id: milestone.id,
          mission_id: mission.id,
          task_id: task.id,
          execution_run_id: executionRun.id,
          verification_brain_run_id: verificationRun.id,
          host_validation_id: passedRepositoryValidation.id,
          checkpoint_id: checkpoint.checkpoint_id,
          roadmap_completed: roadmapComplete
        };
      });

      if (result) return result;
    }
  }

  return null;
}

module.exports = {
  normalizedMethod,
  isRepositoryCleanMethod,
  isRuntimeContinuityVerification,
  testsPassed,
  executionSucceeded,
  resolvedTrustedCheckpoint,
  recoverTrustedVerificationCompletion
};
