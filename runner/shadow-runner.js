const { cfg } = require('./lib/config');
const { createApi } = require('./lib/api');
const { brainPrompt, codexPrompt } = require('./lib/prompts');
const { runChatGPTWeb } = require('./adapters/chatgpt-web');
const { runCodexCommand, resolveCommand } = require('./adapters/codex-command');

if (!cfg.baseUrl) throw new Error('MRAPI_BASE_URL is required.');
if (!cfg.secret) throw new Error('MRAPI_RUNNER_SECRET is required.');

const api = createApi(cfg);
let currentRunId = null;
let stopping = false;

async function request(path, body) { return api.request(path, body); }

async function register() {
  return request('/api/runner/register', {
    executor_id: cfg.executorId,
    name: cfg.executorName,
    executor_type: 'CODEX',
    host_name: cfg.hostName,
    host_type: 'SHADOW',
    runner_version: 'v0.3-alpha',
    capabilities: ['BRAIN_RUN:CHATGPT_WEB', 'EXECUTION_RUN:CODEX', 'LOG', 'FILE', 'SCREENSHOT', 'TEST_RESULT'],
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
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/progress`, { progress_percent: percent, message });
}

async function textEvidence(runId, title, filename, text) {
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type: 'LOG',
    title,
    filename,
    content_type: 'text/plain; charset=utf-8',
    content_base64: Buffer.from(String(text || ''), 'utf8').toString('base64')
  });
}

async function markWaiting(taskId, message) {
  return request(`/api/runner/tasks/${encodeURIComponent(taskId)}/waiting`, { message });
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

    await textEvidence(brainRun.id, 'W01 Brain plan', 'brain-plan.txt', brain.outputText);
    await request(`/api/runner/runs/${encodeURIComponent(brainRun.id)}/brain-complete`, {
      output_text: brain.outputText,
      brain_chat_url: brain.chatUrl
    });
    console.log('[SHADOW] BRAIN COMPLETE', brainRun.id);

    if (!resolveCommand(cfg)) {
      await markWaiting(task.id, 'Brain completed. Codex command not found on Shadow; configure MRAPI_CODEX_COMMAND or enable Codex CLI.');
      console.log('[SHADOW] WAITING: Codex command not found');
      return;
    }

    const execution = await request(`/api/runner/tasks/${encodeURIComponent(task.id)}/execution-start`, {
      executor_id: cfg.executorId
    });
    const executionRun = execution.run;
    currentRunId = executionRun.id;
    console.log('[SHADOW] EXECUTION', task.id, executionRun.id);

    let logBuffer = '';
    const result = await runCodexCommand({
      cfg,
      prompt: codexPrompt(task, brain.outputText, cfg),
      onProgress: (percent, message) => progress(executionRun.id, percent, message),
      onOutput: (text) => { logBuffer += text; process.stdout.write(text); }
    });

    await textEvidence(executionRun.id, 'Codex execution log', 'codex-execution.log', `${logBuffer}\n\nSTDERR\n${result.stderr || ''}`);
    await request(`/api/runner/runs/${encodeURIComponent(executionRun.id)}/complete`, {
      success: result.success,
      summary: result.success ? 'Codex execution completed. Human manual deploy may still be required.' : `Codex exited with code ${result.exitCode}.`,
      error: result.success ? null : result.stderr,
      output: {
        exit_code: result.exitCode,
        stdout_tail: result.stdout.slice(-10000),
        stderr_tail: result.stderr.slice(-10000)
      }
    });
    console.log('[SHADOW] EXECUTION COMPLETE', executionRun.id, result.success ? 'SUCCESS' : 'FAILED');
  } catch (error) {
    console.error('[SHADOW TASK ERROR]', error.message);
    try { await markWaiting(task.id, error.message); } catch (secondary) { console.error('[SHADOW WAITING ERROR]', secondary.message); }
  } finally {
    currentRunId = null;
  }
}

async function loop() {
  console.log('[SHADOW] registering', cfg.executorId, cfg.workerIds);
  await register();
  console.log('[SHADOW] registered');
  console.log('[SHADOW] repo', cfg.repoPath);
  console.log('[SHADOW] W01 chat', cfg.brainChatUrlW01 || '(not configured)');
  console.log('[SHADOW] Codex', resolveCommand(cfg) ? 'command detected/configured' : 'not detected');

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) => console.error('[SHADOW HEARTBEAT ERROR]', error.message));
  }, 30000);

  try {
    while (!stopping) {
      await heartbeat();
      const claim = await request('/api/runner/next-task', { executor_id: cfg.executorId });
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
