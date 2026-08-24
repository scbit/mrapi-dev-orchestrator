# MRAPI DEV v0.4.0.4 — Claim State Contract Fix

## OBJECTIVE
Fix the remaining `/api/runner/next-task` 500 after v0.4.0.3.

Observed runtime:
- executor registers successfully for W01-W05
- Runner no longer dies (v0.4.0.3 resilience works)
- every poll still returns `500 INTERNAL_SERVER_ERROR`

## CONFIRMED CODE MISMATCH
Current claim flow considers BOTH:
- `QUEUED`
- `ASSIGNED`

as eligible tasks.

But `src/services/codexHandoff.js -> trustedScope()` rejects any task whose state is not exactly `QUEUED`:

```js
if (task.state !== 'QUEUED') throw fail('CODEX_HANDOFF_TASK_NOT_QUEUED');
```

This is inconsistent with `claimNextTask()`, which explicitly accepts `['QUEUED', 'ASSIGNED']`.

Also `CODEX_HANDOFF_TASK_NOT_QUEUED` is not currently treated as a skippable claim-candidate error, so an old/stuck `ASSIGNED` task can turn the whole poll into HTTP 500.

## ARCHITECTURE
Do not change:
- ChatGPT Web = Brain
- Codex = Executor
- Shadow = Host
- MRAPI DEV = source of truth
- common executor supports W01-W05
- tenant isolation
- W01-only Git permissions

## IMPLEMENTATION

### 1. Align claim/handoff state contract
Choose one canonical claim-entry contract and use it consistently.

Preferred for compatibility:
- claim may accept `QUEUED` and legacy/stale `ASSIGNED`
- Codex handoff trusted scope may accept `QUEUED` and `ASSIGNED`
- transaction atomically transitions the accepted task to `RUNNING`

Do NOT execute tasks already `RUNNING`, `DONE`, `FAILED`, `SKIPPED`, etc.

Update `trustedScope()` accordingly, for example:
```js
if (!['QUEUED', 'ASSIGNED'].includes(task.state)) {
  throw fail('CODEX_HANDOFF_TASK_NOT_CLAIMABLE');
}
```

Use a clear canonical error code.

### 2. Candidate-error safety
Any expected per-task validation failure must not make `/next-task` return 500.

Include claim/handoff validation errors such as:
- TASK_ALREADY_CLAIMED
- TASK_BRAIN_NOT_COMPLETE
- WORKER_NOT_FOUND
- WORKER_NOT_AVAILABLE
- MISSION_CANCELLED
- CODEX_HANDOFF_TASK_NOT_CLAIMABLE
- CODEX_HANDOFF_TASK_SPEC_REQUIRED
- CODEX_HANDOFF_BRAIN_RUN_REQUIRED
- CODEX_HANDOFF_BRAIN_TENANT_MISMATCH
- CODEX_HANDOFF_BRAIN_RUN_TYPE_REQUIRED
- CODEX_HANDOFF_BRAIN_NOT_COMPLETED
- CODEX_HANDOFF_BRAIN_MISSION_MISMATCH
- CODEX_HANDOFF_TASK_TENANT_MISMATCH
- CODEX_HANDOFF_TASK_MISSION_MISMATCH
- CODEX_HANDOFF_WORKER_REQUIRED
- CODEX_HANDOFF_SCOPE_REQUIRED

Expected bad candidate => log `[RUNNER CLAIM SKIP]` and continue to next candidate.

Unexpected infrastructure/programming error => still return 500.

### 3. Existing stuck ASSIGNED task
The currently stuck W04 task must be recoverable if:
- tenant matches
- mission not cancelled
- Brain Run completed
- worker is eligible
- task state is QUEUED or ASSIGNED

Do not duplicate Task or Run.
The transaction should claim it once and move it to RUNNING.

### 4. Make authenticated Runner 500 diagnostic useful
For `/api/runner/next-task` only, on unexpected errors:
- keep server log with stack/code
- return a safe machine-readable diagnostic to the authenticated Runner:
  - `error: "RUNNER_CLAIM_INTERNAL_ERROR"`
  - `detail: <safe error.message, max 500 chars>`
  - no stack
  - no secret
  - no credentials

Update Runner API error formatting so terminal prints the safe `detail` when present.

This allows future production diagnosis without opening Cloud Run logs.

Example:
```text
[SHADOW POLL ERROR] 500 RUNNER_CLAIM_INTERNAL_ERROR: <detail> retrying...
```

### 5. Version
Bump:
- app/runtime visible version: `v0.4.0.4`
- runner package version consistently

## TESTS
Add tests for:

1. QUEUED task can be handed off.
2. ASSIGNED task can be handed off/recovered.
3. ASSIGNED W04 task is claimed once.
4. RUNNING task cannot be claimed.
5. Expected malformed candidate is skipped, not HTTP 500.
6. Unexpected internal error returns diagnostic `RUNNER_CLAIM_INTERNAL_ERROR`.
7. Runner prints returned safe detail and keeps retrying.
8. W01 flow remains green.
9. W04 multi-worker flow remains green.
10. tenant isolation remains green.
11. W01 Git permissions remain W01-only.
12. full suite passes.

Run:
`node --test`

## SUCCESS CRITERIA
After human deploy + Runner restart:
- no repeated generic 500
- if current W04 task is valid QUEUED/ASSIGNED, Runner claims it
- terminal proceeds to Codex execution
- if another unexpected backend error exists, terminal shows its safe exact detail instead of only `INTERNAL_SERVER_ERROR`

## STOP CONDITIONS
- Do not revert to W01-only.
- Do not delete the stuck Mission/Task.
- Do not create duplicate Runs.
- Do not weaken tenant checks.
- Do not let Codex become Brain.
- Do not deploy.
- Do not push.

## DEPLOY
Codex implements + tests only.
Human commit/push + manual Cloud Run deploy.
Then restart Shadow Runner.
