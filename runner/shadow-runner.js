const { cfg } = require('./lib/config');
const { createApi } = require('./lib/api');
const { brainPrompt } = require('./lib/prompts');
const { runChatGPTWeb } = require('./adapters/chatgpt-web');

if (!cfg.baseUrl) throw new Error('MRAPI_BASE_URL is required.');
if (!cfg.secret) throw new Error('MRAPI_RUNNER_SECRET is required.');

const api = createApi(cfg);
let currentRunId = null;
let stopping = false;

async function request(path, body) {
  return api.request(path, body);
}

async function register() {
  return request('/api/runner/register', {
    executor_id: cfg.executorId,
    name: cfg.executorName,
    executor_type: 'CODEX_APP_MANUAL',
    host_name: cfg.hostName,
    host_type: 'SHADOW',
    runner_version: 'v0.3.1-alpha.2',
    capabilities: [
      'BRAIN_RUN:CHATGPT_WEB',
      'CODEX_HANDOFF:MANUAL_APP',
      'LOG',
      'FILE',
      'SCREENSHOT',
      'TEST_RESULT'
    ],
    worker_ids: cfg.workerIds
  });
}

async function heartbeat() {
  return request('/api/runner/heartbeat', {
    executor_id: cfg.executorId,
    state: 'ONLINE',
    runner_status: currentRunId ? 'BUSY' : 'IDLE',
    current_run_id: currentRunId
  });
}

async function progress(runId, percent, message) {
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/progress`, {
    progress_percent: percent,
    message
  });
}

async function addTextEvidence(runId, type, title, filename, text) {
  const content = Buffer.from(String(text || ''), 'utf8').toString('base64');
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type,
    title,
    filename,
    content_type: 'text/plain; charset=utf-8',
    content_base64: content
  });
}

async function markWaiting(taskId, message, handoff = null) {
  return request(`/api/runner/tasks/${encodeURIComponent(taskId)}/waiting`, {
    message,
    handoff
  });
}

async function executeClaim(claim) {
  const { task, run: brainRun } = claim;
  currentRunId = brainRun.id;

  try {
    console.log('[SHADOW] BRAIN', task.id, brainRun.id);

    const brain = await runChatGPTWeb({
      cfg,
      task,
      prompt: brainPrompt(task, cfg),
      onProgress: (percent, message) => progress(brainRun.id, percent, message)
    });

    await addTextEvidence(
      brainRun.id,
      'LOG',
      'W01 Brain plan',
      'brain-plan.txt',
      brain.outputText
    );

    await request(`/api/runner/runs/${encodeURIComponent(brainRun.id)}/brain-complete`, {
      output_text: brain.outputText,
      brain_chat_url: brain.chatUrl
    });

    console.log('[SHADOW] BRAIN COMPLETE', brainRun.id);

    const handoff = {
      type: 'CODEX_APP_MANUAL',
      worker_id: task.worker_id,
      repository_path: cfg.repoPath,
      brain_run_id: brainRun.id,
      brain_chat_url: brain.chatUrl,
      instructions: brain.outputText,
      operator_action:
        'Open Codex inside the ChatGPT desktop app on Shadow, select the local repository, and paste the Brain instructions. Do not deploy.'
    };

    await markWaiting(
      task.id,
      'Brain completed. Waiting for manual Codex execution in the ChatGPT desktop app on Shadow.',
      handoff
    );

    console.log('[SHADOW] WAITING_FOR_CODEX', task.id);
    console.log('[SHADOW] Brain plan is stored in MRAPI DEV evidence and task handoff.');
  } catch (error) {
    console.error('[SHADOW TASK ERROR]', error.message);
    try {
      await markWaiting(
        task.id,
        `Brain/Runner blocked: ${error.message}`,
        {
          type: 'OPERATOR_ATTENTION',
          repository_path: cfg.repoPath
        }
      );
    } catch (secondary) {
      console.error('[SHADOW WAITING ERROR]', secondary.message);
    }
  } finally {
    currentRunId = null;
  }
}

async function loop() {
  console.log('[SHADOW] registering', cfg.executorId, cfg.workerIds);
  await register();
  console.log('[SHADOW] registered');

  const recovery = await request('/api/runner/recover-abandoned', {
    executor_id: cfg.executorId,
    stale_ms: 120000
  });
  if (recovery?.recovered?.length) {
    console.log('[SHADOW] recovered abandoned Brain Runs', recovery.recovered.length);
  }
  console.log('[SHADOW] repo', cfg.repoPath);
  console.log('[SHADOW] W01 chat', cfg.brainChatUrlW01 || '(not configured)');
  console.log('[SHADOW] Codex mode: manual ChatGPT desktop app handoff');

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) => console.error('[SHADOW HEARTBEAT ERROR]', error.message));
  }, 30000);

  try {
    while (!stopping) {
      await heartbeat();

      const claim = await request('/api/runner/next-task', {
        executor_id: cfg.executorId
      });

      if (claim) {
        console.log('[SHADOW] claimed', claim.task.id, claim.run.id, claim.run.run_type);
        await executeClaim(claim);
      } else {
        await new Promise((resolve) => setTimeout(resolve, cfg.pollMs));
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

loop().catch((error) => {
  console.error('[SHADOW FATAL]', error);
  process.exit(1);
});
