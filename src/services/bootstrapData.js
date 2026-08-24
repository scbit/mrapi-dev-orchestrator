const { DEFAULT_PERMISSIONS } = require('../constants/autonomy');

const TENANT = {
  id: 'tenant_facundo_group',
  name: 'Facundo Group',
  status: 'ACTIVE'
};

const WORKSPACES = [
  { id: 'workspace_scb', name: 'SCB' },
  { id: 'workspace_fm_real_estate', name: 'FM Real Estate' },
  { id: 'workspace_sentire_marine', name: 'Sentire Marine' }
];

const PROJECTS = [
  {
    id: 'project_scb_development',
    workspace_id: 'workspace_scb',
    name: 'SCB Development',
    primary_worker_ids: ['W01']
  },
  {
    id: 'project_fm_real_estate_analysis',
    workspace_id: 'workspace_fm_real_estate',
    name: 'FM Real Estate Analysis',
    primary_worker_ids: ['W02']
  },
  {
    id: 'project_sentire_marine_segue',
    workspace_id: 'workspace_sentire_marine',
    name: 'Sentire Marine / Segue',
    primary_worker_ids: ['W03']
  },
  {
    id: 'project_scb_marketing',
    workspace_id: 'workspace_scb',
    name: 'SCB Marketing',
    primary_worker_ids: ['W04', 'W05']
  }
];

const WORKER_PROFILES = [
  {
    id: 'profile_W01',
    worker_code: 'W01',
    role: 'Software Engineer',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_development',
    capabilities: [
      'audit systems',
      'compare real state vs expected state',
      'generate pending work',
      'program',
      'test',
      'fix',
      'deploy',
      'capture screenshots',
      'record evidence'
    ],
    default_brain: { provider: 'ChatGPT Web', type: 'BRAIN', hardcoded: false },
    default_executor: { provider: 'Codex', type: 'EXECUTOR', hardcoded: false },
    default_host: { provider: 'Shadow', type: 'HOST', hardcoded: false },
    mission_policy: { brain_only_allowed: true, execution_optional: true },
    autonomy_level: 2,
    permissions: { ...DEFAULT_PERMISSIONS, allow_git_commit: true, allow_git_push: true }
  },
  {
    id: 'profile_W02',
    worker_code: 'W02',
    role: 'US Real Estate Analyst',
    workspace_id: 'workspace_fm_real_estate',
    project_id: 'project_fm_real_estate_analysis',
    capabilities: [
      'analyze US properties',
      'comparables',
      'ARV',
      'renovation',
      'closing',
      'holding',
      'ROI',
      'scenarios',
      'maximum purchase price',
      'final investment report'
    ],
    default_brain: { provider: 'ChatGPT Web', type: 'BRAIN', hardcoded: false },
    default_executor: { provider: 'Codex', type: 'EXECUTOR', hardcoded: false },
    default_host: { provider: 'Shadow', type: 'HOST', hardcoded: false },
    mission_policy: { brain_only_allowed: true, execution_optional: true },
    execution_metadata: {
      target_type: 'BROWSER',
      target_name: 'Real estate sources',
      browser_required: true,
      evidence_required: true
    },
    autonomy_level: 1,
    permissions: { ...DEFAULT_PERMISSIONS }
  },
  {
    id: 'profile_W03',
    worker_code: 'W03',
    role: 'Sentire Marine / Segue Agent',
    display_name: 'Sentire Marine Agent',
    workspace_id: 'workspace_sentire_marine',
    project_id: 'project_sentire_marine_segue',
    capabilities: [
      'market research',
      'dealers',
      'brokers',
      'investors',
      'competition',
      'opportunities',
      'commercial research',
      'reports'
    ],
    default_brain: { provider: 'ChatGPT Web', type: 'BRAIN', hardcoded: false },
    default_executor: { provider: 'Codex', type: 'EXECUTOR', hardcoded: false },
    default_host: { provider: 'Shadow', type: 'HOST', hardcoded: false },
    mission_policy: { brain_only_allowed: true, execution_optional: true },
    execution_metadata: {
      target_type: 'BROWSER',
      target_name: 'Marine market sources',
      browser_required: true,
      evidence_required: true
    },
    autonomy_level: 1,
    permissions: { ...DEFAULT_PERMISSIONS }
  },
  {
    id: 'profile_W04',
    worker_code: 'W04',
    role: 'SCB Marketing Creator',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_marketing',
    capabilities: [
      'new campaigns',
      'creative concepts',
      'copy',
      'offers',
      'briefs',
      'creative variants',
      'execution based on approved insights'
    ],
    default_brain: { provider: 'ChatGPT Web', type: 'BRAIN', hardcoded: false },
    default_executor: { provider: 'Codex', type: 'EXECUTOR', hardcoded: false },
    default_host: { provider: 'Shadow', type: 'HOST', hardcoded: false },
    mission_policy: { brain_only_allowed: true, execution_optional: true },
    execution_metadata: {
      target_type: 'BROWSER',
      target_name: 'Meta Ads / HeyGen',
      browser_required: true,
      evidence_required: true
    },
    autonomy_level: 2,
    permissions: { ...DEFAULT_PERMISSIONS }
  },
  {
    id: 'profile_W05',
    worker_code: 'W05',
    role: 'SCB Marketing Analyst',
    workspace_id: 'workspace_scb',
    project_id: 'project_scb_marketing',
    capabilities: [
      'analyze existing campaigns',
      'identify what works',
      'compare metrics',
      'detect fatigue',
      'generate hypotheses',
      'recommend actions to W04'
    ],
    default_brain: { provider: 'ChatGPT Web', type: 'BRAIN', hardcoded: false },
    default_executor: { provider: 'Codex', type: 'EXECUTOR', hardcoded: false },
    default_host: { provider: 'Shadow', type: 'HOST', hardcoded: false },
    mission_policy: { brain_only_allowed: true, execution_optional: true },
    execution_metadata: {
      target_type: 'BROWSER',
      target_name: 'Meta Ads',
      browser_required: true,
      evidence_required: true
    },
    autonomy_level: 1,
    permissions: { ...DEFAULT_PERMISSIONS }
  }
];

const WORKERS = WORKER_PROFILES.map((profile) => ({
  id: profile.worker_code,
  code: profile.worker_code,
  profile_id: profile.id,
  workspace_id: profile.workspace_id,
  project_id: profile.project_id,
  name: profile.display_name || profile.role,
  role: profile.role,
  state: 'IDLE',
  current_mission_id: null,
  current_task_id: null,
  brain_binding: profile.default_brain || null,
  executor_binding: profile.default_executor || null,
  host_binding: profile.default_host || null,
  mission_policy: profile.mission_policy || null,
  execution_metadata: profile.execution_metadata || null,
  permissions: profile.permissions || null,
  autonomy_level: profile.autonomy_level
}));

module.exports = {
  TENANT,
  WORKSPACES,
  PROJECTS,
  WORKER_PROFILES,
  WORKERS
};
