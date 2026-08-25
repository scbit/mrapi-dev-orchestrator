# v0.4.4.7 — Brain allowed_files contract fix

- Fixes Autopilot PROGRAM handoff losing Brain-defined `task_spec.allowed_files`.
- Brain output now overrides adapter fallback task fields.
- Autopilot completion no longer injects a generic legacy task_spec.
- PROGRAM prompt JSON example now includes mandatory `allowed_files`.
- Codex remains Executor-only; Git write/push and deploy remain outside PROGRAM/RETRY.
