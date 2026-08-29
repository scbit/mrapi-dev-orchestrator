const fs = require('fs');

function replaceOnce(source, search, replacement, label) {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) throw new Error('PATCH_PATTERN_NOT_FOUND:' + label);
  return source.replace(search, replacement);
}

{
  const file = 'src/routes/planner.ui.routes.js';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('MANUAL_RESUME_AUTOPILOT_CONTROL_V1')) {
    const oldExact = `      const canStart = approved && !isTerminal(proposal) && !hasActiveAutopilotWork && hasPendingAutopilotWork;`;
    const replacement = `      // MANUAL_RESUME_AUTOPILOT_CONTROL_V1
      const hasUnfinishedAutopilotWork = proposalMilestones.some((milestone) =>
        !['COMPLETED', 'COMPLETE', 'DONE'].includes(text(milestone?.state).trim().toUpperCase())
      );
      const canStart = approved && !isTerminal(proposal) && hasUnfinishedAutopilotWork;`;

    if (s.includes(oldExact)) s = s.replace(oldExact, replacement);
    else {
      const re = /      const canStart = approved && [^;]+;/;
      if (!re.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner canStart');
      s = s.replace(re, replacement);
    }
  }
  fs.writeFileSync(file, s, 'utf8');
}

{
  const file = 'src/public/roadmap.html';
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('resumeAutopilotButton')) {
    const old = `<div class="roadmap-action-row"><button class="primary-button" type="submit">SAVE ROADMAP</button><button class="ghost-button" type="button" id="reopenRoadmapButton" hidden>REOPEN BLOCKED MILESTONE</button></div>`;
    const neu = `<div class="roadmap-action-row"><button class="primary-button" type="submit">SAVE ROADMAP</button><button class="ghost-button" type="button" id="resumeAutopilotButton" hidden>RESUME AUTOPILOT</button><button class="ghost-button" type="button" id="reopenRoadmapButton" hidden>REOPEN BLOCKED MILESTONE</button></div>`;
    s = replaceOnce(s, old, neu, 'roadmap action row');
  }
  fs.writeFileSync(file, s, 'utf8');
}

{
  const file = 'src/public/roadmap-page.js';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V1')) {
    const anchor = `function renderMilestoneStateEditor(item) {`;
    const helper = `// MANUAL_RESUME_AUTOPILOT_ROADMAP_UI_V1
function syncAutopilotControl(item) {
  const button = $('#resumeAutopilotButton');
  if (!button) return;
  const milestones = orderedMilestones(item);
  const terminal = ['COMPLETED', 'COMPLETE', 'DONE', 'CANCELLED', 'CANCELED'].includes(rawState(item));
  const approved = text(item?.approval_status || item?.approval?.status).toUpperCase() === 'APPROVED'
    || (item?.proposal_type === 'PLANNER_ROADMAP' && ['ACTIVE', 'APPROVED'].includes(rawState(item)));
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
    if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:renderMilestoneStateEditor');
    s = s.replace(anchor, helper + anchor);

    s = replaceOnce(
      s,
      `  renderMilestoneStateEditor(item);\n  $('#roadmapEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });`,
      `  renderMilestoneStateEditor(item);\n  syncAutopilotControl(item);\n  $('#roadmapEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });`,
      'editRoadmap sync'
    );

    s = replaceOnce(
      s,
      `  currentRoadmap = null;\n  renderMilestoneStateEditor(null);`,
      `  currentRoadmap = null;\n  renderMilestoneStateEditor(null);\n  syncAutopilotControl(null);`,
      'new roadmap sync'
    );

    const clickAnchor = `$('#reopenRoadmapButton').addEventListener('click', async () => {`;
    const handler = `$('#resumeAutopilotButton').addEventListener('click', async () => {
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
      ? 'Autopilot already owns the current persisted work. Refreshing...'
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
    if (!s.includes(clickAnchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:reopen click anchor');
    s = s.replace(clickAnchor, handler + clickAnchor);
  }
  fs.writeFileSync(file, s, 'utf8');
}

console.log('MANUAL_RESUME_AUTOPILOT_CONTROL_V1_OK');
