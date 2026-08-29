const crypto = require('crypto');

const GOAL_STATES = new Set(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'BLOCKED', 'CANCELLED']);
const MILESTONE_STATES = new Set(['PENDING', 'PLANNING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'BLOCKED', 'SKIPPED', 'NEED_HUMAN_ACTION']);

function cleanText(value, max = 4000) {
  const text = String(value ?? '').trim();
  return text.slice(0, max);
}

function cleanStringArray(value, maxItems = 50) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanText(item, 500)).filter(Boolean);
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (/(password|passwd|secret|token|api[_-]?key|credential|cookie|session)/i.test(key)) return true;
    return child && typeof child === 'object' ? containsSensitiveKey(child) : false;
  });
}

function normalizeProjectContext(input = {}, existing = {}) {
  if (containsSensitiveKey(input.runtime_context)) {
    const error = new Error('Project Context must not store credentials or secrets. Use connection references instead.');
    error.code = 'PROJECT_CONTEXT_SECRET_FORBIDDEN';
    throw error;
  }
  const runtime = input.runtime_context && typeof input.runtime_context === 'object'
    ? input.runtime_context
    : existing.runtime_context || {};

  return {
    repository_url: input.repository_url === undefined ? existing.repository_url ?? null : cleanText(input.repository_url, 1000) || null,
    repository_full_name: input.repository_full_name === undefined ? existing.repository_full_name ?? null : cleanText(input.repository_full_name, 300) || null,
    local_path: input.local_path === undefined ? existing.local_path ?? null : cleanText(input.local_path, 1200) || null,
    default_branch: input.default_branch === undefined ? existing.default_branch ?? 'main' : cleanText(input.default_branch, 200) || 'main',
    default_worker_id: input.default_worker_id === undefined ? existing.default_worker_id ?? null : cleanText(input.default_worker_id, 100) || null,
    reusable_instructions: input.reusable_instructions === undefined
      ? existing.reusable_instructions ?? ''
      : cleanText(input.reusable_instructions, 12000),
    runtime_context: {
      ...runtime,
      ...(input.runtime_context && typeof input.runtime_context === 'object' ? input.runtime_context : {})
    }
  };
}

function normalizeMilestones(items = []) {
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
      id: cleanText(source.id, 160) || `milestone_${index + 1}_${crypto.randomUUID().slice(0, 8)}`,
      title: cleanText(source.title, 300) || `Milestone ${index + 1}`,
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
}

function normalizeRoadmapInput(input = {}, existing = {}) {
  const state = GOAL_STATES.has(input.state) ? input.state : existing.state || 'DRAFT';
  return {
    title: cleanText(input.title ?? existing.title, 500),
    objective: cleanText(input.objective ?? existing.objective, 6000),
    state,
    priority: cleanText(input.priority ?? existing.priority, 30) || 'NORMAL',
    owner_worker_id: cleanText(input.owner_worker_id ?? existing.owner_worker_id, 100) || 'W01',
    auto_advance: input.auto_advance === undefined ? Boolean(existing.auto_advance) : Boolean(input.auto_advance),
    reporting_mode: cleanText(input.reporting_mode ?? existing.reporting_mode, 50) || 'MILESTONE',
    milestones: input.milestones === undefined ? normalizeMilestones(existing.milestones || []) : normalizeMilestones(input.milestones)
  };
}

function milestoneCanStart(milestone, milestones) {
  if (!milestone || milestone.state !== 'PENDING') return false;
  const byId = new Map((milestones || []).map((item) => [item.id, item]));
  const dependencies = Array.isArray(milestone.depends_on)
    ? milestone.depends_on
    : Array.isArray(milestone.dependencies)
      ? milestone.dependencies
      : [];
  return dependencies.every((id) => ['COMPLETED', 'SKIPPED'].includes(byId.get(id)?.state));
}

function nextMilestone(roadmap) {
  const milestones = [...(roadmap?.milestones || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return milestones.find((item) => milestoneCanStart(item, milestones)) || null;
}

module.exports = {
  GOAL_STATES,
  MILESTONE_STATES,
  normalizeProjectContext,
  normalizeRoadmapInput,
  milestoneCanStart,
  nextMilestone,
  containsSensitiveKey
};
