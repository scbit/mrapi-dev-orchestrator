const crypto = require('crypto');
const { nextMilestone } = require('./roadmap');

const AUTOPILOT_ACTIONS = new Set(['COMPLETE', 'RETRY', 'BLOCKED', 'NEED_HUMAN_ACTION']);

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
    if ('"\\/bfnrtu'.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    out += '\\\\' + next;
    i += 1;
  }
  return out;
}

function parseTaggedAutopilotJson(text) {
  const raw = normalizeBrainTransportText(text);
  const tagged = raw.match(/<MRAPI_AUTOPILOT>\s*([\s\S]*?)\s*<\/MRAPI_AUTOPILOT>/i);
  if (tagged) {
    try { return JSON.parse(tagged[1]); } catch {}
    try { return JSON.parse(escapeInvalidJsonBackslashes(tagged[1])); } catch {}
  }
  const candidate = raw.match(/\{[\s\S]*\}/);
  if (candidate) {
    try { return JSON.parse(candidate[0]); } catch {}
    try { return JSON.parse(escapeInvalidJsonBackslashes(candidate[0])); } catch {}
  }
  return null;
}

function normalizeStringList(value, maxItems = 30, maxLength = 2000) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function checkpointId(seed) {
  return `human_action_${crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 24)}`;
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|private[_-]?key|value/i.test(key)) continue;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      out[key] = typeof item === 'string' ? clean(item, 1000) : item;
    } else if (Array.isArray(item)) {
      out[key] = item
        .filter((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
        .map((entry) => typeof entry === 'string' ? clean(entry, 1000) : entry)
        .slice(0, 50);
    }
  }
  return out;
}

function sanitizeAuditValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return null;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? clean(value, 50000) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|private[_-]?key|value/i.test(key)) continue;
    out[key] = sanitizeAuditValue(item, depth + 1);
  }
  return out;
}

function sanitizeGitStageResult(value) {
  const git = sanitizeAuditValue(value || {});
  if (git && typeof git === 'object') {
    delete git.error;
    if (git.checkpoint && typeof git.checkpoint === 'object') {
      delete git.checkpoint.error;
    }
  }
  return git;
}

function boundedRetryHistory(mission, entry) {
  const existing = Array.isArray(mission.autopilot_retry_history)
    ? mission.autopilot_retry_history
    : Array.isArray(mission.retry_revision_history)
      ? mission.retry_revision_history
      : [];
  return [...existing, sanitizeAuditValue(entry)].slice(-10);
}

function retryExecutionSpecSnapshot(spec) {
  return sanitizeAuditValue({
    title: spec?.title || '',
    objective: spec?.objective || '',
    instructions: spec?.instructions || '',
    allowed_files: Array.isArray(spec?.allowed_files) ? spec.allowed_files : [],
    required_tests: Array.isArray(spec?.required_tests) ? spec.required_tests : [],
    diagnostic_tests: Array.isArray(spec?.diagnostic_tests) ? spec.diagnostic_tests : [],
    success_criteria: Array.isArray(spec?.success_criteria) ? spec.success_criteria : [],
    stop_conditions: Array.isArray(spec?.stop_conditions) ? spec.stop_conditions : [],
    required_env_vars: Array.isArray(spec?.required_env_vars) ? spec.required_env_vars : [],
    required_environment_variables: Array.isArray(spec?.required_environment_variables) ? spec.required_environment_variables : [],
    requires_repository: spec?.requires_repository === true,
    repository_required: spec?.repository_required === true,
    prerequisites: Array.isArray(spec?.prerequisites) ? spec.prerequisites : [],
    execution_prerequisites: Array.isArray(spec?.execution_prerequisites) ? spec.execution_prerequisites : [],
    preflight: spec?.preflight || null
  });
}

function retryTaskSpec(milestone, executionSpec) {
  return {
    title: `Autopilot retry: ${milestone.title}`,
    objective: `Apply Brain correction for ${milestone.title}`,
    instructions: executionSpec.instructions,
    allowed_files: executionSpec.allowed_files,
    required_tests: executionSpec.required_tests,
    diagnostic_tests: executionSpec.diagnostic_tests,
    success_criteria: executionSpec.success_criteria,
    stop_conditions: executionSpec.stop_conditions,
    required_env_vars: executionSpec.required_env_vars,
    required_environment_variables: executionSpec.required_environment_variables,
    requires_repository: executionSpec.requires_repository,
    repository_required: executionSpec.repository_required,
    prerequisites: executionSpec.prerequisites,
    execution_prerequisites: executionSpec.execution_prerequisites,
    preflight: executionSpec.preflight
  };
}

function gitAutomationEnabled({ mission = {}, project = {}, milestone = {} } = {}) {
  const runtime = project.runtime_context && typeof project.runtime_context === 'object' ? project.runtime_context : {};
  return mission.git_automation_enabled === true ||
    mission.autopilot_git_enabled === true ||
    project.git_automation_enabled === true ||
    runtime.git_automation_enabled === true ||
    milestone.git_automation_enabled === true ||
    milestone.autopilot_git_enabled === true;
}

function gitStageTaskSpec(milestone, priorTask) {
  const source = priorTask?.task_spec && typeof priorTask.task_spec === 'object' ? priorTask.task_spec : {};
  return {
    title: `Autopilot Git stage: ${milestone.title}`,
    objective: source.objective || `Persist verified changes for ${milestone.title}`,
    instructions: 'Run the explicit Autopilot Git stage only. Do not modify source files.',
    allowed_files: Array.isArray(source.allowed_files) ? source.allowed_files : [],
    required_tests: [],
    diagnostic_tests: [],
    success_criteria: ['Git stage completed successfully or reported NO_CHANGES.'],
    stop_conditions: ['Do not run programming work.', 'Do not deploy.']
  };
}

function gitStageBrainOutput({ tenantId, mission, run, milestone, taskSpec }) {
  return {
    objective: `Git stage for verified milestone ${milestone.title}`,
    worker_id: mission.preferred_worker_id || 'W01',
    requires_execution: true,
    execution_type: 'GIT_STAGE',
    task_spec: taskSpec,
    execution_constraints: {
      no_gcp: true,
      no_cloud_run: true,
      no_deploy: true,
      deployment: 'HUMAN_MANUAL_DEPLOY',
      autopilot_phase: 'GIT_STAGE'
    },
    tenant_id: tenantId,
    workspace_id: mission.workspace_id || null,
    project_id: mission.project_id || null,
    mission_id: mission.id,
    roadmap_id: mission.roadmap_id || null,
    milestone_id: mission.milestone_id || null,
    verification_brain_run_id: run.id
  };
}

function retryBrainOutput({ tenantId, mission, run, milestone, taskSpec }) {
  return {
    objective: `Apply Brain correction for ${milestone.title}`,
    worker_id: mission.preferred_worker_id || 'W01',
    requires_execution: true,
    execution_type: 'CODEX',
    task_spec: taskSpec,
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
  };
}

function normalizeHumanActionCheckpoint(input = {}, existing = null) {
  const now = milestoneTimestamp();
  const checkpointType = clean(input.checkpoint_type || input.type || 'PREREQUISITE', 120).toUpperCase();
  const requirementType = clean(input.requirement_type || checkpointType, 120).toUpperCase();
  const seed = input.checkpoint_seed || [
    input.tenant_id,
    input.roadmap_id,
    input.milestone_id,
    input.mission_id,
    checkpointType,
    requirementType,
    input.requirement_key || input.human_action_request || input.user_action
  ].filter(Boolean).join(':');
  const prior = existing && existing.human_action_required === true ? existing : null;
  return {
    human_action_required: true,
    checkpoint_id: prior?.checkpoint_id || input.checkpoint_id || checkpointId(seed),
    checkpoint_type: checkpointType,
    requirement_type: requirementType,
    human_action_request: clean(input.human_action_request || input.request || input.reason || 'Human action is required.', 2000),
    user_action: clean(input.user_action || input.human_action_request || 'Complete the requested action, then rerun validation.', 2000),
    action_location: clean(input.action_location || 'external', 1000),
    validation_method: clean(input.validation_method || 'manual_confirmation', 1000),
    validation_metadata: sanitizeMetadata(input.validation_metadata),
    status: 'WAITING_FOR_HUMAN',
    waiting_status: 'WAITING_FOR_HUMAN',
    roadmap_id: input.roadmap_id || null,
    milestone_id: input.milestone_id || null,
    mission_id: input.mission_id || null,
    brain_run_id: input.brain_run_id || null,
    paused_from_phase: clean(input.paused_from_phase || input.resume_phase || '', 120) || null,
    reason: clean(input.reason || input.blocker_code || '', 1000) || null,
    blocker_code: clean(input.blocker_code || requirementType, 200),
    created_at: prior?.created_at || now,
    updated_at: now
  };
}

