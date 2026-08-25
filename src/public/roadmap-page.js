const $ = (selector) => document.querySelector(selector);
let projects = [];
let roadmaps = [];

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}

function selectedProject() {
  return projects.find((item) => item.id === $('#projectSelect').value) || null;
}

function populateContext(project) {
  $('#repositoryFullName').value = project?.repository_full_name || '';
  $('#repositoryUrl').value = project?.repository_url || '';
  $('#localPath').value = project?.local_path || '';
  $('#defaultBranch').value = project?.default_branch || 'main';
  $('#defaultWorker').value = project?.default_worker_id || (project?.primary_worker_ids || [])[0] || '';
  $('#reusableInstructions').value = project?.reusable_instructions || '';
}

async function loadRoadmaps() {
  const project = selectedProject();
  if (!project) return;
  const data = await api(`/api/roadmaps?project_id=${encodeURIComponent(project.id)}`);
  roadmaps = data.items || [];
  $('#roadmapList').innerHTML = roadmaps.length ? roadmaps.map((item) => {
    const done = (item.milestones || []).filter((m) => m.state === 'COMPLETED').length;
    return `<div class="roadmap-item" data-id="${esc(item.id)}"><h3>${esc(item.title)}</h3><p>${esc(item.objective)}</p><div class="roadmap-meta">${esc(item.state)} · ${done}/${(item.milestones || []).length} milestones · ${esc(item.owner_worker_id || 'W01')}</div></div>`;
  }).join('') : '<div class="empty-state">No roadmap goals for this project yet.</div>';
  document.querySelectorAll('.roadmap-item').forEach((el) => el.addEventListener('click', () => editRoadmap(el.dataset.id)));
}

function editRoadmap(id) {
  const item = roadmaps.find((r) => r.id === id);
  if (!item) return;
  $('#roadmapEditor').hidden = false;
  $('#roadmapEditorTitle').textContent = item.title;
  $('#roadmapId').value = item.id;
  $('#roadmapTitle').value = item.title || '';
  $('#roadmapObjective').value = item.objective || '';
  $('#roadmapWorker').value = item.owner_worker_id || 'W01';
  $('#roadmapState').value = item.state || 'DRAFT';
  $('#autoAdvance').checked = Boolean(item.auto_advance);
  $('#roadmapMilestones').value = (item.milestones || []).sort((a,b)=>(a.order||0)-(b.order||0)).map((m) => m.title).join('\n');
  $('#roadmapEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openNewRoadmap() {
  $('#roadmapEditor').hidden = false;
  $('#roadmapEditorTitle').textContent = 'New roadmap';
  $('#roadmapId').value = '';
  $('#roadmapTitle').value = 'Finish W01 Autopilot';
  $('#roadmapObjective').value = 'Make W01 able to advance an approved roadmap with Brain-led programming, Codex execution, verification and reporting, escalating only important decisions.';
  $('#roadmapWorker').value = 'W01';
  $('#roadmapState').value = 'ACTIVE';
  $('#autoAdvance').checked = false;
  $('#roadmapMilestones').value = ['Project Context','Roadmap Engine','Autopilot Loop','Git / Deploy Pipeline','Reporting / Notifications','Mission Conversation'].join('\n');
}

async function init() {
  const data = await api('/api/projects');
  projects = data.items || [];
  $('#projectSelect').innerHTML = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('');
  populateContext(selectedProject());
  await loadRoadmaps();
}

$('#projectSelect').addEventListener('change', async () => { populateContext(selectedProject()); await loadRoadmaps(); });
$('#newRoadmapButton').addEventListener('click', openNewRoadmap);

$('#contextForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const message = $('#contextMessage');
  message.textContent = 'Saving…';
  try {
    const updated = await api(`/api/projects/${encodeURIComponent(project.id)}/context`, {
      method: 'PUT',
      body: JSON.stringify({
        repository_full_name: $('#repositoryFullName').value,
        repository_url: $('#repositoryUrl').value,
        local_path: $('#localPath').value,
        default_branch: $('#defaultBranch').value,
        default_worker_id: $('#defaultWorker').value,
        reusable_instructions: $('#reusableInstructions').value
      })
    });
    projects = projects.map((p) => p.id === updated.id ? updated : p);
    message.textContent = 'Project Context saved.';
  } catch (error) { message.textContent = `Error: ${error.message}`; }
});

$('#roadmapForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const id = $('#roadmapId').value;
  const existing = roadmaps.find((r) => r.id === id);
  const oldByTitle = new Map((existing?.milestones || []).map((m) => [m.title, m]));
  const milestones = $('#roadmapMilestones').value.split('\n').map((title) => title.trim()).filter(Boolean).map((title, index) => ({
    ...(oldByTitle.get(title) || {}), title, order: index + 1,
    state: oldByTitle.get(title)?.state || 'PENDING'
  }));
  const payload = {
    project_id: project.id,
    title: $('#roadmapTitle').value,
    objective: $('#roadmapObjective').value,
    owner_worker_id: $('#roadmapWorker').value || 'W01',
    state: $('#roadmapState').value,
    auto_advance: $('#autoAdvance').checked,
    milestones
  };
  const message = $('#roadmapMessage');
  message.textContent = 'Saving…';
  try {
    if (id) await api(`/api/roadmaps/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/roadmaps', { method: 'POST', body: JSON.stringify(payload) });
    message.textContent = 'Roadmap saved.';
    await loadRoadmaps();
  } catch (error) { message.textContent = `Error: ${error.message}`; }
});

init().catch((error) => { document.body.insertAdjacentHTML('beforeend', `<pre>${esc(error.message)}</pre>`); });
