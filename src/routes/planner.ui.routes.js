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
    .primary,.secondary { border-radius:9px; padding:10px 14px; font-weight:800; }
    .primary { border:1px solid rgba(106,167,255,.55); background:#dceaff; color:#07101d; }
    .secondary { border:1px solid var(--line); background:rgba(255,255,255,.03); color:var(--text); }
    button:disabled { opacity:.48; cursor:not-allowed; transform:none; }
    .status { margin:0 0 14px; padding:12px 13px; border:1px solid var(--line); border-radius:12px; background:rgba(255,255,255,.025); color:var(--muted); }
    .status strong { color:var(--text); }
    .status.error { border-color:rgba(255,107,114,.35); color:#ffb9bd; }
    .status.success { border-color:rgba(72,213,151,.3); color:#baf5d8; }
    .badge { display:inline-flex; align-items:center; min-height:24px; padding:4px 8px; border-radius:999px; border:1px solid var(--line); color:#dceaff; font-size:11px; font-weight:900; letter-spacing:.06em; text-transform:uppercase; }
    .badge.awaiting { color:#ffd38d; border-color:rgba(243,189,97,.26); background:rgba(243,189,97,.08); }
    .badge.active { color:#93efc4; border-color:rgba(72,213,151,.22); background:rgba(72,213,151,.08); }
    .proposal-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .proposal-head h2 { margin:3px 0 0; }
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
          <button class="primary hidden" id="startAutopilot" type="button">Start Autopilot</button>
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
      submitting: false
    };

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

    function list(items) {
      const values = Array.isArray(items) ? items.filter((item) => text(item).trim()) : [];
      if (!values.length) return '<span class="small">None recorded</span>';
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

    function isApproved(proposal) {
      const roadmapState = text(proposal?.state).toUpperCase();
      const approvalStatus = text(proposal?.approval_status).toUpperCase();
      return roadmapState === 'ACTIVE' || roadmapState === 'APPROVED' || approvalStatus === 'APPROVED';
    }

    function isProposed(proposal) {
      const roadmapState = text(proposal?.state).toUpperCase();
      const approvalStatus = text(proposal?.approval_status).toUpperCase();
      return roadmapState === 'PROPOSED' || approvalStatus === 'PENDING';
    }

    function renderProposal(proposal) {
      state.proposal = proposal;
      state.proposalId = proposal.roadmap_id || proposal.proposal_id || proposal.id || state.proposalId;
      if (state.proposalId) els.proposalId.value = state.proposalId;
      const approved = isApproved(proposal);
      const proposed = isProposed(proposal);
      els.approve.classList.toggle('hidden', !(proposed && !approved));
      els.start.classList.toggle('hidden', !approved);
      const stateClass = approved ? 'active' : 'awaiting';
      const statusText = proposed && !approved ? 'PROPOSED - awaiting human approval' : text(proposal.state || proposal.approval_status || 'UNKNOWN');
      const milestones = Array.isArray(proposal.milestones) ? [...proposal.milestones] : [];
      milestones.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      els.proposalView.classList.remove('hidden');
      els.proposalView.innerHTML = '<div class="proposal-head"><div><span class="label">ROADMAP PROPOSAL</span><h2>' + escapeHtml(proposal.title) + '</h2></div><span class="badge ' + stateClass + '">' + escapeHtml(statusText) + '</span></div>' +
        '<p><strong>Objective:</strong> ' + escapeHtml(proposal.objective) + '</p>' +
        '<p><strong>Summary:</strong> ' + escapeHtml(proposal.summary) + '</p>' +
        '<div class="info-grid"><div><span class="label">Risks</span>' + list(proposal.risks) + '</div><div><span class="label">Dependencies</span>' + list(proposal.dependencies) + '</div><div><span class="label">Assumptions</span>' + list(proposal.assumptions) + '</div></div>' +
        '<h2>Milestones</h2><div class="milestones">' + milestones.map(renderMilestone).join('') + '</div>';
      if (proposed && !approved) setStatus('Proposal is PROPOSED and waiting for explicit human approval.', '');
      else if (approved) setStatus('Roadmap approval is persisted. Start Autopilot is now available.', 'success');
      else setStatus('Roadmap is ' + text(proposal.state || 'not startable') + '.', '');
    }

    function renderMilestone(milestone) {
      const executorLabel = milestone.executor_required ? 'Executor-required' : 'Brain-only';
      const blocked = ['BLOCKED', 'WAITING', 'PENDING'].includes(text(milestone.state).toUpperCase()) && Array.isArray(milestone.dependencies) && milestone.dependencies.length > 0;
      return '<article class="milestone"><div class="milestone-top"><div><h3>' + escapeHtml(milestone.order || milestone.id) + '. ' + escapeHtml(milestone.title) + '</h3><div class="meta">' + escapeHtml(executorLabel) + (blocked ? ' - waiting on dependencies' : '') + '</div></div><span class="badge">' + escapeHtml(milestone.state || 'PROPOSED') + '</span></div>' +
        '<div class="kv"><div><span class="label">Objective / expected outcome</span><p>' + escapeHtml(milestone.objective || milestone.expected_outcome) + '</p></div>' +
        '<div><span class="label">Description</span><p>' + escapeHtml(milestone.description) + '</p></div>' +
        '<div><span class="label">Dependencies</span>' + list(milestone.dependencies || milestone.depends_on) + '</div>' +
        '<div><span class="label">Risks</span>' + list(milestone.risks) + '</div>' +
        '<div><span class="label">Success criteria</span>' + list(milestone.success_criteria) + '</div>' +
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
        state.requestId = created.planner_request_id || created.request_id || created.mission_id || null;
        state.missionId = created.mission_id || state.requestId;
        state.brainRunId = created.brain_run_id || null;
        state.proposalId = created.roadmap_id || created.proposal_id || created.planner_roadmap_id || null;
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
      state.requestId = null; state.missionId = null; state.brainRunId = null; state.proposalId = null; state.proposal = null; state.submitting = false;
      els.form.reset();
      els.proposalId.value = '';
      els.proposalView.classList.add('hidden');
      els.startView.classList.add('hidden');
      els.approve.classList.add('hidden');
      els.start.classList.add('hidden');
      setStatus('Enter workspace, project, and request text to begin.', '');
      syncSubmitState();
    });

    ['input', 'change'].forEach((name) => {
      els.workspace.addEventListener(name, syncSubmitState);
      els.project.addEventListener(name, syncSubmitState);
      els.request.addEventListener(name, syncSubmitState);
    });
    syncSubmitState();
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
