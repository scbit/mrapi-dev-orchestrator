const { BaseRepository } = require('./base.repository');

class RoadmapsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'roadmaps');
  }

  async listByProject(tenantId, projectId) {
    const items = await this.listByTenant(tenantId);
    return items.filter((item) => item.project_id === projectId);
  }
}

module.exports = { RoadmapsRepository };
