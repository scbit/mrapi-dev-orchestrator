const crypto = require('crypto');
const { nextMilestone } = require('./roadmap');

const AUTOPILOT_ACTIONS = new Set(['COMPLETE', 'RETRY', 'BLOCKED']);

function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

// Firestore transform sentinels (serverTimestamp) cannot be stored inside array elements.
// Roadmap milestones are persisted as an array, so nested milestone timestamps must be
// concrete values. Top-level document timestamps continue using serverTimestamp().
function milestoneTimestamp() {
  return new Date();
}

function clean(value, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseAutopilotDecision(text) {
  const raw = String(text || '');
  const tagged = raw.match(/<MRAPI_AUTOPILOT>\s*([\s\S]*?)\s*<\/MRAPI_AUTOPILOT>/i);
  let parsed = null;
  if (tagged) {
    try { parsed = JSON.parse(tagged[1]); } catch { parsed = null; }
  }
  if (!parsed) {
    const candidate = raw.match(/\{[\s\S]*\}/);
    if (candidate) {
      try { parsed = JSON.parse(candidate[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || !AUTOPILOT_ACTIONS.has(String(parsed.action || '').toUpperCase())) {
    return {
      action: 'BLOCKED',
      reason: 'Brain verification response did not contain a valid MRAPI_AUTOPILOT decision.',
      execution_spec: null
    };
  }
  return {
    action: String(parsed.action).toUpperCase(),
    reason: clean(parsed.reason || parsed.summary || ''),
    execution_spec: parsed.execution_spec && typeof parsed.execution_spec === 'object'
      ? {
          instructions: clean(parsed.execution_spec.instructions || '', 50000),
          allowed_files: Array.isArray(parsed.execution_spec.allowed_files)
            ? [...new Set(parsed.execution_spec.allowed_files.map((x) => clean(x, 1000).replace(/\\/g, '/')).filter(Boolean))].slice(0, 100)
            : [],
          success_criteria: Array.isArray(parsed.execution_spec.success_criteria)
            ? parsed.execution_spec.success_criteria.map((x) => clean(x, 1000)).filter(Boolean).slice(0, 30)
            : [],
          stop_conditions: Array.isArray(parsed.execution_spec.stop_conditions)
            ? parsed.execution_spec.stop_conditions.map((x) => clean(x, 1000)).filter(Boolean).slice(0, 30)
            : []
        }
      : null
  };
}

function milestoneWithState(roadmap, milestoneId, state, extra = {}) {
  let found = false;
  const milestones = (roadmap.milestones || []).map((item) => {
    if (item.id !== milestoneId) return item;
    found = true;
    return { ...item, state, ...extra, updated_at: milestoneTimestamp() };
  });
  if (!found) {
    const error = new Error('MILESTONE_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  return milestones;
}

async function startNextRoadmapMilestone(db, tenantId, roadmapId, options = {}) {
  const roadmapRef = db.collection('roadmaps').doc(roadmapId);
  const missionRef = db.collection('missions').doc();
  let created = null;

  await db.runTransaction(async (tx) => {
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    if (roadmap.state !== 'ACTIVE') {
      const error = new Error('ROADMAP_NOT_ACTIVE'); error.status = 409; throw error;
    }
    const milestone = options.milestone_id
      ? (roadmap.milestones || []).find((item) => item.id === options.milestone_id)
      : nextMilestone(roadmap);
    if (!milestone) {
      const error = new Error('NO_EXECUTABLE_MILESTONE'); error.status = 409; throw error;
    }
    if (milestone.state !== 'PENDING') {
      const error = new Error('MILESTONE_NOT_PENDING'); error.status = 409; throw error;
    }
    if (milestone.mission_id) {
      const error = new Error('MILESTONE_ALREADY_HAS_MISSION'); error.status = 409; throw error;
    }

    const projectRef = db.collection('projects').doc(roadmap.project_id);
    const projectSnap = await tx.get(projectRef);
    if (!projectSnap.exists || projectSnap.data().tenant_id !== tenantId) {
      const error = new Error('PROJECT_NOT_FOUND'); error.status = 404; throw error;
    }
    const project = { id: projectSnap.id, ...projectSnap.data() };
    const workerId = milestone.preferred_worker_id || roadmap.owner_worker_id || project.default_worker_id || 'W01';
    const workerRef = db.collection('workers').doc(workerId);
    const workerSnap = await tx.get(workerRef);
    if (!workerSnap.exists || workerSnap.data().tenant_id !== tenantId) {
      const error = new Error('WORKER_NOT_FOUND'); error.status = 409; throw error;
    }

    const attempt = 1;
    const objective = [
      `ROADMAP GOAL: ${roadmap.title}`,
      `MILESTONE: ${milestone.title}`,
      milestone.description ? `MILESTONE DESCRIPTION: ${milestone.description}` : '',
      `ROADMAP OBJECTIVE: ${roadmap.objective}`,
      '',
      'PROJECT CONTEXT',
      `Repository: ${project.repository_full_name || project.repository_url || '(not configured)'}`,
      `Local path: ${project.local_path || '(not configured)'}`,
      `Branch: ${project.default_branch || 'main'}`,
      project.reusable_instructions ? `Stable instructions: ${project.reusable_instructions}` : '',
      '',
      'AUTOPILOT RULES',
      '- Brain owns design, programming decisions, correction strategy and verification.',
      '- Codex is hands only: apply exact Brain instructions, run tests/browser/artifacts/Git only as authorized.',
      '- Do not deploy Cloud Run. Human manual deploy remains required.',
      '- Keep the execution bounded and verifiable.'
    ].filter(Boolean).join('\n');

    const mission = {
      id: missionRef.id,
      tenant_id: tenantId,
      workspace_id: roadmap.workspace_id || project.workspace_id || null,
      project_id: roadmap.project_id,
      preferred_worker_id: workerId,
      objective,
      priority: milestone.priority || roadmap.priority || 'NORMAL',
      state: 'READY',
      planning_mode: 'AUTOPILOT',
      approval_status: 'APPROVED',
      autopilot_mode: true,
      autopilot_phase: 'PROGRAM',
      autopilot_attempt_count: attempt,
      autopilot_max_attempts: Number(options.max_attempts || 3),
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      created_at: timestamp(),
      updated_at: timestamp()
    };
    tx.set(missionRef, mission);
    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, 'PLANNING', {
        mission_id: missionRef.id,
        started_at: milestoneTimestamp()
      }),
      updated_at: timestamp()
    }, { merge: true });
    created = { mission, milestone, roadmap };
  });

  return created;
}

async function queueVerificationBrainRun(db, tenantId, executionResult) {
  const missionRef = db.collection('missions').doc(executionResult.mission_id);
  const runRef = db.collection('runs').doc();
  let queued = null;

  await db.runTransaction(async (tx) => {
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) return;
    const mission = { id: missionSnap.id, ...missionSnap.data() };
    if (!mission.autopilot_mode || !mission.roadmap_id || !mission.milestone_id) return;

    const roadmapRef = db.collection('roadmaps').doc(mission.roadmap_id);
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) return;
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const milestone = (roadmap.milestones || []).find((item) => item.id === mission.milestone_id);
    if (!milestone) return;

    const report = {
      success: executionResult.success === true,
      execution_run_id: executionResult.run_id,
      task_id: executionResult.task_id,
      result_id: executionResult.result_id,
      summary: clean(executionResult.summary || ''),
      output: executionResult.output || null,
      error: executionResult.error || null
    };

    tx.set(runRef, {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: mission.id,
      task_id: null,
      workspace_id: mission.workspace_id || null,
      project_id: mission.project_id || null,
      worker_id: mission.preferred_worker_id || 'W01',
      executor_id: null,
      parent_run_id: executionResult.run_id,
      parent_execution_run_id: executionResult.run_id,
      objective: `Verify executor result for roadmap milestone: ${milestone.title}`,
      roadmap_title: roadmap.title || '',
      roadmap_objective: roadmap.objective || '',
      milestone_title: milestone.title || '',
      milestone_description: milestone.description || '',
      state: 'RUNNING',
      autopilot_mode: true,
      autopilot_phase: 'VERIFY_EXECUTION',
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      executor_report: report,
      progress_percent: 0,
      progress_message: 'Executor reported; Brain verification queued',
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    });
    tx.set(missionRef, {
      state: 'RUNNING',
      autopilot_phase: 'VERIFYING',
      verification_brain_run_id: runRef.id,
      completed_at: null,
      updated_at: timestamp()
    }, { merge: true });
    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, 'VERIFYING', {
        mission_id: mission.id,
        verification_brain_run_id: runRef.id
      }),
      updated_at: timestamp()
    }, { merge: true });
    queued = { verification_run_id: runRef.id, roadmap_id: roadmap.id, milestone_id: milestone.id };
  });
  return queued;
}

async function completeVerificationBrainRun(db, tenantId, runId, input = {}) {
  const runRef = db.collection('runs').doc(runId);
  let result = null;
  await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
      const error = new Error('RUN_NOT_FOUND'); error.status = 404; throw error;
    }
    const run = { id: runSnap.id, ...runSnap.data() };
    if (run.run_type !== 'BRAIN_RUN' || run.state !== 'RUNNING' || run.autopilot_phase !== 'VERIFY_EXECUTION') {
      const error = new Error('AUTOPILOT_VERIFICATION_RUN_NOT_ACTIVE'); error.status = 409; throw error;
    }
    const missionRef = db.collection('missions').doc(run.mission_id);
    const roadmapRef = db.collection('roadmaps').doc(run.roadmap_id);
    const missionSnap = await tx.get(missionRef);
    const roadmapSnap = await tx.get(roadmapRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
    }
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
    }
    const mission = { id: missionSnap.id, ...missionSnap.data() };
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const milestone = (roadmap.milestones || []).find((item) => item.id === run.milestone_id);
    if (!milestone) {
      const error = new Error('MILESTONE_NOT_FOUND'); error.status = 404; throw error;
    }

    let priorAllowedFiles = [];
    if (mission.current_task_id) {
      const priorTaskSnap = await tx.get(db.collection('tasks').doc(mission.current_task_id));
      if (priorTaskSnap.exists && priorTaskSnap.data().tenant_id === tenantId) {
        const priorTask = priorTaskSnap.data();
        const source = Array.isArray(priorTask.task_spec?.allowed_files)
          ? priorTask.task_spec.allowed_files
          : Array.isArray(priorTask.brain_output?.task_spec?.allowed_files)
            ? priorTask.brain_output.task_spec.allowed_files
            : [];
        priorAllowedFiles = source.map((x) => clean(x, 1000).replace(/\\/g, '/')).filter(Boolean);
      }
    }

    const outputText = clean(input.output_text || input.summary || '', 100000);
    const decision = parseAutopilotDecision(outputText);
    const attempt = Number(mission.autopilot_attempt_count || 1);
    const maxAttempts = Math.max(1, Number(mission.autopilot_max_attempts || 3));
    if (decision.action === 'RETRY' && attempt >= maxAttempts) {
      decision.action = 'BLOCKED';
      decision.reason = `Automatic retry limit reached (${attempt}/${maxAttempts}). ${decision.reason}`.trim();
    }

    tx.set(runRef, {
      state: 'COMPLETED',
      progress_percent: 100,
      progress_message: `Autopilot decision: ${decision.action}`,
      output_text: outputText,
      autopilot_decision: decision,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    if (decision.action === 'COMPLETE') {
      const allMilestones = milestoneWithState(roadmap, milestone.id, 'COMPLETED', {
        completed_at: milestoneTimestamp(),
        verification_brain_run_id: run.id
      });
      const roadmapCompleted = allMilestones.every((item) => ['COMPLETED', 'SKIPPED'].includes(item.state));
      tx.set(roadmapRef, {
        milestones: allMilestones,
        state: roadmapCompleted ? 'COMPLETED' : roadmap.state,
        updated_at: timestamp()
      }, { merge: true });
      tx.set(missionRef, {
        state: 'COMPLETED',
        autopilot_phase: 'COMPLETED',
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: true,
        action: 'COMPLETE',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        auto_advance: roadmap.auto_advance === true && !roadmapCompleted,
        reason: decision.reason
      };
      return;
    }

    if (decision.action === 'RETRY') {
      if (!decision.execution_spec?.instructions) {
        decision.action = 'BLOCKED';
        decision.reason = `${decision.reason} RETRY requires execution_spec.instructions.`.trim();
      } else if (!Array.isArray(decision.execution_spec.allowed_files) || decision.execution_spec.allowed_files.length === 0) {
        decision.action = 'BLOCKED';
        decision.reason = `${decision.reason} RETRY requires Brain-defined execution_spec.allowed_files.`.trim();
      } else {
        const taskRef = db.collection('tasks').doc();
        const cumulativeAllowedFiles = [...new Set([
          ...priorAllowedFiles,
          ...(decision.execution_spec.allowed_files || [])
        ].map((x) => clean(x, 1000).replace(/\\/g, '/')).filter(Boolean))].slice(0, 100);
        tx.set(taskRef, {
          id: taskRef.id,
          tenant_id: tenantId,
          mission_id: mission.id,
          workspace_id: mission.workspace_id || null,
          project_id: mission.project_id || null,
          worker_id: mission.preferred_worker_id || 'W01',
          title: `Autopilot retry: ${milestone.title}`,
          objective: `Apply Brain correction for ${milestone.title}`,
          task_spec: {
            title: `Autopilot retry: ${milestone.title}`,
            objective: `Apply Brain correction for ${milestone.title}`,
            instructions: decision.execution_spec.instructions,
            allowed_files: cumulativeAllowedFiles,
            success_criteria: decision.execution_spec.success_criteria,
            stop_conditions: decision.execution_spec.stop_conditions
          },
          brain_output: {
            objective: `Apply Brain correction for ${milestone.title}`,
            worker_id: mission.preferred_worker_id || 'W01',
            requires_execution: true,
            execution_type: 'CODEX',
            task_spec: {
              title: `Autopilot retry: ${milestone.title}`,
              objective: `Apply Brain correction for ${milestone.title}`,
              instructions: decision.execution_spec.instructions,
              allowed_files: cumulativeAllowedFiles,
              success_criteria: decision.execution_spec.success_criteria,
              stop_conditions: decision.execution_spec.stop_conditions
            },
            execution_constraints: {
              no_gcp: true,
              no_cloud_run: true,
              no_deploy: true,
              deployment: 'HUMAN_MANUAL_DEPLOY'
            },
            brain_run_id: run.id,
            tenant_id: tenantId,
            workspace_id: mission.workspace_id || null,
            project_id: mission.project_id || null,
            mission_id: mission.id
          },
          execution_constraints: {
            no_gcp: true,
            no_cloud_run: true,
            no_deploy: true,
            deployment: 'HUMAN_MANUAL_DEPLOY'
          },
          priority: mission.priority || 'NORMAL',
          state: 'QUEUED',
          phase: 'EXECUTION_PENDING',
          autopilot_phase: 'RETRY',
          attempt_count: attempt + 1,
          brain_run_id: run.id,
          brain_completed_at: timestamp(),
          current_run_id: null,
          claimed_by_executor_id: null,
          created_at: timestamp(),
          updated_at: timestamp()
        });
        tx.set(missionRef, {
          state: 'RUNNING',
          autopilot_phase: 'RETRY_EXECUTION',
          autopilot_attempt_count: attempt + 1,
          current_task_id: taskRef.id,
          autopilot_allowed_files: cumulativeAllowedFiles,
          updated_at: timestamp()
        }, { merge: true });
        tx.set(roadmapRef, {
          milestones: milestoneWithState(roadmap, milestone.id, 'RUNNING', {
            mission_id: mission.id,
            last_retry_brain_run_id: run.id
          }),
          updated_at: timestamp()
        }, { merge: true });
        result = {
          success: true,
          action: 'RETRY',
          roadmap_id: roadmap.id,
          milestone_id: milestone.id,
          mission_id: mission.id,
          task_id: taskRef.id,
          attempt: attempt + 1,
          reason: decision.reason
        };
        return;
      }
    }

    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, 'BLOCKED', {
        blocked_reason: decision.reason,
        verification_brain_run_id: run.id
      }),
      state: 'BLOCKED',
      updated_at: timestamp()
    }, { merge: true });
    tx.set(missionRef, {
      state: 'BLOCKED',
      autopilot_phase: 'BLOCKED',
      blocker_code: 'AUTOPILOT_BLOCKED',
      blocker_message: decision.reason,
      updated_at: timestamp()
    }, { merge: true });
    result = {
      success: false,
      action: 'BLOCKED',
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      mission_id: mission.id,
      reason: decision.reason
    };
  });
  return result;
}

module.exports = {
  AUTOPILOT_ACTIONS,
  parseAutopilotDecision,
  startNextRoadmapMilestone,
  queueVerificationBrainRun,
  completeVerificationBrainRun
};
