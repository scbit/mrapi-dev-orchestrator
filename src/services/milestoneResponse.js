function timestamp() {
  try {
    const { FieldValue } = require('@google-cloud/firestore');
    return FieldValue.serverTimestamp();
  } catch {
    return new Date();
  }
}

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function roadmapIsRunnable(roadmap) {
  if (!roadmap || roadmap.state !== 'ACTIVE') return false;
  if (roadmap.proposal_type === 'PLANNER_ROADMAP') {
    return roadmap.approval_status === 'APPROVED' && roadmap.non_executable !== true;
  }
  return true;
}

function sanitizeReferences(references) {
  if (references == null) return [];
  if (!Array.isArray(references)) fail('INVALID_REFERENCES', 400);
  return references.slice(0, 10).map((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      fail('INVALID_REFERENCES', 400);
    }
    const out = {};
    for (const field of ['id', 'evidence_id', 'resource_id', 'type', 'title', 'description', 'url', 'filename']) {
      if (reference[field] == null) continue;
      const limit = field === 'description' ? 1000 : field === 'url' ? 2000 : 300;
      const value = clean(reference[field], limit);
      if (value) out[field] = value;
    }
    return out;
  });
}

function responseShape(evidence) {
  return {
    id: evidence.id,
    evidence_id: evidence.id,
    tenant_id: evidence.tenant_id,
    workspace_id: evidence.workspace_id || null,
    project_id: evidence.project_id || null,
    roadmap_id: evidence.roadmap_id,
    milestone_id: evidence.milestone_id,
    mission_id: evidence.mission_id || null,
    type: evidence.type,
    evidence_type: evidence.evidence_type || evidence.type,
    source: evidence.source,
    text: evidence.text || evidence.content || '',
    content: evidence.content || evidence.text || '',
    references: Array.isArray(evidence.references) ? evidence.references : [],
    created_at: evidence.created_at || null,
    updated_at: evidence.updated_at || null
  };
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortLatest(items) {
  return [...items].sort((a, b) => {
    const bt = toMillis(b.updated_at || b.created_at);
    const at = toMillis(a.updated_at || a.created_at);
    return bt - at;
  });
}

function isHumanMilestoneResponse(evidence) {
  return evidence?.type === 'MILESTONE_HUMAN_RESPONSE' ||
    evidence?.evidence_type === 'MILESTONE_HUMAN_RESPONSE';
}

function milestoneResponseMatches(evidence, { tenantId, roadmapId, milestoneId, missionId, includePremission }) {
  if (!isHumanMilestoneResponse(evidence)) return false;
  if (evidence.tenant_id !== tenantId) return false;
  if (evidence.roadmap_id !== roadmapId) return false;
  if (evidence.milestone_id !== milestoneId) return false;
  if (missionId === undefined) return true;
  if (evidence.mission_id === missionId) return true;
  return includePremission === true && (evidence.mission_id == null || evidence.mission_id === '');
}

async function listMilestoneResponses(db, tenantId, roadmapId, milestoneId, options = {}) {
  const snap = await db.collection('evidence')
    .where('tenant_id', '==', tenantId)
    .limit(Number(options.limit || 300))
    .get();
  const items = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => milestoneResponseMatches(item, {
      tenantId,
      roadmapId,
      milestoneId,
      missionId: Object.hasOwn(options, 'missionId') ? options.missionId : undefined,
      includePremission: options.includePremission
    }));
  return sortLatest(items).map(responseShape);
}

async function saveMilestoneResponse(db, tenantId, roadmapId, milestoneId, input = {}) {
  const text = clean(input.text, 20000);
  if (!text) fail('MILESTONE_RESPONSE_TEXT_REQUIRED', 400);
  const references = sanitizeReferences(input.references);
  const roadmapRef = db.collection('roadmaps').doc(roadmapId);
  const evidenceRef = db.collection('evidence').doc();
  let saved = null;

  await db.runTransaction(async (tx) => {
    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
      fail('ROADMAP_NOT_FOUND', 404);
    }
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    if (!roadmapIsRunnable(roadmap)) fail('ROADMAP_NOT_ACTIVE', 409);

    const milestone = (Array.isArray(roadmap.milestones) ? roadmap.milestones : [])
      .find((item) => item.id === milestoneId);
    if (!milestone) fail('MILESTONE_NOT_FOUND', 404);

    let mission = null;
    if (milestone.mission_id) {
      const missionSnap = await tx.get(db.collection('missions').doc(milestone.mission_id));
      if (!missionSnap.exists) fail('MILESTONE_MISSION_PROVENANCE_MISMATCH', 409);
      mission = { id: missionSnap.id, ...missionSnap.data() };
      if (
        mission.tenant_id !== tenantId ||
        mission.roadmap_id !== roadmap.id ||
        mission.milestone_id !== milestone.id
      ) {
        fail('MILESTONE_MISSION_PROVENANCE_MISMATCH', 409);
      }
    }

    const at = timestamp();
    saved = {
      id: evidenceRef.id,
      tenant_id: tenantId,
      workspace_id: roadmap.workspace_id || mission?.workspace_id || null,
      project_id: roadmap.project_id || mission?.project_id || null,
      roadmap_id: roadmap.id,
      milestone_id: milestone.id,
      mission_id: milestone.mission_id || null,
      type: 'MILESTONE_HUMAN_RESPONSE',
      evidence_type: 'MILESTONE_HUMAN_RESPONSE',
      source: 'HUMAN/MILESTONE_RESPONSE',
      title: `Human response for ${milestone.id}`,
      description: text,
      text,
      content: text,
      references,
      task_id: null,
      run_id: null,
      brain_run_id: null,
      worker_id: null,
      executor_id: null,
      storage: null,
      created_at: at,
      updated_at: at
    };
    tx.set(evidenceRef, saved);
  });

  return responseShape(saved);
}

module.exports = {
  saveMilestoneResponse,
  listMilestoneResponses,
  sortLatest,
  isHumanMilestoneResponse
};
