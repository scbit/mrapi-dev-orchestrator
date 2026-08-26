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

function sectionFrom(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = endMarker ? html.indexOf(endMarker, start) : html.length;
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return html.slice(start, end);
}

test('/planner contains a clearly labeled conversation-first Planner request form', async () => {
  const html = await renderPlannerPage();
  const form = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '</form>');

  assert.match(form, /<h2>¿Qué querés hacer\?<\/h2>/);
  assert.match(form, /W01 prepara el plan/);
  assert.match(form, /recién ahí puede ejecutarse/);
});

test('workspace and project context controls are present and required', async () => {
  const html = await renderPlannerPage();
  const form = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '</form>');

  assert.match(form, /Contexto/);
  assert.match(form, /Workspace/);
  assert.match(form, /Project/);
  assert.match(form, /<select id="workspaceId" name="workspace_id"[^>]*required/);
  assert.match(form, /<select id="projectId" name="project_id"[^>]*required/);
  assert.doesNotMatch(form, /<input id="workspaceId" name="workspace_id"/);
  assert.doesNotMatch(form, /<input id="projectId" name="project_id"/);
});

test('natural-language request is a required multiline textarea with conversational guidance', async () => {
  const html = await renderPlannerPage();
  const form = sectionFrom(html, '<form class="panel request-panel" id="plannerForm">', '</form>');

  assert.match(form, /Contale a W01 qué necesitás/);
  assert.match(form, /<textarea id="plannerRequest" name="request"[^>]*required[^>]*minlength="1"/);
  assert.match(form, /Contame qué querés crear, cambiar o mejorar/);
  assert.match(form, /W01 te va a proponer un plan antes de ejecutar nada/);
  assert.doesNotMatch(form, /hidden execution instructions/i);
});

test('submit button is disabled until trimmed required fields are valid', async () => {
  const html = await renderPlannerPage();

  assert.match(html, /function canSubmit\(\) \{\s*return Boolean\(!state\.contextLoading && !state\.contextError && els\.workspace\.value\.trim\(\) && els\.project\.value\.trim\(\) && els\.request\.value\.trim\(\)\);/);
  assert.match(html, /els\.submit\.disabled = !canSubmit\(\)/);
  assert.match(html, /if \(state\.submitting\) els\.submit\.disabled = true/);
  assert.match(html, /\['input', 'change'\]\.forEach/);
  assert.match(html, /syncSubmitState\(\);/);
});

test('submit handler performs trimmed validation and blocks whitespace-only request', async () => {
  const html = await renderPlannerPage();
  const submitHandler = sectionFrom(html, "els.form.addEventListener('submit'", "els.refresh.addEventListener('click'");

  assert.match(submitHandler, /event\.preventDefault\(\)/);
  assert.match(submitHandler, /if \(state\.submitting\) return/);
  assert.match(submitHandler, /if \(!canSubmit\(\)\)/);
  assert.match(submitHandler, /Elegí workspace, project y contame qué querés hacer/);
  assert.match(submitHandler, /request: els\.request\.value\.trim\(\)/);
});

test('client sends only workspace_id, project_id, and request to Planner intake', async () => {
  const html = await renderPlannerPage();
  const submitHandler = sectionFrom(html, "els.form.addEventListener('submit'", "els.refresh.addEventListener('click'");
  const bodyBlock = sectionFrom(submitHandler, 'const body = {', '};');

  assert.match(submitHandler, /fetch\('\/api\/planner\/requests'/);
  assert.match(bodyBlock, /workspace_id: els\.workspace\.value\.trim\(\)/);
  assert.match(bodyBlock, /project_id: els\.project\.value\.trim\(\)/);
  assert.match(bodyBlock, /request: els\.request\.value\.trim\(\)/);
  assert.doesNotMatch(bodyBlock, /tenant_id|approve|milestones|task|Task|executor|execution|EXECUTION_RUN/);
  assert.doesNotMatch(submitHandler, /\/approve|\/start|\/api\/tasks|\/api\/runs/);
});

test('in-flight planning state prevents duplicate clicks and restores after failure', async () => {
  const html = await renderPlannerPage();
  const submitHandler = sectionFrom(html, "els.form.addEventListener('submit'", "els.refresh.addEventListener('click'");

  assert.match(html, /submitting: false/);
  assert.match(submitHandler, /if \(state\.submitting\) return/);
  assert.match(submitHandler, /state\.submitting = true/);
  assert.match(submitHandler, /Preparando tu plan/);
  assert.match(submitHandler, /state\.submitting = false/);
  assert.match(submitHandler, /Planner request failed: /);
  assert.match(html, /els\.submit\.textContent = state\.submitting \? 'Preparando tu plan\.\.\.' : 'Pedir plan'/);
});

test('successful intake stores returned identifiers for discovery without approving or starting', async () => {
  const html = await renderPlannerPage();
  const submitHandler = sectionFrom(html, "els.form.addEventListener('submit'", "els.refresh.addEventListener('click'");

  assert.match(submitHandler, /state\.requestId = created\.planner_request_id \|\| created\.request_id \|\| created\.mission_id/);
  assert.match(submitHandler, /state\.missionId = created\.mission_id \|\| state\.requestId/);
  assert.match(submitHandler, /state\.brainRunId = created\.brain_run_id/);
  assert.match(submitHandler, /state\.proposalId = created\.roadmap_id \|\| created\.proposal_id \|\| created\.planner_roadmap_id/);
  assert.match(submitHandler, /W01 está preparando el roadmap/);
  assert.doesNotMatch(submitHandler, /approve:\s*true|\/approve|\/start|startAutopilot/);
});

test('reset clears local UI state without lifecycle backend calls', async () => {
  const html = await renderPlannerPage();
  const resetHandler = sectionFrom(html, "els.reset.addEventListener('click'", "['input', 'change'].forEach");

  assert.match(resetHandler, /state\.requestId = null/);
  assert.match(resetHandler, /state\.missionId = null/);
  assert.match(resetHandler, /state\.brainRunId = null/);
  assert.match(resetHandler, /state\.proposalId = null/);
  assert.match(resetHandler, /state\.proposal = null/);
  assert.match(resetHandler, /state\.submitting = false/);
  assert.match(resetHandler, /els\.form\.reset\(\)/);
  assert.doesNotMatch(resetHandler, /fetch\(|\/delete|\/cancel|\/approve|\/start/);
});

test('tenant_id is not exposed as an authoritative field and client creates no execution work', async () => {
  const html = await renderPlannerPage();
  const source = read('src/routes/planner.ui.routes.js');

  assert.doesNotMatch(html, /name="tenant_id"|id="tenantId"/);
  assert.doesNotMatch(source, /fetch\('\/api\/tasks|fetch\('\/api\/runs|EXECUTION_RUN|createTask|createExecutionRun/);
});
