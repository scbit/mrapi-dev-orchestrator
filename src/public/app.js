const state = {
  dashboard: null,
  workers: [],
  missions: [],
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
  return `
    <div class="mission-item">
      <div>
        <h4>${escapeHtml(mission.objective)}</h4>
        <div class="mission-meta">
          ${escapeHtml(mission.workspace_id)} · ${escapeHtml(mission.project_id)}
          ${mission.preferred_worker_id ? ` · ${escapeHtml(mission.preferred_worker_id)}` : ''}
        </div>
      </div>
      ${stateBadge(mission.state)}
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
}

async function loadAll() {
  try {
    const [dashboard, workers, missions, tasks] = await Promise.all([
      api('/api/dashboard'),
      api('/api/workers'),
      api('/api/missions'),
      api('/api/tasks')
    ]);

    state.dashboard = dashboard;
    state.workers = workers.items;
    state.missions = missions.items;

    renderDashboard();
    renderWorkers();
    renderMissions();

    $('#tasksList').innerHTML = tasks.total
      ? tasks.items.map((task) => `
          <div class="mission-item">
            <div><h4>${escapeHtml(task.title || task.id)}</h4><div class="mission-meta">${escapeHtml(task.mission_id || '')}</div></div>
            ${stateBadge(task.state)}
          </div>
        `).join('')
      : '<div class="empty-state">No tasks yet. Tasks will be created by the Orchestrator in the next milestone.</div>';
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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#missionModal').hidden) closeMissionModal();
  });
}

bindEvents();
loadAll();
