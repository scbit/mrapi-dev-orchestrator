const path = require('path');
const os = require('os');

function csv(value, fallback = '') {
  return String(value || fallback)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const cfg = {
  baseUrl: process.env.MRAPI_BASE_URL,
  tenantId: process.env.MRAPI_TENANT_ID || 'tenant_facundo_group',
  secret: process.env.MRAPI_RUNNER_SECRET || '',
  brainAdapterId: process.env.MRAPI_BRAIN_ADAPTER_ID || 'brain_shadow_chatgpt_w01_01',
  workerIds: csv(process.env.MRAPI_WORKER_IDS, 'W01'),
  pollMs: Math.max(5000, Number(process.env.MRAPI_POLL_SECONDS || 10) * 1000),
  repoPath: process.env.MRAPI_REPO_PATH || path.join(
    os.homedir(), 'Documents', 'GitHub', 'mrapi-dev-orchestrator'
  ),
  brainChatUrlW01: process.env.MRAPI_W01_CHAT_URL || '',
  chromeUserDataDir: process.env.MRAPI_CHROME_PROFILE_DIR ||
    path.join(os.homedir(), 'AppData', 'Local', 'MRAPI', 'chrome-w01'),
  chromeChannel: process.env.MRAPI_CHROME_CHANNEL || 'chrome',
  brainTimeoutMs: Math.max(
    60000,
    Number(process.env.MRAPI_BRAIN_TIMEOUT_SECONDS || 600) * 1000
  )
};

module.exports = { cfg };
