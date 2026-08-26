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
    button,input,textarea { font:inherit; }
    button { cursor:pointer; }
    .shell { width:min(1120px,100%); margin:0 auto; padding:28px 18px 48px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding-bottom:18px; margin-bottom:24px; }
    .brand { color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:32px; }
    p { color:var(--muted); line-height:1.55; }
    a { color:#b9d4ff; }
    .grid { display:grid; grid-template-columns:minmax(0,.86fr) minmax(320px,1.14fr); gap:18px; align-items:start; }
    .panel,.milestone { border:1px solid var(--line); background:var(--panel); border-radius:15px; padding:18px; }
    .field { display:flex; flex-direction:column; gap:7px; margin-bottom:13px; }
    .field span,.label { color:var(--muted); font-size:12px; font-weight:800; }
    input,textarea { width:100%; color:var(--text); background:#081220; border:1px solid rgba(255,255,255,.13); border-radius:10px; padding:11px 12px; outline:none; }
    textarea { min-height:150px; resize:vertical; }
    input:focus,textarea:focus { border-color:rgba(106,167,255,.65); box-shadow:0 0 0 3px rgba(106,167,255,.08); }
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
    .notice { margin:12px 0; padding:12px 13px; border:1px solid rgba(243,189,97,.28); border-radius:12px; background:rgba(243,189,97,.07); color:#ffdca4; }
    .notice.terminal { border-color:rgba(255,107,114,.3); background:rgba(255,107,114,.07); color:#ffbec2; }
    .info-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:14px 0; }
    .info-grid div { border-top:1px solid var(--line); padding-top:10px; }
    ul { margin:7px 0 0; padding-left:18px; color:var(--muted); }
    .milestones { display:grid; gap:12px; margin-top:14px; }
    .milestone h3 { margin:0; font-size:17px; }
    .milestone-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .meta { color:var(--muted); font-size:12px; margin-top:5px; }
    .kv { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 14px; margin-top:12px; }
    .kv div { min-width:0; }
    .hidden { display:none !important; }
    .small { color:var(--muted); font-size:12px; }
    @media (max-width:820px) { .grid,.info-grid,.kv { grid-template-columns:1fr; } .topbar { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div><div class="brand">MRAPI DEV ORCHESTRATOR</div><h1>Roadmap Planner</h1></div>
      <a href="/">Control Room</a>
    </header>

    <section class="grid">
      <form class="panel" id="plannerForm">
        <h2>New Planner Request</h2>
        <p>Submit a high-level request for a W01 roadmap proposal. Review and approve the roadmap before any Autopilot execution can start.</p>
        <label class="field"><span>Workspace ID</span><input id="workspaceId" name="workspace_id" autocomplete="off" required></label>
        <label class="field"><span>Project ID</span><input id="projectId" name="project_id" autocomplete="off" required></label>
        <label class="field"><span>Natural-language product/software request</span><textarea id="plannerRequest" name="request" required minlength="1" placeholder="Describe the product or software outcome you want. Example: Build an intake dashboard that lets operators review pending customer setup requests across workspaces."></textarea></label>
        <div class="actions">
          <button class="primary" id="submitPlannerRequest" type="submit">Submit to Planner</button>
          <button class="secondary" id="resetPlanner" type="button">Reset</button>
        </div>
        <p class="small">Tenant scope is supplied by the server request context. This page does not accept a tenant_id field.</p>
      </form>

      <section class="panel">
        <div id="statusMessage" class="status">Enter workspace, project, and request text to begin.</div>
        <label class="field"><span>Proposal or roadmap ID</span><input id="proposalId" autocomplete="off" placeholder="Available after planning completes"></label>
        <div class="actions">
          <button class="secondary" id="refreshProposal" type="button">Refresh proposal</button>
          <button class="primary hidden" id="approveRoadmap" type="button">Approve roadmap</button>
          <button class="danger hidden" id="requestChanges" type="button">Request changes</button>
          <button class="primary hidden" id="startAutopilot" type="button">Start Autopilot</button>
        </div>
        <div id="requestChangesView" class="hidden">
          <label class="field"><span>Human feedback for W01 revision</span><textarea id="revisionFeedback" placeholder="Describe what W01 should change before this roadmap can be approved."></textarea></label>
          <div class="actions">
            <button class="danger" id="submitRevisionRequest" type="button" disabled>Submit changes</button>
            <button class="secondary" id="cancelRevisionRequest" type="button">Cancel</button>
          </div>
          <p class="small">This feedback will be sent back to W01 to revise the roadmap. Roadmap fields remain read-only.</p>
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
      revisionSubmitting: false
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
      els.workspace.value = remembered.workspaceId;
      els.project.value = remembered.projectId;
      return true;
    }

    function restorePlannerState() {
      try {
        const saved = JSON.parse(localStorage.getItem(plannerStorageKey) || 'null');
        if (!saved || typeof saved !== 'object') return false;
        state.requestId = saved.requestId || null;
        state.missionId = saved.missionId || state.requestId || null;
        state.brainRunId = saved.brainRunId || null;
        state.proposalId = saved.proposalId || null;
        if (saved.workspaceId) els.workspace.value = saved.workspaceId;
        if (saved.projectId) els.project.value = saved.projectId;
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
      startView: document.getElementById('startView')
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

    function setStatus(message, kind) {
      els.status.className = 'status' + (kind ? ' ' + kind : '');
      els.status.textContent = message;
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
      return Boolean(els.workspace.value.trim() && els.project.value.trim() && els.request.value.trim());
    }

    function syncSubmitState() {
      els.submit.disabled = !canSubmit();
      if (state.submitting) els.submit.disabled = true;
      els.submit.textContent = state.submitting ? 'Submitting to Planner...' : 'Submit to Planner';
    }

    function lifecycleState(proposal) {
      return text(proposal?.state || proposal?.lifecycle_state || '').trim().toUpperCase();
    }

    function approvalStatus(proposal) {
      return text(proposal?.approval_status || proposal?.approval?.status || '').trim().toUpperCase();
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
      return ['BLOCKED', 'CANCELLED', 'CANCELED', 'COMPLETED'].includes(lifecycleState(proposal));
    }

    function isReviewComplete(proposal) {
      if (!proposal || typeof proposal !== 'object') return false;
      const requiredTextFields = ['title', 'objective', 'summary'];
      if (requiredTextFields.some((field) => !text(proposal[field]).trim())) return false;
      if (!Array.isArray(proposal.risks) || !Array.isArray(proposal.dependencies) || !Array.isArray(proposal.assumptions)) return false;
      if (!lifecycleState(proposal)) return false;
      if (!Array.isArray(proposal.milestones) || !proposal.milestones.length) return false;
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
      const roadmapState = text(proposal?.state).toUpperCase();
      if (roadmapState === 'ACTIVE' || roadmapState === 'APPROVED') return 'active';
      if (roadmapState === 'BLOCKED') return 'blocked';
      if (roadmapState === 'CANCELLED' || roadmapState === 'CANCELED') return 'cancelled';
      if (roadmapState === 'COMPLETED') return 'complete';
      return 'awaiting';
    }

    function stateLabel(proposal) {
      const roadmapState = lifecycleState(proposal) || 'UNKNOWN';
      const status = approvalStatus(proposal);
      if (roadmapState === 'PROPOSED') return 'PROPOSED - awaiting human approval';
      if ((roadmapState === 'ACTIVE' || roadmapState === 'APPROVED') && status === 'APPROVED') return 'ACTIVE / APPROVED';
      if (roadmapState === 'COMPLETED') return 'COMPLETED';
      if (roadmapState === 'BLOCKED') return 'BLOCKED';
      if (roadmapState === 'CANCELLED' || roadmapState === 'CANCELED') return 'CANCELLED';
      return roadmapState + (status ? ' / ' + status : '');
    }

    function approvalLabel(proposal) {
      const status = approvalStatus(proposal);
      if (status === 'APPROVED') return 'APPROVED';
      if (status === 'PENDING' || status === 'AWAITING_APPROVAL') return 'Awaiting explicit approval';
      return status || 'Not recorded';
    }

    function renderNotice(proposal) {
      if (isProposed(proposal)) {
        return '<div class="notice"><strong>Awaiting explicit human approval.</strong> No Autopilot execution has started from this proposal. Review the persisted roadmap before approving.</div>';
      }
      if (isRevisionPending(proposal)) {
        return '<div class="notice"><strong>Changes requested.</strong> W01 is revising the roadmap based on the persisted human feedback. Approval and Start Autopilot are unavailable until a revised proposal is ready.</div>';
      }
      if (isApproved(proposal)) {
        return '<div class="notice"><strong>Roadmap approval is persisted.</strong> Start Autopilot remains a separate action.</div>';
      }
      if (isTerminal(proposal)) {
        return '<div class="notice terminal"><strong>This roadmap is ' + escapeHtml(stateLabel(proposal)) + '.</strong> It is not presented as ordinary executable approved work.</div>';
      }
      return '<div class="notice"><strong>Roadmap state is ' + escapeHtml(stateLabel(proposal)) + '.</strong> The UI is not inferring execution readiness from incomplete lifecycle data.</div>';
    }

    function renderOriginalRequest(proposal) {
      const originalRequest = text(proposal.original_request || proposal.provenance?.original_request).trim();
      const source = text(proposal.provenance?.source || proposal.proposal_type).trim();
      if (!originalRequest && !source) return '';
      return '<div class="info-grid"><div><span class="label">Original Planner request</span><p>' + escapeHtml(originalRequest || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Proposal source</span><p>' + escapeHtml(source || 'Not recorded') + '</p></div>' +
        '<div><span class="label">Planner context</span><p>' + escapeHtml(text(proposal.workspace_id || 'Workspace not recorded')) + ' / ' + escapeHtml(text(proposal.project_id || 'Project not recorded')) + '</p></div></div>';
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
      const canStart = approved && !isTerminal(proposal);
      els.approve.classList.toggle('hidden', !canApprove);
      els.requestChanges.classList.toggle('hidden', !canRequestChanges);
      els.start.classList.toggle('hidden', !canStart);
      if (!canRequestChanges || isRevisionPending(proposal)) hideRevisionForm();
      const milestones = proposal.milestones.map((milestone, index) => ({ milestone, index }));
      milestones.sort((a, b) => {
        const aHasOrder = Number.isFinite(Number(a.milestone.order));
        const bHasOrder = Number.isFinite(Number(b.milestone.order));
        if (aHasOrder && bHasOrder) return Number(a.milestone.order) - Number(b.milestone.order);
        if (aHasOrder) return -1;
        if (bHasOrder) return 1;
        return a.index - b.index;
      });
      els.proposalView.classList.remove('hidden');
      els.proposalView.innerHTML = '<div class="proposal-head"><div><span class="label">ROADMAP PROPOSAL</span><h2>' + escapeHtml(proposal.title) + '</h2></div><span class="badge ' + stateClass(proposal) + '">' + escapeHtml(stateLabel(proposal)) + '</span></div>' +
        renderNotice(proposal) +
        '<div class="info-grid"><div><span class="label">Lifecycle state</span><p>' + escapeHtml(lifecycleState(proposal)) + '</p></div><div><span class="label">Approval status</span><p>' + escapeHtml(approvalLabel(proposal)) + '</p></div><div><span class="label">Roadmap ID</span><p>' + escapeHtml(state.proposalId || 'Not recorded') + '</p></div></div>' +
        renderRevisionContext(proposal) +
        '<p><strong>Objective:</strong> ' + escapeHtml(proposal.objective) + '</p>' +
        '<p><strong>Summary:</strong> ' + escapeHtml(proposal.summary) + '</p>' +
        '<div class="info-grid"><div><span class="label">Risks</span>' + list(proposal.risks, 'None recorded') + '</div><div><span class="label">Dependencies</span>' + list(proposal.dependencies, 'No dependencies') + '</div><div><span class="label">Assumptions</span>' + list(proposal.assumptions, 'None recorded') + '</div></div>' +
        renderOriginalRequest(proposal) +
        '<h2>Milestones</h2><div class="milestones">' + milestones.map((item) => renderMilestone(item.milestone, item.index)).join('') + '</div>';
      if (proposed && !approved) setStatus('Proposal is PROPOSED and waiting for explicit human approval.', '');
      else if (isRevisionPending(proposal)) setStatus('Changes requested. W01 is revising the roadmap based on persisted feedback.', 'success');
      else if (approved) setStatus('Roadmap approval is persisted. Start Autopilot is now available.', 'success');
      else setStatus('Roadmap is ' + text(proposal.state || 'not startable') + '.', '');
    }

    function renderMilestone(milestone, index) {
      const executorLabel = milestone.executor_required ? 'Executor required' : 'Brain only';
      const executorClass = milestone.executor_required ? 'executor' : 'brain';
      const blocked = ['BLOCKED', 'WAITING', 'PENDING'].includes(text(milestone.state).toUpperCase()) && Array.isArray(milestone.dependencies) && milestone.dependencies.length > 0;
      return '<article class="milestone"><div class="milestone-top"><div><h3>' + escapeHtml(milestone.order || index + 1) + '. ' + escapeHtml(milestone.title) + '</h3><div class="meta">Milestone ID: ' + escapeHtml(milestone.id) + (blocked ? ' - waiting on dependencies' : '') + '</div></div><span class="badge">' + escapeHtml(milestone.state || 'PROPOSED') + '</span></div>' +
        '<div class="kv"><div><span class="label">Objective / expected outcome</span><p>' + escapeHtml(milestone.objective || milestone.expected_outcome) + '</p></div>' +
        '<div><span class="label">Description</span><p>' + escapeHtml(milestone.description) + '</p></div>' +
        '<div><span class="label">Executor requirement</span><p><span class="badge ' + executorClass + '">' + escapeHtml(executorLabel) + '</span></p></div>' +
        '<div><span class="label">Dependencies</span>' + list(milestone.dependencies || milestone.depends_on, 'No dependencies') + '</div>' +
        '<div><span class="label">Risks</span>' + list(milestone.risks, 'None recorded') + '</div>' +
        '<div><span class="label">Success criteria</span>' + list(milestone.success_criteria, 'None recorded') + '</div>' +
        '<div><span class="label">Persisted lifecycle state</span><p>' + escapeHtml(milestone.state || 'PROPOSED') + '</p></div></div></article>';
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
          setStatus('Planning is still pending. No proposal ID is available yet; refresh after the Brain proposal completes.', '');
          return;
        }
        const proposal = await fetch('/api/planner/proposals/' + encodeURIComponent(proposalId)).then(parseResponse);
        renderProposal(proposal);
      } catch (error) {
        setStatus('Proposal retrieval failed: ' + error.message, 'error');
      }
    }

    els.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.submitting) return;
      if (!canSubmit()) {
        setStatus('Workspace, project, and request are required before submission.', 'error');
        return;
      }
      state.submitting = true;
      syncSubmitState();
      setStatus('Submitting Planner request. W01 roadmap proposal generation will begin after intake is accepted.', '');
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
          setStatus('Planning: Planner request accepted' + (state.requestId ? ': ' + text(state.requestId) : '') + '. Waiting for W01 roadmap proposal generation. W01 is preparing the roadmap proposal. Refresh proposal after planning completes.', 'success');
        }
      } catch (error) {
        setStatus('Planner request failed: ' + error.message, 'error');
      } finally {
        state.submitting = false;
        syncSubmitState();
      }
    });

    els.refresh.addEventListener('click', loadProposal);
    els.requestChanges.addEventListener('click', () => {
      if (!isProposed(state.proposal) || !isReviewComplete(state.proposal)) {
        setStatus('Request Changes unavailable: roadmap must be a complete PROPOSED proposal awaiting approval.', 'error');
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
        setStatus('Request Changes failed: feedback is required before W01 can revise the roadmap.', 'error');
        syncRevisionSubmitState();
        return;
      }
      if (state.revisionSubmitting) return;
      state.revisionSubmitting = true;
      syncRevisionSubmitState();
      setStatus('Sending revision request to W01.', '');
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
        setStatus('Changes requested. W01 is revising the roadmap based on persisted feedback.', 'success');
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
        setStatus('Approval saved. Reloading persisted roadmap state.', 'success');
        await loadProposal();
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
        els.startView.classList.remove('hidden');
        els.startView.innerHTML = '<div class="status success"><strong>' + (started.no_new_work || started.reused ? 'Existing Autopilot work reused.' : 'Autopilot started.') + '</strong><br>' +
          'Current milestone: ' + escapeHtml(current.id || started.milestone_id || '') + ' ' + escapeHtml(current.title || '') + ' (' + escapeHtml(current.state || started.state || '') + ')<br>' +
          'Mission: ' + escapeHtml(started.mission_id || '') + '<br>Brain Run: ' + escapeHtml(started.brain_run_id || '') + '</div>';
        await loadProposal();
      } catch (error) {
        setStatus('Start failed: ' + error.message, 'error');
      }
    });

    els.reset.addEventListener('click', () => {
      state.requestId = null; state.missionId = null; state.brainRunId = null; state.proposalId = null; state.proposal = null; state.submitting = false; state.revisionSubmitting = false;
      clearPersistedPlannerState();
      els.form.reset();
      restoreRememberedContext();
      els.revisionFeedback.value = '';
      els.proposalId.value = '';
      els.proposalView.classList.add('hidden');
      els.startView.classList.add('hidden');
      els.requestChangesView.classList.add('hidden');
      els.approve.classList.add('hidden');
      els.requestChanges.classList.add('hidden');
      els.start.classList.add('hidden');
      setStatus('Enter workspace, project, and request text to begin.', '');
      syncSubmitState();
    });

    ['input', 'change'].forEach((name) => {
      els.workspace.addEventListener(name, syncSubmitState);
      els.project.addEventListener(name, syncSubmitState);
      els.request.addEventListener(name, syncSubmitState);
    });
    const restoredPlanner = restorePlannerState();
    if (!restoredPlanner) restoreRememberedContext();
    syncSubmitState();
    if (restoredPlanner) {
      setStatus('Restored active Planner request. Checking for the latest roadmap proposal...', 'success');
      loadProposal();
    }
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
