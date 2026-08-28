const express = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { MISSION_STATES } = require('../constants/states');
const { serializeFirestore } = require('../utils/firestore');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createMissionsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const missions = await repos.missions.listByTenant(req.tenantId);
      res.json({ items: serializeFirestore(missions), total: missions.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:missionId', async (req, res, next) => {
    try {
      const mission = await repos.missions.getById(req.params.missionId);
      if (!mission || mission.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'MISSION_NOT_FOUND' });
      }
      res.json(serializeFirestore(mission));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:missionId/recovery', async (req, res, next) => {
    try {
      const { getMissionRecoveryStatus } = require('../services/missionRecovery');
      res.json(serializeFirestore(await getMissionRecoveryStatus(
        repos.missions.db,
        req.tenantId,
        req.params.missionId
      )));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/recover', async (req, res, next) => {
    try {
      const { recoverMission } = require('../services/missionRecovery');
      const result = await recoverMission(
        repos.missions.db,
        req.tenantId,
        req.params.missionId
      );
      res.json(serializeFirestore(result));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.get('/:missionId/plan', async (req, res, next) => {
    try {
      const { getMissionPlan } = require('../services/orchestration');
      res.json(serializeFirestore(await getMissionPlan(repos.missions.db, req.tenantId, req.params.missionId)));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/plan/request-changes', async (req, res, next) => {
    try {
      const { requestMissionPlanChanges } = require('../services/orchestration');
      res.status(201).json(serializeFirestore(await requestMissionPlanChanges(
        repos.missions.db,
        req.tenantId,
        req.params.missionId,
        req.body || {}
      )));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/plan/approve', async (req, res, next) => {
    try {
      const { approveMissionPlan } = require('../services/orchestration');
      res.json(serializeFirestore(await approveMissionPlan(
        repos.missions.db,
        req.tenantId,
        req.params.missionId,
        req.body || {}
      )));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/dispatch', async (req, res, next) => {
    try {
      const { dispatchMission } = require('../services/orchestration');
      const brainRun = await dispatchMission(repos.missions.db, req.tenantId, req.params.missionId);
      res.status(brainRun.reused ? 200 : 201).json(serializeFirestore(brainRun));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/retry', async (req, res, next) => {
    try {
      const { retryMission } = require('../services/orchestration');
      const brainRun = await retryMission(repos.missions.db, req.tenantId, req.params.missionId);
      res.status(201).json(serializeFirestore(brainRun));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/cancel', async (req, res, next) => {
    try {
      const { cancelMission } = require('../services/orchestration');
      const result = await cancelMission(repos.missions.db, req.tenantId, req.params.missionId, req.body || {});
      res.json(serializeFirestore(result));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const objective = cleanString(req.body.objective || req.body.prompt);
      const workspaceId = cleanString(req.body.workspace_id);
      const projectId = cleanString(req.body.project_id);
      const preferredWorkerId = cleanString(req.body.preferred_worker_id);
      const priority = cleanString(req.body.priority || 'NORMAL').toUpperCase();

      if (objective.length < 3) {
        return res.status(400).json({
          error: 'INVALID_OBJECTIVE',
          message: 'Mission objective must contain at least 3 characters.'
        });
      }

      const workspace = await repos.workspaces.getById(workspaceId);
      if (!workspace || workspace.tenant_id !== req.tenantId) {
        return res.status(400).json({ error: 'INVALID_WORKSPACE' });
      }

      const project = await repos.projects.getById(projectId);
      if (
        !project ||
        project.tenant_id !== req.tenantId ||
        project.workspace_id !== workspaceId
      ) {
        return res.status(400).json({ error: 'INVALID_PROJECT' });
      }

      if (preferredWorkerId) {
        const worker = await repos.workers.getById(preferredWorkerId);
        if (
          !worker ||
          worker.tenant_id !== req.tenantId ||
          worker.workspace_id !== workspaceId
        ) {
          return res.status(400).json({ error: 'INVALID_PREFERRED_WORKER' });
        }
      }

      const state = 'PLANNING';
      if (!MISSION_STATES.includes(state)) {
        throw new Error('Mission state configuration error.');
      }

      let mission = await repos.missions.create(req.tenantId, {
        objective,
        original_prompt: objective,
        workspace_id: workspaceId,
        project_id: projectId,
        preferred_worker_id: preferredWorkerId || null,
        priority: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].includes(priority)
          ? priority
          : 'NORMAL',
        state,
        planning_mode: 'REQUIRED',
        approval_status: 'PENDING',
        current_plan_revision_id: null,
        approved_plan_revision_id: null,
        plan_revision_number: 0,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      });

      const { dispatchMission } = require('../services/orchestration');
      await dispatchMission(repos.missions.db, req.tenantId, mission.id);
      mission = await repos.missions.getById(mission.id);

      res.status(201).json(serializeFirestore(mission));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMissionsRouter };
