const state = {
  dashboard: null,
  workers: [],
  missions: [],
  tasks: [],
  runs: [],
  results: [],
  workspaces: [],
  projects: [],
  context: {
    loading: true,
    error: '',
    workspaceId: '',
    projectId: '',
    workspaceName: '',
    projectName: ''
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const productContextStorageKey = 'mrapi.product.context.v1';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Request failed: ${response.status}`);
    error.body = body;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stateBadge(value) {
  const safe = escapeHtml(value || 'UNKNOWN');
  return `<span class="state-badge state-${safe}">${safe}</span>`;
}

function workspaceLabel(workspace) {
  return String(workspace?.name || workspace?.display_name || workspace?.id || '').trim();
}

function projectLabel(project) {
  return String(project?.name || project?.title || project?.display_name || project?.id || '').trim();
}

function projectWorkspaceId(project) {
  return String(project?.workspace_id || project?.workspaceId || '').trim();
}

function projectsForWorkspace(workspaceId) {
  return state.projects.filter((project) => projectWorkspaceId(project) === workspaceId);
}

function readPersistedContextPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(productContextStorageKey) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    return {
      workspaceId: String(saved.workspaceId || saved.workspace_id || '').trim(),
      projectId: String(saved.projectId || saved.project_id || '').trim()
    };
  } catch {
    return null;
  }
}

function persistContextPreference() {
  const current = validatedContext();
  if (!current.valid) return false;
  try {
    localStorage.setItem(productContextStorageKey, JSON.stringify({
      workspaceId: current.workspace.id,
      projectId: current.project.id
    }));
    return true;
  } catch {
    return false;
  }
}

function clearPersistedContextPreference() {
  try { localStorage.removeItem(productContextStorageKey); } catch {}
}

function validatedContext(candidate = state.context) {
  const workspaceId = String(candidate?.workspaceId || candidate?.workspace_id || '').trim();
  const projectId = String(candidate?.projectId || candidate?.project_id || '').trim();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const project = state.projects.find((item) => item.id === projectId);
  const projectValid = Boolean(project && projectWorkspaceId(project) === workspaceId);
  return {
    valid: Boolean(workspace && projectValid),
    workspaceValid: Boolean(workspace),
    projectValid,
    workspace,
    project,
    workspaceId,
    projectId
  };
}

function setCurrentContext(workspaceId, projectId, options = {}) {
  const workspace = state.workspaces.find((item) => item.id === workspaceId) || null;
  const projects = workspace ? projectsForWorkspace(workspace.id) : [];
  const project = projects.find((item) => item.id === projectId) || null;

  state.context.workspaceId = workspace?.id || '';
  state.context.projectId = project?.id || '';
  state.context.workspaceName = workspace ? workspaceLabel(workspace) : '';
  state.context.projectName = project ? projectLabel(project) : '';

  if (options.persist) {
    if (workspace && project) persistContextPreference();
    else clearPersistedContextPreference();
  }

  renderContextHeader();
}

function renderProjectSelectOptions(select, workspaceId, selectedProjectId = '') {
  const projects = workspaceId ? projectsForWorkspace(workspaceId) : [];
  if (!workspaceId) {
    select.innerHTML = '<option value="">Select workspace first</option>';
    select.disabled = true;
    return;
  }
  if (!projects.length) {
    select.innerHTML = '<option value="">No projects in this workspace</option>';
    select.disabled = true;
    return;
  }
  select.innerHTML = '<option value="">Select project</option>' + projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(projectLabel(project))}</option>`)
    .join('');
  select.value = projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : '';
  select.disabled = false;
}

