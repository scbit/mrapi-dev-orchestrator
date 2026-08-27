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
const { completeGitStageExecutionRun } = require('../services/autopilot');

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
      console.error('[RUNNER NEXT_TASK ERROR]', {
        endpoint: '/api/runner/next-task',
        action: 'claim_next_task',
        tenant_id: req.tenantId,
        executor_id: String(req.body?.executor_id || '').trim() || null,
        worker_ids: Array.isArray(req.body?.worker_ids) ? req.body.worker_ids : undefined,
        capabilities: Array.isArray(req.body?.capabilities) ? req.body.capabilities : undefined,
        code: error.code || null,
        error: error.message,
        stack: error.stack
      });
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({
        error: 'RUNNER_CLAIM_INTERNAL_ERROR',
        detail: String(error.message || 'Unexpected runner claim failure').slice(0, 500)
      });
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

  router.post('/runs/:runId/cancellation', async (req, res, next) => {
    try {
      const runRef = db.collection('runs').doc(req.params.runId);
      const runSnap = await runRef.get();
      if (!runSnap.exists || runSnap.data().tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'RUN_NOT_FOUND' });
      }

      const run = runSnap.data();
      let missionCancelled = false;
      if (run.mission_id) {
        const missionSnap = await db.collection('missions').doc(run.mission_id).get();
        missionCancelled = missionSnap.exists &&
          missionSnap.data().tenant_id === req.tenantId &&
          (missionSnap.data().state === 'CANCELLED' || missionSnap.data().cancellation_requested === true);
      }

      res.json({
        run_id: req.params.runId,
        cancellation_requested: run.cancellation_requested === true || missionCancelled
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/complete', async (req, res, next) => {
    try {
      const runSnap = await db.collection('runs').doc(req.params.runId).get();
      const run = runSnap.exists && runSnap.data().tenant_id === req.tenantId ? runSnap.data() : null;
      if (run?.mission_id && run?.task_id) {
        const missionSnap = await db.collection('missions').doc(run.mission_id).get();
        const taskSnap = await db.collection('tasks').doc(run.task_id).get();
        if (
          missionSnap.exists &&
          taskSnap.exists &&
          missionSnap.data().tenant_id === req.tenantId &&
          taskSnap.data().tenant_id === req.tenantId &&
          (missionSnap.data().autopilot_phase === 'GIT_STAGE' || taskSnap.data().autopilot_phase === 'GIT_STAGE')
        ) {
          return res.json(await completeGitStageExecutionRun(db, req.tenantId, req.params.runId, req.body || {}));
        }
      }
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
