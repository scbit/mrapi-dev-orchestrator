const { getMissionRecoveryStatus } = require('./missionRecovery');

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
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
    const bt = toMillis(b.updated_at || b.completed_at || b.started_at || b.created_at);
    const at = toMillis(a.updated_at || a.completed_at || a.started_at || a.created_at);
    return bt - at;
  });
}

function baseRuntime(roadmap, milestone) {
  return {
    roadmap_id: roadmap?.id || roadmap?.roadmap_id || null,
    milestone_id: milestone?.id || null,
    milestone_state: milestone?.state || null,
    mission_id: milestone?.mission_id || null,
    mission_state: null,
    brain_run: null,
    execution_run: null,
    human_action: null,
    blocker: blockerFrom(milestone),
    latest_evidence: null,
    recovery: null
  };
}

function noRecovery(reason = 'NO_MISSION_LINKED') {
  return {
    recoverable: false,
    mode: 'NO_ACTION',
    action_label: 'No recovery available',
    reason
  };
}

function checkpointFrom(mission, milestone) {
  return mission?.human_action_checkpoint ||
    milestone?.human_action_checkpoint ||
    milestone?.human_action ||
    null;
}

function blockerFrom(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const code = clean(
      source.blocker_code ||
      source.failure_code ||
      source.blocked_reason ||
      source.block_reason ||
      '',
      300
    );
    const message = clean(
      source.blocker_message ||
      source.failure_message ||
      source.blocked_message ||
      source.blocker_reason ||
      source.failure_reason ||
      source.blocked_reason ||
      source.block_reason ||
      source.error ||
      '',
      1000
    );
    const state = clean(source.state || '', 120);
    if (code || message || state) {
      return {
        code: code || null,
        message: message || null,
        reason: message || code || null,
        state: state || null
      };
    }
  }
  return null;
}

function trustedMissionForMilestone(mission, tenantId, roadmap, milestone) {
  return Boolean(
    mission &&
    mission.tenant_id === tenantId &&
    mission.roadmap_id === roadmap.id &&
    mission.milestone_id === milestone.id
  );
}

async function getTenantCollection(db, collectionName, tenantId, limit = 300) {
  const snap = await db.collection(collectionName)
    .where('tenant_id', '==', tenantId)
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function selectRun(runs, runType) {
  return sortLatest(runs.filter((run) => run.run_type === runType))[0] || null;
}

function evidenceMatches(evidence, { tenantId, missionId, roadmap, milestone }) {
  if (evidence.tenant_id !== tenantId) return false;
  if (evidence.mission_id !== missionId) return false;
  if (evidence.milestone_id && evidence.milestone_id !== milestone.id) return false;
  if (evidence.roadmap_id && evidence.roadmap_id !== roadmap.id) return false;
  return true;
}

async function resolveLatestEvidence(db, tenantId, roadmap, milestone, missionId) {
  const evidence = await getTenantCollection(db, 'evidence', tenantId, 300);
  return sortLatest(evidence.filter((item) => evidenceMatches(item, {
    tenantId,
    missionId,
    roadmap,
    milestone
  })))[0] || null;
}

async function resolveMilestoneRuntime(db, tenantId, roadmap, milestone) {
  const runtime = baseRuntime(roadmap, milestone);
  if (!runtime.mission_id) {
    return { ...runtime, recovery: noRecovery() };
  }

  const missionSnap = await db.collection('missions').doc(runtime.mission_id).get();
  const mission = missionSnap.exists ? { id: missionSnap.id, ...missionSnap.data() } : null;
  if (!trustedMissionForMilestone(mission, tenantId, roadmap, milestone)) {
    return {
      ...runtime,
      mission_state: mission?.state || null,
      mission_id: null,
      blocker: {
        code: 'TRUSTED_PROVENANCE_MISMATCH',
        message: 'Linked Mission does not match tenant, roadmap, and milestone provenance.',
        reason: 'TRUSTED_PROVENANCE_MISMATCH',
        state: mission?.state || null
      },
      recovery: noRecovery('TRUSTED_PROVENANCE_MISMATCH')
    };
  }

  const runs = (await getTenantCollection(db, 'runs', tenantId, 300))
    .filter((run) => run.mission_id === mission.id);
  const recovery = await getMissionRecoveryStatus(db, tenantId, mission.id);

  return {
    ...runtime,
    mission_id: mission.id,
    mission_state: mission.state || null,
    brain_run: selectRun(runs, 'BRAIN_RUN'),
    execution_run: selectRun(runs, 'EXECUTION_RUN'),
    human_action: checkpointFrom(mission, milestone),
    blocker: blockerFrom(mission, milestone),
    latest_evidence: await resolveLatestEvidence(db, tenantId, roadmap, milestone, mission.id),
    recovery
  };
}

async function resolveRoadmapRuntime(db, tenantId, roadmap) {
  const milestones = Array.isArray(roadmap?.milestones) ? roadmap.milestones : [];
  const resolved = [];
  for (const milestone of milestones) {
    resolved.push(await resolveMilestoneRuntime(db, tenantId, roadmap, milestone));
  }
  return resolved;
}

module.exports = {
  resolveMilestoneRuntime,
  resolveRoadmapRuntime,
  sortLatest,
  toMillis
};
