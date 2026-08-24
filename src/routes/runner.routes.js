const express = require('express');
const { runnerAuth } = require('../middleware/runnerAuth');
const { serializeFirestore } = require('../utils/firestore');
const {
  registerExecutor,
  heartbeatExecutor,
  claimNextTask,
  updateRunProgress,
  completeBrainRun,
  startExecutionRun,
  markTaskWaiting,
  addEvidence,
  completeRun,
  completeManualCodexHandoff,
  recoverAbandonedBrainRuns
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
      res.json(await heartbeatExecutor(db, req.tenantId, executorId, req.body));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/next-task', async (req, res, next) => {
    try {
      const executorId = String(req.body.executor_id || '').trim();
      if (!executorId) return res.status(400).json({ error: 'EXECUTOR_ID_REQUIRED' });
      const claimed = await claimNextTask(db, req.tenantId, executorId, {
        repository_path: req.body?.repository_path || null
      });
      if (!claimed) return res.status(204).end();
      res.json(serializeFirestore(claimed));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/progress', async (req, res, next) => {
    try {
      res.json(await updateRunProgress(db, req.tenantId, req.params.runId, req.body || {}));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/brain-complete', async (req, res, next) => {
    try {
      res.json(await completeBrainRun(db, req.tenantId, req.params.runId, req.body || {}));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/tasks/:taskId/execution-start', async (req, res, next) => {
    try {
      const executorId = String(req.body.executor_id || '').trim();
      if (!executorId) return res.status(400).json({ error: 'EXECUTOR_ID_REQUIRED' });
      res.status(201).json(serializeFirestore(
        await startExecutionRun(db, req.tenantId, req.params.taskId, executorId)
      ));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/tasks/:taskId/waiting', async (req, res, next) => {
    try {
      res.json(await markTaskWaiting(
        db,
        req.tenantId,
        req.params.taskId,
        req.body.message || '',
        req.body.handoff || null
      ));
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
      res.json(await completeRun(db, req.tenantId, req.params.runId, req.body || {}));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });


  router.post('/tasks/:taskId/manual-codex-complete', async (req, res, next) => {
    try {
      res.json(await completeManualCodexHandoff(
        db,
        req.tenantId,
        req.params.taskId,
        req.body || {}
      ));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });


  router.post('/recover-abandoned', async (req, res, next) => {
    try {
      res.json(await recoverAbandonedBrainRuns(
        db,
        req.tenantId,
        req.body.executor_id,
        Number(req.body.stale_ms || 120000)
      ));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createRunnerRouter };
