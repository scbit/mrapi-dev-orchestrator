# v0.4.4.8 — Runner stale unsafe task isolation

- A queued legacy/unsafe task without Brain-defined `allowed_files` no longer kills the Shadow Runner.
- MRAPI blocks that task + mission before execution, emits a warning event, and continues polling for fresh safe tasks.
- Preserves the safety rule: Codex never executes repository work without explicit Brain scope.
- No Git write/push and no Cloud Run deploy added.
