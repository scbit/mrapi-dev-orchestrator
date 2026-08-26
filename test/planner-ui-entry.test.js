const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function createMiniExpress() {
  function Router() {
    const routes = [];
    const router = async (req, res, next) => {
      for (const route of routes) {
        if (route.method === req.method && route.path === req.url.split('?')[0]) {
          return route.handler(req, res, next);
        }
      }
      return next();
    };
    router.get = (routePath, handler) => routes.push({ method: 'GET', path: routePath, handler });
    router._routes = routes;
    return router;
  }
  return { Router };
}

function loadPlannerUiRouter() {
  const routePath = require.resolve('../src/routes/planner.ui.routes');
  delete require.cache[routePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createMiniExpress();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../src/routes/planner.ui.routes');
  } finally {
    Module._load = originalLoad;
  }
}

async function renderPlannerPage() {
  const { createPlannerUiRouter } = loadPlannerUiRouter();
  const router = createPlannerUiRouter();
  let html = '';
  const headers = {};
  await router(
    { method: 'GET', url: '/planner' },
    {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      end(value) { html = value; }
    },
    () => {
      throw new Error('PLANNER_ROUTE_NOT_FOUND');
    }
  );
  return { html, headers };
}

function scriptFrom(html, marker) {
  const index = html.indexOf(marker);
  assert.notEqual(index, -1, `missing marker: ${marker}`);
  return html.slice(index);
}

test('active application exposes the bounded Planner page route', async () => {
  const appSource = read('src/app.js');
  assert.match(appSource, /createPlannerUiRouter/);
  assert.match(appSource, /app\.use\(createPlannerUiRouter\(\)\)/);
  assert.ok(
    appSource.indexOf('app.use(createPlannerUiRouter())') < appSource.indexOf("express.static"),
    'Planner route must be registered before static fallback'
  );

  const { html, headers } = await renderPlannerPage();
  assert.match(headers['content-type'], /text\/html/);
  assert.match(html, /Roadmap Planner/);
  assert.match(html, /Review and approve the roadmap before any Autopilot execution can start/);
});

test('Planner page contains request and workspace/project context controls with client validation', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /id="plannerForm"/);
  assert.match(html, /id="workspaceId" name="workspace_id"[^>]+required/);
  assert.match(html, /id="projectId" name="project_id"[^>]+required/);
  assert.match(html, /id="plannerRequest" name="request"[^>]+required/);
  assert.match(html, /function canSubmit\(\)/);
  assert.match(html, /els\.request\.value\.trim\(\)/);
  assert.match(html, /els\.submit\.disabled = !canSubmit\(\)/);
  assert.match(html, /Workspace, project, and request are required before submission/);
});

test('Planner UI uses existing Planner APIs and does not expose direct Task or Run creation', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /fetch\('\/api\/planner\/requests'/);
  assert.match(html, /fetch\('\/api\/planner\/proposals\/'/);
  assert.match(html, /fetch\('\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/approve'/);
  assert.match(html, /fetch\('\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/start'/);
  assert.doesNotMatch(html, /fetch\('\/api\/tasks/);
  assert.doesNotMatch(html, /fetch\('\/api\/runs/);
  assert.doesNotMatch(html, /EXECUTION_RUN/);
  assert.doesNotMatch(html, /name="tenant_id"/);
  assert.doesNotMatch(scriptFrom(html, 'const body = {'), /tenant_id\s*:/);
});

test('Planner page shows planning state and reloads proposals from persisted backend state', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /Planning: Planner request accepted/);
  assert.match(html, /Waiting for W01 roadmap proposal generation/);
  assert.match(html, /state\.requestId = created\.planner_request_id \|\| created\.request_id \|\| created\.mission_id/);
  assert.match(html, /state\.brainRunId = created\.brain_run_id/);
  assert.match(html, /state\.proposalId = created\.roadmap_id \|\| created\.proposal_id \|\| created\.planner_roadmap_id/);
  assert.match(html, /discoverProposalFromMission/);
  assert.match(html, /\/api\/missions\//);
  assert.match(html, /\/api\/planner\/proposals\//);
  assert.match(html, /Refresh proposal/);
});

test('proposal rendering includes proposal and ordered milestone review fields', async () => {
  const { html } = await renderPlannerPage();
  for (const label of ['ROADMAP PROPOSAL', 'Objective:', 'Summary:', 'Risks', 'Dependencies', 'Assumptions']) {
    assert.match(html, new RegExp(label.replace(':', ':')));
  }
  assert.match(html, /milestones\.sort\(\(a, b\) => \{/);
  assert.match(html, /return a\.index - b\.index/);
  assert.match(html, /renderMilestone/);
  assert.match(html, /Objective \/ expected outcome/);
  assert.match(html, /Description/);
  assert.match(html, /executor_required \? 'Executor required' : 'Brain only'/);
  assert.match(html, /Executor requirement/);
  assert.match(html, /Success criteria/);
  assert.match(html, /Persisted lifecycle state/);
  assert.match(html, /waiting on dependencies/);
});

test('PROPOSED review requires explicit approval and read or refresh never approves', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /PROPOSED - awaiting human approval/);
  assert.match(html, /id="approveRoadmap"[^>]*>Approve roadmap/);
  assert.match(html, /const canApprove = proposed && !approved && !isTerminal\(proposal\)/);
  assert.match(html, /els\.approve\.classList\.toggle\('hidden', !canApprove\)/);
  assert.match(html, /body: JSON\.stringify\(\{ approve: true \}\)/);

  const loadProposalBody = html.slice(html.indexOf('async function loadProposal()'), html.indexOf("els.form.addEventListener('submit'"));
  assert.doesNotMatch(loadProposalBody, /\/approve/);
  assert.doesNotMatch(loadProposalBody, /approve:\s*true/);
  assert.doesNotMatch(loadProposalBody, /\/start/);
});

test('Start Autopilot is hidden before approval, separate from approval, and reuses existing start handoff', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /<button class="primary hidden" id="startAutopilot"[^>]*>Start Autopilot/);
  assert.match(html, /const canStart = approved && !isTerminal\(proposal\)/);
  assert.match(html, /els\.start\.classList\.toggle\('hidden', !canStart\)/);
  assert.match(html, /Start failed: proposal ID is required/);
  assert.match(html, /\/api\/planner\/roadmaps\/' \+ encodeURIComponent\(proposalId\) \+ '\/start'/);
  assert.match(html, /Existing Autopilot work reused/);
  assert.match(html, /Current milestone:/);
  assert.match(html, /Mission:/);
  assert.match(html, /Brain Run:/);

  const approvalHandler = html.slice(html.indexOf("els.approve.addEventListener('click'"), html.indexOf("els.start.addEventListener('click'"));
  assert.doesNotMatch(approvalHandler, /\/start/);
});

test('readable UI error states exist for request, proposal, approval, and start failures', async () => {
  const { html } = await renderPlannerPage();
  assert.match(html, /Planner request failed:/);
  assert.match(html, /Proposal retrieval failed:/);
  assert.match(html, /Approval failed:/);
  assert.match(html, /Start failed:/);
  assert.match(html, /cancelled|blocked|not startable|waiting on dependencies/i);
  assert.doesNotMatch(html, /stack/);
});
