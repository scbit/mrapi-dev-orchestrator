const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const {
  CONFIGURATION_INCOMPLETE,
  PROVIDER_CHATGPT_WEB,
  assertNoSecretBrainBindingFields,
  brainRuntimeConfigForWorker,
  redactSecretLikeFields,
  workerOperationalPresentation
} = require('../services/worker-brain-binding');

const BRAIN_BINDING_ALLOWED_FIELDS = new Set(['provider', 'chat_binding', 'role', 'instructions']);

function workerReadModel(worker) {
  const safeWorker = redactSecretLikeFields(worker);
  const brainRuntimeConfig = brainRuntimeConfigForWorker(safeWorker);
  const operationalPresentation = workerOperationalPresentation(safeWorker);

  return {
    ...safeWorker,
    brain_runtime_config: brainRuntimeConfig,
    operational_presentation: operationalPresentation,
    configuration_status: operationalPresentation.configuration_status
  };
}

function disallowedBrainBindingFields(body) {
  return Object.keys(body || {}).filter((field) => !BRAIN_BINDING_ALLOWED_FIELDS.has(field));
}

function createWorkersRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const workers = await repos.workers.listByTenant(req.tenantId);
      workers.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      res.json({ items: serializeFirestore(workers.map(workerReadModel)), total: workers.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:workerId', async (req, res, next) => {
    try {
      const worker = await repos.workers.getById(req.params.workerId);
      if (!worker || worker.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
      }
      res.json(serializeFirestore(workerReadModel(worker)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:workerId/brain-chat-binding', async (req, res, next) => {
    try {
      const worker = await repos.workers.getById(req.params.workerId);
      if (!worker || worker.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
      }

      const body = req.body || {};
      assertNoSecretBrainBindingFields(body);

      const disallowed = disallowedBrainBindingFields(body);
      if (disallowed.length) {
        return res.status(400).json({
          error: 'BRAIN_BINDING_FIELDS_NOT_ALLOWED',
          fields: disallowed
        });
      }

      if (body.provider !== PROVIDER_CHATGPT_WEB) {
        return res.status(400).json({ error: 'UNSUPPORTED_BRAIN_BINDING_PROVIDER' });
      }

      if (typeof body.chat_binding !== 'string' || !body.chat_binding.trim()) {
        return res.status(400).json({ error: 'BRAIN_CHAT_BINDING_REQUIRED' });
      }

      const updated = await repos.workers.setBrainChatBinding(req.params.workerId, req.tenantId, {
        version: 1,
        provider: PROVIDER_CHATGPT_WEB,
        chat_binding: body.chat_binding,
        role: body.role,
        instructions: body.instructions,
        configuration_state: CONFIGURATION_INCOMPLETE
      });

      res.json(serializeFirestore(workerReadModel(updated)));
    } catch (error) {
      if (/secret-like field/i.test(error.message)) {
        return res.status(400).json({ error: 'BRAIN_BINDING_SECRET_FIELDS_NOT_ALLOWED' });
      }
      next(error);
    }
  });

  return router;
}

module.exports = { createWorkersRouter };
