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
}

module.exports = { TasksRepository };
