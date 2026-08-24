const CONTRACT_VERSION = 'CODEX_HANDOFF_V0_3_8';

const EXECUTION_RULES = Object.freeze([
  'You are the Executor, not the Brain.',
  'Work only in the local repository shown in this handoff.',
  'Follow the validated task_spec instructions exactly.',
  'Do not redesign strategy.',
  'Do not invent business objectives.',
  'Do not change Worker role.',
  'Preserve multi-tenancy and existing functionality.',
  'Run local tests requested by the task_spec.',
  'Do not access GCP, Google Cloud credentials, or Cloud Run.',
  'Do not deploy.',
  'Do not run git commit or git push; the Runner owns commit/push after successful Codex execution.',
  'Runner may commit/push only when trusted MRAPI handoff git_permissions allow it.',
  'Stop if the Brain stop conditions are met.'
]);

function fail(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeTaskSpec(task, brainRun) {
  const brainOutput = objectOrNull(task.brain_output) || objectOrNull(brainRun?.brain_output) || {};
  const sourceSpec = objectOrNull(brainOutput.task_spec) || {};

  const objective = String(
    sourceSpec.objective ||
    brainOutput.objective ||
    task.objective ||
    brainRun?.objective ||
    ''
  ).trim();

  const instructions = String(
    sourceSpec.instructions ||
    brainOutput.instructions ||
    task.instructions ||
    objective
  ).trim();

  if (!objective && !instructions) {
    throw fail('CODEX_HANDOFF_TASK_SPEC_REQUIRED');
  }

  return {
    title: String(sourceSpec.title || task.title || objective || 'Codex execution task').trim(),
    objective,
    instructions
  };
}

function normalizeExecutionConstraints(task, brainRun) {
  const brainOutput = objectOrNull(task.brain_output) || objectOrNull(brainRun?.brain_output) || {};
  const source = objectOrNull(brainOutput.execution_constraints) || {};

  return {
    ...source,
    no_gcp: true,
    no_cloud_run: true,
    no_deploy: true,
    deployment: 'HUMAN_MANUAL_DEPLOY',
    repository_scope: 'LOCAL_REPOSITORY_ONLY',
    forbidden_actions: [
      'GCP_ACCESS',
      'CLOUD_RUN_ACCESS',
      'DEPLOY',
      'PRODUCTION_CREDENTIALS',
      'UNREQUESTED_PUSH'
    ]
  };
}

function normalizeGitPermissions(workerProfile) {
  const permissions = objectOrNull(workerProfile?.permissions) || {};
  return {
    allow_commit: permissions.allow_git_commit === true,
    allow_push: permissions.allow_git_push === true,
    allowed_branch: 'main'
  };
}

function trustedScope({ tenantId, task, mission, brainRun }) {
  if (!tenantId) throw fail('CODEX_HANDOFF_TENANT_REQUIRED');
  if (!task?.id) throw fail('CODEX_HANDOFF_TASK_REQUIRED');
  if (task.tenant_id !== tenantId) throw fail('CODEX_HANDOFF_TASK_TENANT_MISMATCH');
  if (!['QUEUED', 'ASSIGNED'].includes(task.state)) {
    throw fail('CODEX_HANDOFF_TASK_NOT_CLAIMABLE');
  }
  if (!mission?.id) throw fail('CODEX_HANDOFF_MISSION_REQUIRED');
  if (mission.tenant_id !== tenantId) throw fail('CODEX_HANDOFF_MISSION_TENANT_MISMATCH');
  if (task.mission_id !== mission.id) throw fail('CODEX_HANDOFF_TASK_MISSION_MISMATCH');
  if (!task.worker_id) throw fail('CODEX_HANDOFF_WORKER_REQUIRED');

  if (task.brain_run_id) {
    if (!brainRun?.id) throw fail('CODEX_HANDOFF_BRAIN_RUN_REQUIRED');
    if (brainRun.tenant_id !== tenantId) throw fail('CODEX_HANDOFF_BRAIN_TENANT_MISMATCH');
    if (brainRun.run_type !== 'BRAIN_RUN') throw fail('CODEX_HANDOFF_BRAIN_RUN_TYPE_REQUIRED');
    if (brainRun.state !== 'COMPLETED') throw fail('CODEX_HANDOFF_BRAIN_NOT_COMPLETED');
    if (brainRun.mission_id && brainRun.mission_id !== mission.id) {
      throw fail('CODEX_HANDOFF_BRAIN_MISSION_MISMATCH');
    }
  }

  const workspaceId = mission.workspace_id || brainRun?.workspace_id || null;
  const projectId = mission.project_id || brainRun?.project_id || null;
  if (!workspaceId || !projectId) throw fail('CODEX_HANDOFF_SCOPE_REQUIRED');

  return {
    tenant_id: tenantId,
    mission_id: mission.id,
    task_id: task.id,
    brain_run_id: task.brain_run_id || brainRun?.id || null,
    workspace_id: workspaceId,
    project_id: projectId
  };
}

function buildCodexHandoff(input) {
  const {
    tenantId,
    task,
    mission,
    brainRun = null,
    workerProfile = null,
    executor = {},
    executionRunId,
    repositoryPath
  } = input || {};

  if (!executionRunId) throw fail('CODEX_HANDOFF_EXECUTION_RUN_REQUIRED');
  if (!String(repositoryPath || '').trim()) throw fail('CODEX_HANDOFF_REPOSITORY_PATH_REQUIRED');

  const scope = trustedScope({ tenantId, task, mission, brainRun });
  const taskSpec = normalizeTaskSpec(task, brainRun);

  return {
    contract_version: CONTRACT_VERSION,
    type: 'CODEX_HANDOFF',
    transport: 'CODEX_APP_MANUAL',
    executor_mode: 'CODEX_APP_MANUAL',
    ...scope,
    execution_run_id: executionRunId,
    worker_id: task.worker_id,
    executor_id: executor.id || task.claimed_by_executor_id || null,
    host_name: executor.host_name || 'Shadow',
    objective: taskSpec.objective || taskSpec.instructions,
    task_spec: taskSpec,
    execution_constraints: normalizeExecutionConstraints(task, brainRun),
    git_permissions: normalizeGitPermissions(workerProfile),
    repository_path: String(repositoryPath).trim(),
    execution_rules: [...EXECUTION_RULES],
    return_contract: [
      'changed files',
      'tests run + results',
      'success/failure',
      'concise summary',
      'HUMAN MANUAL DEPLOY if deployment is required'
    ]
  };
}

module.exports = {
  CONTRACT_VERSION,
  EXECUTION_RULES,
  buildCodexHandoff
};
