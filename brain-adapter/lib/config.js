const path = require('path');
const os = require('os');
const fs = require('fs');

function csv(value, fallback = '') {
  return String(value || fallback)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const workerIds = csv(process.env.MRAPI_WORKER_IDS, 'W01');
const defaultWorkerId = workerIds[0] || 'W01';

const brainChatUrls = {
  W01: process.env.MRAPI_W01_CHAT_URL || '',
  W02: process.env.MRAPI_W02_CHAT_URL || '',
  W03: process.env.MRAPI_W03_CHAT_URL || '',
  W04: process.env.MRAPI_W04_CHAT_URL || '',
  W05: process.env.MRAPI_W05_CHAT_URL || ''
};

const chromeProfileNames = {
  W01: 'W01',
  W02: 'W02',
  W03: 'W03',
  W04: 'W04',
  W05: 'W05'
};

function chatUrlForWorker(workerId) {
  const id = String(workerId || '').toUpperCase();
  const url = brainChatUrls[id] || '';
  if (!url) throw new Error(`BRAIN_CHAT_NOT_CONFIGURED_FOR_${id || 'UNKNOWN'}`);
  return url;
}

function chromeUserDataDirForWorker(workerId) {
  const id = String(workerId || defaultWorkerId || 'W01').toUpperCase();
  const profileDir = path.join(__dirname, '..', 'chrome-profiles', chromeProfileNames[id] || id);
  fs.mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

const cfg = {
  baseUrl: process.env.MRAPI_BASE_URL,
  tenantId: process.env.MRAPI_TENANT_ID || 'tenant_facundo_group',
  secret: process.env.MRAPI_RUNNER_SECRET || '',
  brainAdapterId: process.env.MRAPI_BRAIN_ADAPTER_ID || 'brain_shadow_chatgpt_w01_01',
  hostName: process.env.MRAPI_HOST_NAME || os.hostname(),
  workerIds,
  brainChatUrls,
  chromeProfileNames,
  chatUrlForWorker,
  pollMs: Math.max(5000, Number(process.env.MRAPI_POLL_SECONDS || 10) * 1000),
  repoPath: process.env.MRAPI_REPO_PATH || path.join(
    os.homedir(), 'Documents', 'GitHub', 'mrapi-dev-orchestrator'
  ),
  brainChatUrlW01: brainChatUrls.W01,
  brainChatUrlW02: brainChatUrls.W02,
  brainChatUrlW03: brainChatUrls.W03,
  brainChatUrlW04: brainChatUrls.W04,
  brainChatUrlW05: brainChatUrls.W05,
  chromeUserDataDir: chromeUserDataDirForWorker(defaultWorkerId),
  chromeUserDataDirForWorker,
  chromeChannel: process.env.MRAPI_CHROME_CHANNEL || 'chrome',
  brainTimeoutMs: Math.max(
    60000,
    Number(process.env.MRAPI_BRAIN_TIMEOUT_SECONDS || 600) * 1000
  )
};

module.exports = { cfg, chatUrlForWorker, chromeUserDataDirForWorker, chromeProfileNames };
