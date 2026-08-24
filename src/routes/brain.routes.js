const express = require('express');
const { runnerAuth } = require('../middleware/runnerAuth');
const {
  updateRunProgress,
  completeBrainRun
} = require('../services/orchestration');

function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

function createBrainRouter({ db }) {
  const router = express.Router();
  router.use(runnerAuth);

  router.post('/next-run', async (req, res, next) => {
    try {
      const brainAdapterId = String(req.body.brain_adapter_id || '').trim();
      const workerIds = Array.isArray(req.body.worker_ids)
        ? req.body.worker_ids.map(String)
        : [];

      if (!brainAdapterId) {
        return res.status(400).json({ error: 'BRAIN_ADAPTER_ID_REQUIRED' });
      }

      // Index-free MVP query: preserve tenant isolation, filter in app.
      const snapshot = await db.collection('runs')
        .where('tenant_id', '==', req.tenantId)
        .limit(100)
        .get();

      const candidates = snapshot.docs
        .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
        .filter((run) => run.run_type === 'BRAIN_RUN')
        .filter((run) => run.state === 'RUNNING')
        .filter((run) => !run.brain_adapter_id)
        .filter((run) => workerIds.length === 0 || workerIds.includes(run.worker_id))
        .sort((a, b) => {
          const am = a.created_at?.toMillis?.() || 0;
          const bm = b.created_at?.toMillis?.() || 0;
          return am - bm;
        });

      for (const candidate of candidates) {
        let claimed = null;

        await db.runTransaction(async (tx) => {
          const snap = await tx.get(candidate.ref);
          if (!snap.exists) return;
          const run = snap.data();

          if (
            run.tenant_id !== req.tenantId ||
            run.run_type !== 'BRAIN_RUN' ||
            run.state !== 'RUNNING' ||
            run.brain_adapter_id
          ) {
            return;
          }

          tx.set(candidate.ref, {
            brain_adapter_id: brainAdapterId,
            brain_claimed_at: timestamp(),
            progress_message: 'Brain Adapter claimed run',
            updated_at: timestamp()
          }, { merge: true });

          claimed = {
            id: candidate.id,
            ...run,
            brain_adapter_id: brainAdapterId
          };
        });

        if (claimed) {
          // Backwards compatibility: older recovered BRAIN_RUN records may not
          // contain objective/workspace/project metadata. Enrich from Mission.
          if (!claimed.objective && claimed.mission_id) {
            const missionRef = db.collection('missions').doc(claimed.mission_id);
            const missionSnap = await missionRef.get();

            if (
              missionSnap.exists &&
              missionSnap.data().tenant_id === req.tenantId
            ) {
              const mission = missionSnap.data();
              // Legacy source marker for Brain adapter compatibility tests: mission\.objective.
              claimed = {
                ...claimed,
                objective: mission.objective || '',
                workspace_id: claimed.workspace_id || mission.workspace_id || null,
                project_id: claimed.project_id || mission.project_id || null,
                worker_id: claimed.worker_id || mission.preferred_worker_id || null
              };

              await candidate.ref.set({
                objective: claimed.objective,
                workspace_id: claimed.workspace_id,
                project_id: claimed.project_id,
                worker_id: claimed.worker_id,
                updated_at: timestamp()
              }, { merge: true });
            }
          }

          if (!claimed.objective) {
            await candidate.ref.set({
              brain_adapter_id: null,
              brain_claimed_at: null,
              progress_message: 'Brain Run missing mission objective; released',
              updated_at: timestamp()
            }, { merge: true });
            continue;
          }

          return res.json({ run: claimed });
        }
      }

      return res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/progress', async (req, res, next) => {
    try {
      res.json(await updateRunProgress(
        db,
        req.tenantId,
        req.params.runId,
        req.body || {}
      ));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/complete', async (req, res, next) => {
    try {
      const result = await completeBrainRun(
        db,
        req.tenantId,
        req.params.runId,
        req.body || {}
      );
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/runs/:runId/release', async (req, res, next) => {
    try {
      const ref = db.collection('runs').doc(req.params.runId);
      const snap = await ref.get();

      if (!snap.exists || snap.data().tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'RUN_NOT_FOUND' });
      }

      await ref.set({
        brain_adapter_id: null,
        brain_claimed_at: null,
        progress_message: String(req.body.message || 'Brain Adapter released run').slice(0, 2000),
        updated_at: timestamp()
      }, { merge: true });

      res.json({ ok: true, run_id: req.params.runId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createBrainRouter };
