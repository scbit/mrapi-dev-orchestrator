const AUTONOMY_LEVELS = Object.freeze({
  READ_ONLY: 0,
  ANALYZE_REPORT: 1,
  ARTIFACTS: 2,
  EXTERNAL_ACTIONS: 3,
  AUTONOMOUS_OPERATIONS: 4
});

const DEFAULT_PERMISSIONS = Object.freeze({
  allow_deploy: false,
  allow_delete: false,
  allow_send_email: false,
  allow_publish: false,
  allow_modify_production_data: false,
  allow_git_commit: false,
  allow_git_push: false
});

module.exports = { AUTONOMY_LEVELS, DEFAULT_PERMISSIONS };