function renderContextHeader() {
  const workspaceSelect = $('#globalWorkspaceSelect');
  const projectSelect = $('#globalProjectSelect');
  const status = $('#globalContextStatus');
  const technical = $('#globalContextTechnical');
  if (!workspaceSelect || !projectSelect || !status || !technical) return;

  if (state.context.loading) {
    workspaceSelect.innerHTML = '<option value="">Loading context...</option>';
    projectSelect.innerHTML = '<option value="">Loading context...</option>';
    workspaceSelect.disabled = true;
    projectSelect.disabled = true;
    status.textContent = 'Loading trusted context...';
    status.className = 'context-status is-loading';
    return;
  }

  if (state.context.error) {
    workspaceSelect.innerHTML = '<option value="">Context unavailable</option>';
    projectSelect.innerHTML = '<option value="">Context unavailable</option>';
    workspaceSelect.disabled = true;
    projectSelect.disabled = true;
    status.textContent = state.context.error;
    status.className = 'context-status is-error';
    return;
  }

  workspaceSelect.innerHTML = '<option value="">Select workspace</option>' + state.workspaces
    .map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspaceLabel(workspace))}</option>`)
    .join('');
  workspaceSelect.value = state.workspaces.some((workspace) => workspace.id === state.context.workspaceId)
    ? state.context.workspaceId
    : '';
  workspaceSelect.disabled = !state.workspaces.length;
  renderProjectSelectOptions(projectSelect, workspaceSelect.value, state.context.projectId);

  const current = validatedContext();
  if (!state.workspaces.length) {
    status.textContent = 'No workspaces are available.';
    status.className = 'context-status is-empty';
  } else if (workspaceSelect.value && !projectsForWorkspace(workspaceSelect.value).length) {
    status.textContent = 'This workspace has no projects. Create or select a valid project before starting work.';
    status.className = 'context-status is-empty';
  } else if (!current.valid) {
    status.textContent = 'Select a valid workspace and project before creating scoped work.';
    status.className = 'context-status is-attention';
  } else {
    status.textContent = `${workspaceLabel(current.workspace)} / ${projectLabel(current.project)}`;
    status.className = 'context-status is-ready';
  }

  technical.innerHTML = `Workspace ID: ${escapeHtml(state.context.workspaceId || 'none')}<br>Project ID: ${escapeHtml(state.context.projectId || 'none')}`;
}

async function loadTrustedContext() {
  state.context.loading = true;
  state.context.error = '';
  renderContextHeader();
  try {
    const [workspaceData, projectData] = await Promise.all([
      api('/api/workspaces'),
      api('/api/projects')
    ]);
    state.workspaces = Array.isArray(workspaceData.items) ? workspaceData.items : [];
    state.projects = Array.isArray(projectData.items) ? projectData.items : [];
    state.context.loading = false;

    const remembered = readPersistedContextPreference();
    const validRemembered = remembered ? validatedContext(remembered) : null;
    if (validRemembered?.valid) {
      setCurrentContext(validRemembered.workspace.id, validRemembered.project.id);
    } else {
      if (remembered?.workspaceId || remembered?.projectId) clearPersistedContextPreference();
      setCurrentContext('', '');
    }
  } catch (error) {
    state.context.loading = false;
    state.context.error = `Could not load workspace/project context: ${error.message}`;
    state.context.workspaceId = '';
    state.context.projectId = '';
    state.context.workspaceName = '';
    state.context.projectName = '';
    renderContextHeader();
  }
}

function runForMission(missionId) {
  return state.runs
    .filter((run) => run.mission_id === missionId)
    .sort((a, b) => timestampMs(b.updated_at || b.completed_at || b.created_at) - timestampMs(a.updated_at || a.completed_at || a.created_at))[0] || null;
}

function missionProgress(mission) {
  if (mission.state === 'COMPLETED') return { percent: 100, label: 'Completed' };
  if (mission.state === 'FAILED' || mission.state === 'CANCELLED') return { percent: 100, label: mission.state };
  const runs = state.runs.filter((run) => run.mission_id === mission.id);
  const exec = runs.find((run) => run.run_type === 'EXECUTION_RUN' && run.state === 'RUNNING');
  if (exec) return { percent: Number(exec.progress_percent || 0), label: exec.progress_message || 'Executing' };
  const brain = runs.find((run) => run.run_type === 'BRAIN_RUN' && run.state === 'RUNNING');
  if (brain && brain.progress_percent != null) return { percent: Number(brain.progress_percent || 0), label: brain.progress_message || 'Brain planning' };
  return null;
}

function progressBar(progress) {
  if (!progress) return '';
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  return `
    <div class="progress-wrap" title="${escapeHtml(progress.label)}">
      <div class="progress-meta"><span>${escapeHtml(progress.label)}</span><strong>${percent}%</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
    </div>
  `;
}

function latestResult(missionId) {
  const items = state.results
    .filter((result) => result.mission_id === missionId)
    .sort((a, b) => timestampMs(a.updated_at || a.completed_at || a.created_at) - timestampMs(b.updated_at || b.completed_at || b.created_at));
  return items[items.length - 1] || null;
}

function workerRow(worker) {
  return `
    <div class="worker-row">
      <div class="worker-code">${escapeHtml(worker.code)}</div>
      <div>
        <div class="worker-name">${escapeHtml(worker.name)}</div>
        <div class="worker-role">${escapeHtml(worker.role)}${worker.operational_status ? ` · ${escapeHtml(worker.operational_status)}` : ''}</div>
      </div>
      ${stateBadge(worker.operational_status || worker.state)}
    </div>
  `;
}

function missionItem(mission) {
  const canDispatch = mission.state === 'READY';
  const canRetry = ['FAILED', 'BLOCKED'].includes(mission.state);
  const canCancel = ['READY', 'PLANNING', 'RUNNING', 'BLOCKED'].includes(mission.state);
  const result = latestResult(mission.id);
  const progress = missionProgress(mission);
  return `
    <div class="mission-item mission-clickable" data-open-mission="${escapeHtml(mission.id)}">
      <div class="mission-main">
        <h4>${escapeHtml(mission.objective)}</h4>
        <div class="mission-meta">
          ${escapeHtml(mission.workspace_id)} · ${escapeHtml(mission.project_id)}
          ${mission.preferred_worker_id ? ` · ${escapeHtml(mission.preferred_worker_id)}` : ''}
        </div>
        ${progressBar(progress)}
        ${result ? `<div class="result-preview">${escapeHtml(result.summary || result.result_type || 'Result available')}</div>` : ''}
      </div>
      <div class="mission-actions">
        ${stateBadge(mission.state)}
        ${canDispatch ? `<button type="button" class="ghost-button dispatch-button" data-mission-id="${escapeHtml(mission.id)}">Dispatch</button>` : ''}
        ${canRetry ? `<button type="button" class="ghost-button retry-button" data-mission-id="${escapeHtml(mission.id)}">Retry</button>` : ''}
        ${canCancel ? `<button type="button" class="ghost-button cancel-mission-button" data-mission-id="${escapeHtml(mission.id)}">Cancel</button>` : ''}
      </div>
    </div>
  `;
}

function heartbeatLabel(item) {
  const age = item.heartbeat_age_seconds == null ? 'never' : `${item.heartbeat_age_seconds}s ago`;
  return `${item.health_state || 'OFFLINE'} · ${age}`;
}

function trustedObject(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return {};
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.entries(value).filter(([, enabled]) => enabled === true).map(([key]) => key);
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function humanStateLabel(stateKey) {
  return {
    IDLE: 'Idle',
    WORKING: 'Working',
    WAITING: 'Waiting',
    BLOCKED: 'Blocked',
    OFFLINE: 'Offline'
  }[stateKey] || 'Idle';
}

function stateBadgeClass(value) {
  return String(value || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
}

function humanStateBadge(value) {
  const key = stateBadgeClass(value);
  return `<span class="state-badge state-${escapeHtml(key)}">${escapeHtml(humanStateLabel(key) || key)}</span>`;
}

function currentMissionId(worker) {
  return textValue(worker.current_mission_id, worker.active_mission_id, worker.mission_id, worker.currentMissionId, worker.activeMissionId);
}

function missionForWorker(worker) {
  const missionId = currentMissionId(worker);
  if (!missionId) return null;
  return state.missions.find((mission) => mission.id === missionId) ||
    (state.dashboard?.recent_missions || []).find((mission) => mission.id === missionId) ||
    null;
}

function executorForWorker(worker) {
  const binding = trustedObject(worker, ['executor_binding', 'executor', 'execution_binding']);
  const executorId = textValue(worker.executor_id, worker.executor_binding_id, binding.executor_id, binding.id, binding.executorId);
  const workerId = textValue(worker.id, worker.code);
  const items = state.dashboard?.executors?.items || [];
  return items.find((executor) =>
    (executorId && [executor.id, executor.executor_id, executor.name].map(textValue).includes(executorId)) ||
    (workerId && (executor.worker_ids || []).includes(workerId))
  ) || binding || null;
}

function brainForWorker(worker) {
  const binding = trustedObject(worker, ['brain_binding', 'brain', 'brain_configuration']);
  const workerId = textValue(worker.id, worker.code);
  const items = state.dashboard?.brain_adapters?.items || [];
  return items.find((brain) => workerId && (brain.worker_ids || []).includes(workerId)) || binding || null;
}

function isTrustedOffline(worker, executor = null) {
  const values = [
    worker.health_state,
    worker.runner_status,
    worker.operational_status,
    worker.state,
    worker.executor_health,
    executor?.health_state,
    executor?.runner_status
  ].map(upperValue).filter(Boolean);
  const hasRuntime = values.some((value) => ['ONLINE', 'HEALTHY', 'READY', 'IDLE', 'RUNNING', 'WORKING', 'AVAILABLE'].includes(value));
  return values.some((value) => ['OFFLINE', 'UNHEALTHY', 'HEALTH_FAILED', 'DISCONNECTED'].includes(value)) && !hasRuntime;
}

function isWaitingState(value) {
  const stateText = upperValue(value);
  return stateText.includes('WAITING') || ['PENDING', 'QUEUED', 'READY', 'NEEDS_HUMAN', 'HUMAN_ACTION_REQUIRED', 'RECOVERY_REQUIRED'].includes(stateText);
}

function deriveWorkerHumanStatus(worker) {
  const mission = missionForWorker(worker);
  const executor = executorForWorker(worker);
  const workerStates = [worker.operational_status, worker.status, worker.state, worker.worker_status].map(upperValue).filter(Boolean);
  const missionStates = [mission?.state, worker.current_mission_status, worker.mission_status].map(upperValue).filter(Boolean);
  const executorStates = [executor?.runner_status, executor?.health_state, worker.executor_health].map(upperValue).filter(Boolean);

  if (isTrustedOffline(worker, executor)) return 'OFFLINE';
  if ([...workerStates, ...missionStates].some((value) => ['BLOCKED', 'FAILED_BLOCKED'].includes(value))) return 'BLOCKED';
  if (currentMissionId(worker) && [...workerStates, ...missionStates, ...executorStates].some((value) => ['RUNNING', 'WORKING', 'BUSY', 'PLANNING', 'TESTING', 'EXECUTING'].includes(value))) return 'WORKING';
  if (worker.current_brain_run_id || worker.current_run_id || executor?.current_run_id || missionStates.some((value) => ['RUNNING', 'PLANNING'].includes(value))) return 'WORKING';
  if ([...workerStates, ...missionStates, ...executorStates, worker.waiting_reason, worker.blocker_code].some(isWaitingState)) return 'WAITING';
  return 'IDLE';
}

function deriveExecutorHumanStatus(executor) {
  const values = [executor.health_state, executor.runner_status, executor.state, executor.status].map(upperValue).filter(Boolean);
  if (values.some((value) => ['OFFLINE', 'UNHEALTHY', 'DISCONNECTED', 'HEALTH_FAILED'].includes(value))) return 'OFFLINE';
  if (values.some((value) => ['BLOCKED', 'FAILED'].includes(value))) return 'BLOCKED';
  if (executor.current_run_id || values.some((value) => ['RUNNING', 'WORKING', 'BUSY', 'EXECUTING'].includes(value))) return 'WORKING';
  if (values.some((value) => ['WAITING', 'QUEUED', 'PENDING', 'READY'].includes(value))) return 'WAITING';
  return 'IDLE';
}

function matchingRun(runId) {
  if (!runId) return null;
  return state.runs.find((run) => run.id === runId || run.run_id === runId) || null;
}

function matchingTask(taskId) {
  if (!taskId) return null;
  return state.tasks.find((task) => task.id === taskId || task.task_id === taskId) || null;
}

function scopeSummary(worker) {
  const workspaceId = textValue(worker.workspace_id, worker.workspaceId);
  const projectId = textValue(worker.project_id, worker.projectId);
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const project = state.projects.find((item) => item.id === projectId);
  return {
    workspaceId,
    projectId,
    workspaceLabel: workspace ? workspaceLabel(workspace) : textValue(worker.workspace_name, workspaceId, 'Not configured'),
    projectLabel: project ? projectLabel(project) : textValue(worker.project_name, projectId, 'Not configured')
  };
}

function latestTrustedActivity(sources) {
  const stamped = sources.filter(Boolean).flatMap((item) => [
    item.updated_at,
    item.completed_at,
    item.started_at,
    item.created_at,
    item.last_activity_at,
    item.last_seen_at,
    item.last_heartbeat_at,
    item.heartbeat_at
  ].filter(Boolean).map((value) => ({ value, ms: timestampMs(value) })));
  return stamped.sort((a, b) => b.ms - a.ms)[0] || null;
}

function renderFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(textValue(value, 'Not recorded'))}</strong></div>`;
}

function renderTags(items, emptyText = 'Not configured') {
  const values = arrayValue(items);
  return values.length
    ? `<ul class="compact-tags">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="neutral-copy">${escapeHtml(emptyText)}</p>`;
}

function sensitivePermissionKeys() {
  return ['git_write', 'push', 'deploy', 'production', 'publishing'];
}

function permissionEntries(permissions = {}) {
  const entries = permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? Object.entries(permissions) : [];
  const present = new Set(entries.map(([key]) => key));
  for (const key of sensitivePermissionKeys()) {
    if (!present.has(key)) entries.push([key, null]);
  }
  return entries;
}

function permissionLabel(value) {
  if (value === true) return 'Allowed';
  if (value === false) return 'Not authorized';
  return 'Not configured';
}

function renderPermissions(permissions) {
  const entries = permissionEntries(permissions);
  return entries.length
    ? `<ul class="permission-list">${entries.map(([key, value]) => `<li><span>${escapeHtml(key)}</span><strong>${escapeHtml(permissionLabel(value))}</strong></li>`).join('')}</ul>`
    : '<p class="neutral-copy">Not configured</p>';
}

