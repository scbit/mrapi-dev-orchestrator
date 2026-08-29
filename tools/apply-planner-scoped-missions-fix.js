const fs = require('fs');

function rep(src, oldText, newText, label) {
  if (!src.includes(oldText)) throw new Error('PATCH_PATTERN_NOT_FOUND:' + label);
  return src.replace(oldText, newText);
}

// missions.repository.js
{
  const file = 'src/repositories/missions.repository.js';
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('PLANNER_SCOPED_MISSIONS_FIX_V1')) {
    const oldText = `  async listByTenant(tenantId, limit = 100) {
    const snapshot = await this.collection
      .where('tenant_id', '==', tenantId)
      .limit(limit)
      .get();

    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return bv - av;
      });
  }
`;
    const newText = oldText + `
  // PLANNER_SCOPED_MISSIONS_FIX_V1
  async listByRoadmap(tenantId, roadmapId, limit = 25) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    const snapshot = await this.collection
      .where('roadmap_id', '==', roadmapId)
      .limit(safeLimit)
      .get();

    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((mission) => mission.tenant_id === tenantId)
      .sort((a, b) => {
        const av = a.created_at?.toMillis?.() || 0;
        const bv = b.created_at?.toMillis?.() || 0;
        return bv - av;
      });
  }
`;
    s = rep(s, oldText, newText, 'missions repository');
    fs.writeFileSync(file, s, 'utf8');
  }
}

// missions.routes.js
{
  const file = 'src/routes/missions.routes.js';
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('PLANNER_SCOPED_MISSIONS_API_V1')) {
    const oldText = `  router.get('/', async (req, res, next) => {
    try {
      const missions = await repos.missions.listByTenant(req.tenantId);
      res.json({ items: serializeFirestore(missions), total: missions.length });
    } catch (error) {
      next(error);
    }
  });
`;
    const newText = `  router.get('/', async (req, res, next) => {
    try {
      // PLANNER_SCOPED_MISSIONS_API_V1
      const roadmapId = cleanString(req.query?.roadmap_id);
      const requestedLimit = Number.parseInt(req.query?.limit, 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 100))
        : (roadmapId ? 25 : 100);

      const missions = roadmapId
        ? await repos.missions.listByRoadmap(req.tenantId, roadmapId, limit)
        : await repos.missions.listByTenant(req.tenantId, limit);

      res.json({
        items: serializeFirestore(missions),
        total: missions.length,
        scope: roadmapId ? { roadmap_id: roadmapId, limit } : { tenant_id: req.tenantId, limit }
      });
    } catch (error) {
      next(error);
    }
  });
`;
    s = rep(s, oldText, newText, 'missions route');
    fs.writeFileSync(file, s, 'utf8');
  }
}

// planner.ui.routes.js
{
  const file = 'src/routes/planner.ui.routes.js';
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('PLANNER_SCOPED_RECOVERY_UI_V1')) {
    const oldText = `    async function loadMissionsRecovery() {
      if (!els.missionsList) return;
      state.missionsLoading = true;
      state.missionsError = '';
      renderMissionsRecovery();
      try {
        const data = await fetch('/api/missions').then(parseResponse);
        const missions = Array.isArray(data.items) ? data.items : [];
        const recoverableStates = new Set(['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'NEED_HUMAN_ACTION', 'RETRYABLE']);
        const enriched = await Promise.all(missions.map(async (mission) => {
          const missionState = text(mission?.state).trim().toUpperCase();
          if (!mission?.id || !recoverableStates.has(missionState)) return mission;
          try {
            const recovery = await fetch('/api/missions/' + encodeURIComponent(mission.id) + '/recovery').then(parseResponse);
            return { ...mission, recovery };
          } catch {
            return { ...mission, recovery: { recoverable: false, mode: 'NO_ACTION', reason: 'RECOVERY_STATUS_UNAVAILABLE' } };
          }
        }));
        state.missions = enriched;
        state.missionsLoading = false;
        renderMissionsRecovery();
      } catch (error) {
        state.missionsLoading = false;
        state.missionsError = 'Missions failed to load: ' + error.message;
        renderMissionsRecovery();
      }
    }
`;
    const newText = `    async function loadMissionsRecovery() {
      if (!els.missionsList) return;

      // PLANNER_SCOPED_RECOVERY_UI_V1
      const roadmapId = text(els.proposalId?.value || state.proposal?.id || state.proposal?.roadmap_id).trim();
      if (!roadmapId) {
        state.missions = [];
        state.missionsLoading = false;
        state.missionsError = '';
        renderMissionsRecovery();
        return;
      }

      state.missionsLoading = true;
      state.missionsError = '';
      renderMissionsRecovery();

      try {
        const data = await fetch('/api/missions?roadmap_id=' + encodeURIComponent(roadmapId) + '&limit=25').then(parseResponse);
        const missions = Array.isArray(data.items) ? data.items : [];
        const recoverableStates = new Set(['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'NEED_HUMAN_ACTION', 'RETRYABLE']);
        const recoverable = missions.filter((mission) =>
          mission?.id && recoverableStates.has(text(mission?.state).trim().toUpperCase())
        );

        const recoveryByMissionId = new Map();
        const concurrency = 3;
        for (let i = 0; i < recoverable.length; i += concurrency) {
          const batch = recoverable.slice(i, i + concurrency);
          const results = await Promise.all(batch.map(async (mission) => {
            try {
              const recovery = await fetch('/api/missions/' + encodeURIComponent(mission.id) + '/recovery').then(parseResponse);
              return [mission.id, recovery];
            } catch {
              return [mission.id, { recoverable: false, mode: 'NO_ACTION', reason: 'RECOVERY_STATUS_UNAVAILABLE' }];
            }
          }));
          for (const [missionId, recovery] of results) recoveryByMissionId.set(missionId, recovery);
        }

        state.missions = missions.map((mission) =>
          recoveryByMissionId.has(mission.id)
            ? { ...mission, recovery: recoveryByMissionId.get(mission.id) }
            : mission
        );
        state.missionsLoading = false;
        renderMissionsRecovery();
      } catch (error) {
        state.missionsLoading = false;
        state.missionsError = 'Missions failed to load: ' + error.message;
        renderMissionsRecovery();
      }
    }
`;
    s = rep(s, oldText, newText, 'planner loadMissionsRecovery');
    fs.writeFileSync(file, s, 'utf8');
  }
}

console.log('PLANNER_SCOPED_MISSIONS_FIX_V1_OK');
