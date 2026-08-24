const { BaseRepository } = require('./base.repository');

class TenantsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'tenants');
  }
}

module.exports = { TenantsRepository };
