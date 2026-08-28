const fs = require('fs');

const file = 'src/services/correctiveRecovery.js';
let s = fs.readFileSync(file, 'utf8');

const old = `      objective: correctiveObjective(freshMission.objective, recoveryContext),
      brain_context: recoveryContext,
      autopilot_mode: freshMission.autopilot_mode === true,
      autopilot_phase: phase,
      roadmap_id: freshMission.roadmap_id || null,
      milestone_id: freshMission.milestone_id || null,`;

const neu = `      objective: correctiveObjective(freshMission.objective, recoveryContext),
      brain_context: recoveryContext,

      // Preserve the original Brain contract across corrective recovery.
      // Planner replay must remain a Planner Brain Run; otherwise completion
      // is accepted as a normal Brain result and no Roadmap is persisted.
      planning_mode: latestBrain?.planning_mode || freshMission.planning_mode || null,
      planner_request_id:
        latestBrain?.planner_request_id ||
        freshMission.planner_request_id ||
        (latestBrain?.planning_mode === 'PLANNER_ROADMAP_PROPOSAL' ? missionId : null),
      planner_request:
        latestBrain?.planner_request ||
        freshMission.planner_request ||
        freshMission.original_prompt ||
        null,
      non_executable:
        latestBrain?.non_executable === true ||
        freshMission.non_executable === true ||
        latestBrain?.planning_mode === 'PLANNER_ROADMAP_PROPOSAL',
      revision_target_roadmap_id: latestBrain?.revision_target_roadmap_id || null,
      revision_number: latestBrain?.revision_number || null,
      revision_feedback: latestBrain?.revision_feedback || null,
      prior_planner_brain_run_id: latestBrain?.prior_planner_brain_run_id || null,

      autopilot_mode: freshMission.autopilot_mode === true,
      autopilot_phase: phase,
      roadmap_id: freshMission.roadmap_id || null,
      milestone_id: freshMission.milestone_id || null,`;

if (s.includes(neu)) {
  console.log('[SKIP already applied] planner recovery metadata');
} else {
  if (!s.includes(old)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner recovery metadata');
  s = s.replace(old, neu);
  fs.writeFileSync(file, s, 'utf8');
  console.log('[PATCHED] planner recovery metadata');
}

console.log('PLANNER_RECOVERY_METADATA_FIX_OK');
