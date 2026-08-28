const fs = require('fs');

const file = 'src/routes/planner.routes.js';
let s = fs.readFileSync(file, 'utf8');

const start = s.indexOf("  router.get('/resolve', async (req, res, next) => {");
const end = s.indexOf("  router.get('/proposals/:proposalId'", start);

if (start < 0 || end < 0) {
  throw new Error('PLANNER_RESOLVE_ROUTE_NOT_FOUND');
}

const replacement = `  router.get('/resolve', async (req, res, next) => {
    try {
      const missionIdInput = String(req.query?.mission_id || '').trim();
      const brainRunIdInput = String(req.query?.brain_run_id || '').trim();
      if (!missionIdInput && !brainRunIdInput) {
        return res.status(400).json({ error: 'PLANNER_RESOLVE_ID_REQUIRED' });
      }

      const runSnap = await db.collection('runs')
        .where('tenant_id', '==', req.tenantId)
        .limit(500)
        .get();

      const runs = runSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const seedRun = brainRunIdInput
        ? runs.find((item) => item.id === brainRunIdInput)
        : null;

      const missionIds = new Set(
        [missionIdInput, seedRun?.mission_id].map((value) => String(value || '').trim()).filter(Boolean)
      );
      const plannerRequestIds = new Set(
        [
          missionIdInput,
          seedRun?.planner_request_id,
          seedRun?.mission_id
        ].map((value) => String(value || '').trim()).filter(Boolean)
      );

      // Recovery/replay may create a replacement Brain Run while preserving
      // the same Planner Mission. Follow that lineage instead of trusting the
      // stale Brain Run id stored by the browser.
      const siblingRuns = runs
        .filter((item) => item.run_type === 'BRAIN_RUN')
        .filter((item) => {
          const itemMissionId = String(item.mission_id || '').trim();
          const itemPlannerRequestId = String(item.planner_request_id || '').trim();
          return (itemMissionId && missionIds.has(itemMissionId)) ||
            (itemPlannerRequestId && plannerRequestIds.has(itemPlannerRequestId));
        });

      for (const run of siblingRuns) {
        if (run.mission_id) missionIds.add(String(run.mission_id));
        if (run.planner_request_id) plannerRequestIds.add(String(run.planner_request_id));
      }

      const brainRunIds = new Set(
        [brainRunIdInput, ...siblingRuns.map((item) => item.id)]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      );

      // First honor a direct persisted roadmap pointer from the same Mission.
      for (const id of missionIds) {
        const missionSnap = await db.collection('missions').doc(id).get();
        if (!missionSnap.exists || missionSnap.data().tenant_id !== req.tenantId) continue;
        const mission = missionSnap.data();
        const directRoadmapId = String(
          mission.planner_roadmap_id ||
          mission.roadmap_id ||
          mission.current_roadmap_id ||
          ''
        ).trim();
        if (!directRoadmapId) continue;
        const directRoadmapSnap = await db.collection('roadmaps').doc(directRoadmapId).get();
        if (
          directRoadmapSnap.exists &&
          directRoadmapSnap.data().tenant_id === req.tenantId &&
          directRoadmapSnap.data().proposal_type === 'PLANNER_ROADMAP'
        ) {
          const roadmap = { id: directRoadmapSnap.id, ...directRoadmapSnap.data() };
          return res.json(serializeFirestore({
            roadmap_id: roadmap.id,
            proposal_id: roadmap.id,
            mission_id: roadmap.source_planner_mission_id || id,
            brain_run_id: roadmap.source_planner_brain_run_id || roadmap.source_brain_run_id || null,
            workspace_id: roadmap.workspace_id || null,
            project_id: roadmap.project_id || null,
            resolved_via: 'MISSION_POINTER'
          }));
        }
      }

      const roadmapSnap = await db.collection('roadmaps')
        .where('tenant_id', '==', req.tenantId)
        .limit(500)
        .get();

      const matches = roadmapSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((item) => item.proposal_type === 'PLANNER_ROADMAP')
        .filter((item) => {
          const sourceMissionId = String(item.source_planner_mission_id || '').trim();
          const plannerRequestId = String(item.planner_request_id || '').trim();
          const sourceBrainRunId = String(
            item.source_planner_brain_run_id ||
            item.source_brain_run_id ||
            ''
          ).trim();

          return (sourceMissionId && missionIds.has(sourceMissionId)) ||
            (plannerRequestId && plannerRequestIds.has(plannerRequestId)) ||
            (sourceBrainRunId && brainRunIds.has(sourceBrainRunId));
        })
        .sort((a, b) => {
          const am = a.updated_at?.toMillis?.() || a.created_at?.toMillis?.() || 0;
          const bm = b.updated_at?.toMillis?.() || b.created_at?.toMillis?.() || 0;
          return bm - am;
        });

      if (!matches.length) {
        return res.status(404).json({
          error: 'PLANNER_PROPOSAL_NOT_FOUND',
          mission_ids_checked: [...missionIds],
          brain_run_ids_checked: [...brainRunIds],
          planner_request_ids_checked: [...plannerRequestIds]
        });
      }

      const roadmap = matches[0];
      return res.json(serializeFirestore({
        roadmap_id: roadmap.id,
        proposal_id: roadmap.id,
        mission_id: roadmap.source_planner_mission_id || null,
        brain_run_id: roadmap.source_planner_brain_run_id || roadmap.source_brain_run_id || null,
        workspace_id: roadmap.workspace_id || null,
        project_id: roadmap.project_id || null,
        resolved_via: 'REPLAY_LINEAGE'
      }));
    } catch (error) {
      next(error);
    }
  });

`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(file, s, 'utf8');

console.log('PLANNER_REPLAY_LINEAGE_FIX_OK');
