# MRAPI DEV v0.4.4.2 — Autopilot Brain Contract Fix

- Propagates roadmap/autopilot metadata into the initial W01 Brain Run.
- Adds a dedicated Brain prompt for AUTOPILOT PROGRAM so the current milestone is the only source of truth.
- Prevents old chat/version/CODEX_TASK context from redirecting the current milestone.
- Strengthens the AUTOPILOT verification contract.
- Adds one Brain self-repair turn when verification output is not valid MRAPI_AUTOPILOT JSON.
- Enriches verification runs with roadmap and milestone context.
- Codex remains executor/hands only. No Cloud Run deploy is performed automatically.
