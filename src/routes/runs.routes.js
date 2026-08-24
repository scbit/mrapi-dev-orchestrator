const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function createRunsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.runs.listByTenant(req.tenantId);
      items.sort((a, b) => {
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return bv - av;
      });
      res.json({ total: items.length, items: serializeFirestore(items.slice(0, 200)) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRunsRouter };
