const { BaseRepository } = require('./base.repository');

class EvidenceRepository extends BaseRepository {
  constructor(db) {
    super(db, 'evidence');
  }
}

module.exports = { EvidenceRepository };
