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
        <div class="worker-role">${escapeHtml(worker.role)}</div>
      </div>
      ${stateBadge(worker.state)}
    </div>
  `;
}

function missionItem(mission) {
  const canDispatch = mission.state === 'READY';
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
        ${canDispatch ? `<button class="ghost-button dispatch-button" data-mission-id="${escapeHtml(mission.id)}">Dispatch</button>` : ''}
      </div>
    </div>
  `;
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
              ${stateBadge(worker.state)}
            </div>
            <p>
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
  const executionResults = state.results.filter((result) => result.result_type === 'EXECUTION_OUTPUT' || !result.result_type);
  $('#reportsList').innerHTML = executionResults.length
    ? executionResults.map((result) => {
        const mission = state.missions.find((m) => m.id === result.mission_id);
        return `
          <article class="report-card">
            <div class="panel-header">
              <div>
                <span class="eyebrow">${escapeHtml(result.status || 'RESULT')}</span>
                <h3>${escapeHtml(mission?.objective || result.mission_id || 'Execution result')}</h3>
              </div>
              ${stateBadge(result.status || 'SUCCESS')}
            </div>
            <p>${escapeHtml(result.summary || 'No summary')}</p>
            <div class="mission-meta">Mission ${escapeHtml(result.mission_id || '')} · Run ${escapeHtml(result.run_id || '')}</div>
            ${result.output ? `<pre class="result-json">${escapeHtml(JSON.stringify(result.output, null, 2))}</pre>` : ''}
          </article>
        `;
      }).join('')
    : '<div class="empty-state">No final execution results yet.</div>';
}

function openMissionDetail(missionId) {
  const mission = state.missions.find((item) => item.id === missionId);
  if (!mission) return;
  const runs = state.runs.filter((run) => run.mission_id === missionId);
  const results = state.results.filter((result) => result.mission_id === missionId);
  const progress = missionProgress(mission);

  $('#missionDetailTitle').textContent = mission.objective;
  $('#missionDetailBody').innerHTML = `
    <div class="detail-grid">
      <div><span class="eyebrow">STATE</span>${stateBadge(mission.state)}</div>
      <div><span class="eyebrow">WORKER</span><strong>${escapeHtml(mission.preferred_worker_id || 'Automatic')}</strong></div>
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
        <p>${escapeHtml(result.summary || '')}</p>
        ${result.output ? `<pre class="result-json">${escapeHtml(JSON.stringify(result.output, null, 2))}</pre>` : ''}
      </div>
    `).join('') : '<div class="empty-state">No result yet.</div>'}
  `;
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
  const workspaceId = $('#missionWorkspace').value;
  const projectId = $('#missionProject').value;
  const workers = state.workers.filter(
    (worker) => worker.workspace_id === workspaceId && worker.project_id === projectId
  );

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
