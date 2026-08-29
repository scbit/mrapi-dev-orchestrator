const fs = require('fs');

function findFunctionRange(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error('FUNCTION_NOT_FOUND:' + signature);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error('FUNCTION_BRACE_NOT_FOUND:' + signature);
  let depth = 0, inString = false, quote = '', esc = false;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  throw new Error('FUNCTION_END_NOT_FOUND:' + signature);
}

function replaceFunction(file, signature, replacement) {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes('PRESERVE_PLANNER_MILESTONE_METADATA_V2') && signature.includes('normalizeMilestones')) return;
  const [start, end] = findFunctionRange(before, signature);
  const after = before.slice(0, start) + replacement + before.slice(end);
  fs.writeFileSync(file, after, 'utf8');
}

// 1) Replace normalizeMilestones structurally.
replaceFunction(
  'src/services/roadmap.js',
  'function normalizeMilestones(',
`function normalizeMilestones(items = []) {
  // PRESERVE_PLANNER_MILESTONE_METADATA_V2
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map((item, index) => {
    const source = item && typeof item === 'object' ? item : {};
    const state = MILESTONE_STATES.has(source.state) ? source.state : 'PENDING';
    const dependencies = Array.isArray(source.dependencies)
      ? cleanStringArray(source.dependencies, 20)
      : cleanStringArray(source.depends_on, 20);

    return {
      ...source,
      id: cleanText(source.id, 160) || \`milestone_\${index + 1}_\${crypto.randomUUID().slice(0, 8)}\`,
      title: cleanText(source.title, 300) || \`Milestone \${index + 1}\`,
      objective: cleanText(source.objective ?? source.expected_outcome, 6000),
      expected_outcome: cleanText(source.expected_outcome ?? source.objective, 6000),
      description: cleanText(source.description, 8000),
      executor_required: typeof source.executor_required === 'boolean' ? source.executor_required : source.executor_required,
      state,
      priority: cleanText(source.priority, 30) || 'NORMAL',
      dependencies,
      depends_on: dependencies,
      risks: cleanStringArray(source.risks, 50),
      success_criteria: cleanStringArray(source.success_criteria, 50),
      preferred_worker_id: cleanText(source.preferred_worker_id, 100) || null,
      mission_id: cleanText(source.mission_id, 200) || null,
      order: Number.isFinite(Number(source.order)) ? Number(source.order) : index + 1
    };
  });
}`
);

// 2) Add repair helper if missing.
{
  const file = 'src/services/planner.js';
  let s = fs.readFileSync(file, 'utf8');

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
  for (const key of runtimeFields) {
    if (Object.prototype.hasOwnProperty.call(current || {}, key)) merged[key] = current[key];
  }
  const deps = Array.isArray(template?.dependencies)
    ? template.dependencies
    : (Array.isArray(template?.depends_on) ? template.depends_on : []);
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
      Array.isArray(item?.milestones) &&
      item.milestones.length &&
      item.milestones.every(plannerMilestoneHasReviewContract)
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
    const exportIdx = s.indexOf('module.exports = {');
    if (exportIdx < 0) throw new Error('PLANNER_EXPORTS_NOT_FOUND');
    s = s.slice(0, exportIdx) + helper + s.slice(exportIdx);

    if (!s.includes('repairPlannerRoadmapMetadata,')) {
      s = s.replace('  startPlannerRoadmap,\n', '  startPlannerRoadmap,\n  repairPlannerRoadmapMetadata,\n');
    }
    fs.writeFileSync(file, s, 'utf8');
  }
}

// 3) Add repair route robustly.
{
  const file = 'src/routes/planner.routes.js';
  let s = fs.readFileSync(file, 'utf8');

  if (!s.includes('repairPlannerRoadmapMetadata')) {
    s = s.replace(
      '  startPlannerRoadmap\n} = require(\'../services/planner\');',
      '  startPlannerRoadmap,\n  repairPlannerRoadmapMetadata\n} = require(\'../services/planner\');'
    );
    if (!s.includes('repairPlannerRoadmapMetadata')) throw new Error('PLANNER_IMPORT_PATCH_FAILED');
  }

  if (!s.includes('/repair-metadata')) {
    const anchor = "  router.post('/roadmaps/:roadmapId/start', async (req, res, next) => {";
    const idx = s.indexOf(anchor);
    if (idx < 0) throw new Error('PLANNER_START_ROUTE_NOT_FOUND');
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
    s = s.slice(0, idx) + route + s.slice(idx);
  }
  fs.writeFileSync(file, s, 'utf8');
}

// 4) Recent Planner Roadmaps first. Use function replacement fragment, tolerant of current content.
{
  const file = 'src/public/roadmap-page.js';
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('RECENT_PLANNER_ROADMAPS_FIRST_V2')) {
    const needle = '  roadmaps = data.items || [];';
    const idx = s.indexOf(needle);
    if (idx < 0) throw new Error('ROADMAP_LIST_ASSIGNMENT_NOT_FOUND');
    const replacement = `  // RECENT_PLANNER_ROADMAPS_FIRST_V2
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
    .slice(0, 20);`;
    s = s.slice(0, idx) + replacement + s.slice(idx + needle.length);
    fs.writeFileSync(file, s, 'utf8');
  }
}

// verify
const checks = [
  ['src/services/roadmap.js', 'PRESERVE_PLANNER_MILESTONE_METADATA_V2'],
  ['src/services/planner.js', 'repairPlannerRoadmapMetadata'],
  ['src/routes/planner.routes.js', '/repair-metadata'],
  ['src/public/roadmap-page.js', 'RECENT_PLANNER_ROADMAPS_FIRST_V2']
];
for (const [file, marker] of checks) {
  if (!fs.readFileSync(file, 'utf8').includes(marker)) throw new Error('VERIFY_FAILED:' + file);
}
console.log('ROADMAP_METADATA_REPAIR_AND_RECENT_GOALS_V2_OK');
