const fs = require('fs');
const path = require('path');

const root = process.cwd();
const indexPath = path.join(root, 'src', 'public', 'index.html');
const appPath = path.join(root, 'src', 'public', 'app.js');
const plannerUiPath = path.join(root, 'src', 'routes', 'planner.ui.routes.js');
const plannerServicePath = path.join(root, 'src', 'services', 'planner.js');
const testPath = path.join(root, 'test', 'planner-ux-continuity.test.js');

for (const p of [indexPath, appPath, plannerUiPath, plannerServicePath]) {
  if (!fs.existsSync(p)) throw new Error(`Missing expected file: ${p}`);
}

function patchFile(filePath, mutate) {
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = mutate(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log('Updated:', path.relative(root, filePath));
  } else {
    console.log('No change needed:', path.relative(root, filePath));
  }
}

// 1) Add Planner to main navigation.
patchFile(indexPath, (source) => {
  if (source.includes('id="plannerNav"')) return source;
  const anchor = '<button class="nav-item" id="roadmapNav">Roadmap</button>';
  if (!source.includes(anchor)) throw new Error('PATCH_ABORTED: roadmap nav anchor not found.');
  return source.replace(
    anchor,
    `${anchor}\n        <button class="nav-item" id="plannerNav">Planner</button>`
  );
});

// 2) Wire Planner nav to /planner.
patchFile(appPath, (source) => {
  if (source.includes("const plannerNav = document.querySelector('#plannerNav');")) return source;
  const anchor = "const roadmapNav = document.querySelector('#roadmapNav');\nif (roadmapNav) roadmapNav.addEventListener('click', () => { window.location.href = '/roadmap.html#roadmap'; });";
  if (!source.includes(anchor)) throw new Error('PATCH_ABORTED: roadmap nav JS anchor not found.');
  return source.replace(
    anchor,
    `${anchor}\nconst plannerNav = document.querySelector('#plannerNav');\nif (plannerNav) plannerNav.addEventListener('click', () => { window.location.href = '/planner'; });`
  );
});

// 3) Persist Planner request context across reload/navigation.
patchFile(plannerUiPath, (source) => {
  if (source.includes("const plannerStorageKey = 'mrapi.planner.active.v1';")) return source;

  const stateAnchor = `    const state = {
      requestId: null,
      missionId: null,
      brainRunId: null,
      proposalId: null,
      proposal: null,
      submitting: false,
      revisionSubmitting: false
    };
`;

  if (!source.includes(stateAnchor)) throw new Error('PATCH_ABORTED: planner state anchor not found.');

  const helpers = `
    const plannerStorageKey = 'mrapi.planner.active.v1';

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
`;

  source = source.replace(stateAnchor, stateAnchor + helpers);

  const submitAnchor = `        state.proposalId = created.roadmap_id || created.proposal_id || created.planner_roadmap_id || null;
        if (state.proposalId && (created.milestones || created.title || created.objective || created.summary)) {`;

  if (!source.includes(submitAnchor)) throw new Error('PATCH_ABORTED: planner submit persistence anchor not found.');

  source = source.replace(
    submitAnchor,
    `        state.proposalId = created.roadmap_id || created.proposal_id || created.planner_roadmap_id || null;
        persistPlannerState();
        if (state.proposalId && (created.milestones || created.title || created.objective || created.summary)) {`
  );

  const renderAnchor = `      if (state.proposalId) els.proposalId.value = state.proposalId;
      els.proposalView.classList.remove('hidden');`;

  if (!source.includes(renderAnchor)) throw new Error('PATCH_ABORTED: render proposal persistence anchor not found.');

  source = source.replace(
    renderAnchor,
    `      if (state.proposalId) els.proposalId.value = state.proposalId;
      persistPlannerState();
      els.proposalView.classList.remove('hidden');`
  );

  const resetAnchor = `      state.requestId = null; state.missionId = null; state.brainRunId = null; state.proposalId = null; state.proposal = null; state.submitting = false; state.revisionSubmitting = false;
      els.form.reset();`;

  if (!source.includes(resetAnchor)) throw new Error('PATCH_ABORTED: planner reset anchor not found.');

  source = source.replace(
    resetAnchor,
    `      state.requestId = null; state.missionId = null; state.brainRunId = null; state.proposalId = null; state.proposal = null; state.submitting = false; state.revisionSubmitting = false;
      clearPersistedPlannerState();
      els.form.reset();`
  );

  const initAnchor = `    syncSubmitState();
  </script>`;

  if (!source.includes(initAnchor)) throw new Error('PATCH_ABORTED: planner init anchor not found.');

  source = source.replace(
    initAnchor,
    `    const restoredPlanner = restorePlannerState();
    syncSubmitState();
    if (restoredPlanner) {
      setStatus('Restored active Planner request. Checking for the latest roadmap proposal...', 'success');
      loadProposal();
    }
  </script>`
  );

  return source;
});

// 4) Add scoped regression test. Also verify current Planner intake is already self-starting
//    (Mission PLANNING + BRAIN_RUN RUNNING), so no manual Dispatch should be necessary.
const testSource = `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src/public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src/public/app.js'), 'utf8');
const plannerUi = fs.readFileSync(path.join(root, 'src/routes/planner.ui.routes.js'), 'utf8');
const plannerService = fs.readFileSync(path.join(root, 'src/services/planner.js'), 'utf8');

test('Planner is reachable from the primary MRAPI navigation', () => {
  assert.match(indexHtml, /id="plannerNav">Planner<\\/button>/);
  assert.match(appJs, /plannerNav[\\s\\S]*window\\.location\\.href = '\\/planner'/);
});

test('Planner restores the active request after reload', () => {
  assert.match(plannerUi, /mrapi\\.planner\\.active\\.v1/);
  assert.match(plannerUi, /persistPlannerState\\(\\)/);
  assert.match(plannerUi, /restorePlannerState\\(\\)/);
  assert.match(plannerUi, /clearPersistedPlannerState\\(\\)/);
  assert.match(plannerUi, /Restored active Planner request/);
  assert.match(plannerUi, /loadProposal\\(\\)/);
});

test('Planner intake already starts Brain planning without manual Mission Dispatch', () => {
  assert.match(plannerService, /planning_mode:\\s*'PLANNER_ROADMAP_PROPOSAL'/);
  assert.match(plannerService, /state:\\s*'PLANNING'/);
  assert.match(plannerService, /run_type:\\s*'BRAIN_RUN'/);
  assert.match(plannerService, /state:\\s*'RUNNING'/);
  assert.match(plannerService, /non_executable:\\s*true/);
});
`;

fs.writeFileSync(testPath, testSource, 'utf8');
console.log('Added: test/planner-ux-continuity.test.js');
console.log('');
console.log('Run: node --test test\\\\planner-ux-continuity.test.js');
console.log('Then: commit + push, deploy Cloud Run, restart W01 Brain, Ctrl+F5.');
try { fs.unlinkSync(__filename); } catch {}
