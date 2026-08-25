# v0.4.4.3 — Autopilot Executor Safety

- Brain must declare `task_spec.allowed_files` for Autopilot repository work.
- Codex may modify/create/delete only Brain-authorized repo-relative files.
- Runner verifies final Git working-tree changes against `allowed_files`.
- Autopilot repository must be clean before PROGRAM/RETRY execution.
- Git commit/push is disabled during PROGRAM/RETRY and reserved for a separate future `GIT_STAGE`.
- Codex process receives a Git read-only guard that blocks push/commit/pull/fetch/merge/rebase/reset/checkout/switch/branch mutations during Autopilot execution.
- Retry decisions can carry Brain-authored `allowed_files`.
- Cloud Run deploy remains HUMAN MANUAL DEPLOY.

Validation: focused regression suite 63/63 passed; syntax checks passed.
