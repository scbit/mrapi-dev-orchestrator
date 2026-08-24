const { BaseRepository } = require('./base.repository');

class ResultsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'results');
  }
}

module.exports = { ResultsRepository };
