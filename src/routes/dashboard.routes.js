const express = require('express');
const { serializeFirestore } = require('../utils/firestore');
const { needAttention, withHeartbeatHealth, workerHealth } = require('../services/operations');

function createDashboardRouter({ db, repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const [
        workers,
        missions,
        tasks,
        results,
        systemSnapshot,
        executorsSnapshot,
        brainAdaptersSnapshot
      ] = await Promise.all([
        repos.workers.listByTenant(req.tenantId),
        repos.missions.listByTenant(req.tenantId),
        repos.tasks.listFiltered(req.tenantId),
        repos.results.listByTenant(req.tenantId),
        db.collection('system').doc('primary').get(),
        db.collection('executors').where('tenant_id', '==', req.tenantId).get(),
        db.collection('brain_adapters').where('tenant_id', '==', req.tenantId).get()
      ]);

      workers.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      missions.sort((a, b) => (b.updated_at?.toMillis?.() || 0) - (a.updated_at?.toMillis?.() || 0));

      const system = systemSnapshot.exists
        ? { id: systemSnapshot.id, ...systemSnapshot.data() }
        : { id: 'primary', state: 'RUNNING' };

      const workerTotals = {
        total: workers.length,
        active: workers.filter((worker) => worker.state === 'BUSY').length,
        idle: workers.filter((worker) => worker.state === 'IDLE').length,
        blocked: workers.filter((worker) => worker.state === 'BLOCKED').length
      };

      const missionTotals = {
        total: missions.length,
        running: missions.filter((mission) => mission.state === 'RUNNING').length,
        completed: missions.filter((mission) => mission.state === 'COMPLETED').length,
        blocked: missions.filter((mission) => mission.state === 'BLOCKED').length
      };

      const taskTotals = {
        total: tasks.length,
        queued: tasks.filter((task) => ['QUEUED', 'ASSIGNED'].includes(task.state)).length,
        running: tasks.filter((task) => ['RUNNING', 'TESTING'].includes(task.state)).length,
        done: tasks.filter((task) => task.state === 'DONE').length
      };

      const nowMs = Date.now();
      const executorItems = executorsSnapshot.docs.map((doc) => withHeartbeatHealth({
        id: doc.id,
        ...doc.data()
      }, nowMs));

      const brainAdapterItems = brainAdaptersSnapshot.docs.map((doc) => withHeartbeatHealth({
        id: doc.id,
        ...doc.data()
      }, nowMs));

      const operationalWorkers = workers.map((worker) => workerHealth(worker, {
        brainAdapters: brainAdapterItems,
        executors: executorItems
      }));
      const attentionItems = needAttention({
        missions,
        tasks,
        executors: executorItems,
        brainAdapters: brainAdapterItems,
        results
      });
      const onlineExecutors = executorItems.filter((executor) => executor.health_state === 'ONLINE');

      res.json(
        serializeFirestore({
          system,
          worker_totals: workerTotals,
          workers: operationalWorkers,
          mission_totals: missionTotals,
          task_totals: taskTotals,
          need_attention: attentionItems.length,
          need_attention_items: attentionItems.slice(0, 20),
          executors: {
            total: executorItems.length,
            online: onlineExecutors.length,
            items: executorItems
          },
          brain_adapters: {
            total: brainAdapterItems.length,
            online: brainAdapterItems.filter((item) => item.health_state === 'ONLINE').length,
            items: brainAdapterItems
          },
          recent_missions: missions.slice(0, 8)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createDashboardRouter };
