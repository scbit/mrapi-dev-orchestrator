const fs = require('fs');

function save(file, before, after) {
  if (before !== after) fs.writeFileSync(file, after, 'utf8');
}

function ensure(file, condition, message) {
  if (!condition) throw new Error(`VERIFY_FAILED:${message}:${file}`);
}

// -----------------------------------------------------------------------------
// 1) src/services/planner.js
// V1 may already be applied. If not, patch structurally.
// -----------------------------------------------------------------------------
{
  const file = 'src/services/planner.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_AUTOPILOT_V1')) {
    const re = /  if \(startedMilestones\.length > 0\) \{\r?\n\s*const activeStates = new Set\(\[[^\n]+\]\);\r?\n\s*const milestone = startedMilestones\.find\([\s\S]*?\) \|\| startedMilestones\[0\];/;
    const m = s.match(re);
    if (!m) throw new Error('PATCH_PATTERN_NOT_FOUND:planner active milestone guard');

    const replacement = `  // UNIFIED_START_RESUME_AUTOPILOT_V1
  // Reuse only genuinely active/recoverable work. Completed historical milestones
  // must not prevent Start/Resume from continuing with the next eligible milestone.
  const activeStates = new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'NEED_HUMAN_ACTION', 'BLOCKED', 'FAILED', 'RETRYABLE', 'WAITING_HUMAN']);
  const activeMilestone = startedMilestones.find((item) =>
    activeStates.has(String(item.state || '').trim().toUpperCase())
  );
  if (activeMilestone) {
    const milestone = activeMilestone;`;

    s = s.replace(re, replacement);
  }

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 2) src/routes/roadmaps.routes.js
// Ensure shared /autopilot endpoint exists exactly once.
// -----------------------------------------------------------------------------
{
  const file = 'src/routes/roadmaps.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes("const { startPlannerRoadmap } = require('../services/planner');")) {
    const anchor = "const { resolveRoadmapRuntime } = require('../services/milestoneRuntime');";
    if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:roadmaps import anchor');
    s = s.replace(
      anchor,
      anchor + "\nconst { startPlannerRoadmap } = require('../services/planner');\nconst { assertProjectRuntimeReady } = require('../services/projectRuntime');"
    );
  }

  if (!s.includes("router.post('/:roadmapId/autopilot'")) {
    const anchor = "  router.post('/:roadmapId/advance', async (req, res, next) => {";
    if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:roadmaps advance anchor');

    const endpoint = `  // UNIFIED_AUTOPILOT_ENDPOINT_V2
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
    s = s.replace(anchor, endpoint + anchor);
  }

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 3) src/routes/planner.ui.routes.js
// V1 may already have changed visibility and endpoint. Finish safely if needed.
// -----------------------------------------------------------------------------
{
  const file = 'src/routes/planner.ui.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_PLANNER_UI_V1')) {
    const oldBlock = /      const autopilotStarted = hasStartedMilestone\(proposal\);\r?\n\s*const canStart = approved && !isTerminal\(proposal\) && !isRunning\(proposal\) && !autopilotStarted;\r?\n\s*els\.approve\.classList\.toggle\('hidden', !canApprove\);\r?\n\s*els\.requestChanges\.classList\.toggle\('hidden', !canRequestChanges\);\r?\n\s*els\.start\.classList\.toggle\('hidden', !canStart\);/;
    if (!oldBlock.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner start visibility');

    const replacement = `      const autopilotStarted = hasStartedMilestone(proposal);
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
      els.start.textContent = autopilotStarted ? 'Resume Autopilot' : 'Start Autopilot';`;
    s = s.replace(oldBlock, replacement);
  }

  // Replace any remaining old Planner start endpoint.
  s = s.replace(
    /'\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/start'/g,
    "'/api/roadmaps/' + encodeURIComponent(proposalId) + '/autopilot'"
  );

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 4) src/public/roadmap-page.js
// Robust structural patch. This is where V1 failed locally.
// -----------------------------------------------------------------------------
{
  const file = 'src/public/roadmap-page.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('UNIFIED_START_RESUME_ROADMAP_UI_V2')) {
    const autoRe = /(\s*\$\('#autoAdvance'\)\.checked\s*=\s*Boolean\(item\.auto_advance\);\r?\n)/;
    if (!autoRe.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:roadmap autoAdvance assignment');

    const extra = `$1  // UNIFIED_START_RESUME_ROADMAP_UI_V2
  const autopilotActiveStates = new Set(['PLANNING','RUNNING','VERIFYING','BLOCKED','FAILED','RETRYABLE','WAITING_HUMAN','NEED_HUMAN_ACTION']);
  const autopilotPendingStates = new Set(['PENDING','PROPOSED','READY']);
  const autopilotMilestones = item.milestones || [];
  const hasActiveAutopilotWork = autopilotMilestones.some((m) =>
    autopilotActiveStates.has(String(m.state || '').trim().toUpperCase())
  );
  const hasPendingAutopilotWork = autopilotMilestones.some((m) =>
    autopilotPendingStates.has(String(m.state || '').trim().toUpperCase())
  );
  const hasStartedAutopilotWork = autopilotMilestones.some((m) =>
    Boolean(m.mission_id) ||
    ['COMPLETED','COMPLETE','DONE'].includes(String(m.state || '').trim().toUpperCase())
  );
  const roadmapTerminal = ['COMPLETED','COMPLETE','CANCELLED','CANCELED']
    .includes(String(item.state || '').trim().toUpperCase());
  const autopilotButton = $('#startNextMilestoneButton');
  autopilotButton.hidden = roadmapTerminal || hasActiveAutopilotWork || !hasPendingAutopilotWork;
  autopilotButton.textContent = hasStartedAutopilotWork ? 'RESUME AUTOPILOT' : 'START AUTOPILOT';
`;
    s = s.replace(autoRe, extra);
  }

  // Replace handler endpoint and messages even if formatting differs.
  s = s.replace(/Starting next milestone…/g, 'Starting/resuming Autopilot…');
  s = s.replace(
    /`\/api\/roadmaps\/\$\{encodeURIComponent\(id\)\}\/advance`/g,
    '`/api/roadmaps/${encodeURIComponent(id)}/autopilot`'
  );
  s = s.replace(
    /Autopilot started\. Mission \$\{started\.mission_id\} · Brain Run \$\{started\.brain_run_id\}/g,
    'Autopilot started/resumed. Mission ${started.mission_id} · Brain Run ${started.brain_run_id}'
  );

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 5) src/public/roadmap.html
// -----------------------------------------------------------------------------
{
  const file = 'src/public/roadmap.html';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  s = s.replace(
    /id="startNextMilestoneButton">(?:START NEXT MILESTONE|START \/ RESUME AUTOPILOT|START AUTOPILOT|RESUME AUTOPILOT)<\/button>/,
    'id="startNextMilestoneButton">START / RESUME AUTOPILOT</button>'
  );

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// Final verification
// -----------------------------------------------------------------------------
{
  const planner = fs.readFileSync('src/services/planner.js', 'utf8');
  const plannerUi = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');
  const roadmaps = fs.readFileSync('src/routes/roadmaps.routes.js', 'utf8');
  const roadmapUi = fs.readFileSync('src/public/roadmap-page.js', 'utf8');
  const roadmapHtml = fs.readFileSync('src/public/roadmap.html', 'utf8');

  ensure('planner.js', planner.includes('UNIFIED_START_RESUME_AUTOPILOT_V1'), 'planner resume guard missing');
  ensure('roadmaps.routes.js', roadmaps.includes("router.post('/:roadmapId/autopilot'"), 'shared autopilot endpoint missing');
  ensure('roadmaps.routes.js', roadmaps.includes('AUTOPILOT_MILESTONE_SELECTION_FORBIDDEN'), 'manual milestone selection guard missing');
  ensure('planner.ui.routes.js', plannerUi.includes("'/api/roadmaps/' + encodeURIComponent(proposalId) + '/autopilot'"), 'planner not using shared endpoint');
  ensure('planner.ui.routes.js', plannerUi.includes("'Resume Autopilot'"), 'planner resume button missing');
  ensure('roadmap-page.js', roadmapUi.includes('UNIFIED_START_RESUME_ROADMAP_UI_V2'), 'roadmap button state logic missing');
  ensure('roadmap-page.js', roadmapUi.includes('/autopilot`'), 'roadmap not using shared endpoint');
  ensure('roadmap-page.js', !roadmapUi.includes('/advance`'), 'roadmap UI still calls legacy advance');
  ensure('roadmap.html', roadmapHtml.includes('START / RESUME AUTOPILOT'), 'roadmap label missing');
}

console.log('UNIFIED_START_RESUME_AUTOPILOT_V2_OK');
