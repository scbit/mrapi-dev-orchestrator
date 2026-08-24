# MRAPI DEV ORCHESTRATOR

Version: **v0.2-alpha**

MRAPI DEV is a multi-tenant Control Room for autonomous workers.

## Permanent architecture

```text
TENANT → WORKSPACE → PROJECT → MISSION → TASK → RUN → RESULT / EVIDENCE
```

```text
Worker = role + capabilities + permissions + mission
Brain = reasoning system
Executor = execution system
Host = execution environment
```

MRAPI DEV is the source of truth.

## Infrastructure

- GCP project: `ia-sentire-customs-broker`
- Cloud Run service: `mrapi-dev-orchestrator`
- Firestore database: `mrapi-dev`
- Evidence bucket: `mrapi-dev-evidence`

## v0.2 flow

```text
Mission READY
  ↓ Dispatch
Task QUEUED
  ↓ Shadow asks for work
Task claimed atomically
  ↓
Worker BUSY
Mission RUNNING
EXECUTION_RUN RUNNING
  ↓
Progress + Evidence
  ↓
Run COMPLETED/FAILED
Task DONE/FAILED
Mission COMPLETED/FAILED
Worker IDLE
```

## Runner security

Set a long random secret in Cloud Run:

```text
RUNNER_SHARED_SECRET=<random-secret>
```

Shadow must send the same value as `MRAPI_RUNNER_SECRET`.

Runner endpoints reject unauthenticated calls in production.

## Main API

- `GET /health`
- `GET /api/dashboard`
- `GET /api/workers`
- `GET /api/missions`
- `POST /api/missions`
- `POST /api/missions/:missionId/dispatch`
- `GET /api/tasks`
- `GET /api/executors`
- `GET /api/runs`

Runner:

- `POST /api/runner/register`
- `POST /api/runner/heartbeat`
- `POST /api/runner/next-task`
- `POST /api/runner/runs/:runId/progress`
- `POST /api/runner/runs/:runId/evidence`
- `POST /api/runner/runs/:runId/complete`

## Evidence

Evidence metadata lives in Firestore.

Binary evidence sent by the Runner is uploaded by MRAPI DEV to:

`gs://mrapi-dev-evidence/<tenant>/<mission>/<task>/<run>/<evidence>/<file>`

v0.2 JSON uploads are intentionally limited to 10 MB per evidence item.

## Tests

```bash
npm install
npm test
npm run test:syntax
```

## Manual Cloud Run deploy

Do not manually define `PORT`.

Add:

```text
GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker
FIRESTORE_DATABASE=mrapi-dev
EVIDENCE_BUCKET=mrapi-dev-evidence
DEFAULT_TENANT_ID=tenant_facundo_group
BOOTSTRAP_ON_START=true
NODE_ENV=production
RUNNER_SHARED_SECRET=<LONG_RANDOM_SECRET>
```

Then deploy the existing Cloud Run service.

## Shadow Runner

The `runner/` directory is the local Shadow agent.

**v0.2-alpha deliberately stops before launching Codex.**

It validates register → heartbeat → claim → progress → evidence → close transport.

The included executor stub marks a claimed Run as failed with
`EXECUTOR_ADAPTER_NOT_IMPLEMENTED` instead of pretending the mission was executed.

## Next milestone

**v0.3-alpha: Codex executor adapter + actual W01 execution.**
