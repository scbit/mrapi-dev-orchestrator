const path = require('path');

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizePath(value) {
  return clean(value, 4000).replace(/\//g, '\\').replace(/\\+$/, '');
}

function runtimeBinding(project = {}) {
  const runtime = project.runtime_context && typeof project.runtime_context === 'object'
    ? project.runtime_context
    : {};
  return {
    host_id: clean(runtime.host_id || project.host_id || '', 300),
    host_name: clean(runtime.host_name || project.host_name || '', 300),
    repository_path: normalizePath(runtime.repository_path || runtime.local_path || project.repository_path || project.local_path || ''),
    repository_full_name: clean(project.repository_full_name || runtime.repository_full_name || '', 500),
    default_branch: clean(project.default_branch || runtime.default_branch || 'main', 200) || 'main',
    state: clean(runtime.binding_state || project.runtime_binding_state || 'UNCONFIGURED', 100).toUpperCase()
  };
}

function runtimeMissing(project = {}) {
  const binding = runtimeBinding(project);
  const missing = [];
  if (!binding.repository_full_name) missing.push('repository_full_name');
  if (!binding.repository_path) missing.push('repository_path');
  if (!binding.host_name && !binding.host_id) missing.push('host');
  return missing;
}

function runtimeReady(project = {}) {
  const binding = runtimeBinding(project);
  return runtimeMissing(project).length === 0 &&
    ['CONFIGURED', 'VALIDATED', 'READY'].includes(binding.state);
}

async function assertProjectRuntimeReady(db, tenantId, projectId, workspaceId = null) {
  const id = clean(projectId, 300);
  if (!id) {
    const error = new Error('PROJECT_ID_REQUIRED');
    error.status = 400;
    throw error;
  }
  const snap = await db.collection('projects').doc(id).get();
  if (!snap.exists || snap.data().tenant_id !== tenantId) {
    const error = new Error('PROJECT_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  const project = { id: snap.id, ...snap.data() };
  if (workspaceId && project.workspace_id !== workspaceId) {
    const error = new Error('PROJECT_WORKSPACE_MISMATCH');
    error.status = 409;
    throw error;
  }
  const missing = runtimeMissing(project);
  if (missing.length) {
    const error = new Error(`PROJECT_RUNTIME_BINDING_REQUIRED:${missing.join(',')}`);
    error.status = 409;
    throw error;
  }
  if (!runtimeReady(project)) {
    const error = new Error('PROJECT_RUNTIME_BINDING_NOT_READY');
    error.status = 409;
    throw error;
  }
  return { project, binding: runtimeBinding(project) };
}

function projectRuntimePayload(input = {}, existing = {}) {
  const current = runtimeBinding(existing);
  const repositoryFullName = clean(input.repository_full_name || current.repository_full_name, 500);
  const repositoryPath = normalizePath(input.repository_path || input.local_path || current.repository_path);
  const hostName = clean(input.host_name || current.host_name || 'Shadow', 300);
  const hostId = clean(input.host_id || current.host_id, 300);
  const defaultBranch = clean(input.default_branch || current.default_branch || 'main', 200) || 'main';
  const missing = [];
  if (!repositoryFullName) missing.push('repository_full_name');
  if (!repositoryPath) missing.push('repository_path');
  if (!hostName && !hostId) missing.push('host');
  return {
    repository_full_name: repositoryFullName || null,
    local_path: repositoryPath || null,
    repository_path: repositoryPath || null,
    default_branch: defaultBranch,
    runtime_context: {
      ...(existing.runtime_context && typeof existing.runtime_context === 'object' ? existing.runtime_context : {}),
      repository_path: repositoryPath || null,
      local_path: repositoryPath || null,
      repository_full_name: repositoryFullName || null,
      default_branch: defaultBranch,
      host_name: hostName || null,
      host_id: hostId || null,
      binding_state: missing.length ? 'UNCONFIGURED' : 'READY'
    },
    runtime_binding_state: missing.length ? 'UNCONFIGURED' : 'READY',
    runtime_binding_missing: missing
  };
}

module.exports = {
  clean,
  normalizePath,
  runtimeBinding,
  runtimeMissing,
  runtimeReady,
  assertProjectRuntimeReady,
  projectRuntimePayload
};
