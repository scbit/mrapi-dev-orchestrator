const express = require('express');
const path = require('path');
const { serializeFirestore } = require('../utils/firestore');
const { getEvidenceBucket } = require('../services/storage');

function safeName(value) {
  return path.basename(String(value || 'evidence.bin')).replace(/[\r\n"]/g, '_').slice(0, 180);
}

function createEvidenceRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.evidence.listByTenant(req.tenantId);
      items.sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0));
      res.json({ total: items.length, items: serializeFirestore(items.slice(0, 300)) });
    } catch (error) { next(error); }
  });

  router.get('/:evidenceId/download', async (req, res, next) => {
    try {
      const evidence = await repos.evidence.getById(req.params.evidenceId);
      if (!evidence || evidence.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
      }
      const storage = evidence.storage;
      if (!storage?.object_path) {
        return res.status(404).json({ error: 'EVIDENCE_FILE_NOT_FOUND' });
      }
      const file = getEvidenceBucket().file(storage.object_path);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).json({ error: 'EVIDENCE_FILE_NOT_FOUND' });

      res.setHeader('Content-Type', storage.content_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(storage.filename || evidence.title)}"`);
      file.createReadStream().on('error', next).pipe(res);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createEvidenceRouter };
