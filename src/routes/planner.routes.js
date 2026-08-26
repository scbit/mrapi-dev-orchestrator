const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const {
  createPlannerRequest,
  completePlannerBrainRun,
  getPlannerProposal,
  listRecentPlannerRequests,
  approvePlannerRoadmap,
  requestPlannerRoadmapChanges,
  startPlannerRoadmap
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

  router.get('/recent', async (req, res, next) => {
    try {
      const query = req.query || Object.fromEntries(new URLSearchParams(String(req.url || '').split('?')[1] || ''));
      res.json(serializeFirestore(await listRecentPlannerRequests(db, req.tenantId, {
        limit: query.limit
      })));
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

  router.post('/roadmaps/:roadmapId/request-changes', async (req, res, next) => {
    try {
      const revised = await requestPlannerRoadmapChanges(db, req.tenantId, req.params.roadmapId, req.body || {});
      res.status(revised.no_new_work ? 200 : 202).json(serializeFirestore(revised));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/roadmaps/:roadmapId/start', async (req, res, next) => {
    try {
      const roadmapId = req.params.roadmapId;
      const started = await startPlannerRoadmap(db, req.tenantId, roadmapId, req.body || {});
      const current = await getPlannerProposal(db, req.tenantId, roadmapId);
      const activeStates = new Set(['PLANNING', 'RUNNING', 'VERIFYING']);
      const currentMilestone = started.milestone?.id
        ? (current.milestones || []).find((milestone) => milestone.id === started.milestone.id) || started.milestone
        : (current.milestones || []).find((milestone) => activeStates.has(String(milestone.state || '').toUpperCase())) || null;
      res.status(started.no_new_work ? 200 : 201).json(serializeFirestore({
        ok: true,
        roadmap_id: started.roadmap?.id || roadmapId,
        state: current.state || started.roadmap?.state || null,
        approval_status: current.approval_status || started.roadmap?.approval_status || null,
        milestone_id: started.milestone?.id || null,
        mission_id: started.mission?.id || null,
        brain_run_id: started.brain_run?.id || null,
        current_milestone: currentMilestone,
        mission: started.mission || null,
        brain_run: started.brain_run || null,
        brain_context: started.brain_run?.brain_context || started.mission?.brain_context || null,
        reused: started.reused === true,
        no_new_work: started.no_new_work === true,
        already_complete: started.already_complete === true
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createPlannerRouter };
