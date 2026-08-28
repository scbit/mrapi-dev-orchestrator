const fs = require('fs');

const file = 'src/services/correctiveRecovery.js';
let s = fs.readFileSync(file, 'utf8');

const marker = "planning_mode: latestBrain?.planning_mode || freshMission.planning_mode || null";
if (s.includes(marker)) {
  console.log('[SKIP already applied] planner recovery metadata');
  console.log('PLANNER_RECOVERY_METADATA_REPAIR_V2_OK');
  process.exit(0);
}

const regex = /(objective:\s*correctiveObjective\(freshMission\.objective,\s*recoveryContext\),\s*\n\s*brain_context:\s*recoveryContext,\s*\n)(\s*autopilot_mode:\s*freshMission\.autopilot_mode\s*===\s*true,)/m;

if (!regex.test(s)) {
  throw new Error('PATCH_PATTERN_NOT_FOUND:planner recovery metadata repair v2');
}

const insert = `$1
      // Preserve original Brain contract across corrective recovery.
      // Planner replay must remain a Planner Brain Run.
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

$2`;

s = s.replace(regex, insert);
fs.writeFileSync(file, s, 'utf8');

console.log('[PATCHED] planner recovery metadata');
console.log('PLANNER_RECOVERY_METADATA_REPAIR_V2_OK');
