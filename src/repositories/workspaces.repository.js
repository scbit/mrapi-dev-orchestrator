const { BaseRepository } = require('./base.repository');

class WorkspacesRepository extends BaseRepository {
  constructor(db) {
    super(db, 'workspaces');
  }
}

module.exports = { WorkspacesRepository };