function unresolvedHumanActionCheckpoint(milestone) {
  const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
  if (!checkpoint || checkpoint.human_action_required !== true) return null;
  const status = String(checkpoint.status || checkpoint.waiting_status || '').toUpperCase();
  return status === 'WAITING_FOR_HUMAN' || status === 'NEED_HUMAN_ACTION' ? checkpoint : null;
}

function checkpointStatus(checkpoint) {
  return String(checkpoint?.status || checkpoint?.waiting_status || '').toUpperCase();
}

function localPathFromProject(project = {}) {
  const runtime = project.runtime_context && typeof project.runtime_context === 'object'
    ? project.runtime_context
    : {};
  return clean(runtime.repository_path || runtime.local_path || project.repository_path || project.local_path || '', 2000);
}

function capabilityAvailable(name, project = {}, mission = {}) {
  const key = clean(name, 500);
  if (!key) return false;
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
    if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
    const value = context[key];
    return value === true || value === 'available' || value === 'granted' || value === 'enabled';
  }
  return false;
}

function validationMethod(checkpoint) {
  const metadata = checkpoint?.validation_metadata && typeof checkpoint.validation_metadata === 'object'
    ? checkpoint.validation_metadata
    : {};
  return clean(
    checkpoint?.validation_method ||
    checkpoint?.validator ||
    checkpoint?.validator_key ||
    checkpoint?.validator_name ||
    metadata.validation_method ||
    metadata.validator ||
    metadata.validator_key ||
    '',
    1000
  ).toLowerCase().replace(/[\s-]+/g, '_');
}

function manualConfirmationAllowed(checkpoint) {
  return ['manual_confirmation', 'manual_confirm', 'human_confirmation'].includes(validationMethod(checkpoint));
}

function repositoryCleanValidator(checkpoint) {
  const method = validationMethod(checkpoint);
  if (['repository_clean', 'repository_worktree_clean', 'worktree_clean', 'git_worktree_clean'].includes(method)) {
    return true;
  }
  return checkpoint?.repository_clean === true;
}

function validateRepositoryCleanCheckpoint(checkpoint, { project = {} } = {}) {
  const metadata = checkpoint?.validation_metadata && typeof checkpoint.validation_metadata === 'object'
    ? checkpoint.validation_metadata
    : {};
  const repositoryPath = clean(metadata.repository_path || metadata.local_path || localPathFromProject(project), 2000);
  if (!repositoryPath) return { ok: false, message: 'Project repository local path is not configured.' };

  let gitFlow = null;
  try {
    gitFlow = require('../../runner/adapters/git-flow');
  } catch {
    return { ok: false, message: 'Git status validator is not available for repository-clean validation.' };
  }
  const command = gitFlow.resolveGitCommand();
  if (!command) return { ok: false, message: 'Git command is not available for repository-clean validation.' };
  const status = gitFlow.getStatus(repositoryPath, command);
  if (!status.ok) return { ok: false, message: 'Repository worktree status could not be read.' };
  return gitFlow.hasChanges(status.stdout)
    ? { ok: false, message: 'Repository worktree remains dirty.' }
    : { ok: true, message: 'Repository worktree is clean.' };
}

function validateHumanActionCheckpoint(checkpoint, { project = {}, mission = {} } = {}) {
  const requirement = clean(checkpoint?.requirement_type || checkpoint?.checkpoint_type || '', 120).toUpperCase();
  const method = validationMethod(checkpoint);
  const metadata = checkpoint?.validation_metadata && typeof checkpoint.validation_metadata === 'object'
    ? checkpoint.validation_metadata
    : {};

  if (requirement === 'MANUAL_DEPLOY') {
    return {
      ok: false,
      message: 'Deployment identity validation is not implemented until the Cloud Run deploy checkpoint milestone.'
    };
  }

  if (repositoryCleanValidator(checkpoint)) {
    return validateRepositoryCleanCheckpoint(checkpoint, { project, mission });
  }

  if (['ENV_VAR', 'ENVIRONMENT_VARIABLE', 'ENVIRONMENT_VARIABLES', 'REQUIRED_ENV_VAR'].includes(requirement)) {
    const name = clean(metadata.env_var_name || metadata.name || metadata.variable_name || '', 500);
    if (!name) return { ok: false, malformed: true, message: 'Environment variable checkpoint is missing a variable name.' };
    return process.env[name]
      ? { ok: true, message: `Environment variable ${name} is configured.` }
      : { ok: false, message: `Environment variable ${name} is not configured.` };
  }

  if (['REPOSITORY_LOCAL_PATH', 'REPOSITORY', 'LOCAL_PATH'].includes(requirement)) {
    const path = localPathFromProject(project);
    if (!path) return { ok: false, message: 'Project repository local path is not configured.' };
    const predicate = clean(metadata.path_predicate || metadata.predicate || '', 300).toLowerCase();
    if (predicate && !['present', 'exists', 'configured', 'non_empty'].includes(predicate)) {
      return { ok: false, message: `Repository local path predicate ${predicate} is not supported yet.` };
    }
    return { ok: true, message: 'Project repository local path is configured.' };
  }

  if (['CAPABILITY', 'PERMISSION', 'ACCESS'].includes(requirement)) {
    const name = clean(metadata.name || metadata.capability || metadata.permission || metadata.access || '', 500);
    if (!name) return { ok: false, malformed: true, message: 'Capability checkpoint is missing a capability name.' };
    return capabilityAvailable(name, project, mission)
      ? { ok: true, message: `${requirement.toLowerCase()} ${name} is available.` }
      : { ok: false, message: `${requirement.toLowerCase()} ${name} is not available in project runtime metadata.` };
  }

  if (requirement === 'EXTERNAL_ACCESS') {
    const validator = clean(metadata.validator_key || metadata.capability_key || metadata.capability || '', 500);
    if (validator) {
      return capabilityAvailable(validator, project, mission)
        ? { ok: true, message: `External access validator ${validator} is available.` }
        : { ok: false, message: `External access validator ${validator} is not available.` };
    }
    if (manualConfirmationAllowed(checkpoint)) {
      return { ok: true, message: 'Manual confirmation accepted for this external-access checkpoint.' };
    }
    return { ok: false, message: 'External-access checkpoint has no deterministic validator and does not allow manual confirmation.' };
  }

  if (['MANUAL_HUMAN', 'HUMAN_ACTION', 'MANUAL_ACTION'].includes(requirement)) {
    return manualConfirmationAllowed(checkpoint)
      ? { ok: true, message: 'Manual confirmation accepted for this checkpoint.' }
      : { ok: false, message: 'Manual confirmation is not the persisted validator for this checkpoint.' };
  }

  if (['GIT_AUTH', 'GIT_REMOTE_PERMISSION'].includes(requirement)) {
    return manualConfirmationAllowed(checkpoint)
      ? { ok: true, message: `${requirement} confirmation accepted for Git-stage resume.` }
      : { ok: false, message: `${requirement} requires the persisted manual confirmation validator.` };
  }

  return {
    ok: false,
    message: `Unsupported Human Action checkpoint type ${requirement || 'UNKNOWN'} remains unresolved.`
  };
}

function resolvedCheckpoint(checkpoint, validation, now = milestoneTimestamp()) {
  return {
    ...checkpoint,
    status: 'RESOLVED',
    waiting_status: 'RESOLVED',
    resolved_at: now,
    resolved_by: 'HUMAN_READY_CONFIRMATION',
    last_validation_at: now,
    last_validation_message: clean(validation.message, 1000),
    validation_result: {
      ok: true,
      method: validationMethod(checkpoint) || null,
      checked_at: now
    },
    updated_at: now
  };
}

function unresolvedValidatedCheckpoint(checkpoint, validation, now = milestoneTimestamp()) {
  return {
    ...checkpoint,
    status: checkpoint.status || 'WAITING_FOR_HUMAN',
    waiting_status: checkpoint.waiting_status || 'WAITING_FOR_HUMAN',
    last_validation_at: now,
    validation_attempt_count: Number(checkpoint.validation_attempt_count || 0) + 1,
    last_validation_message: clean(validation.message, 1000),
    updated_at: now
  };
}

