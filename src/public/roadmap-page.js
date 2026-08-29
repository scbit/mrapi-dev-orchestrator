const $ = (selector) => document.querySelector(selector);
let workspaces = [];
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

function projectWorkspaceId(project) {
  return String(project?.workspace_id || project?.workspaceId || '').trim();
}

function workspaceLabel(workspace, workspaceId = '') {
  return String(workspace?.name || workspace?.display_name || workspaceId || 'Workspace not recorded').trim();
}

function projectLabel(project, projectId = '') {
  return String(project?.name || project?.title || project?.display_name || projectId || 'Project not recorded').trim();
}

function renderTrustedContext(source = null) {
  const selected = selectedProject();
  const projectId = String(source?.project_id || selected?.id || '').trim();
  const project = projects.find((item) => item.id === projectId) || selected || null;
  const workspaceId = String(source?.workspace_id || projectWorkspaceId(project) || '').trim();
  const workspace = workspaces.find((item) => item.id === workspaceId) || null;
  const html = `
    <div class="context-current">
      <div><span class="eyebrow">Workspace</span><strong>${esc(workspaceLabel(workspace, workspaceId))}</strong></div>
      <div><span class="eyebrow">Project</span><strong>${esc(projectLabel(project, projectId))}</strong></div>
    </div>
    <details class="technical-details compact"><summary>Technical details</summary><div>Workspace ID: ${esc(workspaceId || 'none')}<br>Project ID: ${esc(projectId || 'none')}</div></details>
  `;
  const pageContext = $('#roadmapTrustedContext');
  if (pageContext) {
    pageContext.className = projectId ? 'context-status is-ready' : 'context-status is-attention';
    pageContext.innerHTML = html;
  }
  const editorContext = $('#roadmapEditorContext');
  if (editorContext) editorContext.innerHTML = html;
}

function populateContext(project) {
  renderTrustedContext();
  $('#repositoryFullName').value = project?.repository_full_name || '';
  $('#repositoryUrl').value = project?.repository_url || '';
  $('#localPath').value = project?.local_path || '';
  $('#defaultBranch').value = project?.default_branch || 'main';
  $('#defaultWorker').value = project?.default_worker_id || (project?.primary_worker_ids || [])[0] || '';
  $('#reusableInstructions').value = project?.reusable_instructions || '';
}

async function loadRoadmaps() {
  const project = selectedProject();
  if (!project) {
    $('#roadmapList').innerHTML = '<div class="empty-state">Select a valid project to view roadmaps.</div>';
    renderTrustedContext();
    return;
  }
  renderTrustedContext(project);
  const data = await api(`/api/roadmaps?project_id=${encodeURIComponent(project.id)}`);
  const ts = (item) => {
    const raw = item?.updated_at || item?.created_at || 0;
    if (typeof raw === 'string' || typeof raw === 'number') {
      const parsed = new Date(raw).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return Number(raw?._seconds || raw?.seconds || 0) * 1000;
  };
  roadmaps = (data.items || [])
    .sort((a, b) => {
      const ap = a.proposal_type === 'PLANNER_ROADMAP' ? 1 : 0;
      const bp = b.proposal_type === 'PLANNER_ROADMAP' ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return ts(b) - ts(a);
    })
    .slice(0, 20);
  $('#roadmapList').innerHTML = roadmaps.length ? roadmaps.map((item) => {
    const done = (item.milestones || []).filter((m) => m.state === 'COMPLETED').length;
    return `<div class="roadmap-item" tabindex="0" data-id="${esc(item.id)}"><h3>${esc(item.title)}</h3><p>${esc(item.objective)}</p><div class="roadmap-meta">${esc(item.state)} - ${done}/${(item.milestones || []).length} milestones - ${esc(item.owner_worker_id || 'W01')}</div></div>`;
  }).join('') : '<div class="empty-state">No roadmap goals for this project yet.</div>';
  document.querySelectorAll('.roadmap-item').forEach((el) => {
    el.addEventListener('click', () => editRoadmap(el.dataset.id));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') editRoadmap(el.dataset.id);
    });
  });
}

function renderMilestoneStateEditor(item) {
  const target = $('#milestoneStateEditor');
  if (!target) return;
  const milestones = [...(item?.milestones || [])].sort((a,b)=>(a.order||0)-(b.order||0));
  if (!milestones.length) {
    target.innerHTML = '<div class="empty-state">No persisted milestones to display yet.</div>';
    return;
  }
  target.innerHTML = `
    <div class="roadmap-state-heading"><strong>Milestone timeline</strong><span>Lifecycle state is read from trusted Roadmap runtime.</span></div>
    ${milestones.map((m) => `
      <div class="roadmap-milestone-row">
        <div><strong>${esc(m.title)}</strong><div class="roadmap-meta">${esc(m.id)}</div></div>
        <span class="state-badge state-${esc(m.state || 'PENDING')}">${esc(m.state || 'PENDING')}</span>
      </div>
    `).join('')}
  `;
}