function renderWorkerCard(worker) {
  const missionId = currentMissionId(worker);
  const mission = missionForWorker(worker);
  const brain = brainForWorker(worker);
  const executor = executorForWorker(worker);
  const host = trustedObject(worker, ['host_binding', 'host']);
  const hostSource = Object.keys(host).length ? host : executor || {};
  const scope = scopeSummary(worker);
  const status = deriveWorkerHumanStatus(worker);
  const brainConfigured = worker.brain_binding || worker.brain || worker.brain_configuration ? 'Yes' : 'No';
  const executorConfigured = worker.executor_binding || worker.executor || worker.executor_id || executor ? 'Yes' : 'No';
  const hostConfigured = worker.host_binding || worker.host || executor?.host_name || executor?.host_id ? 'Yes' : 'No';
  const latest = latestTrustedActivity([worker, mission, brain, executor, hostSource]);
  const brainRunId = textValue(worker.current_brain_run_id, brain?.current_brain_run_id, brain?.brain_run_id);
  const executorRunId = textValue(worker.current_run_id, executor?.current_run_id);

  return `
    <article class="worker-card worker-architecture-card">
      <div class="worker-card-top">
        <section class="architecture-section worker-identity-section" aria-label="Worker identity">
          <span class="eyebrow">Worker identity</span>
          <h3>${escapeHtml(textValue(worker.name, worker.display_name, worker.code, worker.id, 'Unnamed Worker'))}</h3>
          <div class="architecture-subtitle">${escapeHtml(textValue(worker.role, 'Role not configured'))}</div>
          <div class="architecture-subtitle">Worker ${escapeHtml(textValue(worker.code, worker.id, 'Not configured'))}</div>
        </section>
        ${humanStateBadge(status)}
      </div>
      <div class="architecture-grid">
        <section class="architecture-section" aria-label="Current Mission">
          <span class="eyebrow">Current Mission</span>
          <h4>${escapeHtml(mission ? textValue(mission.objective, 'Mission objective not recorded') : (missionId ? 'Current Mission' : 'No active Mission'))}</h4>
          <p>${escapeHtml(mission ? textValue(mission.state, mission.status, 'Mission status not recorded') : (missionId ? 'Mission details unavailable in loaded data' : 'No active Mission'))}</p>
        </section>
        <section class="architecture-section" aria-label="Scope">
          <span class="eyebrow">Scope</span>
          <div class="architecture-facts">
            ${renderFact('Workspace', scope.workspaceLabel)}
            ${renderFact('Project', scope.projectLabel)}
          </div>
        </section>
        <section class="architecture-section" aria-label="Brain">
          <span class="eyebrow">Brain</span>
          <h4>${escapeHtml(textValue(brain?.name, brain?.provider, brain?.type, worker.brain_type, 'Brain configuration'))}</h4>
          <div class="architecture-facts">
            ${renderFact('Configured', brainConfigured)}
            ${renderFact('Type / provider', textValue(brain?.type, brain?.provider, worker.brain_type, 'Not configured'))}
            ${renderFact('Health / state', textValue(brain?.health_state, brain?.state, worker.brain_health, 'Not recorded'))}
            ${renderFact('Current Brain Run', brainRunId ? 'Brain Run active' : 'No current Brain Run')}
          </div>
        </section>
        <section class="architecture-section" aria-label="Executor">
          <span class="eyebrow">Executor</span>
          <h4>${escapeHtml(textValue(executor?.name, executor?.id, worker.executor_id, 'Executor availability'))}</h4>
          <p>Executes Tasks/Runs.</p>
          <div class="architecture-facts">
            ${renderFact('Configured', executorConfigured)}
            ${renderFact('Type', textValue(executor?.executor_type, worker.executor_type, 'Not configured'))}
            ${renderFact('Availability', textValue(executor?.health_state, executor?.runner_status, worker.executor_health, 'Unavailable'))}
            ${renderFact('Current Run', executorRunId ? 'Execution in progress' : 'No current Run')}
          </div>
        </section>
        <section class="architecture-section" aria-label="Host">
          <span class="eyebrow">Host</span>
          <h4>${escapeHtml(textValue(executor?.host_name, hostSource.host_name, hostSource.name, executor?.host_id, hostSource.host_id, 'Host environment'))}</h4>
          <p>Environment where Executor runs.</p>
          <div class="architecture-facts">
            ${renderFact('Configured', hostConfigured)}
            ${renderFact('Provider / machine', textValue(hostSource.provider, hostSource.machine, hostSource.environment, 'Not reported'))}
            ${renderFact('Availability', textValue(hostSource.host_state, hostSource.validation_state, hostSource.health_state, 'Not reported'))}
            ${renderFact('Repository readiness', textValue(hostSource.repository_state, hostSource.repo_ready, hostSource.runtime_validation_state, 'Not reported'))}
          </div>
        </section>
        <section class="architecture-section" aria-label="Capabilities">
          <span class="eyebrow">Capabilities</span>
          ${renderTags(worker.capabilities || executor?.capabilities, 'No capabilities reported')}
        </section>
        <section class="architecture-section" aria-label="Permissions">
          <span class="eyebrow">Permissions</span>
          ${renderPermissions(worker.permissions)}
        </section>
        <section class="architecture-section" aria-label="Last activity">
          <span class="eyebrow">Last activity</span>
          <h4>${escapeHtml(latest ? formatTrustedTime(latest.value) : 'No recent activity recorded')}</h4>
        </section>
      </div>
      <details class="advanced-details worker-technical-details">
        <summary>Advanced / Technical Details</summary>
        <div class="technical-grid">
          ${renderFact('Worker ID', textValue(worker.id, worker.code, 'none'))}
          ${renderFact('Tenant / Workspace / Project IDs', `${textValue(worker.tenant_id, 'tenant unavailable')} / ${textValue(scope.workspaceId, 'workspace unavailable')} / ${textValue(scope.projectId, 'project unavailable')}`)}
          ${renderFact('Current Mission ID', textValue(missionId, 'none'))}
          ${renderFact('Brain binding/profile IDs', textValue(worker.brain_binding_id, worker.brain_profile_id, brain?.id, 'none'))}
          ${renderFact('Current Brain Run ID', textValue(brainRunId, 'none'))}
          ${renderFact('Executor binding/type/id', textValue(worker.executor_binding_id, worker.executor_type, executor?.executor_type, executor?.id, 'none'))}
          ${renderFact('Host binding/provider/id', textValue(worker.host_binding_id, hostSource.provider, hostSource.host_id, hostSource.id, 'none'))}
          ${renderFact('Raw status/health', textValue(worker.operational_status, worker.state, worker.health_state, worker.executor_health, 'none'))}
          ${renderFact('Latest activity timestamp', latest?.value || 'none')}
          <div><span>Raw capabilities</span><pre class="result-json">${escapeHtml(JSON.stringify(worker.capabilities || {}, null, 2))}</pre></div>
          <div><span>Raw permissions</span><pre class="result-json">${escapeHtml(JSON.stringify(worker.permissions || {}, null, 2))}</pre></div>
        </div>
      </details>
    </article>
  `;
}

function renderExecutorCard(executor) {
  const status = deriveExecutorHumanStatus(executor);
  const runId = textValue(executor.current_run_id, executor.run_id);
  const run = matchingRun(runId);
  const task = matchingTask(textValue(run?.task_id, executor.current_task_id, executor.task_id));
  const hostName = textValue(executor.host_name, executor.host?.name, executor.host_id, 'Host not reported');
  const latest = latestTrustedActivity([executor, run, task, executor.host]);
  return `
    <article class="executor-card">
      <section class="architecture-section executor-primary" aria-label="Executor">
        <div class="worker-card-top">
          <div>
            <span class="eyebrow">Executor</span>
            <h3>${escapeHtml(textValue(executor.name, executor.id, 'Unnamed Executor'))}</h3>
            <div class="architecture-subtitle">${escapeHtml(textValue(executor.executor_type, 'Executor type not reported'))}</div>
          </div>
          ${humanStateBadge(status)}
        </div>
        <div class="architecture-facts">
          ${renderFact('Current Work', runId ? textValue(taskTitle(task), run?.progress_message, 'Execution in progress') : 'No current Run')}
          ${renderFact('Compatible Workers', arrayValue(executor.worker_ids).join(', ') || 'Not reported')}
          ${renderFact('Last activity', latest ? formatTrustedTime(latest.value) : 'No recent activity recorded')}
        </div>
        <div class="architecture-section-inline">
          <span class="eyebrow">Capabilities</span>
          ${renderTags(executor.capabilities, 'No capabilities reported')}
        </div>
      </section>
      <section class="architecture-section host-block" aria-label="Host">
        <span class="eyebrow">Host</span>
        <h3>${escapeHtml(hostName)}</h3>
        <p>Environment where Executor runs.</p>
        <div class="architecture-facts">
          ${renderFact('Machine / environment', textValue(executor.host_environment, executor.environment, executor.machine, executor.provider, 'Not reported'))}
          ${renderFact('Availability', textValue(executor.host_state, executor.host_validation_state, executor.health_state, 'Not reported'))}
          ${renderFact('Repository readiness', textValue(executor.repository_state, executor.repo_ready, executor.runtime_validation_state, 'Not reported'))}
          ${renderFact('Last heartbeat', textValue(executor.last_heartbeat_at, executor.heartbeat_at, executor.heartbeat_age_seconds == null ? '' : `${executor.heartbeat_age_seconds}s ago`, 'Not reported'))}
        </div>
      </section>
      <details class="advanced-details executor-technical-details">
        <summary>Advanced / Technical Details</summary>
        <div class="technical-grid">
          ${renderFact('Executor ID', textValue(executor.id, executor.executor_id, 'none'))}
          ${renderFact('Current Run ID', textValue(runId, 'none'))}
          ${renderFact('Worker IDs', arrayValue(executor.worker_ids).join(', ') || 'none')}
          ${renderFact('Runner version', textValue(executor.runner_version, 'unknown'))}
          ${renderFact('Heartbeat age/timestamp', textValue(executor.heartbeat_age_seconds == null ? '' : `${executor.heartbeat_age_seconds}s`, executor.last_heartbeat_at, executor.heartbeat_at, 'none'))}
          ${renderFact('Host identifiers', textValue(executor.host_id, executor.host_name, executor.host?.id, 'none'))}
          <div><span>Raw runtime/health/binding state</span><pre class="result-json">${escapeHtml(JSON.stringify(executor, null, 2))}</pre></div>
        </div>
      </details>
    </article>
  `;
}

