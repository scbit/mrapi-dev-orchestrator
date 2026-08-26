const { cfg } = require('./lib/config');
const { createApi } = require('./lib/api');
const { brainPrompt } = require('./lib/prompts');
const { runChatGPTWeb } = require('./adapters/chatgpt-web');

if (!cfg.baseUrl) throw new Error('MRAPI_BASE_URL is required.');
if (!cfg.secret) throw new Error('MRAPI_RUNNER_SECRET is required.');

const api = createApi(cfg);
let stopping = false;
let currentBrainRunId = null;

async function heartbeat() {
  return api.request('/api/brain/heartbeat', {
    brain_adapter_id: cfg.brainAdapterId,
    worker_ids: cfg.workerIds,
    state: 'ONLINE',
    adapter_status: currentBrainRunId ? 'BUSY' : 'IDLE',
    current_brain_run_id: currentBrainRunId,
    adapter_version: 'v0.4.4.15',
    host_name: cfg.hostName
  });
}

async function register() {
  return api.request('/api/brain/register', {
    brain_adapter_id: cfg.brainAdapterId,
    worker_ids: cfg.workerIds,
    state: 'ONLINE',
    adapter_status: 'IDLE',
    current_brain_run_id: null,
    adapter_version: 'v0.4.4.15',
    host_name: cfg.hostName
  });
}

async function processRun(run) {
  console.log('[BRAIN] claimed', run.id, run.worker_id);
  currentBrainRunId = run.id;

  try {
    const brain = await runChatGPTWeb({
      cfg,
      run,
      prompt: brainPrompt(run, cfg),
      onProgress: (progress_percent, message) =>
        api.request(`/api/brain/runs/${encodeURIComponent(run.id)}/progress`, {
          progress_percent,
          message
        })
    });

    const completionPayload = {
      output_text: brain.outputText,
      objective: run.objective || '',
      worker_id: run.worker_id,
      execution_constraints: {
        no_gcp: true,
        no_cloud_run: true,
        no_deploy: true,
        deployment: 'HUMAN_MANUAL_DEPLOY'
      },
      brain_chat_url: brain.chatUrl
    };

    // For normal Missions keep the legacy fallback task spec. For Autopilot,
    // the structured MRAPI_CONTROL block from the Brain must be the sole task scope.
    if (run.autopilot_mode !== true) {
      completionPayload.task_spec = {
        title: run.objective || 'Execution task',
        objective: run.objective || '',
        instructions: brain.outputText
      };
    }

    await api.request(`/api/brain/runs/${encodeURIComponent(run.id)}/complete`, completionPayload);

    console.log('[BRAIN] COMPLETE', run.id);
  } catch (error) {
    console.error('[BRAIN ERROR]', run.id, error.message);
    if (error.message === 'CHATGPT_LOGIN_REQUIRED') {
      console.error('[BRAIN] WAITING CHATGPT_LOGIN_REQUIRED', run.worker_id);
    }

    try {
      await api.request(`/api/brain/runs/${encodeURIComponent(run.id)}/release`, {
        message: error.message === 'CHATGPT_LOGIN_REQUIRED'
          ? `WAITING CHATGPT_LOGIN_REQUIRED for ${run.worker_id}`
          : `Brain Adapter released after error: ${error.message}`
      });
    } catch (releaseError) {
      console.error('[BRAIN RELEASE ERROR]', releaseError.message);
    }
  } finally {
    currentBrainRunId = null;
  }
}

async function loop() {
  console.log('[BRAIN] adapter', cfg.brainAdapterId, cfg.workerIds);
  for (const workerId of cfg.workerIds) {
    const id = String(workerId || '').toUpperCase();
    console.log(`[BRAIN] ${id} chat`, cfg.brainChatUrls[id] || '(missing)');
    console.log(`[BRAIN] ${id} profile`, cfg.chromeUserDataDirForWorker(id));
  }
  console.log('[BRAIN] repo context', cfg.repoPath);
  await register();

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) =>
      console.error('[BRAIN HEARTBEAT ERROR]', error.message)
    );
  }, 30000);

  try {
    while (!stopping) {
      await heartbeat();
      const claim = await api.request('/api/brain/next-run', {
        brain_adapter_id: cfg.brainAdapterId,
        worker_ids: cfg.workerIds
      });

      if (claim?.run) {
        await processRun(claim.run);
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
  console.error('[BRAIN FATAL]', error);
  process.exit(1);
});
