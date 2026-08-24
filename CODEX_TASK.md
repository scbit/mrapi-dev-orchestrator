# MRAPI DEV v0.4.0.3 — Runner Claim 500 Fix

## OBJECTIVE
Fix the backend 500 that crashes the Shadow Runner immediately after successful executor registration.

Observed real runtime:

```text
[SHADOW] registering executor_shadow_codex_01 [ 'W01', 'W02', 'W03', 'W04', 'W05' ]
[SHADOW] registered
[SHADOW] repo C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator
[SHADOW] Codex mode: CLI AUTO
[SHADOW] configured command auto-detect codex/codex.cmd
[SHADOW FATAL] Error: 500 INTERNAL_SERVER_ERROR
    at ...runner\lib\api.js:17:29
    at async loop (...runner\shadow-runner.js:411:21)
```

This started after v0.4.0.x multi-worker changes.

The Runner registers correctly.
Failure happens on the first work polling / claim operation.

## CONTEXT
Architecture remains:

- ChatGPT Web = Brain
- Codex = Executor
- Shadow = Host
- MRAPI DEV = source of truth

Executor:
`executor_shadow_codex_01`

Allowed workers:
`W01, W02, W03, W04, W05`

Do not reduce it back to W01-only.

## FILES / AREAS
Inspect actual code before modifying.

Likely areas:
- `runner/shadow-runner.js` around line ~411
- `runner/lib/api.js`
- runner claim/poll endpoint
- `src/routes/*runner*`
- `src/services/orchestration.js`
- Task claim query / Firestore query
- multi-worker worker_id filtering
- tests for executor registration/claim

## IMPLEMENTATION

### 1. Identify exact failing request
Determine which request is made immediately after registration at Runner line ~411.

Add/retain useful server-side operational logging so a future 500 records:
- endpoint/action
- executor_id
- tenant_id
- worker_ids/capabilities if applicable
- error code/message

Never log secrets.

### 2. Fix multi-worker claim
The Runner now serves five workers.

The claim endpoint must safely accept an executor that is bound to:
`['W01','W02','W03','W04','W05']`

Do not assume a single `worker_id`.

Claim semantics:
- tenant-scoped
- only QUEUED/ASSIGNED eligible work according to existing model
- task worker must be one of executor's allowed worker IDs
- required capabilities/permissions must match
- cancelled missions/tasks must not be claimed
- one atomic claim at a time
- preserve attempt/run history

### 3. Firestore query safety
Pay special attention to Firestore query composition introduced by multi-worker support.

If the 500 is caused by an invalid query/index/operator combination:
- use the simplest safe query compatible with existing indexes
- filter the small candidate set in application code if that avoids brittle composite-index requirements
- keep tenant isolation mandatory
- do not query across tenants

Prefer correctness and low operational complexity over a new index for this patch unless an index is clearly unavoidable.

### 4. No-work response
When there is no eligible Task, claim/poll must return a normal no-work response, never 500.

Examples compatible with existing API:
- HTTP 200 + `{ task: null }`
or
- HTTP 204

Use existing project conventions.

Runner must continue polling.

### 5. Bad/stale task resilience
One malformed/stale task must not crash the whole Runner.

If a candidate:
- references missing Mission
- references missing Worker
- is cancelled
- has invalid execution metadata

skip/block it according to existing conventions and continue safely.

Do not silently execute invalid work.

### 6. Runner error handling
A transient backend 5xx should not permanently terminate the Shadow Runner.

Implement bounded polling resilience:
- log concise error
- wait/backoff
- retry polling
- heartbeat continues/re-register if existing architecture requires it

Do NOT create an open hot loop.
Do NOT retry task execution automatically beyond existing retry rules.

Fatal should remain for unrecoverable local configuration errors, not a single poll 500.

### 7. Preserve W04 pending mission
Do not invent a migration for the currently stuck W04 mission.
After deployment and Runner restart, if its Task is still eligible, the normal claim flow should take it.
If mission/task state is already inconsistent, surface Need Attention rather than creating duplicates.

### 8. Version
Bump to:
`v0.4.0.3`

## TESTS

Add focused tests proving:

1. Executor registers with W01-W05.
2. Multi-worker claim does not throw.
3. W04 queued Task can be claimed by the common Codex executor.
4. W01 Task still works.
5. Task from a worker outside executor binding is not claimed.
6. Tenant isolation is preserved.
7. No eligible task returns normal no-work response.
8. Cancelled Mission Task is not claimed.
9. Malformed/stale candidate does not crash polling.
10. A poll 500 does not terminate Runner loop permanently.
11. Existing Brain-only path remains unaffected.
12. Existing Git W01-only permissions remain unaffected.
13. Full suite passes.

Run:
`node --test`

## SUCCESS CRITERIA
After human deploy and Runner restart, terminal stays alive and shows normal polling/claim behavior instead of:

`[SHADOW FATAL] Error: 500 INTERNAL_SERVER_ERROR`

The existing W04 execution Mission can proceed to Codex if its Task remains valid.

## STOP CONDITIONS
- Do not revert to W01-only.
- Do not hardcode W04.
- Do not weaken tenant isolation.
- Do not let Codex become Brain.
- Do not auto-deploy.
- Do not push.
- Do not delete pending Missions/Tasks.
- Do not create duplicate Runs.

## DEPLOY
Codex:
- inspect
- implement
- test
- stop

Human:
- commit/push
- manual Cloud Run deploy
- restart Shadow Runner
