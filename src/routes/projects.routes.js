const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const { normalizeProjectContext } = require('../services/roadmap');

function timestamp() {
  return new Date();
}

function createProjectsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.projects.listByTenant(req.tenantId);
      items.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      res.json({ items: serializeFirestore(items), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId', async (req, res, next) => {
    try {
      const project = await repos.projects.getById(req.params.projectId);
      if (!project || project.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      }
      res.json(serializeFirestore(project));
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/context', async (req, res, next) => {
    try {
      const project = await repos.projects.getById(req.params.projectId);
      if (!project || project.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      }

      const context = normalizeProjectContext(req.body || {}, project);
      const updated = await repos.projects.upsert(project.id, {
        ...context,
        tenant_id: req.tenantId,
        context_updated_at: timestamp(),
        updated_at: timestamp()
      });
      res.json(serializeFirestore(updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createProjectsRouter };
