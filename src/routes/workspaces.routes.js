const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function workspaceLabel(workspace) {
  return String(workspace?.name || workspace?.id || '');
}

function createWorkspacesRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.workspaces.listByTenant(req.tenantId);
      items.sort((a, b) => workspaceLabel(a).localeCompare(workspaceLabel(b)));
      res.json({ items: serializeFirestore(items), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createWorkspacesRouter };
