const express = require('express');
const { serializeFirestore } = require('../utils/firestore');

function isAttentionMission(mission) {
  return ['BLOCKED', 'FAILED'].includes(mission.state);
}

function isAttentionTask(task) {
  return ['BLOCKED', 'FAILED'].includes(task.state);
}

function createDashboardRouter({ db, repos }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const [
        workers,
        missions,
        tasks,
        systemSnapshot,
        executorsSnapshot
      ] = await Promise.all([
        repos.workers.listByTenant(req.tenantId),
        repos.missions.listByTenant(req.tenantId),
        repos.tasks.listFiltered(req.tenantId),
        db.collection('system').doc('primary').get(),
        db.collection('executors').where('tenant_id', '==', req.tenantId).get()
      ]);

      workers.sort((a, b) => String(a.code).localeCompare(String(b.code)));

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

      const executorItems = executorsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json(
        serializeFirestore({
          system,
          worker_totals: workerTotals,
          workers,
          mission_totals: missionTotals,
          task_totals: taskTotals,
          need_attention:
            missions.filter(isAttentionMission).length +
            tasks.filter(isAttentionTask).length +
            workers.filter((worker) => worker.state === 'BLOCKED').length,
          executors: {
            total: executorItems.length,
            online: executorItems.filter((executor) => executor.state === 'ONLINE').length,
            items: executorItems
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
