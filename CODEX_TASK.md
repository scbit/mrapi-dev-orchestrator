# MRAPI DEV v0.4.0.5 — Firestore Undefined Claim Fix

## OBJECTIVE
Fix the exact remaining `/api/runner/next-task` 500 now exposed by v0.4.0.4 diagnostics.

Observed production error:

```text
500 RUNNER_CLAIM_INTERNAL_ERROR:
Value for argument "data" is not a valid Firestore document.
Cannot use "undefined" as a Firestore value
(found in field "brain_run_id").
```

## CONFIRMED ROOT CAUSE
In `claimNextTask()` the new Execution Run persists fields similar to:

```js
brain_run_id: candidate.brain_run_id,
parent_run_id: candidate.brain_run_id,
```

For legacy/stuck Tasks, `candidate.brain_run_id` can be `undefined`.

Firestore rejects `undefined`.

This is a data-normalization bug, not a Runner/Codex bug.

## ARCHITECTURE
Preserve:
- ChatGPT Web = Brain
- Codex = Executor
- Shadow = Host
- MRAPI DEV = source of truth
- common Codex Executor supports W01-W05
- tenant isolation
- no duplicate Runs
- W01-only Git permissions

## IMPLEMENTATION

### 1. Normalize nullable persisted IDs
In the claim transaction, any optional ID written to Firestore MUST be `null`, never `undefined`.

At minimum fix:
```js
brain_run_id: candidate.brain_run_id || null,
parent_run_id: candidate.brain_run_id || null,
```

Also inspect the complete claim write path for optional values that may be undefined:
- brain_run_id
- parent_run_id
- workspace_id
- project_id
- worker_profile_id
- current_run_id
- execution metadata
- optional handoff metadata

Use explicit `?? null` where empty string has meaning and `|| null` where it does not.

Do NOT globally enable `ignoreUndefinedProperties` as the primary fix.
We want explicit normalized documents at the orchestration boundary.

### 2. Normalize returned claim object
The returned `claimed.run` / `claimed.task` payload should also expose absent optional IDs as `null`, not `undefined`.

Example:
```js
brain_run_id: candidate.brain_run_id ?? null,
parent_run_id: candidate.brain_run_id ?? null
```

### 3. Legacy execution task compatibility
A legacy execution Task without `brain_run_id` may still be claimable ONLY if the existing contract legitimately allows execution without a Brain Run.

Do not weaken the current Brain-required validation for Tasks that explicitly reference a Brain Run.

Rules:
- if `task.brain_run_id` exists -> validate referenced Brain Run as today
- if it does not exist -> do not create an undefined Firestore value
- mission/worker/tenant/task scope validations still apply

Do not fabricate a Brain Run ID.

### 4. Defensive Firestore serialization helper
If useful, add a small local helper for write-bound objects, e.g.:
```js
function nullIfUndefined(value) {
  return value === undefined ? null : value;
}
```

Avoid recursive mutation of arbitrary objects unless tests prove it safe.
Especially do not silently strip required fields.

### 5. Diagnostic remains
Keep v0.4.0.4 safe Runner diagnostics.
If another unexpected problem remains, terminal must still show safe `detail`.

### 6. Current stuck W04 Mission
Do not delete, recreate, retry, or mutate it manually.

After deploy + Runner restart:
- if its Task remains claimable, Runner should claim it normally
- exactly one Execution Run should be created
- Codex should start

### 7. Version
Bump consistently to:
- `v0.4.0.5`
- runner package `0.4.0-5`

## TESTS

Add focused tests proving:

1. Claiming a Task with `brain_run_id === undefined` does not throw Firestore serialization error.
2. Persisted Execution Run stores `brain_run_id: null`.
3. Persisted Execution Run stores `parent_run_id: null`.
4. Returned claim payload uses `null`, not `undefined`.
5. Task with a real `brain_run_id` preserves it.
6. Task with real Brain Run still validates Brain completion.
7. W04 legacy/stuck claim creates exactly one Execution Run.
8. No duplicate Runs on repeated polling.
9. tenant isolation remains intact.
10. W01 flow remains green.
11. safe diagnostics remain green.
12. full suite passes.

Run:
`node --test`

## SUCCESS CRITERIA
After human deploy + Runner restart, this error disappears:

```text
Cannot use "undefined" as a Firestore value (found in field "brain_run_id")
```

Expected next behavior:
- Runner claims the pending W04 Task, or
- returns normal no-work polling,
- but does NOT 500.

If W04 Task is claimed, Codex CLI starts automatically.

## STOP CONDITIONS
- Do not enable a broad Firestore setting as a shortcut.
- Do not delete/recreate pending Mission/Task.
- Do not fabricate Brain IDs.
- Do not create duplicate Runs.
- Do not revert to W01-only.
- Do not weaken tenant isolation.
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
- restart Shadow Runner