function renderOperationsHealth() {
  const data = state.dashboard || {};
  const brain = data.brain_adapters?.items?.find((item) => (item.worker_ids || []).includes('W01'));
  const executor = data.executors?.items?.find((item) => (item.worker_ids || []).includes('W01'));
  const worker = data.workers?.find((item) => item.id === 'W01' || item.code === 'W01');

  const rows = [
    { label: 'W01 Worker', status: worker?.operational_status || worker?.state || 'OFFLINE', detail: worker?.active_mission_id || 'No active mission' },
    { label: 'W01 Brain', status: brain ? heartbeatLabel(brain) : 'OFFLINE · never', detail: brain?.current_brain_run_id || 'No current Brain Run' },
    { label: 'W01 Executor', status: executor ? heartbeatLabel(executor) : 'OFFLINE · never', detail: executor?.current_run_id || 'No current Run' }
  ];

  const target = $('#operationsHealth');
  if (!target) return;
  target.innerHTML = rows.map((row) => `
    <div class="worker-row">
      <div class="worker-code">${escapeHtml(row.label)}</div>
      <div><div class="worker-name">${escapeHtml(row.status)}</div><div class="worker-role">${escapeHtml(row.detail)}</div></div>
      ${stateBadge(String(row.status).split(' ')[0])}
    </div>
  `).join('');
}

function renderNeedAttention() {
  const target = $('#attentionList');
  if (!target) return;
  const items = state.dashboard?.need_attention_items || [];
  target.innerHTML = items.length
    ? items.map((item) => `
      <div class="mission-item">
        <div class="mission-main">
          <h4>${escapeHtml(item.message)}</h4>
          <div class="mission-meta">${escapeHtml(item.entity_type)} ${escapeHtml(item.entity_id)} · ${escapeHtml(item.action_hint || '')}</div>
        </div>
        ${stateBadge(item.severity)}
      </div>
    `).join('')
    : '<div class="empty-state">No operational issues.</div>';
}

function renderExecutors() {
  const items = state.dashboard?.executors?.items || [];
  const target = $('#executorsList');
  if (!target) return;
  target.innerHTML = items.length
    ? items.map(renderExecutorCard).join('')
    : '<div class="empty-state">No executors have registered yet.</div>';
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;

  $('#systemStatus').textContent = `SYSTEM ${data.system.state}`;
  $('#workerCount').textContent = data.worker_totals.total;
  $('#metricActiveWorkers').textContent = data.worker_totals.active;
  $('#metricRunningMissions').textContent = data.mission_totals.running;
  $('#metricQueuedTasks').textContent = data.task_totals.queued;
  $('#metricAttention').textContent = data.need_attention;
  $('#metricCompleted').textContent = data.mission_totals.completed;
  $('#metricExecutors').textContent = data.executors.online;

  $('#workersList').innerHTML =
    data.workers.length > 0
      ? data.workers.map(workerRow).join('')
      : '<div class="empty-state">No workers found.</div>';

  $('#recentMissions').innerHTML =
    data.recent_missions.length > 0
      ? data.recent_missions.map(missionItem).join('')
      : '<div class="empty-state">No missions yet. Create the first real mission.</div>';

  bindMissionActions();
  renderOperationsHealth();
  renderNeedAttention();
  renderExecutors();
}

function renderWorkers() {
  $('#workersFullList').innerHTML =
    state.workers.length > 0
      ? state.workers.map(renderWorkerCard).join('')
      : '<div class="empty-state">No workers found.</div>';
}

function renderMissions() {
  $('#missionsList').innerHTML =
    state.missions.length > 0
      ? state.missions.map(missionItem).join('')
      : '<div class="empty-state">No missions yet. Your first mission will appear here.</div>';
  bindMissionActions();
}

function renderTasks() {
  $('#tasksList').innerHTML = state.tasks.length
    ? state.tasks.map((task) => {
        const run = state.runs.find((item) => item.id === task.current_run_id || item.id === task.execution_run_id);
        const progress = run
          ? { percent: run.state === 'COMPLETED' ? 100 : Number(run.progress_percent || 0), label: run.progress_message || task.phase || task.state }
          : { percent: task.state === 'DONE' ? 100 : 0, label: task.phase || task.state };
        return `
          <div class="mission-item">
            <div class="mission-main">
              <h4>${escapeHtml(task.title || task.id)}</h4>
              <div class="mission-meta">${escapeHtml(task.mission_id || '')}${task.phase ? ` · ${escapeHtml(task.phase)}` : ''}</div>
              ${progressBar(progress)}
            </div>
            ${stateBadge(task.state)}
          </div>
        `;
      }).join('')
    : '<div class="empty-state">No tasks yet.</div>';
}

function renderReports() {
  const reportTypes = new Set(['EXECUTION_OUTPUT', 'BRAIN_RESULT', 'REPORT']);
  const executionResults = state.results.filter((result) => reportTypes.has(result.result_type) || !result.result_type);
  $('#reportsList').innerHTML = executionResults.length
    ? executionResults.map((result) => {
        const mission = state.missions.find((m) => m.id === result.mission_id);
        const resultText = result.content || result.text || result.output?.final_result_text || result.summary || 'No summary';
        return `
          <article class="report-card">
            <div class="panel-header">
              <div>
                <span class="eyebrow">${escapeHtml(result.status || 'RESULT')}</span>
                <h3>${escapeHtml(mission?.objective || result.mission_id || 'Execution result')}</h3>
              </div>
              ${stateBadge(result.status || 'SUCCESS')}
            </div>
            <p>${escapeHtml(resultText)}</p>
            <div class="mission-meta">Mission ${escapeHtml(result.mission_id || '')} · Run ${escapeHtml(result.run_id || '')}</div>
            ${result.output ? `<pre class="result-json">${escapeHtml(JSON.stringify(result.output, null, 2))}</pre>` : ''}
          </article>
        `;
      }).join('')
    : '<div class="empty-state">No final results yet.</div>';
}

