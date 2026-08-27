const express = require('express');

function plannerPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#09111f">
  <title>Roadmap Planner - MRAPI DEV</title>
  <style>
    :root { color-scheme: dark; --bg:#07101d; --panel:rgba(13,25,42,.88); --line:rgba(255,255,255,.1); --text:#edf4ff; --muted:#8fa1b8; --blue:#6aa7ff; --green:#48d597; --amber:#f3bd61; --red:#ff6b72; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:linear-gradient(180deg,#081321 0%,#07101d 100%); color:var(--text); }
    button,input,textarea,select { font:inherit; }
    button { cursor:pointer; }
    .shell { width:min(1120px,100%); margin:0 auto; padding:28px 18px 48px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding-bottom:18px; margin-bottom:24px; }
    .brand { color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:32px; }
    p { color:var(--muted); line-height:1.55; }
    a { color:#b9d4ff; }
    .grid { display:grid; grid-template-columns:minmax(0,.92fr) minmax(320px,1.08fr); gap:18px; align-items:start; }
    .panel,.milestone,.summary-card,.advanced-details,.human-action-panel { border:1px solid var(--line); background:var(--panel); border-radius:15px; padding:18px; }
    .request-panel { padding:20px; }
    .request-panel h2 { margin:0 0 8px; font-size:28px; }
    .flow { margin:0 0 18px; color:#cfe0f7; }
    .context-box { margin:16px 0; padding:14px; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.025); }
    .context-box h3 { margin:0 0 10px; color:#cfe0f7; font-size:14px; }
    .context-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .recent-panel { margin-top:16px; padding-top:16px; border-top:1px solid var(--line); }
    .recent-panel h3 { margin:0 0 10px; font-size:16px; }
    .recent-list { display:grid; gap:9px; }
    .recent-item { width:100%; text-align:left; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:11px 12px; background:rgba(255,255,255,.025); color:var(--text); }
    .recent-item:hover,.recent-item:focus { border-color:rgba(106,167,255,.45); background:rgba(106,167,255,.07); }
    .recent-title { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; font-weight:850; }
    .recent-meta { display:block; margin-top:6px; color:var(--muted); font-size:12px; line-height:1.45; }
    .recent-id { display:block; margin-top:5px; color:rgba(143,161,184,.72); font-size:11px; }
    .primary-request span { color:var(--text); font-size:18px; }
    .primary-request textarea { min-height:220px; border-color:rgba(106,167,255,.32); background:#07111f; font-size:16px; }
    .secondary-tools { margin-top:14px; opacity:.82; }
    .secondary-tools .field span { font-size:11px; }
    .field { display:flex; flex-direction:column; gap:7px; margin-bottom:13px; }
    .field span,.label { color:var(--muted); font-size:12px; font-weight:800; }
    input,textarea,select { width:100%; color:var(--text); background:#081220; border:1px solid rgba(255,255,255,.13); border-radius:10px; padding:11px 12px; outline:none; }
    textarea { min-height:150px; resize:vertical; }
    input:focus,textarea:focus,select:focus { border-color:rgba(106,167,255,.65); box-shadow:0 0 0 3px rgba(106,167,255,.08); }
    .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .primary,.secondary,.danger { border-radius:9px; padding:10px 14px; font-weight:800; }
    .primary { border:1px solid rgba(106,167,255,.55); background:#dceaff; color:#07101d; }
    .secondary { border:1px solid var(--line); background:rgba(255,255,255,.03); color:var(--text); }
    .danger { border:1px solid rgba(243,189,97,.45); background:rgba(243,189,97,.09); color:#ffe0ab; }
    button:disabled { opacity:.48; cursor:not-allowed; transform:none; }
    .status { margin:0 0 14px; padding:12px 13px; border:1px solid var(--line); border-radius:12px; background:rgba(255,255,255,.025); color:var(--muted); }
    .status strong { color:var(--text); }
    .status.error { border-color:rgba(255,107,114,.35); color:#ffb9bd; }
    .status.success { border-color:rgba(72,213,151,.3); color:#baf5d8; }
    .badge { display:inline-flex; align-items:center; min-height:24px; padding:4px 8px; border-radius:999px; border:1px solid var(--line); color:#dceaff; font-size:11px; font-weight:900; letter-spacing:.06em; text-transform:uppercase; }
    .badge.awaiting { color:#ffd38d; border-color:rgba(243,189,97,.26); background:rgba(243,189,97,.08); }
    .badge.active { color:#93efc4; border-color:rgba(72,213,151,.22); background:rgba(72,213,151,.08); }
    .badge.blocked,.badge.cancelled { color:#ffb9bd; border-color:rgba(255,107,114,.28); background:rgba(255,107,114,.08); }
    .badge.complete { color:#d6c7ff; border-color:rgba(185,157,255,.24); background:rgba(185,157,255,.08); }
    .badge.executor { color:#07101d; border-color:rgba(186,245,216,.72); background:#baf5d8; }
    .badge.brain { color:#dceaff; border-color:rgba(106,167,255,.34); background:rgba(106,167,255,.1); }
    .proposal-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .proposal-head h2 { margin:3px 0 0; }
    .summary-card { margin:14px 0; background:rgba(255,255,255,.035); }
    .completion-summary { margin:14px 0; border-color:rgba(72,213,151,.32); background:rgba(72,213,151,.075); }
    .completion-summary h3 { margin:6px 0 8px; font-size:26px; }
    .completion-summary .final-narrative { color:#f7fbff; font-size:16px; }
    .summary-card h3 { margin:6px 0 8px; font-size:24px; }
    .summary-card .objective { color:#f7fbff; font-size:17px; margin:0 0 8px; }
    .human-action-panel { margin:14px 0; border-color:rgba(243,189,97,.45); background:rgba(243,189,97,.095); }
    .human-action-panel.is-current { border-color:rgba(255,211,141,.78); box-shadow:0 0 0 1px rgba(255,211,141,.24); }
    .human-action-panel h3 { margin:7px 0 10px; font-size:22px; }
    .human-action-panel p { margin:7px 0 0; color:#ffe7bc; }
    .human-action-panel .checkpoint-source { color:var(--muted); font-size:12px; margin-top:4px; }
    .human-action-actions { margin-top:14px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .summary-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:16px 0; }
    .metric { border:1px solid rgba(255,255,255,.08); border-radius:10px; padding:10px; background:rgba(255,255,255,.025); }
    .metric strong { display:block; color:#f7fbff; font-size:22px; margin-top:3px; }
    .bounded-summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:12px; }
    .notice { margin:12px 0; padding:12px 13px; border:1px solid rgba(243,189,97,.28); border-radius:12px; background:rgba(243,189,97,.07); color:#ffdca4; }
    .notice.terminal { border-color:rgba(255,107,114,.3); background:rgba(255,107,114,.07); color:#ffbec2; }
    .info-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:14px 0; }
    .info-grid div { border-top:1px solid var(--line); padding-top:10px; }
    ul { margin:7px 0 0; padding-left:18px; color:var(--muted); }
    .milestones { display:grid; gap:12px; margin-top:14px; }
    .milestone h3 { margin:0; font-size:17px; }
    .milestone summary,.advanced-details summary { cursor:pointer; }
    .milestone summary:focus-visible,.advanced-details summary:focus-visible { outline:3px solid rgba(106,167,255,.45); outline-offset:4px; border-radius:8px; }
    .milestone-summary { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; list-style:none; }
    .milestone-summary::-webkit-details-marker { display:none; }
    .milestone-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .meta { color:var(--muted); font-size:12px; margin-top:5px; }
    .kv { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 14px; margin-top:12px; }
    .kv div { min-width:0; }
    .advanced-details { margin-top:14px; background:rgba(255,255,255,.025); }
    .hidden { display:none !important; }
    .small { color:var(--muted); font-size:12px; }
    @media (max-width:820px) { .grid,.info-grid,.kv,.context-grid,.summary-metrics,.bounded-summary { grid-template-columns:1fr; } .topbar { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div><div class="brand">MRAPI DEV ORCHESTRATOR</div><h1>Roadmap Planner</h1></div>
      <a href="/">Control Room</a>
    </header>

    <section class="grid">
      <form class="panel request-panel" id="plannerForm">
        <h2>¿Qué querés hacer?</h2>
        <p class="flow">Pedís algo → W01 prepara el plan → lo revisás → aprobás → recién ahí puede ejecutarse.</p>
        <label class="field primary-request"><span>Contale a W01 qué necesitás</span><textarea id="plannerRequest" name="request" required minlength="1" placeholder="Contame qué querés crear, cambiar o mejorar. W01 te va a proponer un plan antes de ejecutar nada."></textarea></label>
        <section class="context-box" aria-label="Contexto">
          <h3>Contexto</h3>
          <div class="context-grid">
            <label class="field"><span>Workspace</span><select id="workspaceId" name="workspace_id" required disabled><option value="">Cargando contexto...</option></select></label>
            <label class="field"><span>Project</span><select id="projectId" name="project_id" required disabled><option value="">Elegí un workspace primero</option></select></label>
          </div>
        </section>
        <div class="actions">
          <button class="primary" id="submitPlannerRequest" type="submit">Pedir plan</button>
          <button class="secondary" id="resetPlanner" type="button">Reset</button>
        </div>
        <section class="recent-panel" aria-label="Recent Planner Requests">
          <h3>Recent Planner Requests</h3>
          <div id="recentPlannerError" class="small"></div>
          <div id="recentPlannerList" class="recent-list"><span class="small">Loading recent Planner requests...</span></div>
        </section>
      </form>

      <section class="panel">
        <div id="statusMessage" class="status">Elegí el contexto y contame qué querés hacer.</div>
        <div class="secondary-tools">
          <label class="field"><span>Roadmap para actualizar</span><input id="proposalId" autocomplete="off" placeholder="Disponible cuando el plan esté listo"></label>
        </div>
        <div class="actions">
          <button class="secondary" id="refreshProposal" type="button">Actualizar plan</button>
          <button class="primary hidden" id="approveRoadmap" type="button">Approve roadmap</button>
          <button class="danger hidden" id="requestChanges" type="button">Request changes</button>
          <button class="primary hidden" id="startAutopilot" type="button">Start Autopilot</button>
        </div>
        <div id="requestChangesView" class="hidden">
          <label class="field"><span>Qué querés ajustar</span><textarea id="revisionFeedback" placeholder="Contale a W01 qué debería cambiar antes de aprobar este roadmap."></textarea></label>
          <div class="actions">
            <button class="danger" id="submitRevisionRequest" type="button" disabled>Submit changes</button>
            <button class="secondary" id="cancelRevisionRequest" type="button">Cancel</button>
          </div>
          <p class="small">W01 va a revisar el roadmap con este feedback. El plan sigue sin ejecutarse hasta que lo apruebes y lo inicies.</p>
        </div>
        <div id="proposalView" class="hidden"></div>
        <div id="startView" class="hidden"></div>
      </section>
    </section>
  </main>

  <script>
    const state = {
      requestId: null,
      missionId: null,
      brainRunId: null,
      proposalId: null,
      proposal: null,
      submitting: false,
      revisionSubmitting: false,
      contextLoading: true,
      contextError: '',
      workspaces: [],
      projects: [],
      recentPlannerRequests: [],
      recentLoading: true,
      recentError: '',
      restoredPlanner: false,
      activeContext: null
    };

    const plannerStorageKey = 'mrapi.planner.active.v1';
    const plannerContextStorageKey = 'mrapi.planner.context.v1';

    function persistPlannerState() {
      try {
        localStorage.setItem(plannerStorageKey, JSON.stringify({
          requestId: state.requestId,
          missionId: state.missionId,
          brainRunId: state.brainRunId,
          proposalId: state.proposalId,
          workspaceId: els?.workspace?.value || '',
          projectId: els?.project?.value || '',
          request: els?.request?.value || ''
        }));
      } catch {}
    }

    function clearPersistedPlannerState() {
      try { localStorage.removeItem(plannerStorageKey); } catch {}
    }

    function readRememberedContext() {
      try {
        const saved = JSON.parse(localStorage.getItem(plannerContextStorageKey) || 'null');
        if (!saved || typeof saved !== 'object') return null;
        if (typeof saved.workspaceId !== 'string' || typeof saved.projectId !== 'string') return null;
        const workspaceId = saved.workspaceId.trim();
        const projectId = saved.projectId.trim();
        if (!workspaceId || !projectId) return null;
        return { workspaceId, projectId };
      } catch {
        return null;
      }
    }

    function persistRememberedContext(workspaceId, projectId) {
      const remembered = {
        workspaceId: typeof workspaceId === 'string' ? workspaceId.trim() : '',
        projectId: typeof projectId === 'string' ? projectId.trim() : ''
      };
      if (!remembered.workspaceId || !remembered.projectId) return false;
      try {
        localStorage.setItem(plannerContextStorageKey, JSON.stringify(remembered));
        return true;
      } catch {
        return false;
      }
    }

    function restoreRememberedContext() {
      const remembered = readRememberedContext();
      if (!remembered) return false;
      return applyContextSelection(remembered);
    }

    function restorePlannerState() {
      try {
        const saved = JSON.parse(localStorage.getItem(plannerStorageKey) || 'null');
        if (!saved || typeof saved !== 'object') return false;
        state.requestId = saved.requestId || null;
        state.missionId = saved.missionId || state.requestId || null;
        state.brainRunId = saved.brainRunId || null;
        state.proposalId = saved.proposalId || null;
        if (saved.workspaceId || saved.projectId) {
          state.activeContext = {
            workspaceId: typeof saved.workspaceId === 'string' ? saved.workspaceId.trim() : '',
            projectId: typeof saved.projectId === 'string' ? saved.projectId.trim() : ''
          };
        }
        if (saved.request) els.request.value = saved.request;
        if (state.proposalId) els.proposalId.value = state.proposalId;
        return Boolean(state.requestId || state.proposalId);
      } catch {
        return false;
      }
    }

    const els = {
      form: document.getElementById('plannerForm'),
      workspace: document.getElementById('workspaceId'),
      project: document.getElementById('projectId'),
      request: document.getElementById('plannerRequest'),
      submit: document.getElementById('submitPlannerRequest'),
      reset: document.getElementById('resetPlanner'),
      status: document.getElementById('statusMessage'),
      proposalId: document.getElementById('proposalId'),
      refresh: document.getElementById('refreshProposal'),
      approve: document.getElementById('approveRoadmap'),
      requestChanges: document.getElementById('requestChanges'),
      requestChangesView: document.getElementById('requestChangesView'),
      revisionFeedback: document.getElementById('revisionFeedback'),
      submitRevision: document.getElementById('submitRevisionRequest'),
      cancelRevision: document.getElementById('cancelRevisionRequest'),
      start: document.getElementById('startAutopilot'),
      proposalView: document.getElementById('proposalView'),
      startView: document.getElementById('startView'),
      recentList: document.getElementById('recentPlannerList'),
      recentError: document.getElementById('recentPlannerError')
    };

    function text(value) {
      return String(value == null ? '' : value);
    }

    function escapeHtml(value) {
      return text(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }

    function readableValue(value) {
      if (value == null) return '';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return text(value);
      if (typeof value === 'object') return text(value.title || value.name || value.id || value.milestone_id || value.key || '');
      return '';
    }

    function list(items, emptyText = 'None recorded') {
      const values = Array.isArray(items) ? items.map(readableValue).filter((item) => text(item).trim()) : [];
      if (!values.length) return '<span class="small">' + escapeHtml(emptyText) + '</span>';
      return '<ul>' + values.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
    }

    function boundedList(items, limit, emptyText = 'None recorded') {
      const values = Array.isArray(items) ? items.map(readableValue).filter((item) => text(item).trim()) : [];
      if (!values.length) return '<span class="small">' + escapeHtml(emptyText) + '</span>';
      const shown = values.slice(0, limit);
      const more = values.length > shown.length ? '<p class="small">+' + escapeHtml(values.length - shown.length) + ' more in Advanced details.</p>' : '';
      return '<ul>' + shown.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>' + more;
    }

    function renderJson(value, emptyText = 'Not recorded') {
      if (value == null || value === '') return '<span class="small">' + escapeHtml(emptyText) + '</span>';
      return '<pre class="small">' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
    }

    function setStatus(message, kind) {
      els.status.className = 'status' + (kind ? ' ' + kind : '');
      els.status.textContent = message;
    }

    function optionHtml(value, label) {
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(label || value) + '</option>';
    }

    function projectWorkspaceId(project) {
      return text(project?.workspace_id || project?.workspaceId).trim();
    }

    function workspaceLabel(workspace) {
      return text(workspace?.name || workspace?.id).trim();
    }

    function projectLabel(project) {
      return text(project?.name || project?.title || project?.id).trim();
    }

    function projectsForWorkspace(workspaceId) {
      return state.projects.filter((project) => projectWorkspaceId(project) === workspaceId);
    }

    function renderWorkspaceOptions(selectedWorkspaceId = '') {
      els.workspace.innerHTML = '<option value="">Elegí un workspace</option>' +
        state.workspaces.map((workspace) => optionHtml(workspace.id, workspaceLabel(workspace))).join('');
      els.workspace.value = state.workspaces.some((workspace) => workspace.id === selectedWorkspaceId) ? selectedWorkspaceId : '';
    }

    function renderProjectOptions(workspaceId, selectedProjectId = '') {
      if (!workspaceId) {
        els.project.innerHTML = '<option value="">Elegí un workspace primero</option>';
        els.project.value = '';
        return;
      }
      const projects = projectsForWorkspace(workspaceId);
      els.project.innerHTML = '<option value="">Elegí un project</option>' +
        projects.map((project) => optionHtml(project.id, projectLabel(project))).join('');
      els.project.value = projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : '';
      if (!els.project.value && projects.length === 1 && !selectedProjectId) {
        els.project.value = projects[0].id;
      }
    }

    function applyContextSelection(context) {
      if (!context || !state.workspaces.length) return false;
      const workspaceId = text(context.workspaceId).trim();
      const projectId = text(context.projectId).trim();
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        renderWorkspaceOptions('');
        renderProjectOptions('', '');
        return false;
      }
      renderWorkspaceOptions(workspaceId);
      renderProjectOptions(workspaceId, projectId);
      return Boolean(els.workspace.value && (!projectId || els.project.value === projectId));
    }

    function syncContextControlState() {
      const disabled = state.contextLoading || Boolean(state.contextError);
      els.workspace.disabled = disabled || !state.workspaces.length;
      els.project.disabled = disabled || !els.workspace.value || !projectsForWorkspace(els.workspace.value).length;
    }

    async function parseResponse(response) {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.message || body.error || 'Request failed';
        throw new Error(message);
      }
      return body;
    }

    function canSubmit() {
      return Boolean(!state.contextLoading && !state.contextError && els.workspace.value.trim() && els.project.value.trim() && els.request.value.trim());
    }

    function syncSubmitState() {
      syncContextControlState();
      els.submit.disabled = !canSubmit();
      if (state.submitting) els.submit.disabled = true;
      els.submit.textContent = state.submitting ? 'Preparando tu plan...' : 'Pedir plan';
    }

    function lifecycleState(proposal) {
      return text(proposal?.state || proposal?.lifecycle_state || '').trim().toUpperCase();
    }

    function rawLifecycleState(item) {
      return text(item?.state || item?.lifecycle_state || '').trim();
    }

    function approvalStatus(proposal) {
      return text(proposal?.approval_status || proposal?.approval?.status || '').trim().toUpperCase();
    }

    function explicitHumanActionMarker(value) {
      const marker = text(value).trim().toUpperCase();
      return [
        'NEEDS_HUMAN_ACTION',
        'HUMAN_ACTION_REQUIRED',
        'WAITING_FOR_HUMAN',
        'HUMAN_ACTION',
        'HUMAN_CHECKPOINT',
        'MANUAL_ACTION',
        'MANUAL_REVIEW',
        'REVIEW_CHECKPOINT',
        'APPROVAL_CHECKPOINT'
      ].includes(marker);
    }

    function requiresHumanAction(item) {
      if (!item || typeof item !== 'object') return false;
      if (item.human_action_required === true || item.requires_human_action === true) return true;
      if (explicitHumanActionMarker(item.state || item.lifecycle_state || item.revision_status || item.status)) return true;
      if (explicitHumanActionMarker(item.action_type || item.checkpoint_type || item.type)) return true;
      if (item.action && typeof item.action === 'object' && explicitHumanActionMarker(item.action.type || item.action.kind || item.action.state)) return true;
      if (item.checkpoint && typeof item.checkpoint === 'object' && explicitHumanActionMarker(item.checkpoint.type || item.checkpoint.kind || item.checkpoint.state)) return true;
      return item.executor_required === false && (
        explicitHumanActionMarker(item.handoff_type) ||
        explicitHumanActionMarker(item.review_type)
      );
    }

    function explicitTextField(item, fields) {
      if (!item || typeof item !== 'object') return '';
      for (const field of fields) {
        const value = item[field];
        if (typeof value === 'string' || typeof value === 'number') {
          const normalized = text(value).trim();
          if (normalized) return normalized;
        }
      }
      return '';
    }

    function explicitHumanActionObjects(item) {
      if (!item || typeof item !== 'object') return [];
      const objects = [item];
      if (item.action && typeof item.action === 'object') objects.push(item.action);
      if (item.checkpoint && typeof item.checkpoint === 'object') objects.push(item.checkpoint);
      return objects;
    }

    function explicitHumanActionValue(item, fields) {
      for (const candidate of explicitHumanActionObjects(item)) {
        const value = explicitTextField(candidate, fields);
        if (value) return value;
      }
      return '';
    }

    function checkpointFriendlyStatus(rawValue, source) {
      if (explicitHumanActionMarker(rawValue)) return 'Need human action';
      if (!text(rawValue).trim() && requiresHumanAction(source)) return 'Need human action';
      return titleCaseState(rawValue, 'Need human action');
    }

    function humanActionViewModel(source, options = {}) {
      if (!requiresHumanAction(source)) return null;
      const sourceMilestoneId = text(options.sourceMilestoneId || source?.id || '').trim();
      const sourceMilestoneTitle = text(options.sourceMilestoneTitle || source?.title || '').trim();
      const id = explicitHumanActionValue(source, ['checkpoint_id', 'human_action_id', 'action_id']);
      const type = explicitHumanActionValue(source, ['checkpoint_type', 'human_action_type', 'action_type', 'type']);
      const rawStatus = explicitHumanActionValue(source, ['checkpoint_state', 'checkpoint_status', 'human_action_state', 'human_action_status', 'status', 'revision_status', 'state', 'lifecycle_state']);
      const requirement = explicitHumanActionValue(source, ['human_action', 'human_action_request', 'checkpoint_message', 'requirement', 'reason']);
      const userAction = explicitHumanActionValue(source, ['user_action', 'required_action', 'action_instruction', 'instructions']);
      return {
        id,
        type,
        rawStatus,
        friendlyStatus: checkpointFriendlyStatus(rawStatus, source),
        requirement,
        requirementText: requirement || 'MRAPI is waiting for a user action.',
        userAction,
        userActionText: userAction || 'No specific user instruction was recorded.',
        sourceKind: options.sourceKind || 'roadmap',
        sourceMilestoneId,
        sourceMilestoneTitle,
        isCurrent: Boolean(options.isCurrent),
        identity: id
          ? 'id:' + id
          : [
            'source:' + (sourceMilestoneId || options.sourceKind || 'roadmap'),
            'type:' + type,
            'status:' + rawStatus,
            'requirement:' + requirement,
            'action:' + userAction
          ].join('|')
      };
    }

    function sortedMilestoneItems(proposal) {
      const milestones = Array.isArray(proposal?.milestones) ? proposal.milestones.map((milestone, index) => ({ milestone, index })) : [];
      milestones.sort((a, b) => {
        const aHasOrder = Number.isFinite(Number(a.milestone.order));
        const bHasOrder = Number.isFinite(Number(b.milestone.order));
        if (aHasOrder && bHasOrder) return Number(a.milestone.order) - Number(b.milestone.order);
        if (aHasOrder) return -1;
        if (bHasOrder) return 1;
        return a.index - b.index;
      });
      return milestones;
    }

    function humanActionViewModels(proposal, milestones) {
      const candidates = [];
      const views = [];
      const seen = new Set();
      const currentId = text(proposal?.current_milestone_id || proposal?.milestone_id || '').trim();
      const currentObject = currentMilestone(proposal);
      const addCandidate = (view) => {
        if (view) candidates.push(view);
      };

      addCandidate(humanActionViewModel(proposal, {
        sourceKind: 'roadmap',
        isCurrent: !currentId && currentObject && currentObject === proposal
      }));

      for (const item of milestones) {
        const milestone = item.milestone;
        const milestoneId = text(milestone?.id).trim();
        addCandidate(humanActionViewModel(milestone, {
          sourceKind: 'milestone',
          sourceMilestoneId: milestoneId,
          sourceMilestoneTitle: milestone?.title,
          isCurrent: Boolean(milestoneId && milestoneId === currentId) || (currentObject && currentObject === milestone)
        }));
      }
      if (currentObject && currentObject !== proposal && !milestones.some((item) => item.milestone === currentObject)) {
        const milestoneId = text(currentObject.id || currentId).trim();
        addCandidate(humanActionViewModel(currentObject, {
          sourceKind: 'milestone',
          sourceMilestoneId: milestoneId,
          sourceMilestoneTitle: currentObject.title,
          isCurrent: true
        }));
      }

      candidates.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if (a.sourceKind !== b.sourceKind) return a.sourceKind === 'roadmap' ? -1 : 1;
        return 0;
      });
      for (const view of candidates) {
        if (seen.has(view.identity)) continue;
        seen.add(view.identity);
        views.push(view);
      }
      return views;
    }

    function titleCaseState(value, emptyText = 'Pending') {
      const raw = text(value).trim();
      if (!raw) return emptyText;
      return raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/(^|\\s)\\w/g, (match) => match.toUpperCase());
    }

    function currentMilestone(proposal) {
      if (!proposal || typeof proposal !== 'object') return null;
      if (proposal.current_milestone && typeof proposal.current_milestone === 'object') return proposal.current_milestone;
      const currentId = text(proposal.current_milestone_id || proposal.milestone_id).trim();
      const milestones = Array.isArray(proposal.milestones) ? proposal.milestones : [];
      if (currentId) {
        const byId = milestones.find((milestone) => text(milestone?.id).trim() === currentId);
        if (byId) return byId;
      }
      return milestones.find((milestone) => ['RUNNING', 'EXECUTING', 'VERIFYING', 'PLANNING'].includes(lifecycleState(milestone))) || null;
    }

    function relatedMilestones(item) {
      const milestones = [];
      if (item?.current_milestone && typeof item.current_milestone === 'object') milestones.push(item.current_milestone);
      if (Array.isArray(item?.milestones)) milestones.push(...item.milestones.filter((milestone) => milestone && typeof milestone === 'object'));
      return milestones;
    }

    function hasState(item, states) {
      if (states.includes(lifecycleState(item))) return true;
      return relatedMilestones(item).some((milestone) => states.includes(lifecycleState(milestone)));
    }

    function hasHumanActionEvidence(item) {
      const current = currentMilestone(item);
      return requiresHumanAction(item) || (current && requiresHumanAction(current));
    }

    function friendlyLifecycle(item, options = {}) {
      const kind = options.kind || 'roadmap';
      const raw = lifecycleState(item);
      const rawDisplay = rawLifecycleState(item);
      const status = approvalStatus(item);
      const isMilestone = kind === 'milestone';
      const proposedIsAwaitingApproval = !isMilestone && raw === 'PROPOSED' && (status === 'PENDING' || status === 'AWAITING_APPROVAL' || !status);

      if (['COMPLETED', 'COMPLETE', 'DONE'].includes(raw)) return 'Completed';
      if (['CANCELLED', 'CANCELED'].includes(raw)) return 'Cancelled';
      if (raw === 'BLOCKED' || (isMilestone && hasState(item, ['BLOCKED']))) return 'Blocked';
      if (hasHumanActionEvidence(item)) return 'Need human action';
      if (hasState(item, ['RUNNING', 'EXECUTING', 'VERIFYING'])) return 'Running';
      if (raw === 'PLANNING') return 'Planning';
      if (raw === 'PENDING') return isMilestone ? 'Pending' : (status === 'APPROVED' ? 'Approved' : 'Planning');
      if (proposedIsAwaitingApproval) return 'Waiting for approval';
      if ((raw === 'ACTIVE' || raw === 'APPROVED') && status === 'APPROVED') return 'Approved';
      if (raw === 'APPROVED' && !status) return 'Approved';
      if (raw === 'PROPOSED') return isMilestone ? 'Pending' : 'Waiting for approval';
      if (rawDisplay) return titleCaseState(rawDisplay) + (!isMilestone && status ? ' / ' + titleCaseState(status) : '');
      return isMilestone ? 'Pending' : 'Planning';
    }

    function isApproved(proposal) {
      const roadmapState = lifecycleState(proposal);
      const status = approvalStatus(proposal);
      return (roadmapState === 'ACTIVE' || roadmapState === 'APPROVED') && status === 'APPROVED';
    }

    function isProposed(proposal) {
      const roadmapState = lifecycleState(proposal);
      const status = approvalStatus(proposal);
      return roadmapState === 'PROPOSED' && (status === 'PENDING' || status === 'AWAITING_APPROVAL' || !status);
    }

    function isRevisionPending(proposal) {
      return lifecycleState(proposal) === 'PLANNING' && text(proposal?.revision_status).trim().toUpperCase() === 'PENDING';
    }

    function isTerminal(proposal) {
      return ['BLOCKED', 'CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETE', 'DONE'].includes(lifecycleState(proposal));
    }

    function isCompleted(proposal) {
      return ['COMPLETED', 'COMPLETE', 'DONE'].includes(lifecycleState(proposal));
    }

    function isCompletedMilestone(milestone) {
      return ['COMPLETED', 'COMPLETE', 'DONE'].includes(lifecycleState(milestone));
    }

    function isRunning(proposal) {
      return friendlyLifecycle(proposal) === 'Running';
    }

    function isReviewComplete(proposal) {
      if (!proposal || typeof proposal !== 'object') return false;
      const requiredTextFields = ['title', 'objective', 'summary'];
      if (requiredTextFields.some((field) => !text(proposal[field]).trim())) return false;
      if (!Array.isArray(proposal.risks) || !Array.isArray(proposal.dependencies) || !Array.isArray(proposal.assumptions)) return false;
      if (!lifecycleState(proposal)) return false;
      if (!Array.isArray(proposal.milestones)) return false;
      if (!proposal.milestones.length) return isCompleted(proposal);
      return proposal.milestones.every((milestone) => (
        milestone &&
        text(milestone.id).trim() &&
        text(milestone.title).trim() &&
        text(milestone.objective || milestone.expected_outcome).trim() &&
        text(milestone.description).trim() &&
        typeof milestone.executor_required === 'boolean' &&
        Array.isArray(milestone.dependencies || milestone.depends_on) &&
        Array.isArray(milestone.risks) &&
        Array.isArray(milestone.success_criteria)
      ));
    }

    function stateClass(proposal) {
      const label = friendlyLifecycle(proposal);
      if (label === 'Approved' || label === 'Running' || label === 'Completed') return label === 'Completed' ? 'complete' : 'active';
      if (label === 'Blocked') return 'blocked';
      if (label === 'Cancelled') return 'cancelled';
      return 'awaiting';
    }

    function stateLabel(proposal) {
      return friendlyLifecycle(proposal);
    }

    function approvalLabel(proposal) {
      const status = approvalStatus(proposal);
      if (status === 'APPROVED') return 'APPROVED';
      if (status === 'PENDING' || status === 'AWAITING_APPROVAL') return 'Awaiting explicit approval';
      return status || 'Not recorded';
    }

    function friendlyMilestoneState(milestone) {
      return friendlyLifecycle(milestone, { kind: 'milestone' });
    }

    function friendlyPlannerState(item) {
      return friendlyLifecycle(item);
    }

    function friendlyTimestamp(item) {
      const raw = item?.updated_at || item?.created_at;
      if (!raw) return 'Date not recorded';
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return text(raw);
      return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function renderRecentPlannerRequests() {
      els.recentError.textContent = state.recentError || '';
      if (state.recentLoading) {
        els.recentList.innerHTML = '<span class="small">Loading recent Planner requests...</span>';
        return;
      }
      if (state.recentError) {
        els.recentList.innerHTML = '<span class="small">Recent Planner Requests are unavailable right now.</span>';
        return;
      }
      if (!state.recentPlannerRequests.length) {
        els.recentList.innerHTML = '<span class="small">No recent Planner requests yet.</span>';
        return;
      }
      els.recentList.innerHTML = state.recentPlannerRequests.map((item) => {
        const proposalId = text(item.roadmap_id || item.proposal_id || '').trim();
        const workspace = text(item.workspace_name || item.workspace_id || 'Workspace not recorded').trim();
        const project = text(item.project_name || item.project_id || 'Project not recorded').trim();
        return '<button class="recent-item" type="button" data-proposal-id="' + escapeHtml(proposalId) + '">' +
          '<span class="recent-title"><span>' + escapeHtml(item.title || 'Untitled roadmap') + '</span><span class="badge ' + stateClass(item) + '">' + escapeHtml(friendlyPlannerState(item)) + '</span></span>' +
          '<span class="recent-meta">' + escapeHtml(friendlyTimestamp(item)) + ' - Workspace: ' + escapeHtml(workspace) + ' - Project: ' + escapeHtml(project) + '</span>' +
          '<span class="recent-id">Roadmap ' + escapeHtml(proposalId || 'not recorded') + '</span>' +
          '</button>';
      }).join('');
    }

    async function loadRecentPlannerRequests() {
      state.recentLoading = true;
      state.recentError = '';
      renderRecentPlannerRequests();
      try {
        const history = await fetch('/api/planner/recent?limit=10').then(parseResponse);
        state.recentPlannerRequests = Array.isArray(history.items) ? history.items : [];
        state.recentLoading = false;
        renderRecentPlannerRequests();
      } catch (error) {
        state.recentLoading = false;
        state.recentError = 'Recent Planner Requests failed to load.';
        renderRecentPlannerRequests();
      }
    }

    async function openRecentPlannerRequest(proposalId) {
      const id = text(proposalId).trim();
      if (!id) return;
      state.proposalId = id;
      els.proposalId.value = id;
      setStatus('Opening persisted Planner proposal...', '');
      await loadProposal();
    }

    function renderSummaryCard(proposal, milestones) {
      const total = milestones.length;
      const executorCount = milestones.filter((item) => item.milestone.executor_required === true).length;
      const humanActionCount = milestones.filter((item) => requiresHumanAction(item.milestone)).length;
      const humanActionText = humanActionCount > 0 ? escapeHtml(humanActionCount) : 'none identified';
      return '<section class="summary-card" aria-label="Roadmap summary">' +
        '<span class="label">ROADMAP SUMMARY</span><h3>' + escapeHtml(proposal.title) + '</h3>' +
        '<p class="objective"><strong>Objective:</strong> ' + escapeHtml(proposal.objective) + '</p>' +
        '<p>' + escapeHtml(proposal.summary) + '</p>' +
        '<div class="summary-metrics">' +
        '<div class="metric"><span class="label">Milestones</span><strong>' + escapeHtml(total) + '</strong></div>' +
        '<div class="metric"><span class="label">Executor required</span><strong>' + escapeHtml(executorCount) + '</strong></div>' +
        '<div class="metric"><span class="label">Human actions</span><strong>' + humanActionText + '</strong></div>' +
        '</div>' +
        '<div class="bounded-summary"><div><span class="label">Major risks</span>' + boundedList(proposal.risks, 3, 'None recorded') + '</div>' +
        '<div><span class="label">Major dependencies</span>' + boundedList(proposal.dependencies, 3, 'No dependencies') + '</div></div>' +
        '</section>';
    }

    function narrativeText(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return '';
      return text(value).trim();
    }

    function finalNarrative(proposal) {
      const candidates = [
        proposal.final_summary,
        proposal.result_summary,
        proposal.outcome_summary,
        proposal.completion_summary,
        proposal.final_result_summary,
        proposal.outcome
      ];
      for (const candidate of candidates) {
        const value = narrativeText(candidate);
        if (value) return value;
      }
      return '';
    }

    function renderCompletedSummary(proposal, milestones) {
      const total = milestones.length;
      const completed = milestones.filter((item) => isCompletedMilestone(item.milestone)).length;
      const progress = total === 0
        ? '0 milestones recorded; 0 completed.'
        : completed + ' of ' + total + ' milestones completed.';
      const narrative = finalNarrative(proposal);
      return '<section class="summary-card completion-summary" aria-label="Completed roadmap summary">' +
        '<span class="label">COMPLETED ROADMAP</span><h3>' + escapeHtml(proposal.title) + '</h3>' +
        '<p class="objective"><strong>Original objective:</strong> ' + escapeHtml(proposal.objective) + '</p>' +
        '<div class="summary-metrics">' +
        '<div class="metric"><span class="label">State</span><strong>Completed</strong></div>' +
        '<div class="metric"><span class="label">Milestones</span><strong>' + escapeHtml(total) + '</strong></div>' +
        '<div class="metric"><span class="label">Completed</span><strong>' + escapeHtml(completed) + '</strong></div>' +
        '</div>' +
        '<p><strong>Progress:</strong> ' + escapeHtml(progress) + '</p>' +
        '<p class="final-narrative">' + escapeHtml(narrative || 'Completed based on persisted roadmap state; no final result summary is available.') + '</p>' +
        '</section>';
    }

    function renderHumanActionAdvancedDetails(view) {
      return '<details class="advanced-details"><summary><strong>Advanced checkpoint details</strong></summary>' +
        '<div class="info-grid">' +
        '<div><span class="label">Checkpoint ID</span><p>' + escapeHtml(view.id || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Checkpoint type</span><p>' + escapeHtml(view.type || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Raw checkpoint state</span><p>' + escapeHtml(view.rawStatus || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Source milestone ID</span><p>' + escapeHtml(view.sourceMilestoneId || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Persisted requirement field</span><p>' + escapeHtml(view.requirement || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Persisted action field</span><p>' + escapeHtml(view.userAction || 'Not recorded') + '</p></div>' +
        '</div></details>';
    }

    function renderHumanActionPanel(view) {
      const source = view.sourceKind === 'milestone'
        ? 'Milestone: ' + (view.sourceMilestoneTitle || view.sourceMilestoneId || 'Not recorded')
        : 'Roadmap-level checkpoint';
      return '<section class="human-action-panel' + (view.isCurrent ? ' is-current' : '') + '" aria-label="Human action required">' +
        '<span class="label">HUMAN ACTION</span><h3>Need human action</h3>' +
        '<div class="checkpoint-source">' + escapeHtml(source) + '</div>' +
        '<p><strong>MRAPI needs:</strong> ' + escapeHtml(view.requirementText) + '</p>' +
        '<p><strong>What you need to do:</strong> ' + escapeHtml(view.userActionText) + '</p>' +
        '<p><strong>Current checkpoint status:</strong> ' + escapeHtml(view.friendlyStatus) + '</p>' +
        '<div class="human-action-actions"><button class="primary" type="button" disabled>LISTO</button>' +
        '<span class="small">Confirmation will be enabled when MRAPI provides a continuation endpoint.</span></div>' +
        renderHumanActionAdvancedDetails(view) +
        '</section>';
    }

    function renderHumanActionPanels(views) {
      if (!views.length) return '';
      return views.map(renderHumanActionPanel).join('');
    }

    function renderRoadmapAdvancedDetails(proposal) {
      return '<details class="advanced-details"><summary><strong>Advanced roadmap details</strong></summary>' +
        '<div class="info-grid"><div><span class="label">Lifecycle state</span><p>' + escapeHtml(rawLifecycleState(proposal) || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Approval status</span><p>' + escapeHtml(approvalLabel(proposal)) + '</p></div>' +
        '<div><span class="label">Roadmap ID</span><p>' + escapeHtml(state.proposalId || 'Not recorded') + '</p></div></div>' +
        renderRevisionContext(proposal) +
        '<div class="info-grid"><div><span class="label">Risks</span>' + list(proposal.risks, 'None recorded') + '</div>' +
        '<div><span class="label">Dependencies</span>' + list(proposal.dependencies, 'No dependencies') + '</div>' +
        '<div><span class="label">Assumptions</span>' + list(proposal.assumptions, 'None recorded') + '</div></div>' +
        renderOriginalRequest(proposal) +
        '<div class="info-grid"><div><span class="label">Planner Mission ID</span><p>' + escapeHtml(text(proposal.planner_mission_id || proposal.mission_id || state.missionId || 'Not recorded')) + '</p></div>' +
        '<div><span class="label">Brain Run ID</span><p>' + escapeHtml(text(proposal.brain_run_id || proposal.active_revision_brain_run_id || state.brainRunId || 'Not recorded')) + '</p></div>' +
        '<div><span class="label">Proposal type</span><p>' + escapeHtml(text(proposal.proposal_type || 'Not recorded')) + '</p></div></div>' +
        '<div class="kv"><div><span class="label">Provenance</span>' + renderJson(proposal.provenance) + '</div>' +
        '<div><span class="label">Revision history</span>' + renderJson(proposal.revision_history) + '</div></div>' +
        '</details>';
    }

    function renderNotice(proposal) {
      if (isProposed(proposal)) {
        return '<div class="notice"><strong>Waiting for approval.</strong> Nothing has run yet. Review the roadmap before approving it.</div>';
      }
      if (isRevisionPending(proposal)) {
        return '<div class="notice"><strong>Cambios pedidos.</strong> W01 is revising the roadmap with your feedback. Approve and Start are unavailable until the updated plan is ready.</div>';
      }
      if (isRunning(proposal)) {
        const current = currentMilestone(proposal);
        const currentName = text(current?.title || current?.objective || current?.expected_outcome || current?.id || proposal.current_milestone_id || proposal.milestone_id).trim();
        const currentState = current ? friendlyMilestoneState(current) : stateLabel(proposal);
        return '<div class="notice"><strong>Running.</strong> Current milestone: ' + escapeHtml(currentName || 'Not recorded') + '. Status: ' + escapeHtml(currentState) + '.</div>';
      }
      if (isApproved(proposal)) {
        return '<div class="notice"><strong>Approved.</strong> Start Autopilot remains a separate action.</div>';
      }
      if (isTerminal(proposal)) {
        return '<div class="notice terminal"><strong>This roadmap is ' + escapeHtml(stateLabel(proposal)) + '.</strong> It is not presented as ordinary executable approved work.</div>';
      }
      return '<div class="notice"><strong>Roadmap status: ' + escapeHtml(stateLabel(proposal)) + '.</strong> It is not ready to start yet.</div>';
    }

    function renderOriginalRequest(proposal) {
      const originalRequest = text(proposal.original_request || proposal.provenance?.original_request).trim();
      const source = text(proposal.provenance?.source || proposal.proposal_type).trim();
      if (!originalRequest && !source) return '';
      return '<div class="info-grid"><div><span class="label">Pedido original</span><p>' + escapeHtml(originalRequest || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Origen del plan</span><p>' + escapeHtml(source || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Contexto</span><p>' + escapeHtml(text(proposal.workspace_id || 'Workspace not recorded')) + ' / ' + escapeHtml(text(proposal.project_id || 'Project not recorded')) + '</p></div></div>';
    }

    function renderRevisionContext(proposal) {
      const revisionNumber = Number(proposal.revision_number || 1);
      const feedback = text(proposal.latest_revision_feedback).trim();
      if (revisionNumber <= 1 && !feedback) return '';
      return '<div class="info-grid"><div><span class="label">Revision</span><p>Revision ' + escapeHtml(revisionNumber || 1) + '</p></div>' +
        '<div><span class="label">Latest human feedback</span><p>' + escapeHtml(feedback || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Revision status</span><p>' + escapeHtml(text(proposal.revision_status || (isRevisionPending(proposal) ? 'PENDING' : 'Ready for review'))) + '</p></div></div>';
    }

    function syncRevisionSubmitState() {
      const hasFeedback = Boolean(els.revisionFeedback.value.trim());
      els.submitRevision.disabled = state.revisionSubmitting || !hasFeedback;
      els.submitRevision.textContent = state.revisionSubmitting ? 'Sending revision request...' : 'Submit changes';
    }

    function hideRevisionForm() {
      els.requestChangesView.classList.add('hidden');
      state.revisionSubmitting = false;
      syncRevisionSubmitState();
    }

    function renderProposal(proposal) {
      state.proposal = proposal;
      state.proposalId = proposal?.roadmap_id || proposal?.proposal_id || proposal?.id || state.proposalId;
      if (state.proposalId) els.proposalId.value = state.proposalId;
      persistPlannerState();
      els.proposalView.classList.remove('hidden');
      els.startView.classList.add('hidden');
      if (!isReviewComplete(proposal)) {
        els.approve.classList.add('hidden');
        els.requestChanges.classList.add('hidden');
        els.start.classList.add('hidden');
        hideRevisionForm();
        els.proposalView.innerHTML = '<div class="proposal-head"><div><span class="label">ROADMAP PROPOSAL</span><h2>Proposal unavailable</h2></div><span class="badge blocked">INCOMPLETE</span></div>' +
          '<div class="notice terminal"><strong>Proposal review data is incomplete or malformed.</strong> Refresh the persisted proposal after Brain planning completes. Approval is unavailable until required review fields are returned by the server.</div>';
        setStatus('Proposal review data is incomplete or malformed. Approval is unavailable.', 'error');
        return;
      }
      const approved = isApproved(proposal);
      const proposed = isProposed(proposal);
      const canApprove = proposed && !approved && !isTerminal(proposal);
      const canRequestChanges = canApprove;
      const canStart = approved && !isTerminal(proposal) && !isRunning(proposal);
      els.approve.classList.toggle('hidden', !canApprove);
      els.requestChanges.classList.toggle('hidden', !canRequestChanges);
      els.start.classList.toggle('hidden', !canStart);
      if (!canRequestChanges || isRevisionPending(proposal)) hideRevisionForm();
      const milestones = sortedMilestoneItems(proposal);
      const humanActionViews = humanActionViewModels(proposal, milestones);
      els.proposalView.classList.remove('hidden');
      els.proposalView.innerHTML = '<div class="proposal-head"><div><span class="label">ROADMAP PROPOSAL</span><h2>' + escapeHtml(proposal.title) + '</h2></div><span class="badge ' + stateClass(proposal) + '">' + escapeHtml(stateLabel(proposal)) + '</span></div>' +
        renderNotice(proposal) +
        (isCompleted(proposal) ? renderCompletedSummary(proposal, milestones) : renderSummaryCard(proposal, milestones)) +
        renderHumanActionPanels(humanActionViews) +
        renderRoadmapAdvancedDetails(proposal) +
        '<h2>Milestones</h2><div class="milestones">' + milestones.map((item) => renderMilestone(item.milestone, item.index)).join('') + '</div>';
      if (isRunning(proposal)) setStatus('Running - current milestone is in progress.', 'success');
      else if (proposed && !approved) setStatus('Waiting for approval - revisalo antes de aprobar.', '');
      else if (isRevisionPending(proposal)) setStatus('Cambios pedidos. W01 está revisando el roadmap con tu feedback.', 'success');
      else if (approved) setStatus('Roadmap aprobado. Start Autopilot ya está disponible.', 'success');
      else setStatus('Roadmap is ' + stateLabel(proposal) + '.', '');
    }

    function renderMilestone(milestone, index) {
      const executorLabel = milestone.executor_required ? 'Executor required' : 'Brain only';
      const executorClass = milestone.executor_required ? 'executor' : 'brain';
      const dependencyItems = Array.isArray(milestone.dependencies) ? milestone.dependencies : milestone.depends_on;
      const blocked = ['BLOCKED', 'WAITING', 'PENDING'].includes(text(milestone.state).toUpperCase()) && Array.isArray(dependencyItems) && dependencyItems.length > 0;
      return '<details class="milestone"><summary class="milestone-summary"><div><h3>' + escapeHtml(milestone.order || index + 1) + '. ' + escapeHtml(milestone.title) + '</h3><div class="meta">' + escapeHtml(milestone.objective || milestone.expected_outcome) + (blocked ? ' - waiting on dependencies' : '') + '</div></div><span class="badge">' + escapeHtml(friendlyMilestoneState(milestone)) + '</span></summary>' +
        '<div class="kv"><div><span class="label">Description</span><p>' + escapeHtml(milestone.description) + '</p></div></div>' +
        '<details class="advanced-details"><summary><strong>Advanced milestone details</strong></summary><div class="kv">' +
        '<div><span class="label">Milestone ID</span><p>' + escapeHtml(milestone.id) + '</p></div>' +
        '<div><span class="label">Raw lifecycle state</span><p>' + escapeHtml(rawLifecycleState(milestone) || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Executor requirement</span><p><span class="badge ' + executorClass + '">' + escapeHtml(executorLabel) + '</span></p></div>' +
        '<div><span class="label">Dependencies</span>' + list(dependencyItems, 'No dependencies') + '</div>' +
        '<div><span class="label">Risks</span>' + list(milestone.risks, 'None recorded') + '</div>' +
        '<div><span class="label">Success criteria</span>' + list(milestone.success_criteria, 'None recorded') + '</div>' +
        '<div><span class="label">Order</span><p>' + escapeHtml(milestone.order || index + 1) + '</p></div></div></details></details>';
    }

    async function discoverProposalFromMission() {
      if (!state.requestId) return null;
      const mission = await fetch('/api/missions/' + encodeURIComponent(state.requestId)).then(parseResponse);
      const proposalId = mission.planner_roadmap_id || mission.roadmap_id || mission.current_roadmap_id;
      if (proposalId) {
        state.proposalId = proposalId;
        els.proposalId.value = proposalId;
      }
      return proposalId;
    }

    async function loadProposal() {
      try {
        let proposalId = els.proposalId.value.trim() || state.proposalId;
        if (!proposalId) proposalId = await discoverProposalFromMission();
        if (!proposalId) {
          setStatus('Preparando tu plan... Actualizá de nuevo cuando W01 termine.', '');
          return;
        }
        const proposal = await fetch('/api/planner/proposals/' + encodeURIComponent(proposalId)).then(parseResponse);
        renderProposal(proposal);
      } catch (error) {
        setStatus('Proposal retrieval failed: ' + error.message, 'error');
      }
    }

    async function loadPlannerContextOptions() {
      state.contextLoading = true;
      state.contextError = '';
      renderWorkspaceOptions('');
      renderProjectOptions('', '');
      setStatus('Cargando contexto...', '');
      syncSubmitState();
      try {
        const [workspaceData, projectData] = await Promise.all([
          fetch('/api/workspaces').then(parseResponse),
          fetch('/api/projects').then(parseResponse)
        ]);
        state.workspaces = Array.isArray(workspaceData.items) ? workspaceData.items : [];
        state.projects = Array.isArray(projectData.items) ? projectData.items : [];
        state.contextLoading = false;
        renderWorkspaceOptions('');
        renderProjectOptions('', '');
        if (state.restoredPlanner && state.activeContext) {
          applyContextSelection(state.activeContext);
        } else {
          restoreRememberedContext();
        }
        if (state.restoredPlanner) {
          setStatus('Recuperé tu pedido activo. Buscando el plan más reciente...', 'success');
          await loadProposal();
        } else if (!state.workspaces.length) {
          setStatus('No hay workspaces disponibles para pedir un plan.', 'error');
        } else {
          setStatus('Elegí el contexto y contame qué querés hacer.', '');
        }
      } catch (error) {
        state.contextLoading = false;
        state.contextError = 'Planner context failed to load.';
        renderWorkspaceOptions('');
        renderProjectOptions('', '');
        setStatus('No pude cargar el contexto. Workspace y project no están disponibles.', 'error');
      } finally {
        syncSubmitState();
      }
    }

    els.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.submitting) return;
      if (!canSubmit()) {
        setStatus('Elegí workspace, project y contame qué querés hacer.', 'error');
        return;
      }
      state.submitting = true;
      syncSubmitState();
      setStatus('Preparando tu plan...', '');
      try {
        const body = {
          workspace_id: els.workspace.value.trim(),
          project_id: els.project.value.trim(),
          request: els.request.value.trim()
        };
        const created = await fetch('/api/planner/requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }).then(parseResponse);
        persistRememberedContext(body.workspace_id, body.project_id);
        state.requestId = created.planner_request_id || created.request_id || created.mission_id || null;
        state.missionId = created.mission_id || state.requestId;
        state.brainRunId = created.brain_run_id || null;
        state.proposalId = created.roadmap_id || created.proposal_id || created.planner_roadmap_id || null;
        persistPlannerState();
        if (state.proposalId && (created.milestones || created.title || created.objective || created.summary)) {
          els.proposalId.value = state.proposalId;
          renderProposal(created);
        } else {
          setStatus('W01 está preparando el roadmap... Actualizá el plan cuando esté listo.', 'success');
        }
        loadRecentPlannerRequests();
      } catch (error) {
        setStatus('Planner request failed: ' + error.message, 'error');
      } finally {
        state.submitting = false;
        syncSubmitState();
      }
    });

    els.refresh.addEventListener('click', loadProposal);
    els.recentList.addEventListener('click', (event) => {
      const row = event.target?.closest ? event.target.closest('[data-proposal-id]') : event.target;
      const proposalId = row?.dataset?.proposalId;
      if (proposalId) openRecentPlannerRequest(proposalId);
    });
    els.requestChanges.addEventListener('click', () => {
      if (!isProposed(state.proposal) || !isReviewComplete(state.proposal)) {
        setStatus('Request Changes no está disponible hasta que el plan esté listo para revisar.', 'error');
        return;
      }
      els.requestChangesView.classList.remove('hidden');
      syncRevisionSubmitState();
    });

    els.cancelRevision.addEventListener('click', () => {
      els.revisionFeedback.value = '';
      hideRevisionForm();
    });

    els.revisionFeedback.addEventListener('input', syncRevisionSubmitState);

    els.submitRevision.addEventListener('click', async () => {
      const proposalId = els.proposalId.value.trim() || state.proposalId;
      const feedback = els.revisionFeedback.value.trim();
      if (!proposalId) return setStatus('Request Changes failed: proposal ID is required.', 'error');
      if (!feedback) {
        setStatus('Request Changes failed: escribí qué querés ajustar antes de pedir cambios.', 'error');
        syncRevisionSubmitState();
        return;
      }
      if (state.revisionSubmitting) return;
      state.revisionSubmitting = true;
      syncRevisionSubmitState();
      setStatus('Enviando cambios a W01...', '');
      try {
        const revised = await fetch('/api/planner/roadmaps/' + encodeURIComponent(proposalId) + '/request-changes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feedback })
        }).then(parseResponse);
        state.proposal = revised;
        els.approve.classList.add('hidden');
        els.requestChanges.classList.add('hidden');
        els.start.classList.add('hidden');
        hideRevisionForm();
        renderProposal(revised);
        setStatus('Cambios pedidos. W01 está revisando el roadmap con tu feedback.', 'success');
        loadRecentPlannerRequests();
      } catch (error) {
        setStatus('Request Changes failed: ' + error.message, 'error');
      } finally {
        state.revisionSubmitting = false;
        syncRevisionSubmitState();
      }
    });

    els.approve.addEventListener('click', async () => {
      const proposalId = els.proposalId.value.trim() || state.proposalId;
      if (!proposalId) return setStatus('Approval failed: proposal ID is required.', 'error');
      try {
        await fetch('/api/planner/roadmaps/' + encodeURIComponent(proposalId) + '/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approve: true })
        }).then(parseResponse);
        setStatus('Aprobación guardada. Actualizando el roadmap...', 'success');
        await loadProposal();
        loadRecentPlannerRequests();
      } catch (error) {
        setStatus('Approval failed: ' + error.message, 'error');
      }
    });

    els.start.addEventListener('click', async () => {
      const proposalId = els.proposalId.value.trim() || state.proposalId;
      if (!proposalId) return setStatus('Start failed: proposal ID is required.', 'error');
      try {
        const started = await fetch('/api/planner/roadmaps/' + encodeURIComponent(proposalId) + '/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        }).then(parseResponse);
        const current = started.current_milestone || {};
        const currentName = text(current.title || current.objective || current.expected_outcome || current.id || started.milestone_id).trim();
        const currentState = friendlyMilestoneState({ ...current, state: current.state || started.state });
        els.startView.classList.remove('hidden');
        els.startView.innerHTML = '<div class="status success"><strong>' + (started.no_new_work || started.reused ? 'Existing Autopilot work reused.' : 'Autopilot started.') + '</strong><br>' +
          'Current milestone: ' + escapeHtml(currentName || 'Not recorded') + '<br>' +
          'Status: ' + escapeHtml(currentState) +
          '<details class="advanced-details"><summary><strong>Advanced execution details</strong></summary>' +
          '<div class="info-grid"><div><span class="label">Milestone ID</span><p>' + escapeHtml(current.id || started.milestone_id || 'Not recorded') + '</p></div>' +
          '<div><span class="label">Mission ID</span><p>' + escapeHtml(started.mission_id || 'Not recorded') + '</p></div>' +
          '<div><span class="label">Brain Run ID</span><p>' + escapeHtml(started.brain_run_id || 'Not recorded') + '</p></div></div></details></div>';
        await loadProposal();
        loadRecentPlannerRequests();
      } catch (error) {
        setStatus('Start failed: ' + error.message, 'error');
      }
    });

    els.reset.addEventListener('click', () => {
      state.requestId = null; state.missionId = null; state.brainRunId = null; state.proposalId = null; state.proposal = null; state.submitting = false; state.revisionSubmitting = false;
      clearPersistedPlannerState();
      els.form.reset();
      renderWorkspaceOptions('');
      renderProjectOptions('', '');
      restoreRememberedContext();
      els.revisionFeedback.value = '';
      els.proposalId.value = '';
      els.proposalView.classList.add('hidden');
      els.startView.classList.add('hidden');
      els.requestChangesView.classList.add('hidden');
      els.approve.classList.add('hidden');
      els.requestChanges.classList.add('hidden');
      els.start.classList.add('hidden');
      setStatus('Elegí el contexto y contame qué querés hacer.', '');
      renderRecentPlannerRequests();
      syncSubmitState();
    });

    ['input', 'change'].forEach((name) => {
      els.workspace.addEventListener(name, syncSubmitState);
      els.project.addEventListener(name, syncSubmitState);
      els.request.addEventListener(name, syncSubmitState);
    });
    els.workspace.addEventListener('change', () => {
      renderProjectOptions(els.workspace.value, els.project.value);
      syncSubmitState();
    });
    state.restoredPlanner = restorePlannerState();
    syncSubmitState();
    loadRecentPlannerRequests();
    loadPlannerContextOptions();
  </script>
</body>
</html>`;
}

function createPlannerUiRouter() {
  const router = express.Router();
  router.get('/planner', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(plannerPageHtml());
  });
  return router;
}

module.exports = { createPlannerUiRouter, plannerPageHtml };
