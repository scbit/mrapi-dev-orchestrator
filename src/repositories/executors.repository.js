const { BaseRepository } = require('./base.repository');

class ExecutorsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'executors');
  }
}

module.exports = { ExecutorsRepository };
