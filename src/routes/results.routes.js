const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function createResultsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.results.listByTenant(req.tenantId);
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

  router.get('/mission/:missionId', async (req, res, next) => {
    try {
      const items = await repos.results.listByTenant(req.tenantId);
      const filtered = items
        .filter((item) => item.mission_id === req.params.missionId)
        .sort((a, b) => {
          const av = a.created_at?.toMillis?.() || 0;
          const bv = b.created_at?.toMillis?.() || 0;
          return av - bv;
        });

      res.json({ total: filtered.length, items: serializeFirestore(filtered) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createResultsRouter };
