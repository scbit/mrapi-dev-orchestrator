const { BaseRepository } = require('./base.repository');

class TasksRepository extends BaseRepository {
  constructor(db) {
    super(db, 'tasks');
  }

  async listFiltered(tenantId, filters = {}) {
    let query = this.collection.where('tenant_id', '==', tenantId);

    if (filters.state) query = query.where('state', '==', filters.state);
    if (filters.worker_id) query = query.where('worker_id', '==', filters.worker_id);
    if (filters.mission_id) query = query.where('mission_id', '==', filters.mission_id);

    const snapshot = await query.limit(200).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async listClaimable(tenantId) {
    const snapshot = await this.collection
      .where('tenant_id', '==', tenantId)
      .where('state', '==', 'QUEUED')
      .limit(100)
      .get();

    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const priorities = { CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
        const pd = (priorities[b.priority] || 0) - (priorities[a.priority] || 0);
        if (pd) return pd;
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return av - bv;
      });
  }
}

module.exports = { TasksRepository };
