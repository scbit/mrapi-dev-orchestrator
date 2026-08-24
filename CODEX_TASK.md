# MRAPI DEV v0.4.1.2 — Planning Dispatch / BLOCKED / Request Changes Fix

## OBJECTIVE
Fix two regressions observed in the new v0.4.1.0 planning/approval flow:

1. A Mission with an approved plan showing:
   `Requires execution: Yes · EXECUTOR`
   becomes `BLOCKED`, but NO Task reaches the Shadow Runner.
2. `REQUEST CHANGES` sends the revision request to the Brain and gets a new plan, but the Brain/UI appears to remain waiting instead of cleanly finishing the revision cycle and returning the Mission to READY.

The expected flow is:

MISSION → PLAN → READY/PENDING → APPROVE & EXECUTE → RUNNING → TASK → RUNNER

If `requires_execution=true`, approval must never produce BLOCKED merely because execution is required.

## CONTEXT
Current versions:
- app v0.4.1.1
- Brain Adapter 0.4.1-1
- full suite previously green
- W01 persistent ChatGPT profile works
- W04 persistent profile works
- Runner is online and receives other Tasks
- current failing Mission never reached Runner at all

Observed UI:
`Requires execution: Yes · EXECUTOR`
Mission status: `BLOCKED`
Runner: no claim / no Task received.

This strongly indicates the failure occurs BEFORE Runner dispatch, inside approval → task creation/orchestration.

## FILES / AREAS
Inspect and modify only necessary areas:
- src/services/orchestration.js
- src/routes/missions.routes.js
- Brain plan parsing / execution spec normalization
- mission plan persistence
- task creation helpers
- src/public/app.js if BLOCKED reason is not surfaced
- brain-adapter logic for request-changes completion
- tests/planning-approval-v0410.test.js
- new regression tests
- package/version files

Do not redesign Runner unless evidence proves Runner is involved.

## IMPLEMENTATION

### A. Approved EXECUTOR plan must create a Task
Trace the exact approval path.

For a plan with:
- requires_execution = true
- execution_type = "EXECUTOR"
- valid execution_spec

approval must:
1. atomically mark plan APPROVED
2. mark Mission RUNNING
3. create exactly one execution Task (v1 default)
4. leave Task QUEUED/ASSIGNED according to existing canonical flow
5. allow Runner to claim it

Do not transition Mission to BLOCKED simply because `requires_execution=true`.

### B. Normalize execution type
Accept the actual Brain contract values consistently.

If code currently expects a different enum, normalize safely:
- EXECUTOR
- EXECUTION
- CODEX
or existing canonical equivalents

Use one canonical internal value, but preserve compatibility with existing Brain outputs.

Do not silently reinterpret genuinely unknown execution types. Unknown should BLOCK with a clear code.

### C. Missing execution_spec
If requires_execution=true but execution_spec is missing/invalid:
- Mission may BLOCK
- MUST persist a clear blocker:
  `PLAN_EXECUTION_SPEC_MISSING`
- UI must show it
- no silent generic BLOCKED

### D. Task creation failure
If task creation throws:
- do not leave a misleading generic BLOCKED without diagnostics
- persist:
  - blocker/error code
  - message
  - plan revision id
  - brain run id
- emit event
- preserve tenant scope
- do not create duplicate Tasks on retry

### E. Approval idempotency
Double-click/retry:
- exactly one Task
- if plan already approved and Task exists, return current Mission/Task safely
- if approval transaction committed but response failed, retry must recover state rather than duplicate/block

### F. REQUEST CHANGES cycle must terminate cleanly
Expected:
1. user submits request
2. current plan becomes SUPERSEDED / CHANGES_REQUESTED as appropriate
3. new Brain Run created
4. Brain receives previous plan summary + change request
5. Brain returns revised MISSION_PLAN_V1
6. new plan revision persisted
7. Brain Run COMPLETED
8. Mission READY
9. approval_status PENDING
10. UI stops loading/waiting

The Brain Adapter must NOT keep waiting for another user message after it already detected a stable valid plan response.

### G. UI diagnostics
When Mission is BLOCKED show:
- blocker code
- human-readable reason
- source stage (PLANNING / APPROVAL / TASK_CREATION / EXECUTION)
- no internal stack trace unless debug mode

If BLOCKED reason is absent in legacy data, show:
`Block reason unavailable — inspect event/run history`
instead of blank UI.

### H. Version
Bump consistently:
- v0.4.1.2
- 0.4.1-2

## TESTS
Add regression tests proving:

1. W01 plan with requires_execution=true + execution_type=EXECUTOR approves successfully.
2. Mission becomes RUNNING.
3. Exactly one Task is created.
4. Task is claimable by Runner.
5. Mission does NOT become BLOCKED.
6. Runner receives/claims the Task in integration-style test or canonical claim contract test.
7. Brain output `EXECUTOR` is accepted/normalized.
8. Missing execution_spec blocks with PLAN_EXECUTION_SPEC_MISSING.
9. Unknown execution type blocks with explicit code.
10. task creation exception persists explicit blocker.
11. double approval does not duplicate Task.
12. approval retry after partial response failure recovers existing Task.
13. REQUEST CHANGES creates revision N+1.
14. old revision preserved.
15. revised Brain Run ends COMPLETED.
16. Mission becomes READY/PENDING after revised plan.
17. no extra Brain wait loop remains after valid revised response.
18. UI renders blocker code/reason.
19. tenant isolation remains green.
20. existing W04 Brain-only flow green.
21. existing W04 Brain→Codex flow green.
22. Runner tests green.
23. full suite green.

Run:
node --test
npm.cmd test

## SUCCESS CRITERIA
Manual regression:

Mission:
`Crear un PDF que solo diga OK. No publicar.`

Expected:
- Brain plan shows Requires execution: Yes · EXECUTOR
- Mission READY/PENDING
- click APPROVE & EXECUTE
- Mission RUNNING
- Task created automatically
- Shadow Runner logs CLAIM
- Codex creates PDF
- Evidence uploaded
- Mission COMPLETED

Request Changes:
- submit one revision request
- Brain generates revised plan once
- Brain Run completes
- Mission returns READY/PENDING
- UI no longer appears stuck/waiting

## STOP CONDITIONS
- no GCP
- no deploy
- no push
- do not bypass approval
- do not create Tasks before approval
- do not modify Runner unless root cause requires it
- do not hide BLOCKED reasons
- do not break multi-tenancy
- do not introduce a second orchestration path

## DEPLOY
Codex:
- inspect root cause
- implement
- test
- report changed files and exact root cause
- STOP

Human:
- commit/push
- deploy Cloud Run manually
- restart Brain Adapter only if brain-adapter changed
- restart Runner only if runner changed
