const fs = require('fs');

function save(file, before, after) {
  if (before !== after) fs.writeFileSync(file, after, 'utf8');
}

function mustReplace(file, source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  return source.replace(oldText, newText);
}

// 1) Planner service: completed historical milestones must NOT block Resume Autopilot.
// Only active/recoverable work is reused. If everything started so far is COMPLETE,
// fall through to canonical startNextRoadmapMilestone().
{
  const file = 'src/services/planner.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_AUTOPILOT_V1')) {
    const oldText = `  if (startedMilestones.length > 0) {
    const activeStates = new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'NEED_HUMAN_ACTION', 'BLOCKED', 'FAILED', 'RETRYABLE', 'WAITING_HUMAN']);
    const milestone = startedMilestones.find((item) => activeStates.has(String(item.state || '').trim().toUpperCase())) || startedMilestones[0];
`;
    const newText = `  // UNIFIED_START_RESUME_AUTOPILOT_V1
  // Reuse only genuinely active/recoverable work. Completed historical milestones
  // must not prevent the same canonical Autopilot authority from starting the next
  // eligible milestone when a human explicitly presses Start/Resume Autopilot.
  const activeStates = new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'NEED_HUMAN_ACTION', 'BLOCKED', 'FAILED', 'RETRYABLE', 'WAITING_HUMAN']);
  const activeMilestone = startedMilestones.find((item) =>
    activeStates.has(String(item.state || '').trim().toUpperCase())
  );
  if (activeMilestone) {
    const milestone = activeMilestone;
`;
    s = mustReplace(file, s, oldText, newText, 'planner active milestone guard');
  }
  save(file, before, s);
}

// 2) Roadmaps API: expose ONE canonical human Start/Resume endpoint.
// It delegates to the same startPlannerRoadmap service used by Planner.
// It never accepts a milestone id and therefore cannot become a manual selector.
{
  const file = 'src/routes/roadmaps.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_AUTOPILOT_ENDPOINT_V1')) {
    const importAnchor = `const { resolveRoadmapRuntime } = require('../services/milestoneRuntime');
`;
    const importReplacement = importAnchor +
`const { startPlannerRoadmap } = require('../services/planner');
const { assertProjectRuntimeReady } = require('../services/projectRuntime');
`;
    s = mustReplace(file, s, importAnchor, importReplacement, 'roadmaps imports');

    const advanceAnchor = `  router.post('/:roadmapId/advance', async (req, res, next) => {
`;
    const endpoint = `  // UNIFIED_AUTOPILOT_ENDPOINT_V1
  // Shared human control surface for both Planner and Roadmap UI.
  // No milestone selection is accepted here; canonical Autopilot derives the next
  // action exclusively from trusted persisted Roadmap/Mission state.
  router.post('/:roadmapId/autopilot', async (req, res, next) => {
    try {
      const body = req.body || {};
      const forbidden = ['milestone_id', 'milestoneId', 'next_milestone_id', 'nextMilestoneId']
        .find((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (forbidden) {
        return res.status(400).json({ error: 'AUTOPILOT_MILESTONE_SELECTION_FORBIDDEN' });
      }

      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }

      await assertProjectRuntimeReady(
        db,
        req.tenantId,
        roadmap.project_id,
        roadmap.workspace_id || null
      );

      const started = await startPlannerRoadmap(
        db,
        req.tenantId,
        req.params.roadmapId,
        { max_attempts: body.max_attempts || 3 }
      );

      const current = await repos.roadmaps.getById(req.params.roadmapId);
      res.status(started.no_new_work ? 200 : 201).json(serializeFirestore({
        ok: true,
        roadmap_id: req.params.roadmapId,
        state: current?.state || started.roadmap?.state || null,
        milestone_id: started.milestone?.id || null,
        mission_id: started.mission?.id || null,
        brain_run_id: started.brain_run?.id || null,
        reused: started.reused === true,
        no_new_work: started.no_new_work === true,
        already_complete: started.already_complete === true
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

`;
    if (!s.includes(advanceAnchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:roadmaps advance anchor');
    s = s.replace(advanceAnchor, endpoint + advanceAnchor);
  }
  save(file, before, s);
}

// 3) Planner UI: show Start/Resume whenever approved, non-terminal,
// no active/recoverable milestone exists, and pending work remains.
// Both Planner and Roadmap use /api/roadmaps/:id/autopilot.
{
  const file = 'src/routes/planner.ui.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_PLANNER_UI_V1')) {
    const oldLogic = `      const autopilotStarted = hasStartedMilestone(proposal);
      const canStart = approved && !isTerminal(proposal) && !isRunning(proposal) && !autopilotStarted;
      els.approve.classList.toggle('hidden', !canApprove);
      els.requestChanges.classList.toggle('hidden', !canRequestChanges);
      els.start.classList.toggle('hidden', !canStart);
`;
    const newLogic = `      const autopilotStarted = hasStartedMilestone(proposal);
      // UNIFIED_START_RESUME_PLANNER_UI_V1
      const activeAutopilotStates = new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'BLOCKED', 'FAILED', 'RETRYABLE', 'WAITING_HUMAN', 'NEED_HUMAN_ACTION']);
      const pendingAutopilotStates = new Set(['PENDING', 'PROPOSED', 'READY']);
      const proposalMilestones = Array.isArray(proposal.milestones) ? proposal.milestones : [];
      const hasActiveAutopilotWork = proposalMilestones.some((milestone) =>
        activeAutopilotStates.has(text(milestone?.state).trim().toUpperCase())
      );
      const hasPendingAutopilotWork = proposalMilestones.some((milestone) =>
        pendingAutopilotStates.has(text(milestone?.state).trim().toUpperCase())
      );
      const canStart = approved && !isTerminal(proposal) && !hasActiveAutopilotWork && hasPendingAutopilotWork;
      els.approve.classList.toggle('hidden', !canApprove);
      els.requestChanges.classList.toggle('hidden', !canRequestChanges);
      els.start.classList.toggle('hidden', !canStart);
      els.start.textContent = autopilotStarted ? 'Resume Autopilot' : 'Start Autopilot';
`;
    s = mustReplace(file, s, oldLogic, newLogic, 'planner button visibility');

    // Replace Planner-specific start endpoint with shared endpoint.
    const endpointRegex = /\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/start/g;
    if (!endpointRegex.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner start endpoint');
    s = s.replace(endpointRegex, "/api/roadmaps/' + encodeURIComponent(proposalId) + '/autopilot");
  }
  save(file, before, s);
}

