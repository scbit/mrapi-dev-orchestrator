const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

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
  await router(
    { method: 'GET', url: '/planner' },
    {
      setHeader() {},
      end(value) { html = value; }
    },
    () => {
      throw new Error('PLANNER_ROUTE_NOT_FOUND');
    }
  );
  return html;
}

test('main shell exposes visible workspace and project context controls with labels', () => {
  const html = read('src/public/index.html');
  assert.match(html, /class="context-header"/);
  assert.match(html, /aria-label="Current workspace and project context"/);
  assert.match(html, /for="globalWorkspaceSelect"/);
  assert.match(html, /id="globalWorkspaceSelect"/);
  assert.match(html, /for="globalProjectSelect"/);
  assert.match(html, /id="globalProjectSelect"/);
  assert.match(html, /id="globalContextStatus"/);
  assert.match(html, /id="globalContextTechnical"/);
});

test('main app initializes context from trusted backend contracts, not static examples', () => {
  const js = read('src/public/app.js');
  assert.doesNotMatch(js, /workspace_fm_real_estate|workspace_sentire_marine|project_sentire_marine_segue/);
  assert.doesNotMatch(js, /name:\s*'SCB'|FM Real Estate|Sentire Marine/);
  assert.match(js, /api\('\/api\/workspaces'\)/);
  assert.match(js, /api\('\/api\/projects'\)/);
  assert.match(js, /loadTrustedContext\(\)/);
  assert.match(js, /productContextStorageKey = 'mrapi\.product\.context\.v1'/);
});

test('persisted context is revalidated and invalid workspace/project pairs are cleared', () => {
  const js = read('src/public/app.js');
  assert.match(js, /readPersistedContextPreference/);
  assert.match(js, /validRemembered = remembered \? validatedContext\(remembered\) : null/);
  assert.match(js, /if \(validRemembered\?\.valid\)/);
  assert.match(js, /clearPersistedContextPreference\(\)/);
  assert.match(js, /projectWorkspaceId\(project\) === workspaceId/);
  assert.match(js, /setCurrentContext\('', ''\)/);
});

test('workspace changes invalidate incompatible projects and empty project sets are explicit', () => {
  const js = read('src/public/app.js');
  assert.match(js, /setCurrentContext\(\$\('#globalWorkspaceSelect'\)\.value, '', \{ persist: true \}\)/);
  assert.match(js, /No projects in this workspace/);
  assert.match(js, /Select workspace first/);
  assert.match(js, /projectsForWorkspace\(workspaceId\)/);
  assert.doesNotMatch(js, /projects\[0\]/);
});

test('context-invalid main mutation is blocked before request construction', () => {
  const js = read('src/public/app.js');
  const submitStart = js.indexOf('async function submitMission');
  assert.notEqual(submitStart, -1);
  const submitBody = js.slice(submitStart, js.indexOf("function bindEvents()", submitStart));
  assert.match(submitBody, /const current = validatedContext\(selected\)/);
  assert.match(submitBody, /if \(!current\.valid\)/);
  assert.match(submitBody, /return;/);
  assert.ok(submitBody.indexOf('if (!current.valid)') < submitBody.indexOf("api('/api/missions'"));
  assert.match(submitBody, /workspace_id: current\.workspace\.id/);
  assert.match(submitBody, /project_id: current\.project\.id/);
});

test('planner shares trusted scoped workspace/project controls and preserves lifecycle controls', async () => {
  const html = await renderPlannerPage();
  assert.match(html, /fetch\('\/api\/workspaces'\)/);
  assert.match(html, /fetch\('\/api\/projects'\)/);
  assert.match(html, /plannerContextStorageKey = 'mrapi\.product\.context\.v1'/);
  assert.match(html, /projectWorkspaceId\(project\) === candidate\.workspaceId/);
  assert.match(html, /evaluateContextSelection\(\{ workspaceId: els\.workspace\.value, projectId: els\.project\.value \}\)\.valid/);
  assert.match(html, /id="workspaceId" name="workspace_id" aria-label="Workspace"/);
  assert.match(html, /id="projectId" name="project_id" aria-label="Project"/);
  assert.match(html, /id="submitPlannerRequest"/);
  assert.match(html, /id="approveRoadmap"/);
  assert.match(html, /id="requestChanges"/);
  assert.match(html, /id="startAutopilot"/);
  assert.doesNotMatch(html, /Start Next Milestone|startNextMilestone|\/advance/);
});

test('roadmap exposes read-only trusted context and no manual milestone progression mutation', () => {
  const html = read('src/public/roadmap.html');
  const js = read('src/public/roadmap-page.js');
  assert.match(html, /id="roadmapTrustedContext"/);
  assert.match(html, /id="roadmapEditorContext"/);
  assert.match(html, /Read-only roadmap workspace and project context/);
  assert.match(js, /api\('\/api\/workspaces'\)/);
  assert.match(js, /renderTrustedContext\(item\)/);
  assert.match(js, /project_id: ownershipProject\.id/);
  assert.doesNotMatch(html + js, /startNextMilestone|Start Next Milestone|\/advance|milestone-state-select|milestones\/.*\/state/);
});

test('shared visual shell, status, focus, responsive, loading, error, empty and technical patterns exist', () => {
  const css = read('src/public/styles.css');
  const roadmapCss = read('src/public/roadmap-page.css');
  for (const token of [
    '.app-shell', '.sidebar', '.nav-group', '.topbar', '.context-header',
    '.context-selector-grid', '.panel', '.primary-button', '.secondary-button',
    '.danger-button', '.state-badge', '.technical-details', ':focus-visible',
    '.loading-state', '.error-state', '.empty-state'
  ]) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(css, /@media \(max-width: 840px\)/);
  assert.match(css, /context-selector-grid \{ grid-template-columns:1fr; \}/);
  assert.match(roadmapCss, /@media \(max-width: 900px\)/);
  assert.match(roadmapCss, /context-current \{ grid-template-columns: 1fr; \}/);
});

test('context persistence has no workspace/project polling loop and IDs stay secondary', async () => {
  const js = read('src/public/app.js');
  const planner = await renderPlannerPage();
  assert.doesNotMatch(js, /setInterval\(loadTrustedContext/);
  assert.doesNotMatch(js, /setTimeout\(loadTrustedContext/);
  assert.match(js, /Workspace ID:/);
  assert.match(js, /Project ID:/);
  assert.match(planner, /Advanced roadmap details/);
  assert.match(planner, /Workspace not recorded/);
  assert.match(planner, /Project not recorded/);
});
