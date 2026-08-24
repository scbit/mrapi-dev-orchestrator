const express = require('express');
const { runnerAuth } = require('../middleware/runnerAuth');
const { serializeFirestore } = require('../utils/firestore');
const {
  registerExecutor,
  heartbeatExecutor,
  claimNextTask,
  updateRunProgress,
  addEvidence,
  completeRun
} = require('../services/orchestration');

function createRunnerRouter({ db }) {
  const router = express.Router();
  router.use(runnerAuth);

  router.post('/register', async (req, res, next) => {
    try {
      const executor = await registerExecutor(db, req.tenantId, req.body || {});
      res.status(201).json(serializeFirestore(executor));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/heartbeat', async (req, res, next) => {
    try {
      const executorId = String(req.body.executor_id || '').trim();
      if (!executorId) return res.status(400).json({ error: 'EXECUTOR_ID_REQUIRED' });

      const result = await heartbeatExecutor(db, req.tenantId, executorId, req.body);
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/next-task', async (req, res, next) => {
    try {
      const executorId = String(req.body.executor_id || '').trim();
      if (!executorId) return res.status(400).json({ error: 'EXECUTOR_ID_REQUIRED' });

      const claimed = await claimNextTask(db, req.tenantId, executorId);
      if (!claimed) return res.status(204).end();

      res.json(serializeFirestore(claimed));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/progress', async (req, res, next) => {
    try {
      const result = await updateRunProgress(db, req.tenantId, req.params.runId, req.body || {});
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/evidence', async (req, res, next) => {
    try {
      const evidence = await addEvidence(db, req.tenantId, req.params.runId, req.body || {});
      res.status(201).json(serializeFirestore(evidence));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/complete', async (req, res, next) => {
    try {
      const result = await completeRun(db, req.tenantId, req.params.runId, req.body || {});
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createRunnerRouter };