function editRoadmap(id) {
  const item = roadmaps.find((r) => r.id === id);
  if (!item) return;
  renderTrustedContext(item);
  $('#roadmapEditor').hidden = false;
  $('#roadmapEditorTitle').textContent = item.title;
  $('#roadmapId').value = item.id;
  $('#roadmapTitle').value = item.title || '';
  $('#roadmapObjective').value = item.objective || '';
  $('#roadmapWorker').value = item.owner_worker_id || 'W01';
  $('#roadmapState').value = item.state || 'DRAFT';
  const blockedMilestone = (item.milestones || []).find((m) => m.state === 'BLOCKED');
  const reopenButton = $('#reopenRoadmapButton');
  reopenButton.hidden = !(item.state === 'BLOCKED' || blockedMilestone);
  reopenButton.dataset.milestoneId = blockedMilestone?.id || '';
  $('#roadmapMilestones').value = (item.milestones || []).sort((a,b)=>(a.order||0)-(b.order||0)).map((m) => m.title).join('\n');
  renderMilestoneStateEditor(item);
  $('#roadmapEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openNewRoadmap() {
  $('#roadmapEditor').hidden = false;
  $('#roadmapEditorTitle').textContent = 'New roadmap';
  renderTrustedContext();
  $('#roadmapId').value = '';
  $('#roadmapTitle').value = 'Finish W01 Autopilot';
  $('#roadmapObjective').value = 'Make W01 able to run an approved roadmap with Brain-led programming, Codex execution, verification and reporting, escalating only important decisions.';
  $('#roadmapWorker').value = 'W01';
  $('#roadmapState').value = 'ACTIVE';
  $('#reopenRoadmapButton').hidden = true;
  $('#reopenRoadmapButton').dataset.milestoneId = '';
  $('#roadmapMilestones').value = ['Project Context','Roadmap Engine','Autopilot Loop','Git / Deploy Pipeline','Reporting / Notifications','Mission Conversation'].join('\n');
  renderMilestoneStateEditor(null);
}

async function init() {
  const [workspaceData, projectData] = await Promise.all([
    api('/api/workspaces'),
    api('/api/projects')
  ]);
  workspaces = workspaceData.items || [];
  projects = projectData.items || [];
  $('#projectSelect').innerHTML = projects.length
    ? projects.map((p) => `<option value="${esc(p.id)}">${esc(projectLabel(p))}</option>`).join('')
    : '<option value="">No projects available</option>';
  $('#projectSelect').disabled = !projects.length;
  populateContext(selectedProject());
  await loadRoadmaps();
  const anchor = window.location.hash.replace('#', '');
  if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
}

$('#projectSelect').addEventListener('change', async () => { populateContext(selectedProject()); await loadRoadmaps(); });
$('#newRoadmapButton').addEventListener('click', openNewRoadmap);

$('#contextForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const message = $('#contextMessage');
  message.textContent = 'Saving...';
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
    populateContext(updated);
    message.textContent = 'Project Context saved.';
  } catch (error) { message.textContent = `Error: ${error.message}`; }
});

$('#roadmapForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const id = $('#roadmapId').value;
  const existing = roadmaps.find((r) => r.id === id);
  const ownershipProject = existing
    ? (projects.find((p) => p.id === existing.project_id) || project)
    : project;
  const oldByTitle = new Map((existing?.milestones || []).map((m) => [m.title, m]));
  const milestones = $('#roadmapMilestones').value.split('\n').map((title) => title.trim()).filter(Boolean).map((title, index) => ({
    ...(oldByTitle.get(title) || {}), title, order: index + 1,
    state: oldByTitle.get(title)?.state || 'PENDING'
  }));
  const payload = {
    project_id: ownershipProject.id,
    title: $('#roadmapTitle').value,
    objective: $('#roadmapObjective').value,
    owner_worker_id: $('#roadmapWorker').value || 'W01',
    state: $('#roadmapState').value,
    auto_advance: Boolean(existing?.auto_advance),
    milestones
  };
  const message = $('#roadmapMessage');
  message.textContent = 'Saving...';
  try {
    const saved = id
      ? await api(`/api/roadmaps/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/roadmaps', { method: 'POST', body: JSON.stringify(payload) });
    message.textContent = 'Roadmap saved.';
    await loadRoadmaps();
    editRoadmap(saved.id);
  } catch (error) { message.textContent = `Error: ${error.message}`; }
});

$('#reopenRoadmapButton').addEventListener('click', async () => {
  const id = $('#roadmapId').value;
  if (!id) return;
  const button = $('#reopenRoadmapButton');
  button.disabled = true;
  $('#roadmapMessage').textContent = 'Reopening blocked milestone...';
  try {
    const updated = await api(`/api/roadmaps/${encodeURIComponent(id)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ milestone_id: button.dataset.milestoneId || null })
    });
    $('#roadmapMessage').textContent = updated.next_milestone
      ? `Reopened. Next executable milestone: ${updated.next_milestone.title}`
      : 'Reopened.';
    await loadRoadmaps();
    editRoadmap(id);
  } catch (error) {
    $('#roadmapMessage').textContent = `Reopen failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

init().catch((error) => { document.body.insertAdjacentHTML('beforeend', `<pre>${esc(error.message)}</pre>`); });
