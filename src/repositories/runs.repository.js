const { BaseRepository } = require('./base.repository');

class RunsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'runs');
  }
}

module.exports = { RunsRepository };
