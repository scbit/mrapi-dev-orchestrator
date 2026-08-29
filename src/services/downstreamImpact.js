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

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
    if (bt !== at) return bt - at;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
}

function proposalShape(proposal) {
  if (!proposal) return null;
  return {
    id: proposal.id,
    impact_id: proposal.id,
    evidence_id: proposal.id,
    tenant_id: proposal.tenant_id,
    workspace_id: proposal.workspace_id || null,
    project_id: proposal.project_id || null,
    roadmap_id: proposal.roadmap_id,
    source_milestone_id: proposal.source_milestone_id,
    milestone_id: proposal.source_milestone_id,
    mission_id: proposal.mission_id || null,
    type: 'DOWNSTREAM_IMPACT',
    evidence_type: 'DOWNSTREAM_IMPACT',
    status: proposal.status,
    affected_milestone_ids: Array.isArray(proposal.affected_milestone_ids) ? [...proposal.affected_milestone_ids] : [],
    affected_milestones: Array.isArray(proposal.affected_milestone_ids) ? [...proposal.affected_milestone_ids] : [],
    reason: proposal.reason || '',
    proposed_changes: proposal.proposed_changes || null,
    approval_required: proposal.status === 'PENDING_APPROVAL',
    approval: proposal.approval || null,
    approved_at: proposal.approved_at || null,
    approved_by: proposal.approved_by || null,
    approval_source: proposal.approval_source || null,
    rejected_at: proposal.rejected_at || null,
    rejected_by: proposal.rejected_by || null,
    rejection_source: proposal.rejection_source || null,
    created_at: proposal.created_at || null,
    updated_at: proposal.updated_at || null
  };
}

function milestoneOrder(roadmap) {
  return (Array.isArray(roadmap?.milestones) ? roadmap.milestones : [])
    .map((milestone, index) => ({
      milestone,
      index,
      order: Number.isFinite(Number(milestone.order)) ? Number(milestone.order) : index
    }))
    .sort((a, b) => (a.order - b.order) || (a.index - b.index));
}

async function validateScope(tx, db, tenantId, roadmapId, sourceMilestoneId, input = {}) {
  const roadmapRef = db.collection('roadmaps').doc(roadmapId);
  const roadmapSnap = await tx.get(roadmapRef);
  if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) {
    fail('ROADMAP_NOT_FOUND', 404);
  }

  const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
  const ordered = milestoneOrder(roadmap);
  const sourcePosition = ordered.findIndex((item) => item.milestone.id === sourceMilestoneId);
  if (sourcePosition < 0) fail('MILESTONE_NOT_FOUND', 404);
  const sourceMilestone = ordered[sourcePosition].milestone;

  const affected = input.affected_milestone_ids;
  if (!Array.isArray(affected) || affected.length === 0) {
    fail('AFFECTED_MILESTONE_IDS_REQUIRED', 400);
  }

  const affectedIds = affected.map((id) => clean(id, 300)).filter(Boolean);
  if (affectedIds.length !== affected.length) fail('INVALID_AFFECTED_MILESTONE_IDS', 400);
  if (new Set(affectedIds).size !== affectedIds.length) fail('DUPLICATE_AFFECTED_MILESTONE_ID', 400);

  const positions = new Map(ordered.map((item, index) => [item.milestone.id, index]));
  for (const id of affectedIds) {
    if (!positions.has(id)) fail('AFFECTED_MILESTONE_NOT_FOUND', 404);
    if (id === sourceMilestone.id) fail('SOURCE_MILESTONE_CANNOT_BE_AFFECTED', 400);
    if (positions.get(id) <= sourcePosition) fail('AFFECTED_MILESTONE_NOT_DOWNSTREAM', 400);
  }

  const suppliedMissionId = clean(input.mission_id, 300) || null;
  if (sourceMilestone.mission_id && suppliedMissionId && suppliedMissionId !== sourceMilestone.mission_id) {
    fail('MISSION_PROVENANCE_MISMATCH', 409);
  }

  const missionId = sourceMilestone.mission_id || suppliedMissionId || null;
  let mission = null;
  if (missionId) {
    const missionSnap = await tx.get(db.collection('missions').doc(missionId));
    if (!missionSnap.exists) fail('MISSION_PROVENANCE_MISMATCH', 409);
    mission = { id: missionSnap.id, ...missionSnap.data() };
    if (
      mission.tenant_id !== tenantId ||
      mission.roadmap_id !== roadmap.id ||
      mission.milestone_id !== sourceMilestone.id
    ) {
      fail('MISSION_PROVENANCE_MISMATCH', 409);
    }
  }

  return { roadmap, sourceMilestone, affectedIds, mission, missionId };
}

