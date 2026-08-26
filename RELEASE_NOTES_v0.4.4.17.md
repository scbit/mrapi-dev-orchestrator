# v0.4.4.17 — Autopilot verdict authority fix

- Autopilot PROGRAM contract now requires both non-empty `allowed_files` and non-empty `required_tests` before any Executor task can be created.
- Autopilot tasks persist the validated `task_spec` directly so handoff fields are not lost.
- Codex handoff refuses Autopilot work with missing `required_tests`.
- Runner accepts a non-zero Codex CLI process exit caused only by diagnostic/advisory tests when the machine-readable executor report contains at least one required test and every required test passed.
- Empty required-test reports can never turn a failed process into success.
- Verification-format repair explicitly requires `allowed_files` and `required_tests` for RETRY.
- Git writes and Cloud Run deploy remain forbidden during PROGRAM/RETRY.
