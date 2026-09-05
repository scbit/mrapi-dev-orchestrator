const { BaseRepository } = require('./base.repository');
const { normalizeBrainChatBinding } = require('../services/worker-brain-binding');

class WorkersRepository extends BaseRepository {
  constructor(db) {
    super(db, 'workers');
  }

  async requireOwnedWorker(workerId, tenantId) {
    const worker = await this.getById(workerId);
    if (!worker) {
      throw new Error('Worker not found');
    }
    if (worker.tenant_id !== tenantId) {
      throw new Error('Worker does not belong to tenant');
    }
    return worker;
  }

  async setBrainChatBinding(workerId, tenantId, binding) {
    await this.requireOwnedWorker(workerId, tenantId);
    const normalizedBinding = normalizeBrainChatBinding(binding);

    await this.collection.doc(workerId).set({
      brain_chat_binding: normalizedBinding
    }, { merge: true });

    return this.getById(workerId);
  }

  async clearBrainChatBinding(workerId, tenantId) {
    await this.requireOwnedWorker(workerId, tenantId);

    const FieldValue = this.db.constructor?.FieldValue || require('@google-cloud/firestore').FieldValue;
    await this.collection.doc(workerId).set({
      brain_chat_binding: FieldValue.delete()
    }, { merge: true });

    return this.getById(workerId);
  }
}

module.exports = { WorkersRepository };