function parseAutopilotDecision(text) {
  const parsed = parseTaggedAutopilotJson(text);
  if (!parsed || !AUTOPILOT_ACTIONS.has(String(parsed.action || '').toUpperCase())) {
    return {
      action: 'BLOCKED',
      reason: 'Brain verification response did not contain a valid MRAPI_AUTOPILOT decision.',
      execution_spec: null
    };
  }
  const action = String(parsed.action).toUpperCase();
  const humanAction = parsed.human_action && typeof parsed.human_action === 'object'
    ? parsed.human_action
    : parsed.human_action_request && typeof parsed.human_action_request === 'object'
      ? parsed.human_action_request
      : null;
  return {
    action,
    reason: clean(parsed.reason || parsed.summary || ''),
    human_action: humanAction,
    execution_spec: parsed.execution_spec && typeof parsed.execution_spec === 'object'
      ? {
          title: clean(parsed.execution_spec.title || '', 500),
          objective: clean(parsed.execution_spec.objective || '', 6000),
          instructions: clean(parsed.execution_spec.instructions || '', 50000),
          allowed_files: Array.isArray(parsed.execution_spec.allowed_files)
            ? [...new Set(parsed.execution_spec.allowed_files.map((x) => clean(x, 1000).replace(/\\/g, '/')).filter(Boolean))].slice(0, 100)
            : [],
          required_tests: normalizeStringList(
            parsed.execution_spec.required_tests || parsed.execution_spec.tests,
            30,
            4000
          ),
          diagnostic_tests: normalizeStringList(parsed.execution_spec.diagnostic_tests, 30, 4000),
          success_criteria: normalizeStringList(parsed.execution_spec.success_criteria, 30, 1000),
          stop_conditions: normalizeStringList(parsed.execution_spec.stop_conditions, 30, 1000)
          ,
          required_env_vars: normalizeStringList(parsed.execution_spec.required_env_vars, 30, 500),
          required_environment_variables: normalizeStringList(parsed.execution_spec.required_environment_variables, 30, 500),
          requires_repository: parsed.execution_spec.requires_repository === true,
          repository_required: parsed.execution_spec.repository_required === true,
          prerequisites: Array.isArray(parsed.execution_spec.prerequisites)
            ? parsed.execution_spec.prerequisites.filter((item) => item && typeof item === 'object').slice(0, 30).map((item) => sanitizeAuditValue(item))
            : [],
          execution_prerequisites: Array.isArray(parsed.execution_spec.execution_prerequisites)
            ? parsed.execution_spec.execution_prerequisites.filter((item) => item && typeof item === 'object').slice(0, 30).map((item) => sanitizeAuditValue(item))
            : [],
          preflight: parsed.execution_spec.preflight && typeof parsed.execution_spec.preflight === 'object'
            ? sanitizeAuditValue(parsed.execution_spec.preflight)
            : null
        }
      : null
  };
}

const TERMINAL_MISSION_STATES = new Set(['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']);
const ACTIVE_MILESTONE_STATES = new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'NEED_HUMAN_ACTION']);
const NON_RUNNABLE_ROADMAP_STATES = new Set(['BLOCKED', 'ERROR', 'FAILED', 'CANCELLED', 'NEED_HUMAN_ACTION', 'PAUSED', 'COMPLETED']);
const PLANNER_START_ALLOWED_STATES = new Set(['ACTIVE']);

function linkedMissionBlocksFreshStart(mission, tenantId) {
  if (!mission) return false;
  if (mission.tenant_id !== tenantId) return true;
  return !TERMINAL_MISSION_STATES.has(String(mission.state || '').toUpperCase());
}

function completedPredecessorContext(roadmap, milestone) {
  const dependencyIds = Array.isArray(milestone.dependencies)
    ? milestone.dependencies
    : Array.isArray(milestone.depends_on)
      ? milestone.depends_on
      : [];
  const byId = new Map((roadmap.milestones || []).map((item) => [item.id, item]));
  return dependencyIds.map((id) => {
    const dependency = byId.get(id);
    if (!dependency || !['COMPLETED', 'SKIPPED'].includes(dependency.state)) return null;
    return {
      id: dependency.id,
      title: dependency.title || '',
      objective: dependency.objective || dependency.expected_outcome || '',
      description: dependency.description || '',
      state: dependency.state,
      mission_id: dependency.mission_id || null,
      brain_run_id: dependency.brain_run_id || dependency.verification_brain_run_id || null,
      result_id: dependency.result_id || dependency.brain_output_result_id || null,
      completed_at: dependency.completed_at || null
    };
  }).filter(Boolean);
}

function plannerAutopilotBrainContext({ tenantId, roadmap, milestone, project }) {
  const dependencies = Array.isArray(milestone.dependencies)
    ? [...milestone.dependencies]
    : Array.isArray(milestone.depends_on)
      ? [...milestone.depends_on]
      : [];
  return {
    planner_contract: 'PLANNER_ROADMAP_AUTOPILOT_HANDOFF_V1',
    trusted_scope: {
      tenant_id: tenantId,
      workspace_id: roadmap.workspace_id || project.workspace_id || null,
      project_id: roadmap.project_id,
      roadmap_id: roadmap.id,
      milestone_id: milestone.id
    },
    roadmap: {
      id: roadmap.id,
      title: roadmap.title || '',
      objective: roadmap.objective || '',
      summary: roadmap.summary || '',
      original_request: roadmap.original_request || '',
      provenance: roadmap.provenance || null
    },
    current_milestone: {
      id: milestone.id,
      title: milestone.title || '',
      objective: milestone.objective || milestone.expected_outcome || '',
      description: milestone.description || '',
      dependencies,
      depends_on: Array.isArray(milestone.depends_on) ? [...milestone.depends_on] : dependencies,
      risks: Array.isArray(milestone.risks) ? [...milestone.risks] : [],
      success_criteria: Array.isArray(milestone.success_criteria) ? [...milestone.success_criteria] : [],
      executor_required: milestone.executor_required === true,
      order: milestone.order || null
    },
    completed_predecessors: completedPredecessorContext(roadmap, milestone),
    project_context: {
      id: project.id,
      workspace_id: project.workspace_id || null,
      repository_url: project.repository_url || null,
      repository_full_name: project.repository_full_name || null,
      local_path: project.local_path || project.runtime_context?.repository_path || null,
      default_branch: project.default_branch || null,
      default_worker_id: project.default_worker_id || null,
      reusable_instructions: project.reusable_instructions || ''
    },
    instructions: [
      'Brain owns planning and verification. Codex is hands only.',
      'For executor_required=true, return the existing machine-readable execution planning contract before any Executor task exists.',
      'For executor_required=false, return requires_execution=false with a final Brain result.'
    ]
  };
}

function activeMilestone(roadmap) {
  return [...(roadmap.milestones || [])]
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .find((item) => ACTIVE_MILESTONE_STATES.has(String(item.state || '').toUpperCase())) || null;
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
  const runRef = db.collection('runs').doc();
  let created = null;

  await db.runTransaction(async (tx) => {
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    if (roadmap.state === 'COMPLETED' && options.planner_handoff === true) {
      created = { roadmap, milestone: null, mission: null, brain_run: null, already_complete: true, no_new_work: true };
      return;
    }
    if (options.planner_handoff === true) {
      if (
        roadmap.proposal_type !== 'PLANNER_ROADMAP' ||
        roadmap.approval_status !== 'APPROVED' ||
        roadmap.non_executable === true ||
        !PLANNER_START_ALLOWED_STATES.has(roadmap.state)
      ) {
        const error = new Error('PLANNER_ROADMAP_NOT_STARTABLE'); error.status = 409; throw error;
      }
    } else if (roadmap.state !== 'ACTIVE') {
      const error = new Error('ROADMAP_NOT_ACTIVE'); error.status = 409; throw error;
    }

    const existingActiveMilestone = activeMilestone(roadmap);
    if (existingActiveMilestone) {
      let mission = null;
      let brainRun = null;
      if (existingActiveMilestone.mission_id) {
        const existingMissionSnap = await tx.get(db.collection('missions').doc(existingActiveMilestone.mission_id));
        if (existingMissionSnap.exists && existingMissionSnap.data().tenant_id === tenantId) {
          mission = { id: existingMissionSnap.id, ...existingMissionSnap.data() };
          const runsSnap = await tx.get(db.collection('runs').where('tenant_id', '==', tenantId).limit(200));
          brainRun = runsSnap.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .find((run) => run.mission_id === mission.id && run.run_type === 'BRAIN_RUN' && run.autopilot_phase === 'PROGRAM') || null;
        }
      }
      created = {
        mission,
        milestone: existingActiveMilestone,
        roadmap,
        brain_run: brainRun,
        checkpoint: unresolvedHumanActionCheckpoint(existingActiveMilestone),
        reused: true,
        no_new_work: true
      };
      return;
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
      const linkedMissionRef = db.collection('missions').doc(milestone.mission_id);
      const linkedMissionSnap = await tx.get(linkedMissionRef);
      const linkedMission = linkedMissionSnap.exists
        ? { id: linkedMissionSnap.id, ...linkedMissionSnap.data() }
        : null;

      // PENDING may start again after a terminal prior Mission.
      // Historical Mission/Runs remain stored for audit.
      if (linkedMissionBlocksFreshStart(linkedMission, tenantId)) {
        const error = new Error('MILESTONE_ALREADY_HAS_MISSION');
        error.status = 409;
        throw error;
      }
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
      state: options.dispatch_brain_run === true ? 'PLANNING' : 'READY',
      planning_mode: 'AUTOPILOT',
      approval_status: 'APPROVED',
      autopilot_mode: true,
      autopilot_phase: 'PROGRAM',
      autopilot_attempt_count: attempt,
      autopilot_max_attempts: Number(options.max_attempts || 3),
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      planner_roadmap_handoff: options.planner_handoff === true,
      brain_context: plannerAutopilotBrainContext({ tenantId, roadmap, milestone, project }),
      created_at: timestamp(),
      updated_at: timestamp()
    };
    tx.set(missionRef, mission);
    let brainRun = null;
    if (options.dispatch_brain_run === true) {
      brainRun = {
        id: runRef.id,
        tenant_id: tenantId,
        run_type: 'BRAIN_RUN',
        mission_id: missionRef.id,
        task_id: null,
        workspace_id: mission.workspace_id,
        project_id: mission.project_id,
        worker_id: workerId,
        executor_id: null,
        parent_run_id: null,
        objective: mission.objective,
        brain_context: mission.brain_context,
        autopilot_mode: true,
        autopilot_phase: 'PROGRAM',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        state: 'RUNNING',
        progress_percent: 0,
        progress_message: 'Planner roadmap milestone handed off; Brain Run started',
        started_at: timestamp(),
        created_at: timestamp(),
        updated_at: timestamp()
      };
      tx.set(runRef, brainRun);
      tx.set(missionRef, {
        state: 'PLANNING',
        brain_run_id: runRef.id,
        dispatched_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
    }
    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, 'PLANNING', {
        mission_id: missionRef.id,
        brain_run_id: brainRun?.id || null,
        started_at: milestoneTimestamp()
      }),
      updated_at: timestamp()
    }, { merge: true });
    created = { mission, milestone, roadmap, brain_run: brainRun };
  });

  return created;
}

