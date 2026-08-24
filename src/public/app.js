const state = {
  dashboard: null,
  workers: [],
  missions: [],
  tasks: [],
  runs: [],
  results: [],
  workspaces: [
    { id: 'workspace_scb', name: 'SCB' },
    { id: 'workspace_fm_real_estate', name: 'FM Real Estate' },
    { id: 'workspace_sentire_marine', name: 'Sentire Marine' }
  ],
  projects: [
    { id: 'project_scb_development', workspace_id: 'workspace_scb', name: 'SCB Development' },
    { id: 'project_fm_real_estate_analysis', workspace_id: 'workspace_fm_real_estate', name: 'FM Real Estate Analysis' },
    { id: 'project_sentire_marine_segue', workspace_id: 'workspace_sentire_marine', name: 'Sentire Marine / Segue' },
    { id: 'project_scb_marketing', workspace_id: 'workspace_scb', name: 'SCB Marketing' }
  ]
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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

function runForMission(missionId) {
  return state.runs
    .filter((run) => run.mission_id === missionId)
    .sort((a, b) => Number(b.progress_percent || 0) - Number(a.progress_percent || 0))[0] || null;
}

function missionProgress(mission) {
  if (mission.state === 'COMPLETED') return { percent: 100, label: 'Completed' };
  if (mission.state === 'FAILED' || mission.state === 'CANCELLED') return { percent: 100, label: mission.state };
  const runs = state.runs.filter((run) => run.mission_id === mission.id);
  const exec = runs.find((run) => run.run_type === 'EXECUTION_RUN' && run.state === 'RUNNING');
  if (exec) return { percent: Number(exec.progress_percent || 0), label: exec.progress_message || 'Executing' };
  const brain = runs.find((run) => run.run_type === 'BRAIN_RUN' && run.state === 'RUNNING');
  if (brain) return { percent: Math.min(45, Math.max(5, Number(brain.progress_percent || 0))), label: brain.progress_message || 'Brain planning' };
  if (mission.state === 'PLANNING') return { percent: 45, label: 'Planning completed / waiting execution' };
  if (mission.state === 'RUNNING') return { percent: 55, label: 'Running' };
  return { percent: 0, label: mission.state || 'Ready' };
}

function progressBar(progress) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  return `
    <div class="progress-wrap" title="${escapeHtml(progress.label)}">
      <div class="progress-meta"><span>${escapeHtml(progress.label)}</span><strong>${percent}%</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
    </div>
  `;
}

