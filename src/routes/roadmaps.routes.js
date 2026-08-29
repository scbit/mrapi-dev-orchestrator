const crypto = require('crypto');
const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const { normalizeRoadmapInput, nextMilestone } = require('../services/roadmap');
const { resolveRoadmapRuntime } = require('../services/milestoneRuntime');
const { saveMilestoneResponse } = require('../services/milestoneResponse');
const {
  createDownstreamImpactProposal,
  updateDownstreamImpactStatus
} = require('../services/downstreamImpact');

function now() {
  return new Date();
}

async function requireProject(repos, tenantId, projectId) {
  const project = await repos.projects.getById(projectId);
  if (!project || project.tenant_id !== tenantId) return null;
  return project;
}

function createRoadmapsRouter({ repos, db }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const projectId = String(req.query.project_id || '').trim();
      const items = projectId
        ? await repos.roadmaps.listByProject(req.tenantId, projectId)
        : await repos.roadmaps.listByTenant(req.tenantId);
      items.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      res.json({ items: serializeFirestore(items), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const projectId = String(req.body?.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'PROJECT_ID_REQUIRED' });
      const project = await requireProject(repos, req.tenantId, projectId);
      if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

      const payload = normalizeRoadmapInput(req.body || {});
      if (!payload.title || !payload.objective) {
        return res.status(400).json({ error: 'ROADMAP_TITLE_OBJECTIVE_REQUIRED' });
      }
      const id = String(req.body?.id || '').trim() || `roadmap_${crypto.randomUUID()}`;
      const created = await repos.roadmaps.upsert(id, {
        ...payload,
        tenant_id: req.tenantId,
        workspace_id: project.workspace_id,
        project_id: project.id,
        created_at: now(),
        updated_at: now()
      });
      res.status(201).json(serializeFirestore(created));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:roadmapId', async (req, res, next) => {
    try {
      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }
      const milestoneRuntime = await resolveRoadmapRuntime(db, req.tenantId, roadmap);
      res.json(serializeFirestore({
        ...roadmap,
        next_milestone: nextMilestone(roadmap),
        milestone_runtime: milestoneRuntime
      }));
    } catch (error) {
      next(error);
    }
  });

  router.put('/:roadmapId', async (req, res, next) => {
    try {
      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }
      const normalized = normalizeRoadmapInput(req.body || {}, roadmap);
      const updated = await repos.roadmaps.upsert(roadmap.id, {
        ...normalized,
        tenant_id: req.tenantId,
        updated_at: now()
      });
      res.json(serializeFirestore(updated));
    } catch (error) {
      next(error);
    }
  });


  router.post('/:roadmapId/reopen', async (req, res, next) => {
    try {
      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }

      const requestedMilestoneId = String(req.body?.milestone_id || '').trim();
      let reopenedMilestoneId = null;
      const milestones = (roadmap.milestones || []).map((item) => {
        const shouldReopen = requestedMilestoneId
          ? item.id === requestedMilestoneId && item.state === 'BLOCKED'
          : reopenedMilestoneId === null && item.state === 'BLOCKED';
        if (!shouldReopen) return item;
        reopenedMilestoneId = item.id;
        if (item.mission_id) {
          return {
            ...item,
            state: 'BLOCKED',
            updated_at: now()
          };
        }
        return {
          ...item,
          state: 'PENDING',
          mission_id: null,
          verification_brain_run_id: null,
          started_at: null,
          completed_at: null,
          blocked_at: null,
          blocker_code: null,
          blocker_message: null,
          updated_at: now()
        };
      });

      const roadmapOnlyReopen = !reopenedMilestoneId && roadmap.state === 'BLOCKED';
      if (!reopenedMilestoneId && !roadmapOnlyReopen) {
        return res.status(409).json({ error: 'NO_BLOCKED_MILESTONE_TO_REOPEN' });
      }

      const updated = await repos.roadmaps.upsert(roadmap.id, {
        milestones,
        state: 'ACTIVE',
        blocker_code: null,
        blocker_message: null,
        blocked_at: null,
        updated_at: now()
      });

      res.json(serializeFirestore({
        ...updated,
        reopened_milestone_id: reopenedMilestoneId,
        reopened_roadmap_only: roadmapOnlyReopen,
        next_milestone: nextMilestone(updated)
      }));
    } catch (error) {
      next(error);
    }
  });


  router.post('/:roadmapId/advance', async (req, res, next) => {
    try {
      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }
      res.status(409).json({ error: 'ROADMAP_LIFECYCLE_MANAGED_BY_AUTOPILOT' });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:roadmapId/milestones/:milestoneId/respond', async (req, res, next) => {
    try {
      const response = await saveMilestoneResponse(
        db,
        req.tenantId,
        req.params.roadmapId,
        req.params.milestoneId,
        req.body || {}
      );
      res.status(201).json(serializeFirestore({
        evidence_id: response.evidence_id,
        id: response.id,
        roadmap_id: response.roadmap_id,
        milestone_id: response.milestone_id,
        mission_id: response.mission_id
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:roadmapId/milestones/:milestoneId/downstream-impact', async (req, res, next) => {
    try {
      const proposal = await createDownstreamImpactProposal(
        db,
        req.tenantId,
        req.params.roadmapId,
        req.params.milestoneId,
        req.body || {}
      );
      res.status(201).json(serializeFirestore({
        impact_id: proposal.impact_id,
        evidence_id: proposal.evidence_id,
        id: proposal.id,
        status: proposal.status,
        roadmap_id: proposal.roadmap_id,
        source_milestone_id: proposal.source_milestone_id,
        mission_id: proposal.mission_id,
        affected_milestone_ids: proposal.affected_milestone_ids,
        reason: proposal.reason
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:roadmapId/milestones/:milestoneId/downstream-impact/:impactId/approve', async (req, res, next) => {
    try {
      const proposal = await updateDownstreamImpactStatus(
        db,
        req.tenantId,
        req.params.roadmapId,
        req.params.milestoneId,
        req.params.impactId,
        'APPROVED',
        req.body || {}
      );
      res.json(serializeFirestore({
        impact_id: proposal.impact_id,
        evidence_id: proposal.evidence_id,
        id: proposal.id,
        status: proposal.status,
        roadmap_id: proposal.roadmap_id,
        source_milestone_id: proposal.source_milestone_id,
        mission_id: proposal.mission_id,
        affected_milestone_ids: proposal.affected_milestone_ids,
        reason: proposal.reason,
        approval: proposal.approval,
        approved_at: proposal.approved_at,
        approved_by: proposal.approved_by,
        approval_source: proposal.approval_source
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:roadmapId/milestones/:milestoneId/downstream-impact/:impactId/reject', async (req, res, next) => {
    try {
      const proposal = await updateDownstreamImpactStatus(
        db,
        req.tenantId,
        req.params.roadmapId,
        req.params.milestoneId,
        req.params.impactId,
        'REJECTED',
        req.body || {}
      );
      res.json(serializeFirestore({
        impact_id: proposal.impact_id,
        evidence_id: proposal.evidence_id,
        id: proposal.id,
        status: proposal.status,
        roadmap_id: proposal.roadmap_id,
        source_milestone_id: proposal.source_milestone_id,
        mission_id: proposal.mission_id,
        affected_milestone_ids: proposal.affected_milestone_ids,
        reason: proposal.reason,
        rejected_at: proposal.rejected_at,
        rejected_by: proposal.rejected_by,
        rejection_source: proposal.rejection_source
      }));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:roadmapId/milestones/:milestoneId/state', async (req, res, next) => {
    try {
      const roadmap = await repos.roadmaps.getById(req.params.roadmapId);
      if (!roadmap || roadmap.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'ROADMAP_NOT_FOUND' });
      }
      const found = (roadmap.milestones || []).some((item) => item.id === req.params.milestoneId);
      if (!found) return res.status(404).json({ error: 'MILESTONE_NOT_FOUND' });
      res.status(409).json({ error: 'ROADMAP_MILESTONE_STATE_MANAGED_BY_AUTOPILOT' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRoadmapsRouter };
