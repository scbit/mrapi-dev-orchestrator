const express = require('express');
const { config } = require('../config');
const { getEvidenceConfig } = require('../services/storage');

function createHealthRouter({ db }) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const systemDoc = await db.collection('system').doc('primary').get();
      const systemStatus = systemDoc.exists ? systemDoc.data().state : 'RUNNING';

      res.json({
        ok: true,
        service: config.appName,
        version: config.version,
        system_status: systemStatus,
        firestore_database: config.firestoreDatabase,
        evidence: getEvidenceConfig()
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        service: config.appName,
        version: config.version,
        error: 'DEPENDENCY_UNAVAILABLE',
        message: error.message
      });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
