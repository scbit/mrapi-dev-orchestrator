const fs = require('fs');

function replaceOnce(file, from, to, label){
  let s=fs.readFileSync(file,'utf8');
  if(s.includes(to)){ console.log('[SKIP already applied]',label); return; }
  if(!s.includes(from)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  s=s.replace(from,to);
  fs.writeFileSync(file,s,'utf8');
  console.log('[PATCHED]',label);
}

function replaceRegex(file, regex, replacement, label, marker){
  let s=fs.readFileSync(file,'utf8');
  if(marker && s.includes(marker)){ console.log('[SKIP already applied]',label); return; }
  if(!regex.test(s)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  s=s.replace(regex,replacement);
  fs.writeFileSync(file,s,'utf8');
  console.log('[PATCHED]',label);
}

// Backend exact resolver: source Mission / Brain Run -> persisted Planner Roadmap.
replaceOnce(
  'src/routes/planner.routes.js',
  "  router.get('/proposals/:proposalId', async (req, res, next) => {",
  `  router.get('/resolve', async (req, res, next) => {
    try {
      const missionId = String(req.query?.mission_id || '').trim();
      const brainRunId = String(req.query?.brain_run_id || '').trim();
      if (!missionId && !brainRunId) {
        return res.status(400).json({ error: 'PLANNER_RESOLVE_ID_REQUIRED' });
      }

      const snapshot = await db.collection('roadmaps')
        .where('tenant_id', '==', req.tenantId)
        .limit(200)
        .get();

      const matches = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((item) => item.proposal_type === 'PLANNER_ROADMAP')
        .filter((item) => {
          if (missionId && (
            item.source_planner_mission_id === missionId ||
            item.planner_request_id === missionId
          )) return true;
          if (brainRunId && (
            item.source_planner_brain_run_id === brainRunId ||
            item.source_brain_run_id === brainRunId
          )) return true;
          return false;
        })
        .sort((a, b) => {
          const am = a.updated_at?.toMillis?.() || a.created_at?.toMillis?.() || 0;
          const bm = b.updated_at?.toMillis?.() || b.created_at?.toMillis?.() || 0;
          return bm - am;
        });

      if (!matches.length) {
        return res.status(404).json({ error: 'PLANNER_PROPOSAL_NOT_FOUND' });
      }

      const roadmap = matches[0];
      return res.json(serializeFirestore({
        roadmap_id: roadmap.id,
        proposal_id: roadmap.id,
        mission_id: roadmap.source_planner_mission_id || roadmap.planner_request_id || null,
        brain_run_id: roadmap.source_planner_brain_run_id || roadmap.source_brain_run_id || null,
        workspace_id: roadmap.workspace_id || null,
        project_id: roadmap.project_id || null
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/proposals/:proposalId', async (req, res, next) => {`,
  'planner exact recovery resolver'
);

// UI: discovery should use authoritative mission first, then exact backend resolver.
replaceRegex(
  'src/routes/planner.ui.routes.js',
  /async function discoverProposalFromMission\(\) \{[\s\S]*?\n    \}\n\n    async function loadProposal\(\) \{/,
  `async function discoverProposalFromMission() {
      const missionIds = [...new Set([state.missionId, state.requestId].map((value) => text(value).trim()).filter(Boolean))];

      for (const missionId of missionIds) {
        try {
          const mission = await fetch('/api/missions/' + encodeURIComponent(missionId)).then(parseResponse);
          const proposalId = mission.planner_roadmap_id || mission.roadmap_id || mission.current_roadmap_id;
          if (proposalId) {
            state.proposalId = proposalId;
            els.proposalId.value = proposalId;
            persistPlannerState();
            return proposalId;
          }
        } catch {}
      }

      const query = new URLSearchParams();
      if (state.missionId || state.requestId) query.set('mission_id', state.missionId || state.requestId);
      if (state.brainRunId) query.set('brain_run_id', state.brainRunId);

      if ([...query.keys()].length) {
        try {
          const resolved = await fetch('/api/planner/resolve?' + query.toString()).then(parseResponse);
          const proposalId = resolved.roadmap_id || resolved.proposal_id;
          if (proposalId) {
            state.proposalId = proposalId;
            if (resolved.mission_id) state.missionId = resolved.mission_id;
            if (resolved.brain_run_id) state.brainRunId = resolved.brain_run_id;
            els.proposalId.value = proposalId;
            persistPlannerState();
            return proposalId;
          }
        } catch (error) {
          if (!/PLANNER_PROPOSAL_NOT_FOUND/.test(String(error.message || ''))) throw error;
        }
      }

      return null;
    }

    async function loadProposal() {`,
  'planner recovery-aware proposal discovery',
  "/api/planner/resolve?"
);

console.log('PLANNER_RECOVERY_DISCOVERY_FIX_OK');
