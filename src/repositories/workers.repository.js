const { BaseRepository } = require('./base.repository');

class WorkersRepository extends BaseRepository {
  constructor(db) {
    super(db, 'workers');
  }
}

module.exports = { WorkersRepository };
