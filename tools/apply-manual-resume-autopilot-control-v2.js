const fs = require('fs');

function must(condition, message) {
  if (!condition) throw new Error(message);
}

// -------- Planner --------
{
  const file = 'src/routes/planner.ui.routes.js';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('MANUAL_RESUME_AUTOPILOT_CONTROL_V2')) {
    // Remove V1 partial marker if a previous attempt somehow wrote it.
    s = s.replace(/\n\s*\/\/ MANUAL_RESUME_AUTOPILOT_CONTROL_V1[\s\S]*?const canStart = approved && !isTerminal\(proposal\) && hasUnfinishedAutopilotWork;\n/g, '\n');

    const toggleRegex = /^(\s*)els\.start\.classList\.toggle\('hidden',\s*[^;]+;\s*$/m;
    const toggleMatch = s.match(toggleRegex);

    if (toggleMatch) {
      const indent = toggleMatch[1];
      const replacement =
`${indent}// MANUAL_RESUME_AUTOPILOT_CONTROL_V2
${indent}// Human safety valve only. It never selects or advances a milestone.
${indent}// The trusted /autopilot backend remains lifecycle authority.
${indent}const manualAutopilotMilestones = Array.isArray(proposal?.milestones) ? proposal.milestones : [];
${indent}const manualAutopilotHasUnfinished = manualAutopilotMilestones.some((milestone) =>
${indent}  !['COMPLETED', 'COMPLETE', 'DONE'].includes(text(milestone?.state).trim().toUpperCase())
${indent});
${indent}const manualAutopilotApproved = isApproved(proposal);
${indent}const manualAutopilotAvailable = manualAutopilotApproved && !isTerminal(proposal) && manualAutopilotHasUnfinished;
${indent}els.start.classList.toggle('hidden', !manualAutopilotAvailable);`;

      s = s.replace(toggleRegex, replacement);
    } else {
      // Fallback for refactored Planner: insert immediately after proposal render state
      // calculations and before proposal HTML is written.
      const anchorRegex = /^(\s*)els\.proposalView\.classList\.remove\('hidden'\);\s*$/m;
      const m = s.match(anchorRegex);
      must(m, 'PATCH_PATTERN_NOT_FOUND:planner start/toggle and proposalView anchor');

      const indent = m[1];
      const block =
`${indent}// MANUAL_RESUME_AUTOPILOT_CONTROL_V2
${indent}const manualAutopilotMilestones = Array.isArray(proposal?.milestones) ? proposal.milestones : [];
${indent}const manualAutopilotHasUnfinished = manualAutopilotMilestones.some((milestone) =>
${indent}  !['COMPLETED', 'COMPLETE', 'DONE'].includes(text(milestone?.state).trim().toUpperCase())
${indent});
${indent}const manualAutopilotAvailable = isApproved(proposal) && !isTerminal(proposal) && manualAutopilotHasUnfinished;
${indent}if (els.start) {
${indent}  els.start.classList.toggle('hidden', !manualAutopilotAvailable);
${indent}  els.start.textContent = hasStartedMilestone(proposal) ? 'Resume Autopilot' : 'Start Autopilot';
${indent}}
`;
      s = s.replace(anchorRegex, m[0] + '\n' + block);
    }

    // Ensure label is human/manual if a label assignment already exists.
    if (s.includes("els.start.textContent = autopilotStarted ? 'Resume Autopilot' : 'Start Autopilot';")) {
      // already correct
    } else if (!s.includes("els.start.textContent = hasStartedMilestone(proposal) ? 'Resume Autopilot' : 'Start Autopilot';")) {
      const marker = '// MANUAL_RESUME_AUTOPILOT_CONTROL_V2';
      const pos = s.indexOf(marker);
      const after = s.indexOf('\n', pos);
      // no-op: fallback block already handles this when needed
    }
  }

  must(s.includes('MANUAL_RESUME_AUTOPILOT_CONTROL_V2'), 'VERIFY_FAILED:planner marker');
  must(s.includes('/autopilot'), 'VERIFY_FAILED:planner missing trusted autopilot endpoint');
  fs.writeFileSync(file, s, 'utf8');
}

// -------- Roadmap HTML --------
{
  const file = 'src/public/roadmap.html';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('id="resumeAutopilotButton"')) {
    const reopen = '<button class="ghost-button" type="button" id="reopenRoadmapButton" hidden>REOPEN BLOCKED MILESTONE</button>';
    must(s.includes(reopen), 'PATCH_PATTERN_NOT_FOUND:roadmap reopen button');
    s = s.replace(
      reopen,
      '<button class="ghost-button" type="button" id="resumeAutopilotButton" hidden>RESUME AUTOPILOT</button>' + reopen
    );
  }

  fs.writeFileSync(file, s, 'utf8');
}

// -------- Roadmap JS --------
{
  const file = 'src/public/roadmap-page.js';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V2')) {
    const renderAnchor = 'function renderMilestoneStateEditor(item) {';
    must(s.includes(renderAnchor), 'PATCH_PATTERN_NOT_FOUND:renderMilestoneStateEditor');

    const helper = `// MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V2
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

`;

    s = s.replace(renderAnchor, helper + renderAnchor);

    // Keep the button synchronized whenever a Roadmap is opened/refreshed.
    const renderCall = '  renderMilestoneStateEditor(item);';
    must(s.includes(renderCall), 'PATCH_PATTERN_NOT_FOUND:edit roadmap render call');
    s = s.replace(renderCall, renderCall + '\n  syncManualAutopilotControl(item);');

    // New/empty roadmap must hide it.
    const nullCall = '  renderMilestoneStateEditor(null);';
    if (s.includes(nullCall)) {
      s = s.replace(nullCall, nullCall + '\n  syncManualAutopilotControl(null);');
    }

    const listenerAnchor = "$('#reopenRoadmapButton').addEventListener('click', async () => {";
    must(s.includes(listenerAnchor), 'PATCH_PATTERN_NOT_FOUND:roadmap listener anchor');

    const listener = `$('#resumeAutopilotButton').addEventListener('click', async () => {
  const id = text($('#roadmapId').value || currentRoadmap?.id);
  if (!id) return;

  const button = $('#resumeAutopilotButton');
  button.disabled = true;
  $('#roadmapMessage').textContent = 'Asking trusted Autopilot to start or resume...';

  try {
    const result = await api(\`/api/roadmaps/\${encodeURIComponent(id)}/autopilot\`, {
      method: 'POST',
      body: JSON.stringify({})
    });

    $('#roadmapMessage').textContent = result?.no_new_work
      ? 'Autopilot already owns the persisted work. Refreshing trusted state...'
      : 'Autopilot accepted Start / Resume. Refreshing trusted state...';

    await loadRoadmaps();
    await editRoadmap(id);
  } catch (error) {
    $('#roadmapMessage').textContent = \`Autopilot Start / Resume failed: \${error.message}\`;
  } finally {
    button.disabled = false;
  }
});

`;

    s = s.replace(listenerAnchor, listener + listenerAnchor);
  }

  must(s.includes('MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V2'), 'VERIFY_FAILED:roadmap js marker');
  must(s.includes('/autopilot'), 'VERIFY_FAILED:roadmap missing autopilot endpoint');

  fs.writeFileSync(file, s, 'utf8');
}

console.log('MANUAL_RESUME_AUTOPILOT_CONTROL_V2_OK');
