const { BaseRepository } = require('./base.repository');

class WorkerProfilesRepository extends BaseRepository {
  constructor(db) {
    super(db, 'worker_profiles');
  }
}

module.exports = { WorkerProfilesRepository };