function latestResult(missionId) {
  const items = state.results.filter((result) => result.mission_id === missionId);
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
    ? items.map((executor) => `
      <div class="mission-item">
        <div class="mission-main">
          <h4>${escapeHtml(executor.name || executor.id)}</h4>
          <div class="mission-meta">
            Host ${escapeHtml(executor.host_name || '—')} · ${escapeHtml(executor.runner_status || 'IDLE')} ·
            Run ${escapeHtml(executor.current_run_id || 'none')} · heartbeat ${escapeHtml(heartbeatLabel(executor))}
          </div>
          <div class="result-preview">${escapeHtml(executor.executor_type || 'EXECUTOR')} · ${escapeHtml(executor.runner_version || 'unknown')}</div>
        </div>
        ${stateBadge(executor.health_state)}
      </div>
    `).join('')
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
      ? state.workers.map((worker) => `
          <article class="worker-card">
            <div class="worker-card-top">
              <div>
                <span class="eyebrow">${escapeHtml(worker.code)}</span>
                <h3>${escapeHtml(worker.name)}</h3>
              </div>
              ${stateBadge(worker.operational_status || worker.state)}
            </div>
            <p>
              Brain configured: ${worker.brain_binding ? 'YES' : 'NO'}<br>
              Brain health: ${escapeHtml(worker.brain_health || 'OFFLINE')}<br>
              Executor configured: ${worker.executor_binding ? 'YES' : 'NO'}<br>
              Executor health: ${escapeHtml(worker.executor_health || 'OFFLINE')}<br>
              Host: ${escapeHtml(worker.host_binding?.provider || 'None')}<br>
              Autonomy: ${escapeHtml(worker.autonomy_level ?? '—')}<br>
              Permissions: ${escapeHtml(Object.entries(worker.permissions || {}).filter(([, enabled]) => enabled === true).map(([key]) => key).join(', ') || 'none')}<br>
              Workspace: ${escapeHtml(worker.workspace_id)}<br>
              Project: ${escapeHtml(worker.project_id)}<br>
              Current mission: ${escapeHtml(worker.current_mission_id || 'None')}
            </p>
          </article>
        `).join('')
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

function openMissionDetail(missionId) {
  const mission = state.missions.find((item) => item.id === missionId);
  if (!mission) return;
  const runs = state.runs.filter((run) => run.mission_id === missionId);
  const results = state.results.filter((result) => result.mission_id === missionId);
  const progress = missionProgress(mission);
  const canRetry = ['FAILED', 'BLOCKED'].includes(mission.state);
  const canCancel = ['READY', 'PLANNING', 'RUNNING', 'BLOCKED'].includes(mission.state);

  $('#missionDetailTitle').textContent = mission.objective;
  $('#missionDetailBody').innerHTML = `
    <div class="detail-grid">
      <div><span class="eyebrow">STATE</span>${stateBadge(mission.state)}</div>
      <div><span class="eyebrow">WORKER</span><strong>${escapeHtml(mission.preferred_worker_id || 'Automatic')}</strong></div>
    </div>
    <div class="modal-actions">
      <span>${escapeHtml(mission.state)}</span>
      <div>
        ${canRetry ? `<button type="button" class="ghost-button retry-button" data-mission-id="${escapeHtml(mission.id)}">Retry</button>` : ''}
        ${canCancel ? `<button type="button" class="ghost-button cancel-mission-button" data-mission-id="${escapeHtml(mission.id)}">Cancel</button>` : ''}
      </div>
    </div>
    ${progressBar(progress)}
    <h3>Runs</h3>
    ${runs.length ? runs.map((run) => `
      <div class="detail-row">
        <div><strong>${escapeHtml(run.run_type)}</strong><div class="mission-meta">${escapeHtml(run.progress_message || '')}</div></div>
        <div>${stateBadge(run.state)} ${escapeHtml(run.progress_percent ?? 0)}%</div>
      </div>
    `).join('') : '<div class="empty-state">No runs yet.</div>'}
    <h3>Results</h3>
    ${results.length ? results.map((result) => `
      <div class="result-block">
        <strong>${escapeHtml(result.result_type || 'RESULT')}</strong>
        <p>${escapeHtml(result.content || result.text || result.output?.final_result_text || result.summary || '')}</p>
        ${result.output ? `<pre class="result-json">${escapeHtml(JSON.stringify(result.output, null, 2))}</pre>` : ''}
      </div>
    `).join('') : '<div class="empty-state">No result yet.</div>'}
  `;
  bindMissionActions();
  $('#missionDetailModal').hidden = false;
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
  $('#missionWorkspace').innerHTML = state.workspaces
    .map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
    .join('');

  refreshProjectOptions();
}

function refreshProjectOptions() {
  const workspaceId = $('#missionWorkspace').value;
  const projects = state.projects.filter((project) => project.workspace_id === workspaceId);

  $('#missionProject').innerHTML = projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join('');

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
  $('#missionFormMessage').textContent = '';
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
    const mission = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        objective: $('#missionObjective').value,
        workspace_id: $('#missionWorkspace').value,
        project_id: $('#missionProject').value,
        preferred_worker_id: $('#missionWorker').value || null,
        priority: $('#missionPriority').value
      })
    });

    closeMissionModal();
    showToast(`Mission ${mission.id} created in READY state.`);
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
    button.addEventListener('click', () => navigate(button.dataset.view));
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
  $('#missionWorkspace').addEventListener('change', refreshProjectOptions);
  $('#missionProject').addEventListener('change', refreshWorkerOptions);
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
loadAll();
setInterval(loadAll, 5000);
