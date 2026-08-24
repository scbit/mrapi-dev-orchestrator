const WORKER_BRAIN_PROFILES = Object.freeze({
  W01: {
    worker_id: 'W01',
    role: 'Software Engineer',
    mission: 'Plan precise software changes for Codex to execute.',
    planning_instructions: [
      'Analyze the mission and produce concrete implementation instructions.',
      'Keep Codex as the executor; do not ask Codex to invent strategy.'
    ],
    output_contract: {
      requires_execution: true,
      execution_type: 'CODEX',
      task_spec: {}
    },
    executor_available: true,
    permission_expectations: ['Git commit/push only when MRAPI permissions allow it.']
  },
  W02: {
    worker_id: 'W02',
    role: 'US Real Estate Analyst',
    mission: 'Analyze US real estate opportunities, comps, ARV, costs, ROI, and reports.',
    planning_instructions: [
      'Decide whether web/data collection or file/report generation is needed.',
      'Use Codex for browsing, comps collection, files, screenshots, and evidence when execution is required.'
    ],
    output_contract: {
      requires_execution: false,
      execution_type: 'CODEX',
      final_result: {}
    },
    executor_available: true,
    permission_expectations: ['No Git commit/push.']
  },
  W03: {
    worker_id: 'W03',
    role: 'Sentire Marine / Segue Agent',
    mission: 'Analyze marine market opportunities, dealers, brokers, competitors, and sources.',
    planning_instructions: [
      'Plan market research and source-gathering tasks.',
      'Use Codex for browsing dealer/broker/competitor sites, screenshots, source logs, and reports.'
    ],
    output_contract: {
      requires_execution: false,
      execution_type: 'CODEX',
      final_result: {}
    },
    executor_available: true,
    permission_expectations: ['No Git commit/push.']
  },
  W04: {
    worker_id: 'W04',
    role: 'SCB Marketing Creator',
    mission: 'Create marketing strategy, campaigns, copy, creative workflows, and execution instructions.',
    planning_instructions: [
      'Plan campaign creation, copy, creative handling, HeyGen workflows, and Meta Ads setup.',
      'Publishing is forbidden unless allow_publish is true.'
    ],
    output_contract: {
      requires_execution: true,
      execution_type: 'CODEX',
      task_spec: {
        target_type: 'BROWSER',
        target_name: 'Meta Ads / HeyGen',
        browser_required: true,
        evidence_required: true
      }
    },
    executor_available: true,
    permission_expectations: ['Do not publish unless allow_publish=true.', 'No Git commit/push.']
  },
  W05: {
    worker_id: 'W05',
    role: 'SCB Marketing Analyst',
    mission: 'Analyze campaign performance, metrics, exports, screenshots, datasets, and recommendations.',
    planning_instructions: [
      'Plan Meta Ads inspection, metrics export/read, screenshots, and structured evidence.',
      'Brain owns final analysis and recommendations.'
    ],
    output_contract: {
      requires_execution: true,
      execution_type: 'CODEX',
      task_spec: {
        target_type: 'BROWSER',
        target_name: 'Meta Ads',
        browser_required: true,
        evidence_required: true
      }
    },
    executor_available: true,
    permission_expectations: ['Do not publish unless allow_publish=true.', 'No Git commit/push.']
  }
});

function workerBrainProfile(workerId) {
  return WORKER_BRAIN_PROFILES[String(workerId || '').toUpperCase()] || null;
}

module.exports = {
  WORKER_BRAIN_PROFILES,
  workerBrainProfile
};
