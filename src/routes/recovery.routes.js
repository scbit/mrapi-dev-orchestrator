const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const {
  getMissionRecoveryStatus,
  recoverMission
} = require('../services/missionRecovery');

function createRecoveryRouter({ db }) {
  const router = express.Router();

  router.get('/:missionId/recovery', async (req, res, next) => {
    try {
      const status = await getMissionRecoveryStatus(
        db,
        req.tenantId,
        req.params.missionId
      );

      const response = status.mode === 'BRAIN_REPLAY'
        ? {
            ...status,
            action_label: 'Recover & Correct',
            supports_operator_instruction: true
          }
        : status;

      res.json(serializeFirestore(response));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/:missionId/recover', async (req, res, next) => {
    try {
      const result = await recoverMission(
        db,
        req.tenantId,
        req.params.missionId
      );

      const code = result.reused === true || result.no_new_work === true
        ? 200
        : 202;
      res.status(code).json(serializeFirestore(result));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createRecoveryRouter };
