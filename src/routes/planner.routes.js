const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  approvePlannerRoadmap
} = require('../services/planner');

function createPlannerRouter({ db }) {
  const router = express.Router();

  router.post('/requests', async (req, res, next) => {
    try {
      const created = await createPlannerRequest(db, req.tenantId, req.body || {});
      if (req.body?.proposal || req.body?.roadmap_proposal || req.body?.output_text) {
        const proposal = await completePlannerBrainRun(db, req.tenantId, created.brain_run_id, req.body || {});
        return res.status(201).json(serializeFirestore(proposal));
      }
      return res.status(202).json(serializeFirestore(created));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.get('/proposals/:proposalId', async (req, res, next) => {
    try {
      res.json(serializeFirestore(await getPlannerProposal(db, req.tenantId, req.params.proposalId)));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/roadmaps/:roadmapId/approve', async (req, res, next) => {
    try {
      const actorId = req.user?.id || req.auth?.user_id || req.auth?.userId || null;
      const requestId = req.id || req.requestId || null;
      const approved = await approvePlannerRoadmap(db, req.tenantId, req.params.roadmapId, {
        ...(req.body || {}),
        actor_id: actorId,
        request_id: requestId
      });
      res.json(serializeFirestore(approved));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createPlannerRouter };
