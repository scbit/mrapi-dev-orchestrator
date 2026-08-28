const crypto = require('crypto');
const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const { normalizeProjectContext } = require('../services/roadmap');
const { projectRuntimePayload, runtimeBinding, runtimeMissing } = require('../services/projectRuntime');

function timestamp() { return new Date(); }
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function slug(value) {
  return clean(value, 200).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function createProjectsRouter({ repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const items = await repos.projects.listByTenant(req.tenantId);
      items.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      res.json({ items: serializeFirestore(items), total: items.length });
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const name = clean(req.body?.name, 300);
      const workspaceId = clean(req.body?.workspace_id, 300);
      if (!name) return res.status(400).json({ error: 'PROJECT_NAME_REQUIRED' });
      if (!workspaceId) return res.status(400).json({ error: 'WORKSPACE_ID_REQUIRED' });

      const existing = await repos.projects.listByTenant(req.tenantId);
      const duplicate = existing.find((item) =>
        item.workspace_id === workspaceId &&
        String(item.name || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (duplicate) return res.status(409).json({ error: 'PROJECT_ALREADY_EXISTS', project_id: duplicate.id });

      const projectId = clean(req.body?.id, 300) ||
        `project_${slug(name) || 'project'}_${crypto.randomBytes(4).toString('hex')}`;
      const runtime = projectRuntimePayload(req.body || {}, {
        runtime_context: {},
        repository_full_name: null,
        default_branch: 'main'
      });

      const created = await repos.projects.upsert(projectId, {
        id: projectId,
        tenant_id: req.tenantId,
        workspace_id: workspaceId,
        name,
        description: clean(req.body?.description, 3000) || null,
        primary_worker_ids: Array.isArray(req.body?.primary_worker_ids) && req.body.primary_worker_ids.length
          ? req.body.primary_worker_ids.map((x) => clean(x, 100)).filter(Boolean)
          : ['W01'],
        default_worker_id: clean(req.body?.default_worker_id, 100) || 'W01',
        ...runtime,
        created_at: timestamp(),
        updated_at: timestamp()
      });
      res.status(201).json(serializeFirestore({
        ...created,
        runtime_binding: runtimeBinding(created),
        runtime_binding_missing: runtimeMissing(created)
      }));
    } catch (error) { next(error); }
  });

  router.get('/:projectId', async (req, res, next) => {
    try {
      const project = await repos.projects.getById(req.params.projectId);
      if (!project || project.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      }
      res.json(serializeFirestore({
        ...project,
        runtime_binding: runtimeBinding(project),
        runtime_binding_missing: runtimeMissing(project)
      }));
    } catch (error) { next(error); }
  });

  router.put('/:projectId/runtime', async (req, res, next) => {
    try {
      const project = await repos.projects.getById(req.params.projectId);
      if (!project || project.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      }
      const runtime = projectRuntimePayload(req.body || {}, project);
      const updated = await repos.projects.upsert(project.id, {
        ...runtime,
        tenant_id: req.tenantId,
        runtime_binding_updated_at: timestamp(),
        updated_at: timestamp()
      });
      res.json(serializeFirestore({
        ...updated,
        runtime_binding: runtimeBinding(updated),
        runtime_binding_missing: runtimeMissing(updated)
      }));
    } catch (error) { next(error); }
  });

  router.put('/:projectId/context', async (req, res, next) => {
    try {
      const project = await repos.projects.getById(req.params.projectId);
      if (!project || project.tenant_id !== req.tenantId) {
        return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      }
      const context = normalizeProjectContext(req.body || {}, project);
      const updated = await repos.projects.upsert(project.id, {
        ...context,
        tenant_id: req.tenantId,
        context_updated_at: timestamp(),
        updated_at: timestamp()
      });
      res.json(serializeFirestore(updated));
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createProjectsRouter };
