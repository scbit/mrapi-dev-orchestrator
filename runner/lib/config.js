const path = require('path');
const os = require('os');

function csv(value, fallback = '') {
  return String(value || fallback).split(',').map((x) => x.trim()).filter(Boolean);
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const cfg = {
  baseUrl: process.env.MRAPI_BASE_URL,
  tenantId: process.env.MRAPI_TENANT_ID || 'tenant_facundo_group',
  executorId: process.env.MRAPI_EXECUTOR_ID || 'executor_shadow_codex_01',
  hostName: process.env.MRAPI_HOST_NAME || 'Shadow',
  executorName: process.env.MRAPI_EXECUTOR_NAME || 'Codex',
  secret: process.env.MRAPI_RUNNER_SECRET || '',
  workerIds: csv(process.env.MRAPI_WORKER_IDS, 'W01'),
  pollMs: Math.max(5000, Number(process.env.MRAPI_POLL_SECONDS || 10) * 1000),
  repoPath: process.env.MRAPI_REPO_PATH || path.join(
    os.homedir(), 'Documents', 'GitHub', 'mrapi-dev-orchestrator'
  ),
  brainChatUrlW01: process.env.MRAPI_W01_CHAT_URL || '',
  chromeUserDataDir: process.env.MRAPI_CHROME_PROFILE_DIR || path.join(
    os.homedir(), 'AppData', 'Local', 'MRAPI', 'chrome-w01'
  ),
  chromeChannel: process.env.MRAPI_CHROME_CHANNEL || 'chrome',
  brainTimeoutMs: Math.max(
    60000,
    Number(process.env.MRAPI_BRAIN_TIMEOUT_SECONDS || 600) * 1000
  ),
  codexCommand: process.env.MRAPI_CODEX_COMMAND || '',
  codexTimeoutMs: Math.max(
    60000,
    Number(process.env.MRAPI_CODEX_TIMEOUT_SECONDS || 1800) * 1000
  ),
  codexAppCommand: process.env.MRAPI_CODEX_APP_COMMAND || '',
  codexAutoClipboard: bool(process.env.MRAPI_CODEX_AUTO_CLIPBOARD, true),
  codexHandoffDir: process.env.MRAPI_CODEX_HANDOFF_DIR || path.join(
    os.homedir(), 'AppData', 'Local', 'MRAPI', 'codex-handoffs'
  )
};

module.exports = { cfg };
