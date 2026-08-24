const {
  TENANT,
  WORKSPACES,
  PROJECTS,
  WORKER_PROFILES,
  WORKERS
} = require('./bootstrapData');

function now(db) {
  if (db.constructor?.FieldValue?.serverTimestamp) {
    return db.constructor.FieldValue.serverTimestamp();
  }
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

async function mergeBootstrapDoc(db, collection, id, data, tenantId = null) {
  const ref = db.collection(collection).doc(id);
  const existing = await ref.get();

  const base = {
    ...data,
    id,
    ...(tenantId ? { tenant_id: tenantId } : {}),
    updated_at: now(db)
  };

  if (!existing.exists) {
    base.created_at = now(db);
  }

  await ref.set(base, { merge: true });
  return existing.exists ? 'reused' : 'created';
}

async function bootstrapInitialData(db, options = {}) {
  const tenantId = options.tenantId || TENANT.id;
  const summary = {
    tenant_id: tenantId,
    tenant: {},
    workspaces: {},
    projects: {},
    worker_profiles: {},
    workers: {},
    system: {}
  };

  summary.tenant[TENANT.id] = await mergeBootstrapDoc(
    db,
    'tenants',
    TENANT.id,
    TENANT
  );

  for (const workspace of WORKSPACES) {
    summary.workspaces[workspace.id] = await mergeBootstrapDoc(
      db,
      'workspaces',
      workspace.id,
      workspace,
      tenantId
    );
  }

  for (const project of PROJECTS) {
    summary.projects[project.id] = await mergeBootstrapDoc(
      db,
      'projects',
      project.id,
      project,
      tenantId
    );
  }

  for (const profile of WORKER_PROFILES) {
    summary.worker_profiles[profile.id] = await mergeBootstrapDoc(
      db,
      'worker_profiles',
      profile.id,
      profile,
      tenantId
    );
  }

  for (const worker of WORKERS) {
    const ref = db.collection('workers').doc(worker.id);
    const existing = await ref.get();

    if (existing.exists) {
      const data = existing.data();
      const safeMerge = {
        id: worker.id,
        code: worker.code,
        tenant_id: tenantId,
        profile_id: worker.profile_id,
        workspace_id: worker.workspace_id,
        project_id: worker.project_id,
        name: worker.name,
        role: worker.role,
        brain_binding: data.brain_binding ?? worker.brain_binding,
        executor_binding: data.executor_binding ?? worker.executor_binding,
        host_binding: data.host_binding ?? worker.host_binding,
        updated_at: now(db)
      };
      await ref.set(safeMerge, { merge: true });
      summary.workers[worker.id] = 'reused';
    } else {
      await ref.set({
        ...worker,
        tenant_id: tenantId,
        created_at: now(db),
        updated_at: now(db)
      });
      summary.workers[worker.id] = 'created';
    }
  }

  summary.system.primary = await mergeBootstrapDoc(
    db,
    'system',
    'primary',
    {
      state: 'RUNNING',
      version: 'v0.1-alpha'
    },
    tenantId
  );

  return summary;
}

module.exports = { bootstrapInitialData };
