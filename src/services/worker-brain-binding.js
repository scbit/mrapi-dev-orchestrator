const PROVIDER_CHATGPT_WEB = 'CHATGPT_WEB';
const CONFIGURATION_INCOMPLETE = 'CONFIGURATION_INCOMPLETE';
const READY = 'READY';
const SOURCE_PERSISTED = 'PERSISTED';
const SOURCE_LEGACY_W01_FALLBACK = 'LEGACY_W01_FALLBACK';
const SOURCE_NONE = 'NONE';

const SECRET_FIELD_NAMES = new Set([
  'password',
  'passwd',
  'cookie',
  'cookies',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'authheader',
  'secret',
  'runnersecret',
  'apikey',
  'chromesession',
  'browsersession'
]);

function normalizedKeyName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(message);
  }
}

function assertNoSecretBrainBindingFields(input, path = []) {
  if (!input || typeof input !== 'object') return;

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      assertNoSecretBrainBindingFields(input[index], path.concat(String(index)));
    }
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizedKeyName(key);
    if (SECRET_FIELD_NAMES.has(normalized)) {
      const fieldPath = path.concat(key).join('.');
      throw new Error(`Brain chat binding contains secret-like field: ${fieldPath}`);
    }
    assertNoSecretBrainBindingFields(value, path.concat(key));
  }
}

function normalizeOptionalString(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string or null`);
  }
  return value.trim();
}

function normalizeBrainChatBinding(input) {
  assertPlainObject(input, 'Brain chat binding must be an object');
  assertNoSecretBrainBindingFields(input);

  if (input.version !== undefined && input.version !== 1 && input.version !== '1') {
    throw new Error('Unsupported brain chat binding version');
  }

  if (input.provider !== PROVIDER_CHATGPT_WEB) {
    throw new Error('Unsupported brain chat binding provider');
  }

  if (typeof input.chat_binding !== 'string') {
    throw new TypeError('chat_binding must be a non-empty string');
  }
  const chatBinding = input.chat_binding.trim();
  if (!chatBinding) {
    throw new Error('chat_binding must be a non-empty string');
  }

  const configurationState = input.configuration_state ?? CONFIGURATION_INCOMPLETE;
  if (![CONFIGURATION_INCOMPLETE, READY].includes(configurationState)) {
    throw new Error('Unsupported brain chat binding configuration_state');
  }

  return {
    version: 1,
    provider: PROVIDER_CHATGPT_WEB,
    chat_binding: chatBinding,
    role: normalizeOptionalString(input.role, 'role'),
    instructions: normalizeOptionalString(input.instructions, 'instructions'),
    configuration_state: configurationState
  };
}

function getWorkerId(worker) {
  return worker?.id ?? worker?.worker_id ?? worker?.workerId ?? null;
}

function hasPersistedBinding(worker) {
  return Object.prototype.hasOwnProperty.call(worker || {}, 'brain_chat_binding');
}

function brainBindingReadiness(worker) {
  if (!hasPersistedBinding(worker)) return CONFIGURATION_INCOMPLETE;

  try {
    const binding = normalizeBrainChatBinding(worker.brain_chat_binding);
    if (
      binding.provider === PROVIDER_CHATGPT_WEB
      && binding.chat_binding
      && binding.configuration_state === READY
    ) {
      return READY;
    }
  } catch (_) {
    return CONFIGURATION_INCOMPLETE;
  }

  return CONFIGURATION_INCOMPLETE;
}

function legacyW01ChatBinding(legacyConfig) {
  if (!legacyConfig) return null;

  if (typeof legacyConfig.chatUrlForWorker === 'function') {
    const chatUrl = legacyConfig.chatUrlForWorker('W01');
    if (typeof chatUrl === 'string' && chatUrl.trim()) return chatUrl.trim();
  }

  const configuredUrl = legacyConfig.brainChatUrls?.W01;
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  return null;
}

function incompleteResolution(source = SOURCE_NONE, extra = {}) {
  return {
    source,
    readiness: CONFIGURATION_INCOMPLETE,
    configuration_state: CONFIGURATION_INCOMPLETE,
    binding: null,
    ...extra
  };
}

function readyResolution(source, binding) {
  return {
    source,
    readiness: READY,
    configuration_state: READY,
    binding
  };
}

function resolveWorkerBrainBinding(worker, legacyConfig = {}) {
  if (hasPersistedBinding(worker)) {
    try {
      const binding = normalizeBrainChatBinding(worker.brain_chat_binding);
      if (binding.configuration_state === READY) {
        return readyResolution(SOURCE_PERSISTED, binding);
      }
      return incompleteResolution(SOURCE_PERSISTED, { binding });
    } catch (error) {
      return incompleteResolution(SOURCE_PERSISTED, {
        error: error.message
      });
    }
  }

  if (getWorkerId(worker) === 'W01') {
    const fallbackChatBinding = legacyW01ChatBinding(legacyConfig);
    if (fallbackChatBinding) {
      return readyResolution(SOURCE_LEGACY_W01_FALLBACK, {
        version: 1,
        provider: PROVIDER_CHATGPT_WEB,
        chat_binding: fallbackChatBinding,
        role: null,
        instructions: null,
        configuration_state: READY
      });
    }
  }

  return incompleteResolution(SOURCE_NONE);
}

module.exports = {
  PROVIDER_CHATGPT_WEB,
  CONFIGURATION_INCOMPLETE,
  READY,
  SOURCE_PERSISTED,
  SOURCE_LEGACY_W01_FALLBACK,
  SOURCE_NONE,
  assertNoSecretBrainBindingFields,
  normalizeBrainChatBinding,
  brainBindingReadiness,
  resolveWorkerBrainBinding
};
