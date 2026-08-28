const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const {
  getMissionRecoveryStatus,
  recoverMission
} = require('../services/missionRecovery');
const {
  correctiveBrainRecovery
} = require('../services/correctiveRecovery');

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
      const status = await getMissionRecoveryStatus(
        db,
        req.tenantId,
        req.params.missionId
      );

      const result = status.mode === 'BRAIN_REPLAY'
        ? await correctiveBrainRecovery(
            db,
            req.tenantId,
            req.params.missionId,
            {
              failure_code: status.failure_code || status.reason || null,
              recovery_instruction: req.body?.recovery_instruction || ''
            }
          )
        : await recoverMission(
            db,
            req.tenantId,
            req.params.missionId
          );

      res.json(serializeFirestore(result));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createRecoveryRouter };
