/**
 * MRAPI Shadow Runner v0.2-alpha
 *
 * This is the transport/worker-loop only.
 * It intentionally does NOT launch Codex yet.
 * v0.2 proves registration, heartbeat and safe task claiming.
 *
 * The next executor adapter will replace executeTaskStub().
 */

const cfg = {
  baseUrl: process.env.MRAPI_BASE_URL,
  tenantId: process.env.MRAPI_TENANT_ID || 'tenant_facundo_group',
  executorId: process.env.MRAPI_EXECUTOR_ID || 'executor_shadow_codex_01',
  hostName: process.env.MRAPI_HOST_NAME || 'Shadow',
  executorName: process.env.MRAPI_EXECUTOR_NAME || 'Codex',
  secret: process.env.MRAPI_RUNNER_SECRET || '',
  workerIds: String(process.env.MRAPI_WORKER_IDS || 'W01')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  pollMs: Math.max(5000, Number(process.env.MRAPI_POLL_SECONDS || 10) * 1000)
};

if (!cfg.baseUrl) throw new Error('MRAPI_BASE_URL is required.');
if (!cfg.secret) throw new Error('MRAPI_RUNNER_SECRET is required.');

let currentRunId = null;
let stopping = false;

async function request(path, body = {}) {
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runner-secret': cfg.secret,
      'x-tenant-id': cfg.tenantId
    },
    body: JSON.stringify(body)
  });

  if (response.status === 204) return null;
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`${response.status} ${data.error || data.message || text}`);
  }
  return data;
}

async function register() {
  return request('/api/runner/register', {
    executor_id: cfg.executorId,
    name: cfg.executorName,
    executor_type: 'CODEX',
    host_name: cfg.hostName,
    host_type: 'SHADOW',
    runner_version: 'v0.2-alpha',
    capabilities: ['EXECUTION_RUN', 'LOG', 'FILE', 'SCREENSHOT', 'TEST_RESULT'],
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

async function evidenceText(runId, title, text) {
  const content = Buffer.from(String(text), 'utf8').toString('base64');
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type: 'LOG',
    title,
    filename: 'runner-log.txt',
    content_type: 'text/plain; charset=utf-8',
    content_base64: content
  });
}

/**
 * SAFETY:
 * This stub does NOT execute the mission.
 * It reports that the transport loop works and deliberately fails the run
 * so no mission can be falsely marked successful before the Codex adapter exists.
 */
async function executeTaskStub(claim) {
  const { task, run } = claim;
  currentRunId = run.id;

  try {
    await progress(run.id, 5, `Claimed task ${task.id} for ${task.worker_id}`);
    await evidenceText(
      run.id,
      'Shadow Runner transport validation',
      `Runner received task ${task.id}\nMission: ${task.mission_id}\nWorker: ${task.worker_id}\nObjective: ${task.objective}\n`
    );

    await request(`/api/runner/runs/${encodeURIComponent(run.id)}/complete`, {
      success: false,
      summary: 'Shadow Runner transport is connected, but Codex executor adapter is not enabled yet.',
      error: 'EXECUTOR_ADAPTER_NOT_IMPLEMENTED'
    });
  } finally {
    currentRunId = null;
  }
}

async function loop() {
  console.log('[SHADOW] registering', cfg.executorId, cfg.workerIds);
  await register();
  console.log('[SHADOW] registered');

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
        console.log('[SHADOW] claimed', claim.task.id, claim.run.id);
        await executeTaskStub(claim);
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
