const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function createExecutorsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.executors.listByTenant(req.tenantId);
      items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      res.json({ total: items.length, items: serializeFirestore(items) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createExecutorsRouter };
