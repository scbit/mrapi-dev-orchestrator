const fs = require('fs');

function writeIfChanged(file, before, after) {
  if (before !== after) fs.writeFileSync(file, after, 'utf8');
}

// 1) Repository: add listByRoadmap only if V1/V2 has not already added it.
{
  const file = 'src/repositories/missions.repository.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!/async\s+listByRoadmap\s*\(/.test(s)) {
    const classEnd = /\n}\s*\n\s*module\.exports\s*=\s*\{\s*MissionsRepository\s*\};/;
    if (!classEnd.test(s)) throw new Error('PATCH_PATTERN_NOT_FOUND:missions repository class end');

    const method = `
  // PLANNER_SCOPED_MISSIONS_FIX_V2
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
    s = s.replace(classEnd, method + '\n}\n\nmodule.exports = { MissionsRepository };');
  }

  writeIfChanged(file, before, s);
}

// 2) Missions API: replace only the root GET handler structurally.
{
  const file = 'src/routes/missions.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('PLANNER_SCOPED_MISSIONS_API_V2')) {
    const routePattern = /  router\.get\('\/', async \(req, res, next\) => \{[\s\S]*?\n  \}\);\r?\n\r?\n(?=  router\.get\('\/:missionId')/;
    const match = s.match(routePattern);
    if (!match) throw new Error('PATCH_PATTERN_NOT_FOUND:missions root GET');

    const replacement = `  router.get('/', async (req, res, next) => {
    try {
      // PLANNER_SCOPED_MISSIONS_API_V2
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
        scope: roadmapId
          ? { roadmap_id: roadmapId, limit }
          : { tenant_id: req.tenantId, limit }
      });
    } catch (error) {
      next(error);
    }
  });

`;
    s = s.replace(routePattern, replacement);
  }

  writeIfChanged(file, before, s);
}

// 3) Planner UI: replace loadMissionsRecovery() by function boundaries.
//    Supports m3 edits around the function and CRLF/LF.
{
  const file = 'src/routes/planner.ui.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;

  if (!s.includes('PLANNER_SCOPED_RECOVERY_UI_V2')) {
    const start = s.indexOf('    async function loadMissionsRecovery() {');
    if (start < 0) throw new Error('PATCH_PATTERN_NOT_FOUND:loadMissionsRecovery start');

    const next = s.indexOf('    function setActionError(', start);
    if (next < 0) throw new Error('PATCH_PATTERN_NOT_FOUND:loadMissionsRecovery end');

    const replacement = `    async function loadMissionsRecovery() {
      if (!els.missionsList) return;

      // PLANNER_SCOPED_RECOVERY_UI_V2
      // Mission Recovery is scoped to the Roadmap currently loaded in Planner.
      // Never load the tenant-wide Mission collection here.
      const roadmapId = text(
        els.proposalId?.value ||
        state.proposalId ||
        state.proposal?.roadmap_id ||
        state.proposal?.id
      ).trim();

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
        const data = await fetch(
          '/api/missions?roadmap_id=' + encodeURIComponent(roadmapId) + '&limit=25'
        ).then(parseResponse);

        const missions = Array.isArray(data.items) ? data.items : [];
        const recoverableStates = new Set([
          'BLOCKED',
          'FAILED',
          'WAITING_HUMAN',
          'NEED_HUMAN_ACTION',
          'RETRYABLE'
        ]);

        const recoverable = missions.filter((mission) =>
          mission?.id &&
          recoverableStates.has(text(mission?.state).trim().toUpperCase())
        );

        const recoveryByMissionId = new Map();

        // Avoid a recovery-request storm against the backend.
        const concurrency = 3;
        for (let i = 0; i < recoverable.length; i += concurrency) {
          const batch = recoverable.slice(i, i + concurrency);
          const results = await Promise.all(batch.map(async (mission) => {
            try {
              const recovery = await fetch(
                '/api/missions/' + encodeURIComponent(mission.id) + '/recovery'
              ).then(parseResponse);
              return [mission.id, recovery];
            } catch {
              return [
                mission.id,
                {
                  recoverable: false,
                  mode: 'NO_ACTION',
                  reason: 'RECOVERY_STATUS_UNAVAILABLE'
                }
              ];
            }
          }));

          for (const [missionId, recovery] of results) {
            recoveryByMissionId.set(missionId, recovery);
          }
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

    s = s.slice(0, start) + replacement + s.slice(next);
  }

  writeIfChanged(file, before, s);
}

// 4) Sanity assertions.
{
  const repo = fs.readFileSync('src/repositories/missions.repository.js', 'utf8');
  const routes = fs.readFileSync('src/routes/missions.routes.js', 'utf8');
  const ui = fs.readFileSync('src/routes/planner.ui.routes.js', 'utf8');

  if (!/async\s+listByRoadmap\s*\(/.test(repo)) {
    throw new Error('VERIFY_FAILED:listByRoadmap missing');
  }
  if (!routes.includes('PLANNER_SCOPED_MISSIONS_API_V2')) {
    throw new Error('VERIFY_FAILED:scoped missions API missing');
  }
  if (!ui.includes('PLANNER_SCOPED_RECOVERY_UI_V2')) {
    throw new Error('VERIFY_FAILED:scoped recovery UI missing');
  }
  if (ui.includes("const data = await fetch('/api/missions').then(parseResponse);")) {
    throw new Error('VERIFY_FAILED:legacy global missions fetch still present');
  }
}

console.log('PLANNER_SCOPED_MISSIONS_FIX_V2_OK');
