# MRAPI DEV v0.4.0.1 — Mission Worker Selector Fix

## OBJECTIVE
Fix the MRAPI web Mission creation flow so the worker selector shows all configured workers W01–W05, not only W01.

Current observed state:
- v0.4.0-alpha.0 deployed
- W04 Brain Adapter can start as `brain_shadow_chatgpt_w04_01`
- `MRAPI_W04_CHAT_URL` is correctly configured
- Mission creation UI still only offers W01

Expected:
Mission creation must load tenant-scoped workers from MRAPI DEV and show:
- W01 Software Engineer
- W02 US Real Estate Analyst
- W03 Sentire Marine / Segue Agent
- W04 SCB Marketing Creator
- W05 SCB Marketing Analyst

## ARCHITECTURE RULES
- MRAPI DEV is source of truth.
- Do not hardcode worker dropdown to W01.
- Preserve `tenant_id` isolation.
- Brain config/online state must NOT determine whether a Worker exists in the selector.
- A Worker may appear even if its Brain is not configured/online.
- Dispatch can later block if required runtime is unavailable.
- Preserve 1 WORKER = 1 CHAT.
- Do not change W01 Git permissions.
- Do not deploy or push.

## FILES / AREAS
Inspect and modify only what is required:
- Mission creation UI / worker selector
- worker list API used by Mission form
- bootstrap worker creation / seed logic
- tenant-scoped workers query
- related tests

Likely areas:
- `src/services/bootstrapData.js`
- workers routes/services
- mission form frontend JS/HTML
- API returning workers
- tests around bootstrap and mission UI

Do not assume these exact files if repo differs; inspect first.

## IMPLEMENTATION

### 1. Verify persisted workers
Determine whether W02–W05 actually exist in Firestore/bootstrap data.

If bootstrap only creates W01:
- extend idempotent bootstrap to create W01–W05 for tenant `tenant_facundo_group`
- never overwrite existing worker state/config unnecessarily
- use merge/idempotent creation behavior

Required initial workers:
- W01 — Software Engineer — workspace SCB
- W02 — US Real Estate Analyst — workspace FM Real Estate
- W03 — Sentire Marine / Segue Agent — workspace Sentire Marine
- W04 — SCB Marketing Creator — workspace SCB
- W05 — SCB Marketing Analyst — workspace SCB

All must have:
- tenant_id
- worker_id/id
- profile/binding references compatible with v0.4.0
- Brain binding present/configurable
- Executor binding Codex/Shadow initial default
- correct autonomy/permissions
- W02–W05 must NOT get `allow_git_commit` or `allow_git_push`

### 2. Fix worker API/listing
The API used by the Mission form must return all active tenant workers.

Do not filter workers out because:
- Brain chat URL is missing
- Brain Adapter is offline
- Executor is offline

Runtime readiness is separate from worker existence.

### 3. Fix Mission creation selector
Populate selector dynamically from the tenant-scoped Workers API.

Show all W01–W05.

Recommended label:
`W04 — SCB Marketing Creator`

Use worker ID as submitted value.

No W01 hardcoded fallback except a harmless default selection if appropriate.

### 4. Dispatch validation
When dispatching:
- worker must exist and belong to tenant
- if its Brain runtime is missing/offline, block the Mission cleanly / Need Attention
- do NOT hide it from Mission creation

### 5. Existing tenant data migration/bootstrap
Because Cloud Run is already deployed and Firestore may contain only W01:
ensure the existing bootstrap path can add missing W02–W05 on next startup without deleting or recreating W01.

If bootstrap runs on startup (`BOOTSTRAP_ON_START`), missing workers should be added automatically.

If current bootstrap does not safely add missing workers, implement a safe idempotent `ensureInitialWorkers()`.

### 6. Version
Bump visible runtime/app version to:
`v0.4.0.1`

## TESTS

Add focused tests that prove:

1. Bootstrap ensures W01–W05.
2. Running bootstrap twice does not duplicate workers.
3. Existing W01 data is not destructively overwritten.
4. Worker listing returns W01–W05 for tenant.
5. Worker listing is tenant-scoped.
6. Mission form/API does not filter workers by Brain online/configured status.
7. W04 can be selected for a new Mission.
8. W02–W05 do not inherit W01 Git permissions.
9. Full existing suite remains green.

Run:
`node --test`
and any targeted test file you add.

## SUCCESS CRITERIA
After manual deploy/restart:
- `+ NEW MISSION` shows W01, W02, W03, W04, W05.
- W04 can be selected before dispatch.
- Missing/offline Brain is handled at dispatch/runtime, not by hiding Worker.
- Existing W01 behavior remains unchanged.
- Full test suite passes.

## STOP CONDITIONS
- Do not redesign worker architecture.
- Do not hardcode W04 only.
- Do not duplicate worker documents.
- Do not remove tenant scoping.
- Do not change W01 Git policy.
- Do not deploy.
- Do not push.

## DEPLOY
Codex:
- inspect
- implement
- test
- stop

Human:
- commit/push
- manual Cloud Run deploy
- restart affected local processes if needed
