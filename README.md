# MRAPI DEV — Brain Adapter v0.3.2 overlay

This ZIP is an **overlay** for the current GitHub version after Codex implemented real
`BRAIN_RUN → TASK → EXECUTION_RUN` separation.

## Architecture

```text
MRAPI DEV
→ BRAIN_RUN
→ Brain Adapter (separate process)
→ ChatGPT Web W01
→ BRAIN_OUTPUT
→ TASK QUEUED
→ Shadow Runner
→ EXECUTION_RUN
→ manual Codex app
```

The Shadow Runner remains execution-only.

## Files added/changed

- `src/app.js` — mounts `/api/brain`
- `src/routes/brain.routes.js` — Brain Run claim/progress/complete/release API
- `brain-adapter/` — separate local Brain process for Shadow

## Install on Shadow

```powershell
cd C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\brain-adapter
npm.cmd install
```

## Important

- Uses the existing runner shared secret only for MVP authentication.
- No GCP credentials are stored on Shadow.
- No automatic Cloud Run deploy.
- One worker still maps to one dedicated ChatGPT chat.

## v0.3.2-alpha.1

Compatibility fix: when a legacy/recovered BRAIN_RUN has no `objective`, the Brain API enriches it from the linked Mission before sending it to ChatGPT Web. If no objective can be resolved, the run is released instead of sending an empty mission.