function renderPlanSection(mission, planData) {
  const plan = planData?.current_plan || null;
  if (mission.planning_mode === 'REQUIRED' && !plan) {
    return `<h3>Plan</h3><div class="plan-panel"><p>Brain is preparing the plan...</p></div>`;
  }
  if (!plan) return '';

  const pending = mission.state === 'READY' && mission.approval_status === 'PENDING';
  const readonly = ['RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(mission.state) || mission.approval_status === 'APPROVED';
  return `
    <h3>Plan</h3>
    <div class="plan-panel">
      <div class="mission-meta">Plan Revision ${escapeHtml(plan.revision || '')} · Approved Revision ${escapeHtml(mission.approved_plan_revision_number || mission.approved_plan_revision_id || 'None')} · ${escapeHtml(mission.approval_status || plan.status || '')}</div>
      <h4>${escapeHtml(plan.objective || mission.objective || '')}</h4>
      <p>${escapeHtml(plan.approach || '')}</p>
      <div class="plan-grid">
        <div><strong>Planned actions</strong><ul>${(plan.planned_actions || []).map((item) => `<li>${escapeHtml(item.title || item.description || item)}</li>`).join('')}</ul></div>
        <div><strong>Deliverables</strong><ul>${(plan.expected_deliverables || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
        <div><strong>Risks / assumptions</strong><ul>${[...(plan.risks || []), ...(plan.assumptions || [])].map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
        <div><strong>Permissions</strong><ul>${(plan.permissions_required || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None requested</li>'}</ul></div>
      </div>
      <div class="mission-meta">Requires execution: ${plan.requires_execution === false ? 'No' : 'Yes'} · ${escapeHtml(plan.execution_type || '')}</div>
      ${pending && !readonly ? `<div class="plan-actions">
        <button type="button" class="primary-button approve-plan-button" data-mission-id="${escapeHtml(mission.id)}">APPROVE & EXECUTE</button>
        <button type="button" class="ghost-button request-plan-changes-button" data-mission-id="${escapeHtml(mission.id)}">REQUEST CHANGES</button>
      </div>` : ''}
    </div>
  `;
}

function textValue(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function upperValue(value) {
  return textValue(value).toUpperCase();
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'object' && Number.isFinite(value.seconds)) return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTrustedTime(value) {
  const ms = timestampMs(value);
  if (!ms) return 'No trusted activity yet';
  return new Date(ms).toLocaleString();
}

function taskTitle(task) {
  return textValue(task?.title, task?.task_spec?.title, task?.objective, task?.task_spec?.objective);
}

function missionTasks(missionId) {
  return state.tasks.filter((task) => task.mission_id === missionId);
}

function missionRuns(missionId) {
  return state.runs.filter((run) => run.mission_id === missionId);
}

function sortedByTrustedTime(items) {
  return [...items].sort((a, b) => timestampMs(b.updated_at || b.completed_at || b.created_at || b.started_at) - timestampMs(a.updated_at || a.completed_at || a.created_at || a.started_at));
}

function currentTask(tasks, runs) {
  const activeRun = sortedByTrustedTime(runs).find((run) => ['QUEUED', 'ASSIGNED', 'WAITING', 'RUNNING', 'TESTING', 'PENDING'].includes(upperValue(run.state)));
  return tasks.find((task) => task.id === activeRun?.task_id) ||
    sortedByTrustedTime(tasks).find((task) => ['READY', 'QUEUED', 'ASSIGNED', 'WAITING', 'RUNNING', 'TESTING', 'PENDING'].includes(upperValue(task.state))) ||
    sortedByTrustedTime(tasks)[0] ||
    null;
}

function checkpointStatus(checkpoint) {
  return upperValue(checkpoint?.status || checkpoint?.waiting_status || checkpoint?.checkpoint_status || checkpoint?.validation_state);
}

function isResolvedHumanAction(checkpoint) {
  const status = checkpointStatus(checkpoint);
  return ['RESOLVED', 'COMPLETED', 'DONE', 'PASS', 'PASSED'].includes(status) || checkpoint?.human_action_required === false || checkpoint?.resolved === true;
}

function isUnresolvedHumanAction(checkpoint) {
  if (!checkpoint || checkpoint.stale === true || checkpoint.superseded === true) return false;
  if (isResolvedHumanAction(checkpoint)) return false;
  const status = checkpointStatus(checkpoint);
  return checkpoint.human_action_required === true ||
    ['WAITING_FOR_HUMAN', 'NEED_HUMAN_ACTION', 'PENDING', 'READY', 'FAILED', 'VALIDATING'].includes(status);
}

function currentHumanAction(mission, tasks = []) {
  const candidates = [
    mission.active_human_action,
    mission.current_human_action_checkpoint,
    mission.human_action_checkpoint,
    mission.human_action,
    ...tasks.flatMap((task) => [task.active_human_action, task.current_human_action_checkpoint, task.human_action_checkpoint, task.human_action])
  ].filter(Boolean);
  return candidates.find(isUnresolvedHumanAction) || null;
}

function activeRecovery(mission, runs, recoveryStatus = null) {
  if (recoveryStatus?.recoverable === true && recoveryStatus.mode && recoveryStatus.mode !== 'NO_ACTION') return recoveryStatus;
  const activeRun = runs.find((run) =>
    (run.recovery_replay === true || run.recovery_mode || run.corrective_recovery === true) &&
    ['QUEUED', 'ASSIGNED', 'WAITING', 'RUNNING', 'TESTING', 'PENDING'].includes(upperValue(run.state))
  );
  if (activeRun) return { recoverable: true, mode: activeRun.recovery_mode || 'BRAIN_REPLAY', reason: activeRun.progress_message || 'Trusted recovery work is active.', active_run_id: activeRun.id };
  if (mission.recovery_active_run_id) return { recoverable: true, mode: mission.last_recovery_mode || 'BRAIN_REPLAY', reason: mission.last_recovery_failure_code || 'Trusted recovery work is active.', active_run_id: mission.recovery_active_run_id };
  return null;
}

function isVerificationRun(run) {
  const type = upperValue(run?.run_type || run?.brain_run_type || run?.type);
  const subtype = upperValue(run?.brain_run_type || run?.run_subtype || run?.mode);
  const phase = upperValue(run?.phase || run?.brain_phase || run?.progress_message || run?.purpose);
  return type.includes('VERIFICATION') || subtype.includes('VERIFICATION') || phase.includes('VERIFY') || phase.includes('VERIFICATION');
}

function isTestRun(run) {
  const phase = upperValue(run?.phase || run?.execution_phase || run?.progress_message || run?.stage || run?.task_phase);
  return phase.includes('TEST') || phase.includes('VALIDATION') || upperValue(run?.state) === 'TESTING';
}

function readyExecutionTask(task) {
  const stateText = upperValue(task?.state);
  const requiresExecution = task?.requires_execution !== false && task?.task_spec?.requires_execution !== false;
  return requiresExecution && ['READY', 'QUEUED', 'ASSIGNED', 'WAITING', 'PENDING'].includes(stateText);
}

function deriveMissionCenterPhase({ mission, tasks = [], runs = [], humanAction = null, recovery = null }) {
  const activeRuns = runs.filter((run) => ['QUEUED', 'ASSIGNED', 'WAITING', 'RUNNING', 'TESTING', 'PENDING'].includes(upperValue(run.state)));
  if (humanAction && isUnresolvedHumanAction(humanAction)) return { key: 'human-action', label: 'Waiting Human Action', actor: 'Human' };
  if (recovery) return { key: 'recovering', label: 'Recovering', actor: recovery.mode === 'EXECUTION_RETRY' ? 'Executor' : 'Brain' };
  if (activeRuns.some((run) => run.run_type === 'BRAIN_RUN' && isVerificationRun(run))) return { key: 'verification', label: 'Verification', actor: 'Brain' };
  if (activeRuns.some((run) => run.run_type === 'EXECUTION_RUN' && isTestRun(run))) return { key: 'testing', label: 'Testing', actor: 'Executor' };
  if (activeRuns.some((run) => run.run_type === 'EXECUTION_RUN')) return { key: 'executor-working', label: 'Executor Working', actor: 'Executor' };
  if (tasks.some(readyExecutionTask)) return { key: 'waiting-executor', label: 'Waiting for Executor', actor: 'Executor' };
  if (activeRuns.some((run) => run.run_type === 'BRAIN_RUN' && ['PROGRAM', 'PLANNING'].includes(upperValue(run.brain_run_type || run.phase || run.run_subtype || run.mode)))) return { key: 'brain-working', label: 'Brain Working', actor: 'Brain' };
  if (activeRuns.some((run) => run.run_type === 'BRAIN_RUN')) return { key: 'brain-working', label: 'Brain Working', actor: 'Brain' };
  if (['PLANNING', 'PLAN_REQUIRED', 'PENDING_PLAN'].includes(upperValue(mission.state))) return { key: 'planning', label: 'Planning', actor: 'Brain' };
  if (['COMPLETED', 'DONE', 'SUCCESS'].includes(upperValue(mission.state))) return { key: 'completed', label: 'Completed', actor: 'MRAPI' };
  if (['BLOCKED', 'FAILED', 'CANCELLED', 'ERROR'].includes(upperValue(mission.state))) return { key: 'blocked-failed', label: 'Blocked/Failed', actor: 'MRAPI' };
  return { key: 'planning', label: 'Planning', actor: 'Brain' };
}

function missionCenterExplanation(phase, mission, result) {
  const outcome = result ? textValue(result.summary, result.content, result.text, result.output?.final_result_text, result.result_type) : '';
  const map = {
    planning: 'Brain is preparing the execution plan.',
    'brain-working': 'Brain is working from trusted mission context.',
    'waiting-executor': 'A prepared task is waiting for Executor work.',
    'executor-working': 'Executor is working on the current task.',
    testing: 'Required tests are running or being evaluated.',
    verification: 'Brain is validating trusted execution evidence.',
    'human-action': 'MRAPI is waiting for a required human action before this Mission can continue.',
    recovering: 'Existing Mission recovery is in progress.',
    completed: outcome ? `Mission finished: ${outcome}` : 'Mission finished; trusted final result is available when persisted.',
    'blocked-failed': 'Trusted state indicates this Mission cannot currently continue.'
  };
  return map[phase.key] || textValue(mission.progress_message, mission.state, 'Mission state is available.');
}

function missionCenterNextStep(phase) {
  return {
    planning: 'Brain is preparing the execution plan.',
    'brain-working': 'Wait for Brain result.',
    'waiting-executor': 'Executor can begin the prepared Task.',
    'executor-working': 'Wait for execution/test result.',
    testing: 'Required tests are running or being evaluated.',
    verification: 'Brain is validating trusted execution evidence.',
    'human-action': 'Complete the requested human action and mark LISTO.',
    recovering: 'Existing Mission recovery is in progress.',
    completed: 'Mission finished; show trusted final result.',
    'blocked-failed': 'Inspect trusted failure details and use recovery if available.'
  }[phase.key] || 'Wait for trusted state to update.';
}

function latestMissionActivity(mission, tasks, runs, results, humanAction) {
  const sources = [mission, ...tasks, ...runs, ...results, humanAction].filter(Boolean);
  const stamped = sources.flatMap((item) => [
    item.updated_at,
    item.completed_at,
    item.started_at,
    item.created_at,
    item.validation_completed_at,
    item.responded_at
  ].filter(Boolean).map((value) => ({ value, ms: timestampMs(value) })));
  return stamped.sort((a, b) => b.ms - a.ms)[0] || null;
}

function trustedEvidenceStatus(result) {
  if (!result) return { label: 'Not verified yet', className: 'neutral', pass: false };
  const candidates = [
    result.verification_status,
    result.evidence_status,
    result.validation_status,
    result.status,
    result.success === true ? 'PASS' : '',
    result.output?.status,
    result.output?.validation_status,
    result.output?.verification_status,
    result.output?.validation_result?.status,
    result.output?.validation_result?.ok === true ? 'PASS' : ''
  ].map(upperValue).filter(Boolean);
  if (candidates.some((value) => ['PASS', 'PASSED', 'SUCCESS', 'COMPLETED', 'DONE'].includes(value))) return { label: 'PASS', className: 'pass', pass: true };
  if (candidates.some((value) => ['FAIL', 'FAILED', 'ERROR', 'REJECTED'].includes(value))) return { label: 'FAILED', className: 'failed', pass: false };
  return { label: 'Not verified yet', className: 'neutral', pass: false };
}

function recoveryActionLabel(mode) {
  if (mode === 'BRAIN_REPLAY' || mode === 'BRAIN_CORRECTIVE_REPLAY') return 'Correct / Replay Brain';
  if (mode === 'EXECUTION_RETRY') return 'Retry Execution';
  if (mode === 'HUMAN_ACTION_RESUME') return 'Resume Mission';
  if (mode === 'AUTOPILOT_RESUME') return 'Resume Autopilot';
  return 'Recover Mission';
}

function recoveryPanel(mission, recovery) {
  if (!recovery?.recoverable || !recovery.mode || recovery.mode === 'NO_ACTION') {
    return '<section class="mission-center-empty" aria-label="Recovery unavailable">Recovery unavailable from trusted state.</section>';
  }
  const active = recovery.active === true || recovery.active_run_id || mission.recovery_active_run_id;
  const label = recoveryActionLabel(recovery.mode);
  return `
    <section class="mission-center-recovery" aria-label="Recovery">
      <div>
        <span class="eyebrow">Recovery</span>
        <h3>${escapeHtml(label)}</h3>
        <p>${escapeHtml(recovery.reason || 'Trusted recovery is available for this Mission.')}</p>
      </div>
      <button type="button" class="danger-button mrapi-mission-center-recovery" data-mission-center-recovery="1" data-mission-id="${escapeHtml(mission.id)}" data-recovery-mode="${escapeHtml(recovery.mode)}" ${active ? 'disabled' : ''}>${escapeHtml(active ? 'Recovery in progress' : label)}</button>
    </section>
  `;
}

function humanActionValidationStatus(checkpoint) {
  const validation = checkpoint?.validation_result || checkpoint?.validation || {};
  const status = upperValue(
    validation.status ||
    validation.validation_status ||
    (validation.ok === true ? 'PASS' : '') ||
    (validation.ok === false ? 'FAILED' : '') ||
    checkpoint?.validation_state ||
    checkpoint?.validation_status
  );
  if (['PASS', 'PASSED', 'SUCCESS', 'COMPLETED', 'DONE'].includes(status)) return { label: 'PASS', className: 'pass' };
  if (['FAIL', 'FAILED', 'ERROR', 'REJECTED'].includes(status)) return { label: 'FAILED', className: 'failed' };
  if (status) return { label: status, className: 'neutral' };
  return { label: 'Not verified yet', className: 'neutral' };
}

function humanActionPanel(mission, checkpoint) {
  if (!checkpoint || !isUnresolvedHumanAction(checkpoint)) return '';
  const validation = humanActionValidationStatus(checkpoint);
  const canReady = textValue(checkpoint.checkpoint_id || checkpoint.id) && textValue(checkpoint.roadmap_id || mission.roadmap_id);
  return `
    <section class="mission-center-human-action" aria-label="Action required">
      <div class="mission-center-panel-header">
        <div><span class="eyebrow">ACTION REQUIRED</span><h3>${escapeHtml(textValue(checkpoint.title, checkpoint.name, 'Human Action'))}</h3></div>
        <span class="evidence-badge ${escapeHtml(validation.className)}">${escapeHtml(validation.label)}</span>
      </div>
      <div class="mission-center-facts">
        <div><span>What MRAPI needs</span><strong>${escapeHtml(textValue(checkpoint.human_action_request, checkpoint.request, mission.human_action_request, 'A trusted human action is required.'))}</strong></div>
        <div><span>Why it is needed</span><strong>${escapeHtml(textValue(checkpoint.reason, checkpoint.blocker_message, checkpoint.blocker_code, mission.blocker_message, 'The Mission is paused until this checkpoint is satisfied.'))}</strong></div>
        <div><span>User action</span><strong>${escapeHtml(textValue(checkpoint.user_action, checkpoint.instruction, checkpoint.instructions, 'Complete the requested action outside MRAPI.'))}</strong></div>
        <div><span>Location / target</span><strong>${escapeHtml(textValue(checkpoint.action_location, checkpoint.target, checkpoint.location, 'No target provided'))}</strong></div>
        <div><span>Expected evidence</span><strong>${escapeHtml(textValue(checkpoint.validation_method, checkpoint.evidence_expected, checkpoint.expected_evidence, 'Trusted validation evidence is required.'))}</strong></div>
        <div><span>Validation state</span><strong>${escapeHtml(validation.label)}</strong></div>
      </div>
      <div class="mission-center-actions">
        <button type="button" class="primary-button human-action-ready-button" data-human-action-ready="1" data-mission-id="${escapeHtml(mission.id)}" data-roadmap-id="${escapeHtml(checkpoint.roadmap_id || mission.roadmap_id || '')}" data-checkpoint-id="${escapeHtml(checkpoint.checkpoint_id || checkpoint.id || '')}" ${canReady ? '' : 'disabled'}>LISTO</button>
        <span class="mission-meta">${canReady ? 'LISTO validates trusted state; it does not locally mark PASS.' : 'LISTO unavailable: checkpoint or roadmap context is missing.'}</span>
      </div>
    </section>
  `;
}

function roadmapMilestoneBlock(mission) {
  const roadmapText = textValue(mission.roadmap_title, mission.roadmap_name);
  const milestoneText = textValue(mission.milestone_title, mission.milestone_name);
  if (!roadmapText && !milestoneText && !mission.roadmap_id && !mission.milestone_id) return '';
  return `
    <section class="mission-center-context">
      <span class="eyebrow">Roadmap / Milestone</span>
      <div class="mission-center-context-grid">
        <div><span>Roadmap</span><strong>${escapeHtml(roadmapText || 'Linked roadmap')}</strong></div>
        <div><span>Milestone</span><strong>${escapeHtml(milestoneText || 'Linked milestone')}</strong></div>
      </div>
    </section>
  `;
}

function evidenceSummary(result) {
  const evidence = trustedEvidenceStatus(result);
  const summary = result ? textValue(result.summary, result.content, result.text, result.output?.final_result_text, result.result_type, 'Persisted result available.') : 'No result yet.';
  return `
    <section class="mission-center-evidence" aria-label="Evidence and verification">
      <div class="mission-center-panel-header">
        <div><span class="eyebrow">Result / Verification</span><h3>Latest Outcome</h3></div>
        <span class="evidence-badge ${escapeHtml(evidence.className)}">${escapeHtml(evidence.label)}</span>
      </div>
      <p>${escapeHtml(summary)}</p>
      <div class="mission-meta">${result ? 'Persisted Result is available; raw output is under Technical Details.' : 'No result yet.'}</div>
    </section>
  `;
}

function technicalDetails(mission, tasks, runs, results, recovery, humanAction, planData, latestActivity) {
  return `
    <details class="mission-center-technical technical-details">
      <summary>Advanced / Technical Details</summary>
      <div class="technical-grid">
        <div><span>Mission ID</span><code>${escapeHtml(mission.id)}</code></div>
        <div><span>Tenant / Workspace / Project</span><code>${escapeHtml(textValue(mission.tenant_id, 'tenant unavailable'))} / ${escapeHtml(textValue(mission.workspace_id, 'workspace unavailable'))} / ${escapeHtml(textValue(mission.project_id, 'project unavailable'))}</code></div>
        <div><span>Roadmap ID</span><code>${escapeHtml(mission.roadmap_id || 'none')}</code></div>
        <div><span>Milestone ID</span><code>${escapeHtml(mission.milestone_id || 'none')}</code></div>
        <div><span>Task IDs and states</span><code>${escapeHtml(tasks.map((task) => `${task.id}:${task.state || 'UNKNOWN'}${task.phase ? `/${task.phase}` : ''}`).join(', ') || 'none')}</code></div>
        <div><span>Brain Run IDs/types/states</span><code>${escapeHtml(runs.filter((run) => run.run_type === 'BRAIN_RUN').map((run) => `${run.id}:${run.brain_run_type || run.phase || run.run_type}/${run.state || 'UNKNOWN'}`).join(', ') || 'none')}</code></div>
        <div><span>Execution Run IDs/states</span><code>${escapeHtml(runs.filter((run) => run.run_type === 'EXECUTION_RUN').map((run) => `${run.id}:${run.state || 'UNKNOWN'}${run.phase ? `/${run.phase}` : ''}`).join(', ') || 'none')}</code></div>
        <div><span>Raw Mission state</span><code>${escapeHtml(mission.state || 'UNKNOWN')}</code></div>
        <div><span>Latest activity timestamp</span><code>${escapeHtml(latestActivity?.value || 'none')}</code></div>
        <div><span>Result IDs</span><code>${escapeHtml(results.map((result) => `${result.id || 'result'}:${result.status || result.result_type || 'UNKNOWN'}`).join(', ') || 'none')}</code></div>
        <div><span>Recovery metadata</span><pre class="result-json">${escapeHtml(JSON.stringify(recovery || mission.recovery || {}, null, 2))}</pre></div>
        <div><span>Human Action/checkpoint identifiers</span><pre class="result-json">${escapeHtml(JSON.stringify(humanAction || {}, null, 2))}</pre></div>
        <div><span>Raw result/evidence payload</span><pre class="result-json">${escapeHtml(JSON.stringify(results, null, 2))}</pre></div>
        <div><span>Raw Mission payload</span><pre class="result-json">${escapeHtml(JSON.stringify({ mission, plan: planData }, null, 2))}</pre></div>
      </div>
    </details>
  `;
}

function renderMissionCenter({ mission, tasks, runs, results, planData, recovery }) {
  if (!mission) return '<section class="mission-center-state error-state">Mission not found or unavailable.</section>';
  const humanAction = currentHumanAction(mission, tasks);
  const currentRecovery = activeRecovery(mission, runs, recovery);
  const phase = deriveMissionCenterPhase({ mission, tasks, runs, humanAction, recovery: currentRecovery });
  const result = latestResult(mission.id);
  const task = currentTask(tasks, runs);
  const latestActivity = latestMissionActivity(mission, tasks, runs, results, humanAction);
  const progress = missionProgress(mission);
  const worker = textValue(mission.worker_name, mission.preferred_worker_name, mission.preferred_worker_id, mission.worker_id, 'Automatic');
  return `
    <section class="mission-center" aria-label="Mission Center">
      <section class="mission-center-now phase-${escapeHtml(phase.key)}" aria-labelledby="missionCenterNowTitle">
        <div class="mission-center-panel-header">
          <div><span class="eyebrow">What is happening now</span><h3 id="missionCenterNowTitle">${escapeHtml(phase.label)}</h3></div>
          ${stateBadge(mission.state)}
        </div>
        <p>${escapeHtml(missionCenterExplanation(phase, mission, result))}</p>
        <div class="mission-center-facts">
          <div><span>Mission objective</span><strong>${escapeHtml(mission.objective || 'Objective unavailable')}</strong></div>
          <div><span>Worker</span><strong>${escapeHtml(worker)}</strong></div>
          <div><span>Current actor</span><strong>${escapeHtml(phase.actor || 'MRAPI')}</strong></div>
          <div><span>Current Task</span><strong>${escapeHtml(taskTitle(task) || (tasks.length ? 'Task title unavailable' : 'No Tasks yet'))}</strong></div>
          <div><span>Latest activity</span><strong>${escapeHtml(formatTrustedTime(latestActivity?.value))}</strong></div>
          <div><span>Next expected step</span><strong>${escapeHtml(missionCenterNextStep(phase))}</strong></div>
        </div>
        ${progress ? `<div class="mission-center-secondary">${progressBar(progress)}</div>` : ''}
      </section>
      ${humanActionPanel(mission, humanAction)}
      ${roadmapMilestoneBlock(mission)}
      <div class="mission-center-grid">
        ${evidenceSummary(result)}
        ${recoveryPanel(mission, currentRecovery)}
      </div>
      ${!tasks.length && !runs.length ? '<section class="mission-center-empty">No Tasks/Runs yet.</section>' : ''}
      ${renderPlanSection(mission, planData)}
      ${typeof window !== 'undefined' && typeof window.mrapiCleanResult === 'function' && result ? `<section class="mission-center-artifacts" aria-label="Artifact evidence drill-down">${window.mrapiCleanResult(result)}</section>` : ''}
      ${renderBlockerDiagnostics(mission)}
      ${technicalDetails(mission, tasks, runs, results, currentRecovery, humanAction, planData, latestActivity)}
    </section>
  `;
}

function renderBlockerDiagnostics(mission) {
  if (mission.state !== 'BLOCKED') return '';
  const code = mission.blocker_code || mission.blocked_reason || mission.block_reason || 'BLOCK_REASON_UNAVAILABLE';
  const reason = mission.blocker_message ||
    mission.blocked_message ||
    mission.block_reason_detail ||
    (code === 'BLOCK_REASON_UNAVAILABLE'
      ? 'Block reason unavailable - inspect event/run history'
      : code);
  const stage = mission.blocker_stage || mission.blocker_source_stage || mission.block_source_stage || 'UNKNOWN';
  return `
    <div class="result-block blocker-diagnostics">
      <strong>${escapeHtml(code)}</strong>
      <p>${escapeHtml(reason)}</p>
      <div class="mission-meta">Source stage: ${escapeHtml(stage)}</div>
    </div>
  `;
}

function renderExecutionSnapshotSummary(mission, runs) {
  const snapshotLabel = mission.approved_execution_snapshot_id
    ? `Snapshot Rev ${escapeHtml(mission.approved_plan_revision_number || mission.plan_revision_number || '')}`
    : 'No execution snapshot';
  const attempts = runs
    .filter((run) => run.run_type === 'EXECUTION_RUN')
    .map((run) => Number(run.attempt || 0));
  const currentAttempt = Math.max(0, ...attempts, Number(mission.retry_count || 0));
  return `
    <div class="mission-meta">
      Execution: ${snapshotLabel} · Current attempt: ${escapeHtml(currentAttempt || 0)}
    </div>
  `;
}

async function openMissionDetail(missionId) {
  const mission = state.missions.find((item) => item.id === missionId);
  $('#missionDetailTitle').textContent = 'Mission Center';
  $('#missionDetailBody').innerHTML = '<section class="mission-center-state loading-state">Loading Mission Center...</section>';
  $('#missionDetailModal').hidden = false;
  if (!mission) {
    $('#missionDetailBody').innerHTML = '<section class="mission-center-state error-state">Mission not found or unavailable.</section>';
    return;
  }
  let planData = null;
  let recovery = null;
  try {
    planData = await api(`/api/missions/${encodeURIComponent(missionId)}/plan`);
  } catch {
    planData = null;
  }
  try {
    recovery = await api(`/api/missions/${encodeURIComponent(missionId)}/recovery`);
  } catch (error) {
    recovery = { recoverable: false, mode: 'NO_ACTION', reason: `Recovery unavailable: ${error.message}` };
  }
  const runs = state.runs.filter((run) => run.mission_id === missionId);
  const results = state.results.filter((result) => result.mission_id === missionId);

  $('#missionDetailTitle').textContent = mission.objective || 'Mission Center';
  $('#missionDetailBody').innerHTML = renderMissionCenter({
    mission,
    tasks: missionTasks(missionId),
    runs,
    results,
    planData,
    recovery
  });
  bindMissionActions();
  bindMissionCenterActions();
}

function closeMissionDetail() {
  $('#missionDetailModal').hidden = true;
}

function bindMissionActions() {
  $$('.dispatch-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      button.disabled = true;
      try {
        await api(`/api/missions/${encodeURIComponent(missionId)}/dispatch`, {
          method: 'POST',
          body: '{}'
        });
        showToast('Mission dispatched.');
        await loadAll();
      } catch (error) {
        showToast(`Dispatch failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  $$('.retry-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      if (!confirm('Retry this mission and create a new attempt?')) return;
      button.disabled = true;
      try {
        await api(`/api/missions/${encodeURIComponent(missionId)}/retry`, {
          method: 'POST',
          body: '{}'
        });
        showToast('Mission retry started.');
        closeMissionDetail();
        await loadAll();
      } catch (error) {
        showToast(`Retry failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  $$('.cancel-mission-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      if (!confirm('Cancel this mission? Running work will stop at the next safe boundary.')) return;
      button.disabled = true;
      try {
        await api(`/api/missions/${encodeURIComponent(missionId)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Cancelled from Control Room' })
        });
        showToast('Mission cancelled.');
        closeMissionDetail();
        await loadAll();
      } catch (error) {
        showToast(`Cancel failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  $$('.approve-plan-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      button.disabled = true;
      try {
        await api(`/api/missions/${encodeURIComponent(missionId)}/plan/approve`, {
          method: 'POST',
          body: JSON.stringify({ approved_by: 'operator' })
        });
        showToast('Plan approved. Execution queued.');
        closeMissionDetail();
        await loadAll();
      } catch (error) {
        showToast(`Approval failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  $$('.request-plan-changes-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      const message = prompt('What should the worker change?');
      if (!message || !message.trim()) return;
      button.disabled = true;
      try {
        await api(`/api/missions/${encodeURIComponent(missionId)}/plan/request-changes`, {
          method: 'POST',
          body: JSON.stringify({ message })
        });
        showToast('Plan changes requested.');
        closeMissionDetail();
        await loadAll();
      } catch (error) {
        showToast(`Change request failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  $$('[data-open-mission]').forEach((row) => {
    row.addEventListener('click', () => openMissionDetail(row.dataset.openMission));
  });
}

async function loadAll() {
  try {
    const [dashboard, workers, missions, tasks, runs, results] = await Promise.all([
      api('/api/dashboard'),
      api('/api/workers'),
      api('/api/missions'),
      api('/api/tasks'),
      api('/api/runs'),
      api('/api/results')
    ]);

    state.dashboard = dashboard;
    state.workers = workers.items;
    state.missions = missions.items;
    state.tasks = tasks.items;
    state.runs = runs.items;
    state.results = results.items;

    renderDashboard();
    renderWorkers();
    renderMissions();
    renderTasks();
    renderReports();
  } catch (error) {
    console.error(error);
    showToast(`Could not load MRAPI DEV: ${error.message}`, true);
  }
}

function navigate(view) {
  $$('.view').forEach((el) => el.classList.remove('active'));
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));

  const viewEl = $(`#view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  const navLabel = $(`.nav-item[data-view="${view}"]`)?.textContent || 'Control Room';
  $('#pageTitle').textContent = view === 'dashboard' ? 'Control Room' : navLabel;

  if (viewEl?.classList.contains('placeholder-view')) {
    viewEl.innerHTML = `
      <div class="placeholder-card">
        <div>
          <span class="eyebrow">${escapeHtml(navLabel)}</span>
          <h2>${escapeHtml(navLabel)}</h2>
          <p>Coming in next MRAPI DEV version.</p>
        </div>
      </div>
    `;
  }

  $('#sidebar').classList.remove('open');
}

function populateMissionSelectors() {
  const workspaceSelect = $('#missionWorkspace');
  const projectSelect = $('#missionProject');
  if (state.context.loading) {
    workspaceSelect.innerHTML = '<option value="">Loading context...</option>';
    projectSelect.innerHTML = '<option value="">Loading context...</option>';
    workspaceSelect.disabled = true;
    projectSelect.disabled = true;
    return;
  }
  if (state.context.error) {
    workspaceSelect.innerHTML = '<option value="">Context unavailable</option>';
    projectSelect.innerHTML = '<option value="">Context unavailable</option>';
    workspaceSelect.disabled = true;
    projectSelect.disabled = true;
    $('#missionFormMessage').textContent = state.context.error;
    return;
  }
  workspaceSelect.innerHTML = '<option value="">Select workspace</option>' + state.workspaces
    .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(workspaceLabel(w))}</option>`)
    .join('');
  workspaceSelect.disabled = !state.workspaces.length;
  workspaceSelect.value = state.context.workspaceId || '';
  refreshProjectOptions(state.context.projectId);
}

function bindMissionCenterActions() {
  $$('.human-action-ready-button').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const missionId = button.dataset.missionId;
      const roadmapId = button.dataset.roadmapId;
      const checkpointId = button.dataset.checkpointId;
      if (!missionId || !roadmapId || !checkpointId) {
        showToast('LISTO failed: checkpoint context is incomplete.', true);
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/planner/proposals/${encodeURIComponent(roadmapId)}/human-action/${encodeURIComponent(checkpointId)}/ready`, {
          method: 'POST',
          body: JSON.stringify({ ready: true })
        });
        showToast('Human Action submitted for trusted validation.');
        await loadAll();
        await openMissionDetail(missionId);
      } catch (error) {
        showToast(`LISTO failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function refreshProjectOptions(preferredProjectId = '') {
  const workspaceId = $('#missionWorkspace').value;
  const projects = projectsForWorkspace(workspaceId);

  const projectSelect = $('#missionProject');
  if (!workspaceId) {
    projectSelect.innerHTML = '<option value="">Select workspace first</option>';
    projectSelect.disabled = true;
  } else if (!projects.length) {
    projectSelect.innerHTML = '<option value="">No projects in this workspace</option>';
    projectSelect.disabled = true;
  } else {
    projectSelect.innerHTML = '<option value="">Select project</option>' + projects
      .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(projectLabel(project))}</option>`)
      .join('');
    projectSelect.value = projects.some((project) => project.id === preferredProjectId) ? preferredProjectId : '';
    projectSelect.disabled = false;
  }

  refreshWorkerOptions();
}

function refreshWorkerOptions() {
  const workers = [...state.workers].sort((a, b) => String(a.code || a.id).localeCompare(String(b.code || b.id)));

  $('#missionWorker').innerHTML = [
    '<option value="">Automatic / none yet</option>',
    ...workers.map((worker) => `<option value="${worker.id}">${escapeHtml(worker.code)} — ${escapeHtml(worker.name)}</option>`)
  ].join('');
}

function openMissionModal() {
  populateMissionSelectors();
  const current = validatedContext();
  $('#missionFormMessage').textContent = current.valid ? '' : 'Select a valid workspace and project before creating a mission.';
  $('#missionModal').hidden = false;
  setTimeout(() => $('#missionObjective').focus(), 0);
}

function closeMissionModal() {
  $('#missionModal').hidden = true;
  $('#missionForm').reset();
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.style.borderColor = error ? 'rgba(255,107,114,.35)' : 'rgba(72,213,151,.28)';
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2800);
}

async function submitMission(event) {
  event.preventDefault();
  const submit = $('#createMissionSubmit');
  submit.disabled = true;
  $('#missionFormMessage').textContent = '';

  try {
    const selected = {
      workspaceId: $('#missionWorkspace').value,
      projectId: $('#missionProject').value
    };
    const current = validatedContext(selected);
    if (!current.valid) {
      $('#missionFormMessage').textContent = current.workspaceValid
        ? 'Select a project that belongs to the selected workspace before creating a mission.'
        : 'Select a valid workspace before creating a mission.';
      return;
    }
    const mission = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        objective: $('#missionObjective').value,
        workspace_id: current.workspace.id,
        project_id: current.project.id,
        preferred_worker_id: $('#missionWorker').value || null,
        priority: $('#missionPriority').value
      })
    });

    closeMissionModal();
    showToast(`Mission ${mission.id} created in PLANNING state.`);
    await loadAll();
    navigate('missions');
  } catch (error) {
    $('#missionFormMessage').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.view) navigate(button.dataset.view);
    });
  });

  $$('[data-view-target]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.viewTarget));
  });

  ['#newMissionButton', '#quickMissionButton', '#missionsNewButton'].forEach((selector) => {
    $(selector)?.addEventListener('click', openMissionModal);
  });

  $('#closeMissionModal').addEventListener('click', closeMissionModal);
  $('#cancelMissionButton').addEventListener('click', closeMissionModal);
  $('#missionForm').addEventListener('submit', submitMission);
  $('#missionWorkspace').addEventListener('change', () => refreshProjectOptions(''));
  $('#missionProject').addEventListener('change', refreshWorkerOptions);
  $('#globalWorkspaceSelect')?.addEventListener('change', () => {
    setCurrentContext($('#globalWorkspaceSelect').value, '', { persist: true });
  });
  $('#globalProjectSelect')?.addEventListener('change', () => {
    setCurrentContext($('#globalWorkspaceSelect').value, $('#globalProjectSelect').value, { persist: true });
  });
  $('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  $('#missionModal').addEventListener('click', (event) => {
    if (event.target === $('#missionModal')) closeMissionModal();
  });

  $('#closeMissionDetailModal').addEventListener('click', closeMissionDetail);
  $('#missionDetailModal').addEventListener('click', (event) => {
    if (event.target === $('#missionDetailModal')) closeMissionDetail();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#missionModal').hidden) closeMissionModal();
    if (event.key === 'Escape' && !$('#missionDetailModal').hidden) closeMissionDetail();
  });
}

bindEvents();
loadTrustedContext().finally(loadAll);
setInterval(loadAll, 5000);

globalThis.mrapiMissionCenterHumanActionV1 = {
  renderMissionCenter,
  deriveMissionCenterPhase,
  currentHumanAction,
  trustedEvidenceStatus,
  recoveryActionLabel
};

globalThis.mrapiWorkersExecutorHostExperienceV1 = {
  renderWorkerCard,
  renderExecutorCard,
  deriveWorkerHumanStatus,
  deriveExecutorHumanStatus,
  permissionLabel,
  renderPermissions
};


// v0.4.3.1 — Project Context / Roadmap entry points.
const projectsContextNav = document.querySelector('#projectsContextNav');
if (projectsContextNav) projectsContextNav.addEventListener('click', () => { window.location.href = '/projects/setup'; });
const roadmapNav = document.querySelector('#roadmapNav');
if (roadmapNav) roadmapNav.addEventListener('click', () => { window.location.href = '/roadmap.html#roadmap'; });
const plannerNav = document.querySelector('#plannerNav');
if (plannerNav) plannerNav.addEventListener('click', () => { window.location.href = '/planner'; });
