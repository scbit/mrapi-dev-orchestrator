const { BaseRepository } = require('./base.repository');

class MissionsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'missions');
  }

  async create(tenantId, payload) {
    const ref = this.collection.doc();
    await ref.set({
      id: ref.id,
      tenant_id: tenantId,
      ...payload
    });
    return this.getById(ref.id);
  }

  async listByTenant(tenantId, limit = 100) {
    const snapshot = await this.collection
      .where('tenant_id', '==', tenantId)
      .limit(limit)
      .get();

    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return bv - av;
      });
  }

  // PLANNER_SCOPED_MISSIONS_FIX_V1
  async listByRoadmap(tenantId, roadmapId, limit = 25) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    const snapshot = await this.collection
      .where('roadmap_id', '==', roadmapId)
      .limit(safeLimit)
      .get();

    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((mission) => mission.tenant_id === tenantId)
      .sort((a, b) => {
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return bv - av;
      });
  }
}

module.exports = { MissionsRepository };
