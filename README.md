# MRAPI DEV ORCHESTRATOR

Version: **v0.1-alpha.2**

MRAPI DEV is a multi-tenant Control Room for autonomous workers.

## Architecture

```text
TENANT → WORKSPACE → PROJECT → MISSION → TASK → RUN → RESULT / EVIDENCE
```

Core separation:

```text
Worker = role + capabilities + permissions + mission
Brain = reasoning system
Executor = execution system
Host = execution environment
```

A Worker is never hardcoded to Codex, Shadow, ChatGPT, Telegram, or any other provider.

## Infrastructure

- GCP project: `ia-sentire-customs-broker`
- Firestore database: `mrapi-dev`
- Evidence bucket: `mrapi-dev-evidence`
- Runtime: Node.js + Express
- Hosting: Google Cloud Run
- Frontend: responsive HTML/CSS/JavaScript served by the same service

## Environment

Copy `.env.example` values into your runtime environment.

Cloud Run should use its service account / Application Default Credentials. Do not commit credential JSON files.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

Optional syntax check:

```bash
npm run test:syntax
```

## Run locally

With valid Google Cloud Application Default Credentials:

```bash
GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker \
FIRESTORE_DATABASE=mrapi-dev \
EVIDENCE_BUCKET=mrapi-dev-evidence \
DEFAULT_TENANT_ID=tenant_facundo_group \
npm start
```

## Bootstrap

On startup, `bootstrapInitialData()` creates or safely merges the bootstrap-owned initial resources.

It is idempotent and uses stable document IDs. It never deletes collections and never resets arbitrary existing data.

Initial data:

- Tenant: Facundo Group
- Workspaces: SCB, FM Real Estate, Sentire Marine
- Projects: SCB Development, FM Real Estate Analysis, Sentire Marine / Segue, SCB Marketing
- Worker profiles: W01-W05
- Workers: W01-W05, all initially IDLE
- System state: RUNNING

## API

- `GET /health`
- `GET /api/dashboard`
- `GET /api/workers`
- `GET /api/workers/:workerId`
- `GET /api/missions`
- `POST /api/missions`
- `GET /api/missions/:missionId`
- `GET /api/tasks`

Tenant scope is resolved from `x-tenant-id`. During v0.1-alpha, if the header is absent it falls back to `DEFAULT_TENANT_ID`.

## Deploy

```bash
gcloud run deploy mrapi-dev-orchestrator \
  --source . \
  --project ia-sentire-customs-broker \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker,FIRESTORE_DATABASE=mrapi-dev,EVIDENCE_BUCKET=mrapi-dev-evidence,DEFAULT_TENANT_ID=tenant_facundo_group,BOOTSTRAP_ON_START=true
```

If the existing Cloud Run service already uses another region, keep that region instead of creating a second service unintentionally.

## Current limitations

v0.1-alpha intentionally does not include:

- Shadow Runner
- executor registration / heartbeat
- Brain automation
- authentication / user sessions
- Telegram / WhatsApp notification delivery
- task planning engine
- autonomous execution

## Next milestone

**v0.2-alpha: Shadow Runner registration + heartbeat + first real W01 execution.**


## v0.1-alpha.2 startup fix

Cloud Run HTTP listener now starts before Firestore bootstrap. A bootstrap/IAM error is logged without killing the container, avoiding misleading PORT startup failures.


## v0.1-alpha.2 infrastructure decision

MRAPI DEV runs inside GCP project `ia-sentire-customs-broker`. The Cloud Run service remains `mrapi-dev-orchestrator`.
