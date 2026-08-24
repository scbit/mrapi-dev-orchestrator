# MRAPI DEV v0.4.0.6 — Completion Event Undefined Fix

## OBJECTIVE
Fix the exact post-Codex completion failure now observed in production.

Observed runtime:

```text
[CODEX STDOUT] Success.
...
[SHADOW TASK ERROR] 500 INTERNAL_SERVER_ERROR
[SHADOW COMPLETE ERROR] 409 RUN_NOT_ACTIVE
```

## CONFIRMED ROOT CAUSE

In `completeRun()` the Execution Run transaction successfully completes the Run/Task/Mission and builds:

```js
result = {
  success: missionCancelled ? false : success,
  cancelled: missionCancelled || undefined,
  mission_id: run.mission_id,
  task_id: run.task_id,
  run_id: runId,
  result_id: resultRef.id
};
```

Immediately after the transaction:

```js
await emitEvent(db, tenantId, result.success ? 'RUN_COMPLETED' : 'RUN_FAILED', result, ...)
```

When `missionCancelled === false`, `result.cancelled` becomes `undefined`.

Firestore rejects the Event payload because it contains `undefined`.

Therefore:
1. transaction can already have committed Run as COMPLETED;
2. `emitEvent()` throws 500 afterward;
3. Runner thinks Task failed and calls `/complete` again;
4. second call correctly returns `409 RUN_NOT_ACTIVE`.

This explains the exact log sequence.

## ARCHITECTURE
Preserve:
- ChatGPT Web = Brain
- Codex = Executor
- Shadow = Host
- MRAPI DEV = source of truth
- W01-W05 common Executor
- existing Mission/Task/Run history
- tenant isolation
- W01-only Git permissions

## IMPLEMENTATION

### 1. Never return undefined in completion result
Replace:

```js
cancelled: missionCancelled || undefined
```

with an explicit boolean:

```js
cancelled: missionCancelled === true
```

or omit the property entirely when false, but explicit boolean is preferred.

### 2. Make Event payloads Firestore-safe
`emitEvent()` is a central persistence boundary.

Add a small explicit sanitizer for Event payloads that recursively converts/removes `undefined` values before Firestore write.

Preferred behavior:
- object property `undefined` -> `null` or omitted consistently
- arrays containing `undefined` -> `null`
- preserve Date / Firestore Timestamp / primitives
- do not stringify arbitrary objects
- do not mutate original payload

This is defense-in-depth. Callers should still normalize their own contracts.

Do NOT globally enable `ignoreUndefinedProperties`.

### 3. Audit completion/event result objects
Inspect completion-related paths for other patterns like:
- `foo: condition || undefined`
- optional ids/fields copied into Event payloads
- result payloads later persisted into Firestore

At minimum cover:
- `completeRun`
- `completeBrainRun`
- `completeManualCodexHandoff`
- retry/cancel events
- Task claimed/completed events

Normalize optional values to `null`/boolean where appropriate.

### 4. Completion API idempotency safety
Do NOT broadly redesign completion semantics.

However, for this exact already-committed case, improve Runner behavior:

If Runner receives `409 RUN_NOT_ACTIVE` after it already sent a completion request, log a concise message indicating the Run may already be terminal and do not attempt another completion loop.

Do not create a duplicate Result.
Do not reopen a completed Run.

If existing API can safely return terminal state on a repeated complete request without mutation, that is acceptable, but avoid a large redesign in this patch.

### 5. Current production Mission
Do not delete or recreate the Mission automatically.

Because the transaction likely committed before `emitEvent()` failed, inspect normal UI state after deploy:
- if Mission/Task/Run are already COMPLETED/DONE, leave them as-is;
- if Mission is still inconsistent, surface Need Attention / use existing Retry, not duplicate Run creation.

### 6. Version
Bump consistently:
- `v0.4.0.6`
- runner/package `0.4.0-6`

## TESTS

Add focused tests proving:

1. Successful Execution completion returns `cancelled: false`, never undefined.
2. Cancelled completion returns `cancelled: true`.
3. `emitEvent()` safely persists payloads containing nested undefined.
4. Event sanitizer does not mutate original payload.
5. Successful Run completion writes exactly one Result.
6. Successful Run completion emits RUN_COMPLETED without 500.
7. Repeated completion after terminal state does not create duplicate Result.
8. Runner handles `409 RUN_NOT_ACTIVE` after completion without a second failure cascade.
9. W04 execution completion remains green.
10. W01 execution/Git flow remains green.
11. tenant isolation remains green.
12. full suite passes.

Run:
`node --test`

## SUCCESS CRITERIA
After human deploy and Runner restart, a successful Codex Task ends with a clean terminal result such as:

```text
[SHADOW] COMPLETE ...
```

and NOT:

```text
[SHADOW TASK ERROR] 500 ...
[SHADOW COMPLETE ERROR] 409 RUN_NOT_ACTIVE
```

Mission/Task/Run/Result must stay consistent and only one Result must be created.

## STOP CONDITIONS
- Do not delete completed Runs.
- Do not duplicate Results.
- Do not globally enable Firestore ignoreUndefinedProperties.
- Do not revert to W01-only.
- Do not weaken tenant isolation.
- Do not let Codex become Brain.
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
- restart Shadow Runner only