async function createDownstreamImpactProposal(db, tenantId, roadmapId, sourceMilestoneId, input = {}) {
  const reason = clean(input.reason, 4000);
  if (!reason) fail('DOWNSTREAM_IMPACT_REASON_REQUIRED', 400);
  if (Object.hasOwn(input, 'proposed_changes') && input.proposed_changes != null && !isPlainObject(input.proposed_changes)) {
    fail('INVALID_PROPOSED_CHANGES', 400);
  }

  const evidenceRef = db.collection('evidence').doc();
  let saved = null;

  await db.runTransaction(async (tx) => {
    const { roadmap, sourceMilestone, affectedIds, mission, missionId } = await validateScope(
      tx,
      db,
      tenantId,
      roadmapId,
      sourceMilestoneId,
      input
    );
    const at = timestamp();
    saved = {
      id: evidenceRef.id,
      tenant_id: tenantId,
      workspace_id: roadmap.workspace_id || mission?.workspace_id || null,
      project_id: roadmap.project_id || mission?.project_id || null,
      roadmap_id: roadmap.id,
      milestone_id: sourceMilestone.id,
      source_milestone_id: sourceMilestone.id,
      mission_id: missionId,
      type: 'DOWNSTREAM_IMPACT',
      evidence_type: 'DOWNSTREAM_IMPACT',
      status: 'PENDING_APPROVAL',
      source: 'BRAIN/DOWNSTREAM_IMPACT_DETECTED',
      title: `Downstream impact detected from ${sourceMilestone.id}`,
      description: reason,
      reason,
      affected_milestone_ids: affectedIds,
      proposed_changes: Object.hasOwn(input, 'proposed_changes') ? input.proposed_changes || null : null,
      approval: null,
      approved_at: null,
      approved_by: null,
      approval_source: null,
      rejected_at: null,
      rejected_by: null,
      rejection_source: null,
      task_id: null,
      run_id: null,
      brain_run_id: clean(input.brain_run_id, 300) || null,
      worker_id: null,
      executor_id: null,
      storage: null,
      created_at: at,
      updated_at: at
    };
    tx.set(evidenceRef, saved);
  });

  return proposalShape(saved);
}

function isDownstreamImpactProposal(evidence) {
  return evidence?.type === 'DOWNSTREAM_IMPACT' ||
    evidence?.evidence_type === 'DOWNSTREAM_IMPACT';
}

function proposalMatches(proposal, { tenantId, roadmapId, sourceMilestoneId, missionId }) {
  if (!isDownstreamImpactProposal(proposal)) return false;
  if (proposal.tenant_id !== tenantId) return false;
  if (proposal.roadmap_id !== roadmapId) return false;
  if ((proposal.source_milestone_id || proposal.milestone_id) !== sourceMilestoneId) return false;
  if (missionId === undefined) return true;
  return (proposal.mission_id || null) === (missionId || null);
}

