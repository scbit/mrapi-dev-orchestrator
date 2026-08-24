const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function createWorkersRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const workers = await repos.workers.listByTenant(req.tenantId);
      workers.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      res.json({ items: serializeFirestore(workers), total: workers.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:workerId', async (req, res, next) => {
    try {
      const worker = await repos.workers.getById(req.params.workerId);
      if (!worker || worker.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
      }
      res.json(serializeFirestore(worker));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createWorkersRouter };
