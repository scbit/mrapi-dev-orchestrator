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
const { confirmHumanActionReady } = require('../services/autopilot');

function normalizeHumanActionStatus(checkpoint = {}) {
  return String(checkpoint.status || checkpoint.waiting_status || checkpoint.checkpoint_status || '').trim().toUpperCase();
}

function unresolvedHumanActionCheckpoint(milestone = {}) {
  const checkpoint = milestone?.human_action_checkpoint || milestone?.human_action || null;
  if (!checkpoint || checkpoint.human_action_required !== true) return null;
  const status = normalizeHumanActionStatus(checkpoint);
  return status === 'WAITING_FOR_HUMAN' || status === 'NEED_HUMAN_ACTION' ? checkpoint : null;
}

function withActiveHumanActionContext(proposal, tenantId) {
  const milestones = Array.isArray(proposal?.milestones) ? proposal.milestones : [];
  const milestone = milestones.find((item) => unresolvedHumanActionCheckpoint(item)) || null;
  const checkpoint = milestone ? unresolvedHumanActionCheckpoint(milestone) : null;
  if (!milestone || !checkpoint?.checkpoint_id) return proposal;
  return {
    ...proposal,
    tenant_id: tenantId,
    current_human_action_checkpoint_id: checkpoint.checkpoint_id,
    active_human_action_checkpoint_id: checkpoint.checkpoint_id,
    current_human_action_milestone_id: checkpoint.milestone_id || milestone.id || null,
    current_human_action_mission_id: checkpoint.mission_id || milestone.mission_id || null,
    active_human_action: {
      checkpoint_id: checkpoint.checkpoint_id,
      tenant_id: checkpoint.tenant_id || tenantId,
      roadmap_id: checkpoint.roadmap_id || proposal.roadmap_id || proposal.proposal_id || proposal.id || null,
      milestone_id: checkpoint.milestone_id || milestone.id || null,
      mission_id: checkpoint.mission_id || milestone.mission_id || null,
      status: normalizeHumanActionStatus(checkpoint)
    }
  };
}

function validateHumanActionReadyBody(body = {}) {
  const allowed = new Set(['ready', 'confirm', 'confirmed', 'listo']);
  for (const key of Object.keys(body || {})) {
    if (!allowed.has(key)) {
      const error = new Error('HUMAN_ACTION_READY_BODY_UNSUPPORTED_FIELD');
      error.status = 400;
      throw error;
    }
  }
  if (!(body.ready === true || body.confirm === true || body.confirmed === true || body.listo === true)) {
    const error = new Error('HUMAN_ACTION_READY_CONFIRMATION_REQUIRED');
    error.status = 400;
    throw error;
  }
}

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
      const proposal = await getPlannerProposal(db, req.tenantId, req.params.proposalId);
      res.json(serializeFirestore(withActiveHumanActionContext(proposal, req.tenantId)));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/proposals/:proposalId/human-action/:checkpointId/ready', async (req, res, next) => {
    try {
      validateHumanActionReadyBody(req.body || {});
      const result = await confirmHumanActionReady(
        db,
        req.tenantId,
        req.params.proposalId,
        req.params.checkpointId,
        req.body || {}
      );
      res.status(result.resumed === false ? 200 : 202).json(serializeFirestore(result));
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
