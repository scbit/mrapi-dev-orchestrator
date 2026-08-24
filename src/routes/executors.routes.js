const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const { withHeartbeatHealth } = require('../services/operations');

function createExecutorsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.executors.listByTenant(req.tenantId);
      const nowMs = Date.now();
      const operational = items
        .map((item) => withHeartbeatHealth(item, nowMs))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      res.json({ total: operational.length, items: serializeFirestore(operational) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createExecutorsRouter };
