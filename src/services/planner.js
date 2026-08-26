let FieldValue;
try {
  ({ FieldValue } = require('@google-cloud/firestore'));
} catch {
  FieldValue = { serverTimestamp: () => new Date() };
}

function timestamp() {
  return FieldValue.serverTimestamp();
}

function cleanText(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function requiredText(value, fieldName, max = 4000) {
  const text = cleanText(value, max);
  if (!text) {
    const error = new Error(`${fieldName}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}

function stringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    const error = new Error(`${fieldName}_MUST_BE_ARRAY`);
    error.status = 400;
    throw error;
  }
  return value.map((item) => {
    if (typeof item !== 'string') {
      const error = new Error(`${fieldName}_MUST_BE_ARRAY_OF_STRINGS`);
      error.status = 400;
      throw error;
    }
    const text = cleanText(item, 1000);
    if (!text) {
      const error = new Error(`${fieldName}_MUST_BE_ARRAY_OF_STRINGS`);
      error.status = 400;
      throw error;
    }
    return text;
  });
}

function findFirstJsonObject(source) {
  const text = String(source || '');
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseProposal(input = {}) {
  if (input.proposal && typeof input.proposal === 'object') return input.proposal;
  if (input.roadmap_proposal && typeof input.roadmap_proposal === 'object') return input.roadmap_proposal;

  const raw = String(input.output_text || input.summary || '');
  const tagged = raw.match(/<MRAPI_ROADMAP_PROPOSAL>([\s\S]*?)<\/MRAPI_ROADMAP_PROPOSAL>/i);
  const jsonText = findFirstJsonObject(tagged ? tagged[1] : raw);
  if (!jsonText) {
    const error = new Error('PLANNER_PROPOSAL_JSON_REQUIRED');
    error.status = 400;
    throw error;
  }

  try {
    return JSON.parse(jsonText);
  } catch {
    const error = new Error('PLANNER_PROPOSAL_JSON_INVALID');
    error.status = 400;
    throw error;
  }
}

function validateAcyclic(milestones) {
  const byId = new Map(milestones.map((item) => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const error = new Error('PLANNER_PROPOSAL_CYCLIC_DEPENDENCIES');
      error.status = 400;
      throw error;
    }
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }

  for (const milestone of milestones) visit(milestone.id);
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireExplicitApproval(input = {}) {
  if (
    input.approve === true ||
    input.confirm_approval === true ||
    input.approval_intent === 'APPROVE_PLANNER_ROADMAP'
  ) {
    return;
  }
  fail('EXPLICIT_PLANNER_ROADMAP_APPROVAL_REQUIRED', 400);
}

function validateStoredPlannerRoadmap(roadmap) {
  if (!roadmap || typeof roadmap !== 'object' || Array.isArray(roadmap)) {
    fail('PLANNER_ROADMAP_OBJECT_REQUIRED', 400);
  }
  if (roadmap.proposal_type !== 'PLANNER_ROADMAP') {
    fail('PLANNER_ROADMAP_NOT_APPROVABLE', 409);
  }
  if (!cleanText(roadmap.title, 500)) fail('PLANNER_PROPOSAL_TITLE_REQUIRED', 400);
  if (!cleanText(roadmap.objective, 6000)) fail('PLANNER_PROPOSAL_OBJECTIVE_REQUIRED', 400);
  if (!cleanText(roadmap.summary, 10000)) fail('PLANNER_PROPOSAL_SUMMARY_REQUIRED', 400);
  if (!Array.isArray(roadmap.milestones) || roadmap.milestones.length === 0) {
    fail('PLANNER_PROPOSAL_MILESTONES_REQUIRED', 400);
  }

  const seen = new Set();
  const milestones = roadmap.milestones.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('PLANNER_PROPOSAL_MILESTONE_OBJECT_REQUIRED', 400);
    }
    const id = cleanText(item.id, 160);
    if (!id) fail('PLANNER_PROPOSAL_MILESTONE_ID_REQUIRED', 400);
    if (seen.has(id)) fail('PLANNER_PROPOSAL_DUPLICATE_MILESTONE_ID', 400);
    seen.add(id);
    if (!cleanText(item.title, 500)) fail('PLANNER_PROPOSAL_MILESTONE_TITLE_REQUIRED', 400);
    if (!cleanText(item.objective || item.expected_outcome, 6000)) {
      fail('PLANNER_PROPOSAL_MILESTONE_OBJECTIVE_REQUIRED', 400);
    }
    if (!cleanText(item.description, 8000)) fail('PLANNER_PROPOSAL_MILESTONE_DESCRIPTION_REQUIRED', 400);
    if (typeof item.executor_required !== 'boolean') {
      fail('PLANNER_PROPOSAL_EXECUTOR_REQUIRED_REQUIRED', 400);
    }
    const dependencies = Array.isArray(item.dependencies) ? item.dependencies : item.depends_on;
    if (!Array.isArray(dependencies)) {
      fail('PLANNER_PROPOSAL_MILESTONE_DEPENDENCIES_MUST_BE_ARRAY', 400);
    }
    if (!Array.isArray(item.success_criteria) || item.success_criteria.length === 0) {
      fail('PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA_REQUIRED', 400);
    }
    stringArray(dependencies, 'PLANNER_PROPOSAL_MILESTONE_DEPENDENCIES');
    stringArray(item.risks ?? [], 'PLANNER_PROPOSAL_MILESTONE_RISKS');
    stringArray(item.success_criteria, 'PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA');
    return {
      id,
      dependencies,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index + 1
    };
  });

  for (const milestone of milestones) {
    for (const dependency of milestone.dependencies) {
      if (dependency === milestone.id) fail('PLANNER_PROPOSAL_SELF_DEPENDENCY', 400);
      if (!seen.has(dependency)) fail('PLANNER_PROPOSAL_UNKNOWN_DEPENDENCY', 400);
    }
  }
  validateAcyclic(milestones);
}

function validateProposal(rawProposal) {
  if (!rawProposal || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
    const error = new Error('PLANNER_PROPOSAL_OBJECT_REQUIRED');
    error.status = 400;
    throw error;
  }
  const proposal = rawProposal;
  const title = requiredText(proposal.title, 'PLANNER_PROPOSAL_TITLE', 500);
  const objective = requiredText(proposal.objective, 'PLANNER_PROPOSAL_OBJECTIVE', 6000);
  const summary = requiredText(proposal.summary, 'PLANNER_PROPOSAL_SUMMARY', 10000);

  if (!Array.isArray(proposal.milestones) || proposal.milestones.length === 0) {
    const error = new Error('PLANNER_PROPOSAL_MILESTONES_REQUIRED');
    error.status = 400;
    throw error;
  }

  const seen = new Set();
  const milestones = proposal.milestones.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      const error = new Error('PLANNER_PROPOSAL_MILESTONE_OBJECT_REQUIRED');
      error.status = 400;
      throw error;
    }
    const id = requiredText(item.id, 'PLANNER_PROPOSAL_MILESTONE_ID', 160);
    const milestoneTitle = requiredText(item.title, 'PLANNER_PROPOSAL_MILESTONE_TITLE', 500);
    const milestoneObjective = requiredText(item.objective, 'PLANNER_PROPOSAL_MILESTONE_OBJECTIVE', 6000);
    const description = requiredText(item.description, 'PLANNER_PROPOSAL_MILESTONE_DESCRIPTION', 8000);
    if (seen.has(id)) {
      const error = new Error('PLANNER_PROPOSAL_DUPLICATE_MILESTONE_ID');
      error.status = 400;
      throw error;
    }
    if (typeof item?.executor_required !== 'boolean') {
      const error = new Error('PLANNER_PROPOSAL_EXECUTOR_REQUIRED_REQUIRED');
      error.status = 400;
      throw error;
    }
    seen.add(id);
    const dependencies = stringArray(item.dependencies ?? [], 'PLANNER_PROPOSAL_MILESTONE_DEPENDENCIES');
    const successCriteria = stringArray(item.success_criteria, 'PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA');
    if (successCriteria.length === 0) {
      const error = new Error('PLANNER_PROPOSAL_MILESTONE_SUCCESS_CRITERIA_REQUIRED');
      error.status = 400;
      throw error;
    }

    return {
      id,
      title: milestoneTitle,
      objective: milestoneObjective,
      expected_outcome: milestoneObjective,
      description,
      executor_required: item.executor_required,
      dependencies,
      depends_on: dependencies,
      risks: stringArray(item?.risks ?? [], 'PLANNER_PROPOSAL_MILESTONE_RISKS'),
      success_criteria: successCriteria,
      state: 'PROPOSED',
      order: index + 1
    };
  });

  for (const milestone of milestones) {
    for (const dependency of milestone.dependencies) {
      if (dependency === milestone.id) {
        const error = new Error('PLANNER_PROPOSAL_SELF_DEPENDENCY');
        error.status = 400;
        throw error;
      }
      if (!seen.has(dependency)) {
        const error = new Error('PLANNER_PROPOSAL_UNKNOWN_DEPENDENCY');
        error.status = 400;
        throw error;
      }
    }
  }
  validateAcyclic(milestones);

  return {
    title,
    objective,
    summary,
    risks: stringArray(proposal.risks ?? [], 'PLANNER_PROPOSAL_RISKS'),
    dependencies: stringArray(proposal.dependencies ?? [], 'PLANNER_PROPOSAL_DEPENDENCIES'),
    assumptions: stringArray(proposal.assumptions ?? [], 'PLANNER_PROPOSAL_ASSUMPTIONS'),
    state: 'PROPOSED',
    approval_status: 'PENDING',
    approved_at: null,
    auto_advance: false,
    milestones
  };
}

function trustedProjectContext(project) {
  return {
    id: project.id,
    workspace_id: project.workspace_id || null,
    repository_url: project.repository_url || null,
    repository_full_name: project.repository_full_name || null,
    local_path: project.local_path || project.runtime_context?.repository_path || null,
    default_branch: project.default_branch || null,
    default_worker_id: project.default_worker_id || null,
    primary_worker_ids: Array.isArray(project.primary_worker_ids) ? project.primary_worker_ids : [],
    reusable_instructions: project.reusable_instructions || '',
    runtime_context: project.runtime_context && typeof project.runtime_context === 'object'
      ? project.runtime_context
      : {}
  };
}

function plannerBrainContext({ tenantId, workspace, project, request }) {
  const scope = {
    tenant_id: tenantId,
    workspace_id: workspace.id,
    project_id: project.id
  };
  return {
    planner_contract: 'ROADMAP_PROPOSAL_V1',
    natural_language_request: request,
    trusted_scope: scope,
    workspace_context: {
      id: workspace.id,
      name: workspace.name || null,
      description: workspace.description || null
    },
    project_context: trustedProjectContext(project),
    instructions: [
      'Produce a structured non-executable roadmap proposal for human review.',
      'Do not approve, start, or request Codex execution.',
      'Return proposal fields: title, objective, summary, risks, dependencies, assumptions, milestones[].',
      'Each milestone requires id, title, objective or expected_outcome, description, executor_required, dependencies, risks, success_criteria.'
    ]
  };
}

function responseShape(roadmap) {
  return {
    roadmap_id: roadmap.id,
    proposal_id: roadmap.id,
    state: roadmap.state,
    approval_status: roadmap.approval_status || null,
    approved_at: roadmap.approved_at || null,
    approved_by: roadmap.approved_by || null,
    auto_advance: roadmap.auto_advance === true,
    title: roadmap.title,
    objective: roadmap.objective,
    summary: roadmap.summary || '',
    milestones: roadmap.milestones || [],
    risks: roadmap.risks || [],
    dependencies: roadmap.dependencies || [],
    assumptions: roadmap.assumptions || [],
    request_id: roadmap.planner_request_id || null,
    planner_request_id: roadmap.planner_request_id || null,
    mission_id: roadmap.source_planner_mission_id || null,
    brain_run_id: roadmap.source_planner_brain_run_id || null,
    original_request: roadmap.original_request || null,
    provenance: roadmap.provenance || null,
    approval: roadmap.approval || null
  };
}

async function createPlannerRequest(db, tenantId, input = {}) {
  const request = cleanText(input.request ?? input.prompt ?? input.objective, 50000);
  if (!request) {
    const error = new Error('PLANNER_REQUEST_REQUIRED');
    error.status = 400;
    throw error;
  }

  const workspaceId = cleanText(input.workspace_id, 300);
  const projectId = cleanText(input.project_id, 300);
  if (!workspaceId) {
    const error = new Error('WORKSPACE_ID_REQUIRED');
    error.status = 400;
    throw error;
  }
  if (!projectId) {
    const error = new Error('PROJECT_ID_REQUIRED');
    error.status = 400;
    throw error;
  }

  const workspaceRef = db.collection('workspaces').doc(workspaceId);
  const projectRef = db.collection('projects').doc(projectId);
  const missionRef = db.collection('missions').doc();
  const runRef = db.collection('runs').doc();
  let result;

  await db.runTransaction(async (tx) => {
    const workspaceSnap = await tx.get(workspaceRef);
    const projectSnap = await tx.get(projectRef);
    if (!workspaceSnap.exists || workspaceSnap.data().tenant_id !== tenantId) {
      const error = new Error('WORKSPACE_NOT_FOUND');
      error.status = 404;
      throw error;
    }
    if (
      !projectSnap.exists ||
      projectSnap.data().tenant_id !== tenantId ||
      projectSnap.data().workspace_id !== workspaceId
    ) {
      const error = new Error('PROJECT_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const workspace = { id: workspaceSnap.id, ...workspaceSnap.data() };
    const project = { id: projectSnap.id, ...projectSnap.data() };
    const brainContext = plannerBrainContext({ tenantId, workspace, project, request });
    const workerId = (project.primary_worker_ids || [])[0] || project.default_worker_id || 'W01';
    const objective = [
      'PLANNER ROADMAP REQUEST',
      '',
      request,
      '',
      'TRUSTED_SCOPE',
      JSON.stringify(brainContext.trusted_scope),
      '',
      'PROJECT_CONTEXT',
      JSON.stringify(brainContext.project_context)
    ].join('\n').slice(0, 100000);

    const mission = {
      id: missionRef.id,
      tenant_id: tenantId,
      workspace_id: workspace.id,
      project_id: project.id,
      objective,
      original_prompt: request,
      preferred_worker_id: workerId,
      priority: 'NORMAL',
      state: 'PLANNING',
      planning_mode: 'PLANNER_ROADMAP_PROPOSAL',
      approval_status: 'PENDING',
      planner_request: request,
      planner_request_id: missionRef.id,
      non_executable: true,
      created_at: timestamp(),
      updated_at: timestamp()
    };

    const run = {
      id: runRef.id,
      tenant_id: tenantId,
      run_type: 'BRAIN_RUN',
      mission_id: missionRef.id,
      task_id: null,
      workspace_id: workspace.id,
      project_id: project.id,
      worker_id: workerId,
      executor_id: null,
      parent_run_id: null,
      objective,
      state: 'RUNNING',
      progress_percent: 0,
      progress_message: 'Planner roadmap proposal requested; Brain Run started',
      planning_mode: 'PLANNER_ROADMAP_PROPOSAL',
      planner_request_id: missionRef.id,
      planner_request: request,
      brain_context: brainContext,
      non_executable: true,
      started_at: timestamp(),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(missionRef, mission);
    tx.set(runRef, run);
    result = {
      success: true,
      request_id: missionRef.id,
      planner_request_id: missionRef.id,
      mission_id: missionRef.id,
      brain_run_id: runRef.id,
      state: 'PLANNING',
      brain_context: brainContext
    };
  });

  return result;
}

async function getPlannerProposal(db, tenantId, proposalId) {
  const snap = await db.collection('roadmaps').doc(proposalId).get();
  if (!snap.exists || snap.data().tenant_id !== tenantId || snap.data().proposal_type !== 'PLANNER_ROADMAP') {
    const error = new Error('PLANNER_PROPOSAL_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  return responseShape({ id: snap.id, ...snap.data() });
}

async function approvePlannerRoadmap(db, tenantId, roadmapId, input = {}) {
  requireExplicitApproval(input);
  const roadmapRef = db.collection('roadmaps').doc(roadmapId);
  let result;

  await db.runTransaction(async (tx) => {
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      fail('PLANNER_ROADMAP_NOT_FOUND', 404);
    }

    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    if (roadmap.proposal_type !== 'PLANNER_ROADMAP') {
      fail('PLANNER_ROADMAP_NOT_APPROVABLE', 409);
    }

    const sourceMissionRef = roadmap.source_planner_mission_id
      ? db.collection('missions').doc(roadmap.source_planner_mission_id)
      : null;
    const sourceMissionSnap = sourceMissionRef ? await tx.get(sourceMissionRef) : null;
    const sourceMission = sourceMissionSnap?.exists ? sourceMissionSnap.data() : null;

    if (!sourceMissionRef || !sourceMissionSnap.exists || sourceMission.tenant_id !== tenantId) {
      fail('PLANNER_SOURCE_MISSION_NOT_FOUND', 409);
    }
    if (sourceMission.state === 'CANCELLED' || sourceMission.cancellation_requested === true) {
      fail('PLANNER_SOURCE_MISSION_CANCELLED', 409);
    }

    if (roadmap.state === 'ACTIVE' && roadmap.approval_status === 'APPROVED') {
      validateStoredPlannerRoadmap(roadmap);
      result = responseShape(roadmap);
      return;
    }

    if (roadmap.state !== 'PROPOSED' || roadmap.approval_status !== 'PENDING' || roadmap.non_executable !== true) {
      fail('PLANNER_ROADMAP_NOT_APPROVABLE', 409);
    }

    validateStoredPlannerRoadmap(roadmap);

    const milestones = roadmap.milestones.map((milestone) => {
      if (milestone.state !== 'PROPOSED' && milestone.state !== 'PENDING') {
        fail('PLANNER_ROADMAP_MILESTONE_NOT_APPROVABLE', 409);
      }
      const dependencies = Array.isArray(milestone.dependencies)
        ? [...milestone.dependencies]
        : [...(milestone.depends_on || [])];
      return {
        ...milestone,
        dependencies,
        depends_on: Array.isArray(milestone.depends_on) ? [...milestone.depends_on] : dependencies,
        state: 'PENDING'
      };
    });

    const approval = {
      status: 'APPROVED',
      state: 'APPROVED',
      approved_at: timestamp(),
      source: 'PLANNER_ROADMAP_APPROVAL'
    };
    const actor = cleanText(input.actor_id || '', 300);
    if (actor) approval.approved_by = actor;
    const requestId = cleanText(input.request_id || '', 300);
    if (requestId) approval.request_id = requestId;

    const update = {
      state: 'ACTIVE',
      approval_status: 'APPROVED',
      approved_at: approval.approved_at,
      approved_by: approval.approved_by || null,
      approval,
      non_executable: false,
      milestones,
      updated_at: timestamp()
    };

    tx.set(roadmapRef, update, { merge: true });
    tx.set(sourceMissionRef, {
      state: 'COMPLETED',
      approval_status: 'APPROVED',
      planner_roadmap_approved: true,
      planner_roadmap_approved_at: approval.approved_at,
      approved_at: approval.approved_at,
      approved_by: approval.approved_by || null,
      updated_at: timestamp()
    }, { merge: true });
    result = responseShape({ ...roadmap, ...update, id: roadmap.id });
  });

  return result;
}

async function startPlannerRoadmap(db, tenantId, roadmapId, input = {}) {
  const { startNextRoadmapMilestone } = require('./autopilot');
  return startNextRoadmapMilestone(db, tenantId, roadmapId, {
    planner_handoff: true,
    dispatch_brain_run: true,
    max_attempts: input.max_attempts || 3
  });
}

async function completePlannerBrainRun(db, tenantId, runId, input = {}) {
  const runRef = db.collection('runs').doc(runId);
  const preflight = await runRef.get();
  if (!preflight.exists || preflight.data().tenant_id !== tenantId) {
    const error = new Error('RUN_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const runData = preflight.data();
  if (runData.planning_mode !== 'PLANNER_ROADMAP_PROPOSAL') {
    const error = new Error('RUN_NOT_PLANNER_BRAIN_RUN');
    error.status = 400;
    throw error;
  }

  if (runData.state === 'COMPLETED' && runData.planner_roadmap_id) {
    return getPlannerProposal(db, tenantId, runData.planner_roadmap_id);
  }

  let parsedProposal;
  try {
    parsedProposal = validateProposal(parseProposal(input));
  } catch (error) {
    await db.runTransaction(async (tx) => {
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) return;
      const run = runSnap.data();
      if (run.state !== 'RUNNING') return;
      const missionRef = db.collection('missions').doc(run.mission_id);
      const missionSnap = await tx.get(missionRef);
      if (missionSnap.exists && missionSnap.data().tenant_id === tenantId) {
        tx.set(missionRef, {
          state: 'BLOCKED',
          blocker_code: error.message,
          blocker_stage: 'PLANNER_PROPOSAL_VALIDATION',
          blocker_message: error.message,
          updated_at: timestamp()
        }, { merge: true });
      }
      tx.set(runRef, {
        state: 'FAILED',
        progress_message: 'Planner proposal validation failed',
        error: error.message,
        output_text: String(input.output_text || '').slice(0, 100000),
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
    });
    throw error;
  }

  let result;
  await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
      const error = new Error('RUN_NOT_FOUND');
      error.status = 404;
      throw error;
    }
    const run = runSnap.data();
    if (run.state === 'COMPLETED' && run.planner_roadmap_id) {
      result = { reuse_roadmap_id: run.planner_roadmap_id };
      return;
    }
    if (run.state !== 'RUNNING') {
      const error = new Error('PLANNER_BRAIN_RUN_NOT_ACTIVE');
      error.status = 409;
      throw error;
    }

    const missionRef = db.collection('missions').doc(run.mission_id);
    const missionSnap = await tx.get(missionRef);
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND');
      error.status = 404;
      throw error;
    }
    const mission = missionSnap.data();
    if (mission.state === 'CANCELLED' || mission.cancellation_requested === true) {
      tx.set(runRef, {
        state: 'FAILED',
        progress_message: 'Planner completion ignored because Mission is cancelled',
        error: 'MISSION_CANCELLED',
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
      result = {
        cancelled: true,
        success: false,
        mission_id: run.mission_id,
        brain_run_id: runId,
        error: 'MISSION_CANCELLED'
      };
      return;
    }

    const roadmapRef = db.collection('roadmaps').doc();
    const roadmap = {
      id: roadmapRef.id,
      ...parsedProposal,
      tenant_id: tenantId,
      workspace_id: run.workspace_id || mission.workspace_id || null,
      project_id: run.project_id || mission.project_id || null,
      proposal_type: 'PLANNER_ROADMAP',
      planner_request_id: run.planner_request_id || mission.planner_request_id || mission.id,
      original_request: run.planner_request || mission.planner_request || mission.original_prompt || '',
      source_planner_mission_id: run.mission_id,
      source_planner_brain_run_id: runId,
      source_brain_run_id: runId,
      non_executable: true,
      provenance: {
        source: 'PLANNER_BRAIN_RUN',
        mission_id: run.mission_id,
        brain_run_id: runId,
        planner_request_id: run.planner_request_id || mission.planner_request_id || mission.id,
        original_request: run.planner_request || mission.planner_request || mission.original_prompt || ''
      },
      raw_brain_output: String(input.output_text || '').slice(0, 100000),
      created_at: timestamp(),
      updated_at: timestamp()
    };

    tx.set(roadmapRef, roadmap);
    tx.set(runRef, {
      state: 'COMPLETED',
      progress_percent: 100,
      progress_message: 'Planner roadmap proposal ready for review',
      output_text: String(input.output_text || '').slice(0, 100000),
      planner_roadmap_id: roadmapRef.id,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });
    tx.set(missionRef, {
      state: 'READY',
      approval_status: 'PENDING',
      planner_roadmap_id: roadmapRef.id,
      brain_run_id: runId,
      updated_at: timestamp()
    }, { merge: true });
    result = responseShape(roadmap);
  });

  if (result?.reuse_roadmap_id) {
    return getPlannerProposal(db, tenantId, result.reuse_roadmap_id);
  }
  return result;
}

module.exports = {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  approvePlannerRoadmap,
  startPlannerRoadmap,
  validateProposal,
  parseProposal
};