// 4) Roadmap UI: same button semantics and same backend endpoint.
// Hide while active/recoverable work exists; show Start or Resume when safe.
{
  const file = 'src/public/roadmap-page.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_ROADMAP_UI_V1')) {
    const autoLine = `  $('#autoAdvance').checked = Boolean(item.auto_advance);
`;
    const replacement = autoLine + `  // UNIFIED_START_RESUME_ROADMAP_UI_V1
  const lifecycleStates = new Set(['PLANNING','RUNNING','VERIFYING','BLOCKED','FAILED','RETRYABLE','WAITING_HUMAN','NEED_HUMAN_ACTION']);
  const pendingStates = new Set(['PENDING','PROPOSED','READY']);
  const milestones = item.milestones || [];
  const hasActiveWork = milestones.some((m) => lifecycleStates.has(String(m.state || '').trim().toUpperCase()));
  const hasPendingWork = milestones.some((m) => pendingStates.has(String(m.state || '').trim().toUpperCase()));
  const hasStartedWork = milestones.some((m) => Boolean(m.mission_id) || ['COMPLETED','COMPLETE','DONE'].includes(String(m.state || '').trim().toUpperCase()));
  const terminal = ['COMPLETED','COMPLETE','CANCELLED','CANCELED'].includes(String(item.state || '').trim().toUpperCase());
  const autopilotButton = $('#startNextMilestoneButton');
  autopilotButton.hidden = terminal || hasActiveWork || !hasPendingWork;
  autopilotButton.textContent = hasStartedWork ? 'RESUME AUTOPILOT' : 'START AUTOPILOT';
`;
    s = mustReplace(file, s, autoLine, replacement, 'roadmap edit button state');

    const oldHandlerText = `  $('#roadmapMessage').textContent = 'Starting next milestone…';
  try {
    const started = await api(\`/api/roadmaps/\${encodeURIComponent(id)}/advance\`, {
      method: 'POST',
      body: JSON.stringify({ max_attempts: 3 })
    });
    $('#roadmapMessage').textContent = \`Autopilot started. Mission \${started.mission_id} · Brain Run \${started.brain_run_id}\`;
`;
    const newHandlerText = `  $('#roadmapMessage').textContent = 'Starting/resuming Autopilot…';
  try {
    const started = await api(\`/api/roadmaps/\${encodeURIComponent(id)}/autopilot\`, {
      method: 'POST',
      body: JSON.stringify({ max_attempts: 3 })
    });
    $('#roadmapMessage').textContent = started.no_new_work
      ? 'Autopilot already has active/recoverable work. No duplicate work created.'
      : \`Autopilot started/resumed. Mission \${started.mission_id} · Brain Run \${started.brain_run_id}\`;
`;
    s = mustReplace(file, s, oldHandlerText, newHandlerText, 'roadmap button handler');
  }
  save(file, before, s);
}

// 5) Roadmap HTML label.
{
  const file = 'src/public/roadmap.html';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  if (!s.includes('START / RESUME AUTOPILOT')) {
    s = mustReplace(
      file,
      s,
      'id="startNextMilestoneButton">START NEXT MILESTONE</button>',
      'id="startNextMilestoneButton">START / RESUME AUTOPILOT</button>',
      'roadmap html button label'
    );
  }
  save(file, before, s);
}

// Verification assertions
{
  const planner = fs.readFileSync('src/services/planner.js', 'utf8');
  const plannerUi = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  const roadmaps = fs.readFileSync('src/routes/roadmaps.routes.js', 'utf8');
  const roadmapUi = fs.readFileSync('src/public/roadmap-page.js', 'utf8');
  const roadmapHtml = fs.readFileSync('src/public/roadmap.html', 'utf8');

  if (!planner.includes('UNIFIED_START_RESUME_AUTOPILOT_V1')) throw new Error('VERIFY_FAILED:planner service');
  if (!roadmaps.includes("router.post('/:roadmapId/autopilot'")) throw new Error('VERIFY_FAILED:shared endpoint');
  if (!plannerUi.includes("'/api/roadmaps/' + encodeURIComponent(proposalId) + '/autopilot'")) throw new Error('VERIFY_FAILED:planner shared endpoint');
  if (!roadmapUi.includes('/autopilot`')) throw new Error('VERIFY_FAILED:roadmap shared endpoint');
  if (roadmapUi.includes('/advance`')) throw new Error('VERIFY_FAILED:legacy roadmap advance still used by UI');
  if (!roadmapHtml.includes('START / RESUME AUTOPILOT')) throw new Error('VERIFY_FAILED:roadmap label');
}

console.log('UNIFIED_START_RESUME_AUTOPILOT_V1_OK');
