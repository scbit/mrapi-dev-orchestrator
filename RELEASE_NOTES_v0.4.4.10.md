# W01 Autopilot RETRY scope integrity fix

- Preserves Brain-defined `allowed_files` in every RETRY task representation, including `brain_output.task_spec` used by Codex handoff validation.
- Blocks unsafe RETRY creation when the Brain omits `allowed_files` instead of queuing an executor task that will fail later.
- Clarifies runner reporting when the Codex process exits with code 0 but MRAPI post-execution validation fails.
- Reduces inline Mission output tails; full bounded execution output remains available as LOG evidence.
- Git write/push/deploy behavior is unchanged: PROGRAM/RETRY remains read-only for Git and Cloud Run deploy stays manual.
