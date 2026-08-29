const $ = (selector) => document.querySelector(selector);
let workspaces = [];
let projects = [];
let roadmaps = [];
let currentRoadmap = null;

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

function text(value) {
  return String(value ?? '').trim();
}

function rawState(item) {
  return text(item?.state || item?.lifecycle_state || item?.status).toUpperCase();
}

function titleState(value, fallback = 'Pending') {
  const raw = text(value);
  if (!raw) return fallback;
  return raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/(^|\s)\w/g, (match) => match.toUpperCase());
}

function orderedMilestones(item) {
  return [...(Array.isArray(item?.milestones) ? item.milestones : [])].sort((a, b) => {
    const ao = Number(a?.order);
    const bo = Number(b?.order);
    if (Number.isFinite(ao) && Number.isFinite(bo)) return ao - bo;
    if (Number.isFinite(ao)) return -1;
    if (Number.isFinite(bo)) return 1;
    return 0;
  });
}

function runtimeFor(item, milestone) {
  const runtime = Array.isArray(item?.milestone_runtime) ? item.milestone_runtime : [];
  const id = text(milestone?.id || milestone?.milestone_id);
  return runtime.find((entry) => text(entry?.milestone_id) === id) || null;
}

function currentMilestone(item) {
  if (item?.current_milestone && typeof item.current_milestone === 'object') return item.current_milestone;
  const currentId = text(item?.current_milestone_id || item?.milestone_id);
  if (currentId) {
    const byId = orderedMilestones(item).find((milestone) => text(milestone?.id) === currentId);
    if (byId) return byId;
  }
  return orderedMilestones(item).find((milestone) => ['PLANNING', 'RUNNING', 'EXECUTING', 'VERIFYING'].includes(rawState(milestone))) || null;
}

function unresolvedHumanAction(runtime, milestone) {
  const human = runtime?.human_action || milestone?.human_action_checkpoint || milestone?.human_action || null;
  if (!human || typeof human !== 'object') return false;
  if (human.resolved === true || human.is_resolved === true || human.stale === true || human.is_stale === true) return false;
  const status = text(human.status || human.waiting_status || human.checkpoint_status || human.state || milestone?.state).toUpperCase();
  return human.human_action_required === true || ['WAITING_FOR_HUMAN', 'WAITING_HUMAN', 'NEED_HUMAN_ACTION', 'NEEDS_HUMAN_ACTION', 'HUMAN_ACTION_REQUIRED'].includes(status);
}

function checkpointId(runtime, milestone) {
  const human = runtime?.human_action || milestone?.human_action_checkpoint || milestone?.human_action || {};
  return text(human.checkpoint_id || human.human_action_id || human.action_id || human.id || milestone?.checkpoint_id);
}

function isRecoverable(runtime) {
  const recovery = runtime?.recovery || {};
  return Boolean(recovery.recoverable === true && recovery.mode && recovery.mode !== 'NO_ACTION');
}

function humanMilestoneState(item, milestone) {
  const runtime = runtimeFor(item, milestone);
  const milestoneState = rawState({ state: runtime?.milestone_state || milestone?.state });
  const missionState = rawState(runtime?.mission || runtime?.mission_state ? { state: runtime?.mission?.state || runtime?.mission_state } : null);
  const current = currentMilestone(item);
  const isCurrent = text(current?.id) && text(current?.id) === text(milestone?.id);
  const recovery = runtime?.recovery || {};

  if (unresolvedHumanAction(runtime, milestone)) return { label: 'HUMAN ACTION', className: 'human-action', isCurrent };
  if (isRecoverable(runtime)) return { label: 'RECOVERABLE', className: 'recoverable', isCurrent };
  if (['COMPLETED', 'COMPLETE', 'DONE'].includes(milestoneState)) return { label: 'COMPLETED', className: 'completed', isCurrent: false };
  if (['BLOCKED', 'FAILED'].includes(milestoneState) || (['BLOCKED', 'FAILED'].includes(missionState) && recovery.recoverable !== true)) return { label: 'BLOCKED', className: 'blocked', isCurrent };
  if (isCurrent || ['PLANNING', 'RUNNING', 'EXECUTING', 'VERIFYING', 'ACTIVE'].includes(milestoneState) || ['PLANNING', 'RUNNING', 'EXECUTING', 'VERIFYING'].includes(missionState)) return { label: 'CURRENT', className: 'current', isCurrent: true };
  return { label: 'PENDING', className: 'pending', isCurrent: false };
}

function humanRoadmapState(item) {
  const milestones = orderedMilestones(item);
  if (milestones.some((milestone) => humanMilestoneState(item, milestone).label === 'HUMAN ACTION')) return 'Waiting for your action';
  if (milestones.some((milestone) => humanMilestoneState(item, milestone).label === 'RECOVERABLE')) return 'Recoverable interruption';
  const state = rawState(item);
  if (['COMPLETED', 'COMPLETE', 'DONE'].includes(state)) return 'Completed';
  if (['BLOCKED', 'FAILED'].includes(state)) return 'Blocked';
  if (milestones.some((milestone) => humanMilestoneState(item, milestone).label === 'CURRENT')) return 'Autopilot running';
  if (state === 'PROPOSED') return 'Ready for review';
  if (state === 'ACTIVE' || state === 'APPROVED') return 'Approved and ready';
  return titleState(state || 'PENDING');
}

function listHtml(items, emptyText = 'Not recorded') {
  const values = Array.isArray(items) ? items.map((item) => text(item?.title || item?.name || item?.id || item)).filter(Boolean) : [];
  if (!values.length) return `<span class="muted">${esc(emptyText)}</span>`;
  return `<ul>${values.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

function jsonDetails(value, emptyText = 'Not recorded') {
  if (value == null || value === '') return `<span class="muted">${esc(emptyText)}</span>`;
  return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
}

function evidenceSummary(runtime) {
  const evidence = runtime?.latest_evidence || runtime?.verification_evidence || null;
  if (!evidence || typeof evidence !== 'object') return 'Not verified yet';
  const state = text(evidence.verification_state || evidence.state || evidence.status || evidence.result).toUpperCase();
  const passed = evidence.verified === true || evidence.passed === true || ['PASSED', 'PASS', 'COMPLETED', 'COMPLETE', 'SUCCESS'].includes(state);
  const summary = text(evidence.summary || evidence.title || evidence.message || evidence.outcome);
  return passed ? `Verification passed${summary ? ': ' + summary : ''}` : (summary || titleState(state, 'Verification evidence recorded'));
}

function missionSummary(item, milestone, runtime) {
  const mission = runtime?.mission && typeof runtime.mission === 'object' ? runtime.mission : {};
  const objective = text(mission.objective || runtime?.mission_objective || milestone?.objective || milestone?.expected_outcome);
  const worker = text(mission.worker_id || mission.owner_worker_id || runtime?.worker_id || milestone?.owner_worker_id || item?.owner_worker_id || 'W01');
  const phase = titleState(mission.state || runtime?.mission_state || runtime?.phase || runtime?.status, 'Status not recorded');
  const outcome = text(runtime?.outcome_summary || runtime?.latest_outcome || runtime?.latest_evidence?.summary || runtime?.latest_human_response?.summary);
  if (!text(runtime?.mission_id || milestone?.mission_id) && !objective) return '<span class="muted">No linked Mission yet.</span>';
  return `<div class="mission-summary">
    <strong>${esc(objective || 'Mission objective not recorded')}</strong>
    <span>Worker: ${esc(worker)} · Status: ${esc(phase)}</span>
    <span>${esc(outcome || 'No outcome recorded yet.')}</span>
  </div>`;
}

function recoveryActionLabel(mode) {
  if (mode === 'BRAIN_REPLAY') return 'Correct / Replay Brain';
  if (mode === 'EXECUTION_RETRY') return 'Retry Execution';
  if (mode === 'HUMAN_ACTION_RESUME') return 'Resume Mission';
  return 'Resume Autopilot';
}

function recoveryPanel(item, milestone, runtime) {
  const recovery = runtime?.recovery || {};
  const missionId = text(runtime?.mission_id || milestone?.mission_id);
  const human = runtime?.human_action || milestone?.human_action_checkpoint || milestone?.human_action || {};
  const cpId = checkpointId(runtime, milestone);
  const humanAction = unresolvedHumanAction(runtime, milestone)
    ? `<section class="timeline-attention" aria-label="Human Action">
        <strong>Waiting for your action</strong>
        <p>Needed: ${esc(text(human.human_action_request || human.requirement || human.reason) || 'MRAPI is waiting for a user action.')}</p>
        <p>What to do: ${esc(text(human.user_action || human.required_action || human.instructions) || 'No specific user instruction was recorded.')}</p>
        <p>Validation: ${esc(text(human.validation_method || human.validation || human.validator) || 'Not recorded')}</p>
        ${cpId ? `<button class="secondary-button" type="button" data-human-action-ready="1" data-roadmap-id="${esc(item.id)}" data-checkpoint-id="${esc(cpId)}">LISTO</button>` : '<span class="muted">LISTO is unavailable until checkpoint context is recorded.</span>'}
      </section>`
    : '';
  const recoverable = isRecoverable(runtime) && missionId
    ? `<section class="timeline-attention recoverable" aria-label="Recovery">
        <strong>${esc(recoveryActionLabel(recovery.mode))}</strong>
        <p>${esc(recovery.reason || 'Trusted recovery is available for this Mission.')}</p>
        <button class="danger-button" type="button" data-mission-recovery="1" data-mission-id="${esc(missionId)}">${esc(recoveryActionLabel(recovery.mode))}</button>
      </section>`
    : '';
  return humanAction + recoverable;
}

function renderRoadmapProductHeader(item) {
  const milestones = orderedMilestones(item);
  const completed = milestones.filter((milestone) => ['COMPLETED', 'COMPLETE', 'DONE'].includes(rawState(milestone))).length;
  const total = milestones.length;
  const current = currentMilestone(item);
  const state = humanRoadmapState(item);
  const width = total ? Math.round((completed / total) * 100) : 0;
  const next = item?.next_milestone && typeof item.next_milestone === 'object' ? item.next_milestone : null;
  return `<section class="roadmap-product-header" aria-label="Roadmap progress">
    <div class="roadmap-product-copy">
      <span class="eyebrow">Trusted Roadmap</span>
      <h2>${esc(item.title || 'Untitled roadmap')}</h2>
      <p>${esc(item.objective || 'Objective not recorded.')}</p>
      <div class="state-badge state-${esc(state.toLowerCase().replace(/\s+/g, '-'))}">${esc(state)}</div>
    </div>
    <div class="roadmap-progress-panel">
      <strong>${esc(completed)} of ${esc(total)} milestones completed</strong>
      <div class="progress-track" aria-label="${esc(completed)} of ${esc(total)} milestones completed"><span style="width:${width}%"></span></div>
      <p>Current milestone: ${esc(current?.title || current?.objective || current?.id || 'None active')}</p>
      ${next ? `<p class="muted">Next milestone, informational only: ${esc(next.title || next.objective || next.id || 'Not recorded')}</p>` : ''}
      <div id="roadmapHeaderContext" class="context-header read-only"></div>
    </div>
  </section>`;
}

function renderMilestoneTimeline(item) {
  const milestones = orderedMilestones(item);
  if (!milestones.length) return '<div class="empty-state">No persisted milestones to display yet.</div>';
  return `<div class="timeline-stepper" aria-label="Persisted milestone timeline">
    ${milestones.map((milestone, index) => {
      const runtime = runtimeFor(item, milestone);
      const state = humanMilestoneState(item, milestone);
      const executor = milestone.executor_required === true ? 'Executor required' : milestone.executor_required === false ? 'Brain-only' : 'Execution requirement not recorded';
      const worker = text(runtime?.worker_id || runtime?.mission?.worker_id || milestone.owner_worker_id || item.owner_worker_id || 'W01');
      return `<article class="timeline-step is-${esc(state.className)}">
        <div class="timeline-marker" aria-hidden="true">${esc(index + 1)}</div>
        <div class="timeline-card">
          <div class="timeline-title-row">
            <div><span class="eyebrow">Milestone ${esc(index + 1)}</span><h3>${esc(milestone.title || milestone.id || 'Untitled milestone')}</h3></div>
            <div class="timeline-badges"><span class="state-badge state-${esc(state.className)}">${esc(state.label)}</span>${state.isCurrent ? '<span class="state-badge state-current">CURRENT</span>' : ''}</div>
          </div>
          <p class="timeline-objective">${esc(milestone.objective || milestone.expected_outcome || milestone.description || 'Objective not recorded.')}</p>
          <div class="timeline-grid">
            <div><span class="eyebrow">Current Work</span><p>${esc(text(runtime?.summary || runtime?.current_work || runtime?.phase) || titleState(runtime?.milestone_state || milestone.state, 'Not started yet'))}</p></div>
            <div><span class="eyebrow">Worker</span><p>${esc(worker)}</p></div>
            <div><span class="eyebrow">Execution Mode</span><p>${esc(executor)}</p></div>
            <div><span class="eyebrow">Verification</span><p>${esc(evidenceSummary(runtime))}</p></div>
          </div>
          <div class="timeline-split">
            <div><span class="eyebrow">Linked Mission</span>${missionSummary(item, milestone, runtime)}</div>
            <div><span class="eyebrow">Success Criteria</span>${listHtml(milestone.success_criteria, 'No success criteria recorded')}</div>
          </div>
          ${recoveryPanel(item, milestone, runtime)}
          <details class="technical-details"><summary>Advanced / Technical Details</summary>
            <div class="technical-grid">
              <div><span>milestone_id</span><p>${esc(milestone.id || 'Not recorded')}</p></div>
              <div><span>mission_id</span><p>${esc(runtime?.mission_id || milestone.mission_id || 'Not recorded')}</p></div>
              <div><span>Dependencies IDs</span>${listHtml(milestone.dependencies || milestone.depends_on, 'No dependencies')}</div>
              <div><span>Raw milestone state</span><p>${esc(milestone.state || milestone.lifecycle_state || 'Not recorded')}</p></div>
              <div><span>Raw runtime state</span><p>${esc(runtime?.milestone_state || runtime?.state || runtime?.status || 'Not recorded')}</p></div>
              <div><span>Task IDs</span>${listHtml([runtime?.task_id, runtime?.current_task_id, milestone.task_id].filter(Boolean), 'Not recorded')}</div>
              <div><span>Brain Run IDs</span>${listHtml([runtime?.brain_run?.id, runtime?.brain_run_id, milestone.brain_run_id].filter(Boolean), 'Not recorded')}</div>
              <div><span>Execution Run IDs</span>${listHtml([runtime?.execution_run?.id, runtime?.execution_run_id, milestone.execution_run_id].filter(Boolean), 'Not recorded')}</div>
              <div><span>Timestamps</span>${jsonDetails({ created_at: milestone.created_at, updated_at: milestone.updated_at, runtime_updated_at: runtime?.updated_at })}</div>
              <div><span>Raw Evidence</span>${jsonDetails(runtime?.latest_evidence || runtime?.verification_evidence)}</div>
              <div><span>Raw Recovery</span>${jsonDetails(runtime?.recovery)}</div>
            </div>
          </details>
        </div>
      </article>`;
    }).join('')}
  </div>`;
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
    const milestones = orderedMilestones(item);
    const done = milestones.filter((m) => ['COMPLETED', 'COMPLETE', 'DONE'].includes(rawState(m))).length;
    return `<div class="roadmap-item" tabindex="0" data-id="${esc(item.id)}"><h3>${esc(item.title)}</h3><p>${esc(item.objective)}</p><div class="roadmap-meta">${esc(item.state)} - ${done}/${(item.milestones || []).length} milestones - ${esc(item.owner_worker_id || 'W01')}</div></div>`;
  }).join('') : '<div class="empty-state">No roadmap goals for this project yet.</div>';
  document.querySelectorAll('.roadmap-item').forEach((el) => {
    el.addEventListener('click', () => editRoadmap(el.dataset.id));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') editRoadmap(el.dataset.id);
    });
  });
}

// MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V2
function syncManualAutopilotControl(item) {
  const button = $('#resumeAutopilotButton');
  if (!button) return;

  if (!item) {
    button.hidden = true;
    return;
  }

  const milestones = orderedMilestones(item);
  const roadmapState = rawState(item);
  const terminal = ['COMPLETED', 'COMPLETE', 'DONE', 'CANCELLED', 'CANCELED'].includes(roadmapState);
  const approval = text(item?.approval_status || item?.approval?.status).toUpperCase();
  const approved = approval === 'APPROVED' ||
    (item?.proposal_type === 'PLANNER_ROADMAP' && ['ACTIVE', 'APPROVED'].includes(roadmapState));
  const unfinished = milestones.some((milestone) =>
    !['COMPLETED', 'COMPLETE', 'DONE'].includes(rawState(milestone))
  );
  const started = milestones.some((milestone) =>
    Boolean(text(milestone?.mission_id)) ||
    !['', 'PENDING', 'PROPOSED', 'READY'].includes(rawState(milestone))
  );

  button.hidden = !(approved && !terminal && unfinished);
  button.textContent = started ? 'RESUME AUTOPILOT' : 'START AUTOPILOT';
}

function renderMilestoneStateEditor(item) {
  const target = $('#milestoneStateEditor');
  if (!target) return;
  target.innerHTML = item
    ? renderRoadmapProductHeader(item) + renderMilestoneTimeline(item)
    : '<div class="empty-state">No persisted milestones to display yet.</div>';
  renderTrustedContext(item);
  const headerContext = $('#roadmapHeaderContext');
  const trustedContext = $('#roadmapEditorContext');
  if (headerContext && trustedContext) headerContext.innerHTML = trustedContext.innerHTML;
}

async function editRoadmap(id) {
  let item = roadmaps.find((r) => r.id === id);
  if (!item) return;
  try {
    item = await api(`/api/roadmaps/${encodeURIComponent(id)}`);
    currentRoadmap = item;
  } catch (error) {
    $('#roadmapMessage').textContent = `Roadmap refresh failed: ${error.message}`;
    currentRoadmap = item;
  }
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
  $('#roadmapMilestones').value = orderedMilestones(item).map((m) => m.title).join('\n');
  renderMilestoneStateEditor(item);
  syncManualAutopilotControl(item);
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
  currentRoadmap = null;
  renderMilestoneStateEditor(null);
  syncManualAutopilotControl(null);
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
    await editRoadmap(saved.id);
  } catch (error) { message.textContent = `Error: ${error.message}`; }
});

$('#resumeAutopilotButton').addEventListener('click', async () => {
  const id = text($('#roadmapId').value || currentRoadmap?.id);
  if (!id) return;

  const button = $('#resumeAutopilotButton');
  button.disabled = true;
  $('#roadmapMessage').textContent = 'Asking trusted Autopilot to start or resume...';

  try {
    const result = await api(`/api/roadmaps/${encodeURIComponent(id)}/autopilot`, {
      method: 'POST',
      body: JSON.stringify({})
    });

    $('#roadmapMessage').textContent = result?.no_new_work
      ? 'Autopilot already owns the persisted work. Refreshing trusted state...'
      : 'Autopilot accepted Start / Resume. Refreshing trusted state...';

    await loadRoadmaps();
    await editRoadmap(id);
  } catch (error) {
    $('#roadmapMessage').textContent = `Autopilot Start / Resume failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
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
      ? `Reopened. Upcoming milestone, informational only: ${updated.next_milestone.title}`
      : 'Reopened.';
    await loadRoadmaps();
    await editRoadmap(id);
  } catch (error) {
    $('#roadmapMessage').textContent = `Reopen failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('#milestoneStateEditor').addEventListener('click', async (event) => {
  const button = event.target?.closest ? event.target.closest('button') : event.target;
  if (!button?.dataset) return;
  if (button.dataset.missionRecovery) {
    const missionId = text(button.dataset.missionId);
    if (!missionId) return;
    button.disabled = true;
    $('#roadmapMessage').textContent = 'Starting trusted recovery...';
    try {
      await api(`/api/missions/${encodeURIComponent(missionId)}/recover`, { method: 'POST', body: JSON.stringify({}) });
      $('#roadmapMessage').textContent = 'Recovery started. Refreshing trusted roadmap state...';
      await loadRoadmaps();
      if (currentRoadmap?.id) await editRoadmap(currentRoadmap.id);
    } catch (error) {
      $('#roadmapMessage').textContent = `Recovery failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }
  if (button.dataset.humanActionReady) {
    const roadmapId = text(button.dataset.roadmapId || currentRoadmap?.id);
    const cpId = text(button.dataset.checkpointId);
    if (!roadmapId || !cpId) return;
    button.disabled = true;
    $('#roadmapMessage').textContent = 'Validating Human Action checkpoint...';
    try {
      const result = await api(`/api/planner/proposals/${encodeURIComponent(roadmapId)}/human-action/${encodeURIComponent(cpId)}/ready`, {
        method: 'POST',
        body: JSON.stringify({ ready: true })
      });
      $('#roadmapMessage').textContent = result?.resumed === false ? 'Human Action is still required.' : 'Human Action validated. Refreshing trusted roadmap state...';
      await loadRoadmaps();
      await editRoadmap(roadmapId);
    } catch (error) {
      $('#roadmapMessage').textContent = `LISTO failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }
});

init().catch((error) => { document.body.insertAdjacentHTML('beforeend', `<pre>${esc(error.message)}</pre>`); });
