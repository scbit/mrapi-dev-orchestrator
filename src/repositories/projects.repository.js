const { BaseRepository } = require('./base.repository');

class ProjectsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'projects');
  }
}

module.exports = { ProjectsRepository };
