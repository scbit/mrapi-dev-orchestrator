class BaseRepository {
  constructor(db, collectionName) {
    this.db = db;
    this.collectionName = collectionName;
    this.collection = db.collection(collectionName);
  }

  async getById(id) {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  async listByTenant(tenantId) {
    const snapshot = await this.collection.where('tenant_id', '==', tenantId).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async upsert(id, data, options = { merge: true }) {
    await this.collection.doc(id).set(data, options);
    return this.getById(id);
  }
}

module.exports = { BaseRepository };