function runnableRoadmapState(state) {
  return !NON_RUNNABLE_ROADMAP_STATES.has(String(state || '').toUpperCase());
}

function milestonesCompleteOrSkipped(roadmap) {
  return (roadmap.milestones || []).every((item) => ['COMPLETED', 'SKIPPED'].includes(item.state));
}

function pendingMilestones(roadmap) {
  return (roadmap.milestones || []).filter((item) => item.state === 'PENDING');
}

async function findProgramBrainRun(db, tenantId, missionId) {
  if (!missionId) return null;
  const runsSnap = await db.collection('runs').where('tenant_id', '==', tenantId).limit(200).get();
  return runsSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .find((run) => run.mission_id === missionId && run.run_type === 'BRAIN_RUN' && run.autopilot_phase === 'PROGRAM') || null;
}

async function markNextMilestoneNeedsHumanAction(db, tenantId, roadmapId, milestoneId, missionId, checkpoint) {
  await db.runTransaction(async (tx) => {
    const roadmapRef = db.collection('roadmaps').doc(roadmapId);
    const missionRef = db.collection('missions').doc(missionId);
    const roadmapSnap = await tx.get(roadmapRef);
    const missionSnap = await tx.get(missionRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
    }
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const milestone = (roadmap.milestones || []).find((item) => item.id === milestoneId);
    if (!milestone) {
      const error = new Error('MILESTONE_NOT_FOUND'); error.status = 404; throw error;
    }
    const existing = unresolvedHumanActionCheckpoint(milestone);
    const finalCheckpoint = existing || checkpoint;
    tx.set(roadmapRef, {
      milestones: milestoneWithHumanAction(roadmap, milestoneId, finalCheckpoint),
      updated_at: timestamp()
    }, { merge: true });
    tx.set(missionRef, {
      state: 'NEED_HUMAN_ACTION',
      autopilot_phase: 'NEED_HUMAN_ACTION',
      human_action_required: true,
      human_action_checkpoint: finalCheckpoint,
      blocker_code: finalCheckpoint.blocker_code,
      blocker_message: finalCheckpoint.human_action_request,
      updated_at: timestamp()
    }, { merge: true });
  });
}

async function continueRoadmapAfterComplete(db, tenantId, roadmapId, completedMilestoneId, options = {}) {
  let checked = null;
  await db.runTransaction(async (tx) => {
    const roadmapRef = db.collection('roadmaps').doc(roadmapId);
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      checked = { continuation_state: 'DENIED', auto_advance: false };
      return;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const completedMilestone = (roadmap.milestones || []).find((item) => item.id === completedMilestoneId);
    if (!completedMilestone || completedMilestone.state !== 'COMPLETED') {
      checked = { continuation_state: 'CURRENT_NOT_COMPLETED', auto_advance: false, roadmap };
      return;
    }
    if (roadmap.auto_advance !== true) {
      checked = { continuation_state: 'DISABLED', auto_advance: false, roadmap };
      return;
    }
    if (milestonesCompleteOrSkipped(roadmap)) {
      if (roadmap.state !== 'COMPLETED') {
        tx.set(roadmapRef, { state: 'COMPLETED', updated_at: timestamp() }, { merge: true });
      }
      checked = { continuation_state: 'ROADMAP_COMPLETED', auto_advance: true, roadmap };
      return;
    }
    if (!runnableRoadmapState(roadmap.state)) {
      checked = { continuation_state: 'STOPPED', auto_advance: true, roadmap };
      return;
    }
    const existingActiveMilestone = activeMilestone(roadmap);
    if (existingActiveMilestone) {
      checked = {
        continuation_state: existingActiveMilestone.state === 'NEED_HUMAN_ACTION' ? 'NEED_HUMAN_ACTION' : 'ALREADY_RUNNING',
        auto_advance: true,
        roadmap,
        milestone: existingActiveMilestone,
        checkpoint: unresolvedHumanActionCheckpoint(existingActiveMilestone)
      };
      return;
    }
    const milestone = nextMilestone(roadmap);
    if (!milestone) {
      checked = {
        continuation_state: pendingMilestones(roadmap).length > 0 ? 'NO_ELIGIBLE_MILESTONE' : 'ROADMAP_COMPLETED',
        auto_advance: true,
        roadmap
      };
      return;
    }
    checked = { continuation_state: 'SELECTED', auto_advance: true, roadmap, milestone };
  });

  if (!checked || checked.continuation_state !== 'SELECTED') {
    const missionId = checked?.milestone?.mission_id || null;
    const brainRun = missionId ? await findProgramBrainRun(db, tenantId, missionId) : null;
    return {
      auto_advance: checked?.auto_advance === true,
      continuation_state: checked?.continuation_state || 'STOPPED',
      next_milestone_id: checked?.milestone?.id || null,
      next_mission_id: missionId,
      next_brain_run_id: brainRun?.id || null,
      checkpoint_id: checked?.checkpoint?.checkpoint_id || null
    };
  }

  const projectSnap = await db.collection('projects').doc(checked.roadmap.project_id).get();
  if (!projectSnap.exists || projectSnap.data().tenant_id !== tenantId) {
    return { auto_advance: true, continuation_state: 'STOPPED', next_milestone_id: checked.milestone.id };
  }
  const project = { id: projectSnap.id, ...projectSnap.data() };
  const provisionalMission = {
    id: `provisional:${checked.roadmap.id}:${checked.milestone.id}`,
    tenant_id: tenantId,
    workspace_id: checked.roadmap.workspace_id || project.workspace_id || null,
    project_id: checked.roadmap.project_id,
    roadmap_id: checked.roadmap.id,
    milestone_id: checked.milestone.id
  };
  const { deterministicProgramPreflight } = require('./orchestration');
  const provisionalCheckpoint = deterministicProgramPreflight({
    tenantId,
    brainOutput: { task_spec: {} },
    mission: provisionalMission,
    run: { id: null, mission_id: provisionalMission.id, roadmap_id: checked.roadmap.id, milestone_id: checked.milestone.id },
    roadmap: checked.roadmap,
    milestone: checked.milestone,
    project
  });

  if (provisionalCheckpoint) {
    const started = await startNextRoadmapMilestone(db, tenantId, roadmapId, {
      milestone_id: checked.milestone.id,
      planner_handoff: options.planner_handoff === true,
      dispatch_brain_run: false,
      max_attempts: options.max_attempts
    });
    const checkpoint = normalizeHumanActionCheckpoint({
      ...provisionalCheckpoint,
      checkpoint_id: null,
      tenant_id: tenantId,
      roadmap_id: checked.roadmap.id,
      milestone_id: checked.milestone.id,
      mission_id: started.mission.id,
      checkpoint_seed: null
    });
    await markNextMilestoneNeedsHumanAction(db, tenantId, roadmapId, checked.milestone.id, started.mission.id, checkpoint);
    return {
      auto_advance: true,
      continuation_state: 'NEED_HUMAN_ACTION',
      next_milestone_id: checked.milestone.id,
      next_mission_id: started.mission.id,
      next_brain_run_id: null,
      checkpoint_id: checkpoint.checkpoint_id
    };
  }

  const started = await startNextRoadmapMilestone(db, tenantId, roadmapId, {
    milestone_id: checked.milestone.id,
    planner_handoff: options.planner_handoff === true,
    dispatch_brain_run: true,
    max_attempts: options.max_attempts
  });
  return {
    auto_advance: true,
    continuation_state: started.reused ? 'ALREADY_RUNNING' : 'STARTED',
    next_milestone_id: started.milestone?.id || checked.milestone.id,
    next_mission_id: started.mission?.id || null,
    next_brain_run_id: started.brain_run?.id || null,
    checkpoint_id: started.checkpoint?.checkpoint_id || null
  };
}

