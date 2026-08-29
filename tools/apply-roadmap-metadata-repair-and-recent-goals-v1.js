
const fs = require('fs');

function save(file, before, after) {
  if (before !== after) fs.writeFileSync(file, after, 'utf8');
}
function rep(file, source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`PATCH_PATTERN_NOT_FOUND:${label}:${file}`);
  return source.replace(oldText, newText);
}

// Preserve Planner milestone metadata
{
  const file = 'src/services/roadmap.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  if (!s.includes('PRESERVE_PLANNER_MILESTONE_METADATA_V1')) {
    const oldText = `    return {
      id: cleanText(item?.id, 160) || \`milestone_\${index + 1}_\${crypto.randomUUID().slice(0, 8)}\`,
      title: cleanText(item?.title, 300) || \`Milestone \${index + 1}\`,
      description: cleanText(item?.description, 4000),
      state,
      priority: cleanText(item?.priority, 30) || 'NORMAL',
      depends_on: cleanStringArray(item?.depends_on, 20),
      success_criteria: cleanStringArray(item?.success_criteria, 30),
      preferred_worker_id: cleanText(item?.preferred_worker_id, 100) || null,
      mission_id: cleanText(item?.mission_id, 200) || null,
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index + 1
    };
`;
    const newText = `    // PRESERVE_PLANNER_MILESTONE_METADATA_V1
    const dependencies = Array.isArray(item?.dependencies)
      ? cleanStringArray(item.dependencies, 20)
      : cleanStringArray(item?.depends_on, 20);
    return {
      ...(item && typeof item === 'object' ? item : {}),
      id: cleanText(item?.id, 160) || \`milestone_\${index + 1}_\${crypto.randomUUID().slice(0, 8)}\`,
      title: cleanText(item?.title, 300) || \`Milestone \${index + 1}\`,
      objective: cleanText(item?.objective ?? item?.expected_outcome, 6000),
      expected_outcome: cleanText(item?.expected_outcome ?? item?.objective, 6000),
      description: cleanText(item?.description, 8000),
      executor_required: typeof item?.executor_required === 'boolean' ? item.executor_required : item?.executor_required,
      state,
      priority: cleanText(item?.priority, 30) || 'NORMAL',
      dependencies,
      depends_on: dependencies,
      risks: cleanStringArray(item?.risks, 50),
      success_criteria: cleanStringArray(item?.success_criteria, 50),
      preferred_worker_id: cleanText(item?.preferred_worker_id, 100) || null,
      mission_id: cleanText(item?.mission_id, 200) || null,
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index + 1
    };
`;
    s = rep(file, s, oldText, newText, 'normalizeMilestones');
  }
  save(file, before, s);
}

