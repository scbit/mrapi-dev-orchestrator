# v0.4.4.11 — Autopilot RETRY worktree continuity

- PROGRAM still requires a clean repository.
- RETRY can continue on dirty files produced by the same Mission when every changed path remains inside the cumulative Brain-defined `allowed_files`.
- RETRY scopes are cumulative across attempts, so prior valid edits remain authorized for verification and follow-up corrections.
- Any unrelated dirty path still blocks before Codex runs.
- Git write/push and Cloud Run deploy remain disabled during PROGRAM/RETRY.