function milestoneWithHumanAction(roadmap, milestoneId, checkpoint) {
  return milestoneWithState(roadmap, milestoneId, 'NEED_HUMAN_ACTION', {
    human_action_required: true,
    human_action_checkpoint: checkpoint,
    waiting_status: checkpoint.waiting_status,
    blocked_reason: checkpoint.blocker_code
  });
}

function failClosedHumanActionReason(decision) {
  if (decision.action !== 'NEED_HUMAN_ACTION') return null;
  if (!clean(decision.reason)) return 'NEED_HUMAN_ACTION requires a non-empty reason.';
  const source = decision.human_action && typeof decision.human_action === 'object' ? decision.human_action : {};
  const request = source.human_action_request || source.request || source.reason;
  const userAction = source.user_action;
  const location = source.action_location;
  const validation = source.validation_method;
  if (![request, userAction, location, validation].every((item) => clean(item))) {
    return 'NEED_HUMAN_ACTION requires human_action_request, user_action, action_location, and validation_method.';
  }
  return null;
}

function checkpointFromAutopilotDecision(decision, scope, existing = null) {
  const source = decision.human_action && typeof decision.human_action === 'object' ? decision.human_action : {};
  return normalizeHumanActionCheckpoint({
    ...scope,
    checkpoint_type: source.checkpoint_type || 'AUTOPILOT_VERIFICATION',
    requirement_type: source.requirement_type || 'HUMAN_ACTION',
    brain_run_id: scope.brain_run_id || null,
    human_action_request: source.human_action_request || source.request || decision.reason,
    user_action: source.user_action,
    action_location: source.action_location,
    validation_method: source.validation_method,
    validation_metadata: source.validation_metadata,
    reason: decision.reason,
    blocker_code: source.blocker_code || 'AUTOPILOT_NEED_HUMAN_ACTION',
    requirement_key: source.requirement_key || decision.reason
  }, existing);
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
    if (mission.state === 'CANCELLED' || mission.cancellation_requested === true) return;

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
      error: executionResult.error || null,
      process_exit_code: executionResult.output?.process_exit_code ?? executionResult.output?.exit_code ?? null,
      process_exited_cleanly: executionResult.output?.process_exited_cleanly ?? null,
      verdict_source: executionResult.output?.verdict_source || executionResult.output?.executor_report?.verdict_source || null,
      required_tests: Array.isArray(executionResult.output?.required_tests)
        ? executionResult.output.required_tests
        : Array.isArray(executionResult.output?.executor_report?.required_tests)
          ? executionResult.output.executor_report.required_tests
          : [],
      diagnostic_tests: Array.isArray(executionResult.output?.diagnostic_tests)
        ? executionResult.output.diagnostic_tests
        : Array.isArray(executionResult.output?.executor_report?.diagnostic_tests)
          ? executionResult.output.executor_report.diagnostic_tests
          : [],
      diagnostic_only_failure: executionResult.output?.diagnostic_only_failure === true ||
        executionResult.output?.executor_report?.diagnostic_only_failure === true,
      scope_check: executionResult.output?.scope_check || null,
      executor_report: executionResult.output?.executor_report || null,
      attempt: Number(mission.autopilot_attempt_count || 1),
      max_attempts: Number(mission.autopilot_max_attempts || 3),
      trusted_scope: {
        tenant_id: tenantId,
        workspace_id: mission.workspace_id || null,
        project_id: mission.project_id || null,
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id
      }
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
    if (
      run.run_type === 'BRAIN_RUN' &&
      run.state === 'COMPLETED' &&
      run.autopilot_phase === 'VERIFY_EXECUTION' &&
      run.autopilot_decision?.action === 'COMPLETE'
    ) {
      const missionSnap = run.mission_id ? await tx.get(db.collection('missions').doc(run.mission_id)) : null;
      const roadmapSnap = run.roadmap_id ? await tx.get(db.collection('roadmaps').doc(run.roadmap_id)) : null;
      if (!missionSnap?.exists || missionSnap.data().tenant_id !== tenantId) {
        const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
      }
      if (!roadmapSnap?.exists || roadmapSnap.data().tenant_id !== tenantId) {
        const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
      }
      const mission = { id: missionSnap.id, ...missionSnap.data() };
      const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
      if (roadmap.auto_advance !== true) {
        const error = new Error('AUTOPILOT_VERIFICATION_RUN_NOT_ACTIVE'); error.status = 409; throw error;
      }
      result = {
        success: true,
        action: 'COMPLETE',
        roadmap_id: roadmap.id,
        milestone_id: run.milestone_id,
        completed_milestone_id: run.milestone_id,
        mission_id: mission.id,
        auto_advance: roadmap.auto_advance === true,
        replayed: true,
        reason: run.autopilot_decision.reason || ''
      };
      return;
    }
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

    let priorTask = null;
    if (mission.current_task_id) {
      const priorTaskSnap = await tx.get(db.collection('tasks').doc(mission.current_task_id));
      if (priorTaskSnap.exists && priorTaskSnap.data().tenant_id === tenantId) {
        priorTask = { id: priorTaskSnap.id, ...priorTaskSnap.data() };
      }
    }
    const runsSnap = await tx.get(db.collection('runs').where('tenant_id', '==', tenantId).limit(200));
    const priorExecutionRun = runsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => item.mission_id === mission.id && item.run_type === 'EXECUTION_RUN')
      .sort((a, b) => Number(b.started_at?.toMillis?.() || b.created_at?.toMillis?.() || 0) - Number(a.started_at?.toMillis?.() || a.created_at?.toMillis?.() || 0))[0] || null;
    const projectSnap = mission.project_id ? await tx.get(db.collection('projects').doc(mission.project_id)) : null;
    const project = projectSnap?.exists && projectSnap.data().tenant_id === tenantId
      ? { id: projectSnap.id, ...projectSnap.data() }
      : {};
    const tasksSnap = await tx.get(db.collection('tasks').where('tenant_id', '==', tenantId).limit(200));
    const missionTasks = tasksSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((task) => task.mission_id === mission.id);

    const outputText = clean(input.output_text || input.summary || '', 100000);
    const decision = parseAutopilotDecision(outputText);
    const attempt = Number(mission.autopilot_attempt_count || 1);
    const maxAttempts = Math.max(1, Number(mission.autopilot_max_attempts || 3));
    if (decision.action === 'RETRY' && attempt >= maxAttempts) {
      decision.action = 'BLOCKED';
      decision.reason = `Automatic retry limit reached (${attempt}/${maxAttempts}). ${decision.reason}`.trim();
    }
    const malformedHumanAction = failClosedHumanActionReason(decision);
    if (malformedHumanAction) {
      decision.action = 'BLOCKED';
      decision.reason = `Malformed NEED_HUMAN_ACTION decision: ${malformedHumanAction}`;
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
      if (gitAutomationEnabled({ mission, project, milestone })) {
        const existingGitStage = missionTasks
          .find((task) => task.mission_id === mission.id && task.autopilot_phase === 'GIT_STAGE' && !['DONE', 'FAILED', 'SKIPPED'].includes(String(task.state || '').toUpperCase()));
        const taskSpec = gitStageTaskSpec(milestone, priorTask);
        if (!Array.isArray(taskSpec.allowed_files) || taskSpec.allowed_files.length === 0) {
          decision.action = 'BLOCKED';
          decision.reason = `${decision.reason} GIT_STAGE requires trusted allowed_files from the verified execution task.`.trim();
        } else if (existingGitStage) {
          result = {
            success: true,
            action: 'GIT_STAGE',
            roadmap_id: roadmap.id,
            milestone_id: milestone.id,
            mission_id: mission.id,
            task_id: existingGitStage.id,
            continuation_state: 'GIT_STAGE_PENDING',
            reason: decision.reason
          };
          return;
        } else {
          const taskRef = db.collection('tasks').doc();
          const brainOutput = gitStageBrainOutput({ tenantId, mission, run, milestone, taskSpec });
          tx.set(taskRef, {
            id: taskRef.id,
            tenant_id: tenantId,
            mission_id: mission.id,
            workspace_id: mission.workspace_id || null,
            project_id: mission.project_id || null,
            worker_id: mission.preferred_worker_id || 'W01',
            title: taskSpec.title,
            objective: taskSpec.objective,
            task_spec: taskSpec,
            brain_output: brainOutput,
            execution_constraints: {
              no_gcp: true,
              no_cloud_run: true,
              no_deploy: true,
              deployment: 'HUMAN_MANUAL_DEPLOY',
              autopilot_phase: 'GIT_STAGE'
            },
            priority: mission.priority || 'NORMAL',
            state: 'QUEUED',
            phase: 'EXECUTION_PENDING',
            autopilot_phase: 'GIT_STAGE',
            attempt_count: attempt,
            verification_brain_run_id: run.id,
            current_run_id: null,
            claimed_by_executor_id: null,
            created_at: timestamp(),
            updated_at: timestamp()
          });
          tx.set(missionRef, {
            state: 'RUNNING',
            autopilot_phase: 'GIT_STAGE',
            current_git_stage_task_id: taskRef.id,
            pending_git_stage: {
              task_id: taskRef.id,
              verification_brain_run_id: run.id,
              attempt,
              allowed_files: taskSpec.allowed_files,
              created_at: milestoneTimestamp()
            },
            updated_at: timestamp()
          }, { merge: true });
          tx.set(roadmapRef, {
            milestones: milestoneWithState(roadmap, milestone.id, 'RUNNING', {
              mission_id: mission.id,
              verification_brain_run_id: run.id,
              git_stage_status: 'QUEUED',
              git_stage_task_id: taskRef.id
            }),
            updated_at: timestamp()
          }, { merge: true });
          result = {
            success: true,
            action: 'GIT_STAGE',
            roadmap_id: roadmap.id,
            milestone_id: milestone.id,
            mission_id: mission.id,
            task_id: taskRef.id,
            continuation_state: 'GIT_STAGE_PENDING',
            reason: decision.reason
          };
          return;
        }
      }
    }

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
        completed_milestone_id: milestone.id,
        mission_id: mission.id,
        auto_advance: roadmap.auto_advance === true && !roadmapCompleted,
        continuation_state: roadmapCompleted ? 'ROADMAP_COMPLETED' : (roadmap.auto_advance === true ? 'PENDING' : 'DISABLED'),
        reason: decision.reason
      };
      return;
    }

    if (decision.action === 'NEED_HUMAN_ACTION') {
      const existing = unresolvedHumanActionCheckpoint(milestone);
      const checkpoint = checkpointFromAutopilotDecision(decision, {
        tenant_id: tenantId,
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        brain_run_id: run.id,
        paused_from_phase: 'VERIFY_EXECUTION'
      }, existing);
      tx.set(roadmapRef, {
        milestones: milestoneWithHumanAction(roadmap, milestone.id, checkpoint),
        updated_at: timestamp()
      }, { merge: true });
      tx.set(missionRef, {
        state: 'NEED_HUMAN_ACTION',
        autopilot_phase: 'NEED_HUMAN_ACTION',
        human_action_required: true,
        human_action_checkpoint: checkpoint,
        blocker_code: checkpoint.blocker_code,
        blocker_message: checkpoint.human_action_request,
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: false,
        action: 'NEED_HUMAN_ACTION',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        checkpoint_id: checkpoint.checkpoint_id,
        human_action_checkpoint: checkpoint,
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
      } else if (!Array.isArray(decision.execution_spec.required_tests) || decision.execution_spec.required_tests.length === 0) {
        decision.action = 'BLOCKED';
        decision.reason = `${decision.reason} RETRY requires Brain-defined execution_spec.required_tests.`.trim();
      } else {
        const currentAttempt = attempt + 1;
        const retryRevision = Number(mission.autopilot_retry_revision || mission.retry_revision || 0) + 1;
        const activeExecutionSpec = retryExecutionSpecSnapshot(decision.execution_spec);
        const taskSpec = retryTaskSpec(milestone, activeExecutionSpec);
        const brainOutput = retryBrainOutput({ tenantId, mission, run, milestone, taskSpec });
        const retryAuditEntry = {
          attempt: currentAttempt,
          revision: retryRevision,
          verification_brain_run_id: run.id,
          prior_task_id: priorTask?.id || mission.current_task_id || null,
          prior_execution_run_id: priorExecutionRun?.id || priorTask?.current_run_id || priorTask?.execution_run_id || null,
          prior_result_id: priorExecutionRun?.result_id || priorTask?.result_id || null,
          prior_verification_brain_run_id: milestone.verification_brain_run_id || mission.verification_brain_run_id || null,
          prior_reason: decision.reason,
          decided_at: milestoneTimestamp(),
          execution_spec: activeExecutionSpec
        };
        const retryHistory = boundedRetryHistory(mission, retryAuditEntry);
        const { deterministicProgramPreflight } = require('./orchestration');
        const checkpoint = deterministicProgramPreflight({
          tenantId,
          brainOutput,
          mission: {
            ...mission,
            id: mission.id,
            autopilot_phase: 'RETRY_EXECUTION',
            pending_retry_execution: {
              attempt: currentAttempt,
              revision: retryRevision,
              verification_brain_run_id: run.id,
              brain_output: brainOutput,
              task_spec: taskSpec
            }
          },
          run: { ...run, id: run.id, autopilot_phase: 'RETRY_EXECUTION' },
          roadmap,
          milestone,
          project
        });
        if (checkpoint) {
          const retryCheckpoint = normalizeHumanActionCheckpoint({
            ...checkpoint,
            checkpoint_type: 'RETRY_PREFLIGHT',
            tenant_id: tenantId,
            roadmap_id: roadmap.id,
            milestone_id: milestone.id,
            mission_id: mission.id,
            brain_run_id: run.id,
            paused_from_phase: 'RETRY_EXECUTION',
            validation_metadata: checkpoint.validation_metadata
          }, unresolvedHumanActionCheckpoint(milestone));
          const pendingRetryExecution = sanitizeAuditValue({
            attempt: currentAttempt,
            revision: retryRevision,
            verification_brain_run_id: run.id,
            reason: decision.reason,
            brain_output: brainOutput,
            task_spec: taskSpec,
            execution_spec: activeExecutionSpec,
            checkpoint_id: retryCheckpoint.checkpoint_id,
            created_at: milestoneTimestamp()
          });
          tx.set(roadmapRef, {
            milestones: milestoneWithState(roadmap, milestone.id, 'NEED_HUMAN_ACTION', {
              mission_id: mission.id,
              last_retry_brain_run_id: run.id,
              retry_attempt: currentAttempt,
              retry_revision: retryRevision,
              retry_status: 'NEED_HUMAN_ACTION',
              active_retry_execution_spec: activeExecutionSpec,
              retry_history: retryHistory,
              human_action_required: true,
              human_action_checkpoint: retryCheckpoint,
              waiting_status: retryCheckpoint.waiting_status,
              blocked_reason: retryCheckpoint.blocker_code
            }),
            updated_at: timestamp()
          }, { merge: true });
          tx.set(missionRef, {
            state: 'NEED_HUMAN_ACTION',
            autopilot_phase: 'NEED_HUMAN_ACTION',
            autopilot_attempt_count: currentAttempt,
            autopilot_retry_revision: retryRevision,
            retry_status: 'NEED_HUMAN_ACTION',
            last_retry_brain_run_id: run.id,
            last_retry_reason: decision.reason,
            active_retry_execution_spec: activeExecutionSpec,
            pending_retry_execution: pendingRetryExecution,
            autopilot_retry_history: retryHistory,
            human_action_required: true,
            human_action_checkpoint: retryCheckpoint,
            blocker_code: retryCheckpoint.blocker_code,
            blocker_message: retryCheckpoint.human_action_request,
            updated_at: timestamp()
          }, { merge: true });
          result = {
            success: false,
            action: 'NEED_HUMAN_ACTION',
            roadmap_id: roadmap.id,
            milestone_id: milestone.id,
            mission_id: mission.id,
            checkpoint_id: retryCheckpoint.checkpoint_id,
            human_action_checkpoint: retryCheckpoint,
            attempt: currentAttempt,
            revision: retryRevision,
            reason: retryCheckpoint.reason || decision.reason
          };
          return;
        }
        const taskRef = db.collection('tasks').doc();
        tx.set(taskRef, {
          id: taskRef.id,
          tenant_id: tenantId,
          mission_id: mission.id,
          workspace_id: mission.workspace_id || null,
          project_id: mission.project_id || null,
          worker_id: mission.preferred_worker_id || 'W01',
          title: taskSpec.title,
          objective: taskSpec.objective,
          task_spec: taskSpec,
          brain_output: brainOutput,
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
          attempt_count: currentAttempt,
          autopilot_retry_revision: retryRevision,
          retry_of_task_id: priorTask?.id || mission.current_task_id || null,
          retry_of_run_id: priorExecutionRun?.id || priorTask?.current_run_id || priorTask?.execution_run_id || null,
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
          autopilot_attempt_count: currentAttempt,
          autopilot_retry_revision: retryRevision,
          retry_status: 'QUEUED',
          last_retry_brain_run_id: run.id,
          last_retry_reason: decision.reason,
          current_task_id: taskRef.id,
          current_retry_task_id: taskRef.id,
          active_retry_execution_spec: activeExecutionSpec,
          pending_retry_execution: null,
          autopilot_retry_history: retryHistory,
          autopilot_allowed_files: activeExecutionSpec.allowed_files,
          updated_at: timestamp()
        }, { merge: true });
        tx.set(roadmapRef, {
          milestones: milestoneWithState(roadmap, milestone.id, 'RUNNING', {
            mission_id: mission.id,
            last_retry_brain_run_id: run.id,
            retry_attempt: currentAttempt,
            retry_revision: retryRevision,
            retry_status: 'QUEUED',
            active_retry_execution_spec: activeExecutionSpec,
            retry_history: retryHistory
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
          attempt: currentAttempt,
          revision: retryRevision,
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
  if (result?.action === 'COMPLETE' && result.roadmap_id && result.milestone_id) {
    const continuation = await continueRoadmapAfterComplete(
      db,
      tenantId,
      result.roadmap_id,
      result.milestone_id,
      input.continuation_options || {}
    );
    result = {
      ...result,
      auto_advance: continuation.auto_advance === true,
      next_milestone_id: continuation.next_milestone_id || null,
      next_mission_id: continuation.next_mission_id || null,
      next_brain_run_id: continuation.next_brain_run_id || null,
      continuation_state: continuation.continuation_state,
      checkpoint_id: continuation.checkpoint_id || null
    };
  }
  return result;
}

async function completeGitStageExecutionRun(db, tenantId, runId, input = {}) {
  const runRef = db.collection('runs').doc(runId);
  let result = null;
  await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) {
      const error = new Error('RUN_NOT_FOUND'); error.status = 404; throw error;
    }
    const run = { id: runSnap.id, ...runSnap.data() };
    if (run.run_type !== 'EXECUTION_RUN') {
      const error = new Error('RUN_NOT_EXECUTION'); error.status = 409; throw error;
    }
    const taskRef = db.collection('tasks').doc(run.task_id);
    const missionRef = db.collection('missions').doc(run.mission_id);
    const taskSnap = await tx.get(taskRef);
    const missionSnap = await tx.get(missionRef);
    if (!taskSnap.exists || taskSnap.data().tenant_id !== tenantId) {
      const error = new Error('TASK_NOT_FOUND'); error.status = 404; throw error;
    }
    if (!missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('MISSION_NOT_FOUND'); error.status = 404; throw error;
    }
    const task = { id: taskSnap.id, ...taskSnap.data() };
    const mission = { id: missionSnap.id, ...missionSnap.data() };
    if (task.autopilot_phase !== 'GIT_STAGE' && mission.autopilot_phase !== 'GIT_STAGE') {
      const error = new Error('RUN_NOT_GIT_STAGE'); error.status = 409; throw error;
    }
    const roadmapRef = db.collection('roadmaps').doc(mission.roadmap_id);
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('ROADMAP_NOT_FOUND'); error.status = 404; throw error;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const milestone = (roadmap.milestones || []).find((item) => item.id === mission.milestone_id);
    if (!milestone) {
      const error = new Error('MILESTONE_NOT_FOUND'); error.status = 404; throw error;
    }

    const git = input.output?.git && typeof input.output.git === 'object' ? sanitizeGitStageResult(input.output.git) : {};
    const classification = clean(git.classification || git.status || '', 120).toUpperCase();
    const success = input.success === true && (classification === 'SUCCESS' || git.reason === 'NO_CHANGES');
    const resultRef = db.collection('results').doc();

    tx.set(resultRef, {
      id: resultRef.id,
      tenant_id: tenantId,
      mission_id: mission.id,
      task_id: task.id,
      run_id: run.id,
      workspace_id: run.workspace_id || mission.workspace_id || null,
      project_id: run.project_id || mission.project_id || null,
      brain_run_id: task.verification_brain_run_id || run.brain_run_id || null,
      worker_id: run.worker_id,
      executor_id: run.executor_id,
      status: success ? 'SUCCESS' : 'FAILED',
      result_type: 'GIT_STAGE_OUTPUT',
      summary: clean(input.summary || git.reason || 'Git stage completed.', 10000),
      output: { ...(input.output || {}), git },
      created_at: timestamp()
    });
    tx.set(runRef, {
      state: success ? 'COMPLETED' : 'FAILED',
      progress_percent: success ? 100 : 0,
      progress_message: clean(input.summary || git.reason || '', 2000),
      error: success ? null : clean(input.error || git.error || git.reason || 'GIT_STAGE_FAILED', 5000),
      result_id: resultRef.id,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });
    tx.set(taskRef, {
      state: success ? 'DONE' : 'FAILED',
      phase: success ? 'COMPLETED' : 'FAILED',
      result_id: resultRef.id,
      git_stage_result: git,
      completed_at: timestamp(),
      updated_at: timestamp()
    }, { merge: true });

    if (success) {
      const allMilestones = milestoneWithState(roadmap, milestone.id, 'COMPLETED', {
        completed_at: milestoneTimestamp(),
        verification_brain_run_id: task.verification_brain_run_id || milestone.verification_brain_run_id || null,
        git_stage_result: git,
        git_stage_status: 'SUCCESS',
        git_stage_result_id: resultRef.id
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
        pending_git_stage: null,
        git_stage_result: git,
        completed_at: timestamp(),
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: true,
        action: 'COMPLETE',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        completed_milestone_id: milestone.id,
        mission_id: mission.id,
        result_id: resultRef.id,
        git_stage_result: git,
        auto_advance: roadmap.auto_advance === true && !roadmapCompleted,
        continuation_state: roadmapCompleted ? 'ROADMAP_COMPLETED' : (roadmap.auto_advance === true ? 'PENDING' : 'DISABLED')
      };
      return;
    }

    if (classification === 'NEED_HUMAN_ACTION') {
      const checkpoint = normalizeHumanActionCheckpoint({
        ...(git.checkpoint || {}),
        checkpoint_type: git.checkpoint?.checkpoint_type || git.reason || 'GIT_AUTH',
        requirement_type: git.checkpoint?.requirement_type || git.reason || 'GIT_AUTH',
        tenant_id: tenantId,
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        brain_run_id: task.verification_brain_run_id || null,
        paused_from_phase: 'GIT_STAGE',
        resume_phase: 'GIT_STAGE',
        reason: git.reason || 'GIT_STAGE_NEEDS_HUMAN_ACTION',
        validation_metadata: {
          branch: git.branch || null,
          target_branch: git.target_branch || null,
          commit_sha: git.commit_sha || git.sha || null,
          changed_files: Array.isArray(git.changed_files) ? git.changed_files : [],
          staged_files: Array.isArray(git.staged_files) ? git.staged_files : []
        }
      }, unresolvedHumanActionCheckpoint(milestone));
      tx.set(roadmapRef, {
        milestones: milestoneWithState(roadmap, milestone.id, 'NEED_HUMAN_ACTION', {
          human_action_required: true,
          human_action_checkpoint: checkpoint,
          waiting_status: checkpoint.waiting_status,
          blocked_reason: checkpoint.blocker_code,
          git_stage_status: 'NEED_HUMAN_ACTION',
          git_stage_result: git
        }),
        updated_at: timestamp()
      }, { merge: true });
      tx.set(missionRef, {
        state: 'NEED_HUMAN_ACTION',
        autopilot_phase: 'NEED_HUMAN_ACTION',
        human_action_required: true,
        human_action_checkpoint: checkpoint,
        blocker_code: checkpoint.blocker_code,
        blocker_message: checkpoint.human_action_request,
        git_stage_result: git,
        updated_at: timestamp()
      }, { merge: true });
      result = {
        success: false,
        action: 'NEED_HUMAN_ACTION',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        checkpoint_id: checkpoint.checkpoint_id,
        human_action_checkpoint: checkpoint,
        git_stage_result: git,
        reason: git.reason || 'GIT_STAGE_NEEDS_HUMAN_ACTION'
      };
      return;
    }

    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, 'BLOCKED', {
        blocked_reason: git.reason || input.error || 'GIT_STAGE_BLOCKED',
        git_stage_status: 'BLOCKED',
        git_stage_result: git
      }),
      state: 'BLOCKED',
      updated_at: timestamp()
    }, { merge: true });
    tx.set(missionRef, {
      state: 'BLOCKED',
      autopilot_phase: 'BLOCKED',
      blocker_code: git.reason || 'GIT_STAGE_BLOCKED',
      blocker_message: git.error || git.reason || input.error || 'Git stage blocked.',
      git_stage_result: git,
      updated_at: timestamp()
    }, { merge: true });
    result = {
      success: false,
      action: 'BLOCKED',
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      mission_id: mission.id,
      git_stage_result: git,
      reason: git.reason || input.error || 'GIT_STAGE_BLOCKED'
    };
  });

  if (result?.action === 'COMPLETE' && result.roadmap_id && result.milestone_id) {
    const continuation = await continueRoadmapAfterComplete(
      db,
      tenantId,
      result.roadmap_id,
      result.milestone_id,
      input.continuation_options || {}
    );
    result = {
      ...result,
      auto_advance: continuation.auto_advance === true,
      next_milestone_id: continuation.next_milestone_id || null,
      next_mission_id: continuation.next_mission_id || null,
      next_brain_run_id: continuation.next_brain_run_id || null,
      continuation_state: continuation.continuation_state,
      checkpoint_id: continuation.checkpoint_id || null
    };
  }
  return result;
}

async function confirmHumanActionReady(db, tenantId, roadmapId, checkpointId, input = {}) {
  const confirmed = input.ready === true || input.confirm === true || input.confirmed === true || input.listo === true;
  if (!confirmed) {
    const error = new Error('HUMAN_ACTION_READY_CONFIRMATION_REQUIRED');
    error.status = 400;
    throw error;
  }

  let outcome = null;
  await db.runTransaction(async (tx) => {
    const roadmapRef = db.collection('roadmaps').doc(roadmapId);
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      const error = new Error('PLANNER_PROPOSAL_NOT_FOUND'); error.status = 404; throw error;
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    if (roadmap.proposal_type && roadmap.proposal_type !== 'PLANNER_ROADMAP') {
      const error = new Error('PLANNER_PROPOSAL_NOT_FOUND'); error.status = 404; throw error;
    }

    const matchingMilestones = (roadmap.milestones || []).filter((milestone) => {
      const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
      return checkpoint?.checkpoint_id === checkpointId;
    });
    const milestone = matchingMilestones[0] || null;
    const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
    if (!milestone || !checkpoint) {
      const error = new Error('HUMAN_ACTION_CHECKPOINT_NOT_FOUND'); error.status = 404; throw error;
    }

    const currentHumanMilestone = (roadmap.milestones || []).find((item) => unresolvedHumanActionCheckpoint(item));
    if (
      currentHumanMilestone &&
      currentHumanMilestone.id !== milestone.id &&
      unresolvedHumanActionCheckpoint(currentHumanMilestone)?.checkpoint_id !== checkpointId
    ) {
      const error = new Error('HUMAN_ACTION_CHECKPOINT_STALE');
      error.status = 409;
      throw error;
    }

    const missionId = checkpoint.mission_id || milestone.mission_id;
    const missionRef = missionId ? db.collection('missions').doc(missionId) : null;
    const missionSnap = missionRef ? await tx.get(missionRef) : null;
    if (!missionRef || !missionSnap.exists || missionSnap.data().tenant_id !== tenantId) {
      const error = new Error('HUMAN_ACTION_CHECKPOINT_NOT_FOUND'); error.status = 404; throw error;
    }
    const mission = { id: missionSnap.id, ...missionSnap.data() };
    if (
      checkpoint.roadmap_id !== roadmap.id ||
      checkpoint.milestone_id !== milestone.id ||
      checkpoint.mission_id !== mission.id ||
      mission.roadmap_id !== roadmap.id ||
      mission.milestone_id !== milestone.id
    ) {
      const error = new Error('HUMAN_ACTION_CHECKPOINT_PROVENANCE_INVALID');
      error.status = 409;
      throw error;
    }

    const projectSnap = mission.project_id ? await tx.get(db.collection('projects').doc(mission.project_id)) : null;
    const project = projectSnap?.exists && projectSnap.data().tenant_id === tenantId
      ? { id: projectSnap.id, ...projectSnap.data() }
      : {};

    const status = checkpointStatus(checkpoint);
    if (status === 'RESOLVED') {
      const inferredResolvedPausePhase = String(checkpoint.checkpoint_type || '').toUpperCase() === 'AUTOPILOT_VERIFICATION'
        ? 'VERIFY_EXECUTION'
        : '';
      const resolvedPausePhase = clean(checkpoint.paused_from_phase || checkpoint.resume_phase || mission.paused_from_phase || inferredResolvedPausePhase, 120).toUpperCase();
      outcome = {
        resumed: true,
        reused: true,
        no_new_work: true,
        state: resolvedPausePhase === 'VERIFY_EXECUTION' || resolvedPausePhase === 'VERIFYING' ? 'VERIFYING' : 'RESOLVED',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        brain_run_id: checkpoint.brain_run_id || milestone.brain_run_id || mission.brain_run_id || null,
        task_id: checkpoint.continuation_task_id || mission.current_task_id || null,
        checkpoint_id: checkpointId,
        resume_phase: resolvedPausePhase || null,
        message: 'Human Action checkpoint was already resolved.'
      };
      return;
    }
    if (!['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION'].includes(status)) {
      const error = new Error('HUMAN_ACTION_CHECKPOINT_NOT_WAITING');
      error.status = 409;
      throw error;
    }

    const validation = validateHumanActionCheckpoint(checkpoint, { project, mission });
    const now = milestoneTimestamp();
    if (!validation.ok) {
      const updatedCheckpoint = unresolvedValidatedCheckpoint(checkpoint, validation, now);
      tx.set(roadmapRef, {
        milestones: milestoneWithHumanAction(roadmap, milestone.id, updatedCheckpoint),
        updated_at: timestamp()
      }, { merge: true });
      tx.set(missionRef, {
        state: 'NEED_HUMAN_ACTION',
        autopilot_phase: 'NEED_HUMAN_ACTION',
        human_action_required: true,
        human_action_checkpoint: updatedCheckpoint,
        blocker_code: updatedCheckpoint.blocker_code,
        blocker_message: updatedCheckpoint.human_action_request,
        updated_at: timestamp()
      }, { merge: true });
      outcome = {
        resumed: false,
        state: 'NEED_HUMAN_ACTION',
        roadmap_id: roadmap.id,
        milestone_id: milestone.id,
        mission_id: mission.id,
        checkpoint_id: checkpointId,
        message: validation.message
      };
      return;
    }

    const updatedCheckpoint = resolvedCheckpoint(checkpoint, validation, now);
    const inferredPausePhase = String(checkpoint.checkpoint_type || '').toUpperCase() === 'AUTOPILOT_VERIFICATION'
      ? 'VERIFY_EXECUTION'
      : '';
    const pausePhase = clean(checkpoint.paused_from_phase || checkpoint.resume_phase || mission.paused_from_phase || inferredPausePhase, 120).toUpperCase();
    const brainRunId = checkpoint.brain_run_id || milestone.brain_run_id || mission.brain_run_id || null;
    const resumesVerification = pausePhase === 'VERIFY_EXECUTION' || pausePhase === 'VERIFYING';
    const resumesGitStage = pausePhase === 'GIT_STAGE';
    tx.set(roadmapRef, {
      milestones: milestoneWithState(roadmap, milestone.id, resumesVerification ? 'VERIFYING' : (resumesGitStage ? 'RUNNING' : 'NEED_HUMAN_ACTION'), {
        mission_id: mission.id,
        brain_run_id: milestone.brain_run_id || mission.brain_run_id || null,
        verification_brain_run_id: milestone.verification_brain_run_id || mission.verification_brain_run_id || null,
        human_action_required: false,
        human_action_checkpoint: updatedCheckpoint,
        waiting_status: 'RESOLVED',
        blocked_reason: null
      }),
      updated_at: timestamp()
    }, { merge: true });
    tx.set(missionRef, {
      state: resumesVerification || resumesGitStage ? 'RUNNING' : 'NEED_HUMAN_ACTION',
      autopilot_phase: resumesVerification ? 'VERIFYING' : (resumesGitStage ? 'GIT_STAGE' : 'NEED_HUMAN_ACTION'),
      human_action_required: false,
      human_action_checkpoint: updatedCheckpoint,
      updated_at: timestamp()
    }, { merge: true });
    outcome = {
      resumed: resumesVerification || resumesGitStage,
      state: resumesVerification ? 'VERIFYING' : (resumesGitStage ? 'GIT_STAGE' : 'RESOLVED'),
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      mission_id: mission.id,
      brain_run_id: brainRunId,
      checkpoint_id: checkpointId,
      resume_phase: pausePhase || 'PROGRAM',
      message: validation.message
    };
  });

  if (outcome?.no_new_work === true || outcome?.state === 'NEED_HUMAN_ACTION' || outcome?.resume_phase === 'VERIFY_EXECUTION' || outcome?.resume_phase === 'VERIFYING' || outcome?.resume_phase === 'GIT_STAGE') {
    return outcome;
  }
  if (outcome?.state === 'RESOLVED' && outcome?.brain_run_id) {
    const { resumeAutopilotProgramAfterHumanAction } = require('./orchestration');
    return resumeAutopilotProgramAfterHumanAction(db, tenantId, {
      mission_id: outcome.mission_id,
      roadmap_id: outcome.roadmap_id,
      milestone_id: outcome.milestone_id,
      brain_run_id: outcome.brain_run_id,
      checkpoint_id: outcome.checkpoint_id
    });
  }
  return outcome;
}

module.exports = {
  TERMINAL_MISSION_STATES,
  linkedMissionBlocksFreshStart,
  AUTOPILOT_ACTIONS,
  parseAutopilotDecision,
  normalizeHumanActionCheckpoint,
  unresolvedHumanActionCheckpoint,
  validateHumanActionCheckpoint,
  confirmHumanActionReady,
  milestoneWithHumanAction,
  failClosedHumanActionReason,
  continueRoadmapAfterComplete,
  startNextRoadmapMilestone,
  plannerAutopilotBrainContext,
  queueVerificationBrainRun,
  completeGitStageExecutionRun,
  completeVerificationBrainRun
};
