# MRAPI DEV ORCHESTRATOR — v0.3.1-alpha.2

## Real Shadow flow

This version matches the actual tools available on Shadow.

```text
Mission READY
→ Dispatch
→ Task QUEUED
→ Shadow claims
→ BRAIN_RUN
→ ChatGPT Web W01 generates plan
→ Brain plan stored as evidence
→ Task WAITING / WAITING_FOR_CODEX
→ Human opens Codex inside ChatGPT desktop app
→ Codex executes locally on repo
→ Manual completion is reported to MRAPI DEV
→ EXECUTION_RUN recorded
→ RESULT / EVIDENCE
→ Worker IDLE
```

There is **no fake Codex CLI integration**.

## Why hybrid

On Shadow, Codex is available inside the ChatGPT desktop app, not as a local CLI command.
Therefore the Runner automates the Brain phase and creates a structured handoff for Codex.

## Security

Shadow has no GCP credentials.
Codex has no GCP credentials.
Cloud Run deploy remains human/manual.

## Cloud Run

Same variables as v0.3:

- `GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker`
- `FIRESTORE_DATABASE=mrapi-dev`
- `EVIDENCE_BUCKET=mrapi-dev-evidence`
- `DEFAULT_TENANT_ID=tenant_facundo_group`
- `BOOTSTRAP_ON_START=true`
- `NODE_ENV=production`
- `RUNNER_SHARED_SECRET=<secret>`

Do not set `PORT`.

## Runner

Install:

```powershell
cd C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\runner
npm.cmd install
```

Configure W01 chat URL and start:

```powershell
npm.cmd start
```

When a W01 task is dispatched, the Runner opens the dedicated W01 ChatGPT Web chat, runs the Brain phase and then leaves the task in `WAITING_FOR_CODEX`.

## Next milestone

Add a small Control Room action to copy the Brain handoff and report Codex completion from the UI.

## v0.3.1-alpha.2

On Runner startup, stale BRAIN_RUN attempts owned by the same executor are marked FAILED with `RUNNER_RESTARTED_OR_ABANDONED`, their Task is safely returned to `QUEUED`, and history is preserved.

## v0.3.1-alpha.2

Fix: abandoned Brain Run recovery no longer requires a Firestore composite index. Tenant isolation remains enforced and run filtering happens in application code.