async function listDownstreamImpactProposals(db, tenantId, roadmapId, sourceMilestoneId, options = {}) {
  const snap = await db.collection('evidence')
    .where('tenant_id', '==', tenantId)
    .limit(Number(options.limit || 300))
    .get();
  const items = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => proposalMatches(item, {
      tenantId,
      roadmapId,
      sourceMilestoneId,
      missionId: Object.hasOwn(options, 'missionId') ? options.missionId : undefined
    }));
  return sortLatest(items).map(proposalShape);
}

async function latestDownstreamImpactProposal(db, tenantId, roadmapId, sourceMilestoneId, options = {}) {
  const proposals = await listDownstreamImpactProposals(db, tenantId, roadmapId, sourceMilestoneId, options);
  return proposals.find((item) => item.status === 'PENDING_APPROVAL') || proposals[0] || null;
}

async function updateDownstreamImpactStatus(db, tenantId, roadmapId, sourceMilestoneId, impactId, nextStatus, input = {}) {
  if (!['APPROVED', 'REJECTED'].includes(nextStatus)) fail('INVALID_DOWNSTREAM_IMPACT_STATUS', 400);
  const impactRef = db.collection('evidence').doc(impactId);
  const roadmapRef = db.collection('roadmaps').doc(roadmapId);
  let saved = null;

  await db.runTransaction(async (tx) => {
    const impactSnap = await tx.get(impactRef);
    if (!impactSnap.exists) fail('DOWNSTREAM_IMPACT_NOT_FOUND', 404);
    const proposal = { id: impactSnap.id, ...impactSnap.data() };
    if (!proposalMatches(proposal, { tenantId, roadmapId, sourceMilestoneId })) {
      fail('DOWNSTREAM_IMPACT_NOT_FOUND', 404);
    }

    const roadmapSnap = await tx.get(roadmapRef);
    if (!roadmapSnap.exists || roadmapSnap.data().tenant_id !== tenantId) fail('ROADMAP_NOT_FOUND', 404);
    const roadmap = { id: roadmapSnap.id, ...roadmapSnap.data() };
    const sourceMilestone = (Array.isArray(roadmap.milestones) ? roadmap.milestones : [])
      .find((item) => item.id === sourceMilestoneId);
    if (!sourceMilestone) fail('MILESTONE_NOT_FOUND', 404);
    if (proposal.mission_id) {
      const missionSnap = await tx.get(db.collection('missions').doc(proposal.mission_id));
      if (!missionSnap.exists) fail('MISSION_PROVENANCE_MISMATCH', 409);
      const mission = { id: missionSnap.id, ...missionSnap.data() };
      if (
        mission.tenant_id !== tenantId ||
        mission.roadmap_id !== roadmap.id ||
        mission.milestone_id !== sourceMilestone.id ||
        sourceMilestone.mission_id !== proposal.mission_id
      ) {
        fail('MISSION_PROVENANCE_MISMATCH', 409);
      }
    }

    if (proposal.status !== 'PENDING_APPROVAL') fail('DOWNSTREAM_IMPACT_NOT_PENDING', 409);

    const at = timestamp();
    const actor = clean(input.actor || input.approved_by || input.rejected_by || input.source || 'human', 300) || 'human';
    const metadata = nextStatus === 'APPROVED'
      ? {
          status: 'APPROVED',
          approval: { approved_at: at, approved_by: actor, source: 'HUMAN' },
          approved_at: at,
          approved_by: actor,
          approval_source: 'HUMAN',
          updated_at: at
        }
      : {
          status: 'REJECTED',
          approval: null,
          rejected_at: at,
          rejected_by: actor,
          rejection_source: 'HUMAN',
          updated_at: at
        };
    tx.set(impactRef, metadata, { merge: true });
    saved = { ...proposal, ...metadata };
  });

  return proposalShape(saved);
}

module.exports = {
  createDownstreamImpactProposal,
  listDownstreamImpactProposals,
  latestDownstreamImpactProposal,
  updateDownstreamImpactStatus,
  isDownstreamImpactProposal,
  sortLatest
};
