const express = require('express');
const { TASK_STATES } = require('../constants/states');
const { serializeFirestore } = require('../utils/firestore');

function createTasksRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      if (req.query.state && !TASK_STATES.includes(String(req.query.state))) {
        return res.status(400).json({ error: 'INVALID_TASK_STATE' });
      }

      const items = await repos.tasks.listFiltered(req.tenantId, {
        state: req.query.state || null,
        worker_id: req.query.worker_id || null,
        mission_id: req.query.mission_id || null
      });

      res.json({ items: serializeFirestore(items), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTasksRouter };
