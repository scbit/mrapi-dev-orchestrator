const { BaseRepository } = require('./base.repository');

class EventsRepository extends BaseRepository {
  constructor(db) {
    super(db, 'events');
  }
}

module.exports = { EventsRepository };