// Add repair helper
{
  const file = 'src/services/planner.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  if (!s.includes('async function repairPlannerRoadmapMetadata')) {
    const helper = `
function plannerMilestoneHasReviewContract(milestone) {
  if (!milestone || typeof milestone !== 'object') return false;
  return Boolean(
    cleanText(milestone.id, 160) &&
    cleanText(milestone.title, 500) &&
    cleanText(milestone.objective || milestone.expected_outcome, 6000) &&
    cleanText(milestone.description, 8000) &&
    typeof milestone.executor_required === 'boolean' &&
    Array.isArray(milestone.dependencies || milestone.depends_on) &&
    Array.isArray(milestone.risks) &&
    Array.isArray(milestone.success_criteria)
  );
}

function mergePlannerMilestoneMetadata(template, current) {
  const runtimeFields = ['state','mission_id','verification_brain_run_id','started_at','completed_at','blocked_at','blocker_code','blocker_message','retry_attempt','retry_revision','retry_status','last_retry_brain_run_id','active_retry_execution_spec','retry_execution_spec','retry_history','human_action_checkpoint','human_action','updated_at','created_at'];
  const merged = { ...template, ...current };
  for (const key of runtimeFields) if (Object.prototype.hasOwnProperty.call(current || {}, key)) merged[key] = current[key];
  const deps = Array.isArray(template?.dependencies) ? template.dependencies : (Array.isArray(template?.depends_on) ? template.depends_on : []);
  merged.dependencies = deps;
  merged.depends_on = deps;
  return merged;
}

async function repairPlannerRoadmapMetadata(db, tenantId, roadmapId) {
  const ref = db.collection('roadmaps').doc(roadmapId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().tenant_id !== tenantId) fail('ROADMAP_NOT_FOUND', 404);
  const roadmap = { id: snap.id, ...snap.data() };
  if (roadmap.proposal_type !== 'PLANNER_ROADMAP') fail('PLANNER_ROADMAP_REQUIRED', 409);

  const currentMilestones = Array.isArray(roadmap.milestones) ? roadmap.milestones : [];
  if (currentMilestones.length && currentMilestones.every(plannerMilestoneHasReviewContract)) {
    return { roadmap, repaired: false, source: 'CURRENT_ALREADY_VALID' };
  }

  let templateRoadmap = null;
  let source = null;
  const runIds = [roadmap.source_planner_brain_run_id, roadmap.provenance?.brain_run_id, roadmap.active_revision_brain_run_id]
    .map((v) => cleanText(v, 200)).filter(Boolean);

  for (const runId of [...new Set(runIds)]) {
    const runSnap = await db.collection('runs').doc(runId).get();
    if (!runSnap.exists || runSnap.data().tenant_id !== tenantId) continue;
    const run = runSnap.data();
    const candidates = [run.output_text, run.result_text, run.final_result_text, run.response_text, run.summary]
      .filter((v) => typeof v === 'string' && v.trim());
    for (const candidate of candidates) {
      try {
        const parsed = validateProposal(parseProposal({ output_text: candidate }));
        if (parsed?.milestones?.length) {
          templateRoadmap = parsed;
          source = 'CURRENT_PLANNER_BRAIN_RUN';
          break;
        }
      } catch {}
    }
    if (templateRoadmap) break;
  }

  if (!templateRoadmap) {
    const history = Array.isArray(roadmap.revision_history) ? roadmap.revision_history : [];
    templateRoadmap = [...history].reverse().find((item) =>
      Array.isArray(item?.milestones) && item.milestones.length && item.milestones.every(plannerMilestoneHasReviewContract)
    ) || null;
    if (templateRoadmap) source = 'REVISION_HISTORY_FALLBACK';
  }
  if (!templateRoadmap) fail('PLANNER_METADATA_REPAIR_SOURCE_NOT_FOUND', 409);

  const byId = new Map(templateRoadmap.milestones.map((m) => [m.id, m]));
  const repairedMilestones = currentMilestones.map((current) => {
    const template = byId.get(current.id);
    return template ? mergePlannerMilestoneMetadata(template, current) : current;
  });

  await ref.set({ milestones: repairedMilestones, updated_at: timestamp() }, { merge: true });
  const done = await ref.get();
  return { roadmap: { id: done.id, ...done.data() }, repaired: true, source };
}

`;
    s = s.replace('module.exports = {', helper + 'module.exports = {');
    s = s.replace('  startPlannerRoadmap,\n  validateProposal,', '  startPlannerRoadmap,\n  repairPlannerRoadmapMetadata,\n  validateProposal,');
  }
  save(file, before, s);
}

// Repair route
{
  const file = 'src/routes/planner.routes.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  if (!s.includes('/repair-metadata')) {
    s = rep(file, s,
`  startPlannerRoadmap
} = require('../services/planner');`,
`  startPlannerRoadmap,
  repairPlannerRoadmapMetadata
} = require('../services/planner');`,
'planner import');
    const anchor = `  router.post('/roadmaps/:roadmapId/start', async (req, res, next) => {
`;
    const route = `  router.post('/roadmaps/:roadmapId/repair-metadata', async (req, res, next) => {
    try {
      const result = await repairPlannerRoadmapMetadata(db, req.tenantId, req.params.roadmapId);
      res.json(serializeFirestore(result));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

`;
    if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner start anchor');
    s = s.replace(anchor, route + anchor);
  }
  save(file, before, s);
}

// Recent Planner roadmaps first
{
  const file = 'src/public/roadmap-page.js';
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  if (!s.includes('RECENT_PLANNER_ROADMAPS_FIRST_V1')) {
    const oldText = `  roadmaps = data.items || [];
  $('#roadmapList').innerHTML = roadmaps.length ? roadmaps.map((item) => {
`;
    const newText = `  // RECENT_PLANNER_ROADMAPS_FIRST_V1
  const ts = (item) => {
    const raw = item?.updated_at || item?.created_at || 0;
    if (typeof raw === 'string' || typeof raw === 'number') {
      const parsed = new Date(raw).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return Number(raw?._seconds || raw?.seconds || 0) * 1000;
  };
  roadmaps = (data.items || [])
    .sort((a, b) => {
      const ap = a.proposal_type === 'PLANNER_ROADMAP' ? 1 : 0;
      const bp = b.proposal_type === 'PLANNER_ROADMAP' ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return ts(b) - ts(a);
    })
    .slice(0, 20);
  $('#roadmapList').innerHTML = roadmaps.length ? roadmaps.map((item) => {
`;
    s = rep(file, s, oldText, newText, 'recent roadmaps');
  }
  save(file, before, s);
}

console.log('ROADMAP_METADATA_REPAIR_AND_RECENT_GOALS_V1_OK');
