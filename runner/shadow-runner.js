const { cfg } = require('./lib/config');
const { createApi } = require('./lib/api');
const { buildCodexPrompt } = require('./adapters/codex-desktop-handoff');
const { runCodexCommand } = require('./adapters/codex-command');

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
    executor_type: 'CODEX_CLI_AUTO',
    host_name: cfg.hostName,
    host_type: 'SHADOW',
    runner_version: 'v0.3.4-alpha.0',
    capabilities: [
      'EXECUTION_RUN:CODEX_CLI_AUTO',
      'CODEX_HANDOFF:VALIDATED',
      'CODEX_EXEC:AUTO',
      'RESULT:AUTO',
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

async function markWaiting(taskId, message, handoff = null) {
  return request(`/api/runner/tasks/${encodeURIComponent(taskId)}/waiting`, {
    message,
    handoff
  });
}

async function addLogEvidence(runId, taskId, result) {
  const combined = [
    `TASK ${taskId}`,
    `EXIT_CODE ${result.exitCode}`,
    '',
    'STDOUT',
    result.stdout || '',
    '',
    'STDERR',
    result.stderr || ''
  ].join('\n');

  // Keep evidence bounded. Full local process output remains available in the
  // runner terminal; MRAPI receives a useful tail without excessive tokens/data.
  const capped = combined.slice(-500000);

  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type: 'LOG',
    title: `Codex CLI execution ${taskId}`,
    description: `Codex CLI exited with code ${result.exitCode}`,
    filename: `codex-${taskId}.log`,
    content_type: 'text/plain; charset=utf-8',
    content_base64: Buffer.from(capped, 'utf8').toString('base64')
  });
}

async function completeExecution(runId, result) {
  const stdoutTail = String(result.stdout || '').slice(-50000);
  const stderrTail = String(result.stderr || '').slice(-20000);
  const success = result.success === true;

  return request(`/api/runner/runs/${encodeURIComponent(runId)}/complete`, {
    success,
    summary: success
      ? `Codex CLI completed automatically with exit code ${result.exitCode}.`
      : `Codex CLI failed with exit code ${result.exitCode}.`,
    error: success ? null : (stderrTail || `Codex exit code ${result.exitCode}`),
    output: {
      executor_mode: 'CODEX_CLI_AUTO',
      exit_code: result.exitCode,
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail
    }
  });
}

async function executeClaim(claim) {
  const { task, run: executionRun } = claim;
  const codexHandoff = claim.codex_handoff || task.codex_handoff || null;
  const handoffTask = codexHandoff ? { ...task, codex_handoff: codexHandoff } : task;
  currentRunId = executionRun.id;

  try {
    console.log('[SHADOW] EXECUTION', task.id, executionRun.id);
    await progress(executionRun.id, 10, 'Starting automatic Codex CLI execution');

    const prompt = buildCodexPrompt({
      task: handoffTask,
      executionRun: { ...executionRun, codex_handoff: codexHandoff },
      cfg
    });

    const result = await runCodexCommand({
      cfg,
      prompt,
      onOutput(text, stream) {
        const clean = String(text || '').trimEnd();
        if (clean) console.log(`[CODEX ${stream.toUpperCase()}]`, clean);
      },
      onProgress(percent, message) {
        return progress(executionRun.id, Math.max(10, Math.min(95, percent)), message);
      }
    });

    try {
      await addLogEvidence(executionRun.id, task.id, result);
    } catch (evidenceError) {
      console.error('[SHADOW EVIDENCE ERROR]', evidenceError.message);
    }

    const completion = await completeExecution(executionRun.id, result);

    console.log(
      result.success ? '[SHADOW] COMPLETE' : '[SHADOW] FAILED',
      task.id,
      executionRun.id,
      completion?.result_id || ''
    );
  } catch (error) {
    console.error('[SHADOW TASK ERROR]', error.message);

    if (error.message === 'CODEX_COMMAND_NOT_FOUND') {
      await markWaiting(
        task.id,
        'Codex CLI is not installed/configured on Shadow. Install/sign in once, then retry.',
        {
          type: 'CODEX_CLI_SETUP_REQUIRED',
          repository_path: cfg.repoPath,
          execution_run_id: executionRun.id
        }
      );
      console.log('[SHADOW] WAITING_CODEX_CLI_SETUP', task.id);
      return;
    }

    try {
      await request(`/api/runner/runs/${encodeURIComponent(executionRun.id)}/complete`, {
        success: false,
        summary: `Automatic Codex execution failed: ${error.message}`,
        error: String(error.stack || error.message).slice(0, 5000),
        output: {
          executor_mode: 'CODEX_CLI_AUTO',
          runner_error: error.message
        }
      });
    } catch (secondary) {
      console.error('[SHADOW COMPLETE ERROR]', secondary.message);
    }
  } finally {
    currentRunId = null;
  }
}

async function loop() {
  console.log('[SHADOW] registering', cfg.executorId, cfg.workerIds);
  await register();
  console.log('[SHADOW] registered');
  console.log('[SHADOW] repo', cfg.repoPath);
  console.log('[SHADOW] Codex mode: CLI AUTO');
  console.log('[SHADOW] configured command', cfg.codexCommand || 'auto-detect codex/codex.cmd');

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) =>
      console.error('[SHADOW HEARTBEAT ERROR]', error.message)
    );
  }, 30000);

  try {
    while (!stopping) {
      await heartbeat();

      const claim = await request('/api/runner/next-task', {
        executor_id: cfg.executorId,
        repository_path: cfg.repoPath
      });

      if (claim) {
        console.log(
          '[SHADOW] claimed',
          claim.task.id,
          claim.run.id,
          claim.run.run_type
        );
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
