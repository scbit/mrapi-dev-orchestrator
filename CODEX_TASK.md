# MRAPI DEV v0.3.9.1 — Cancel / Retry correctness fix

## OBJECTIVE
Fix the observed production behavior where cancelling one Mission appeared to create another CANCELLED Mission.

Required invariant:
**Cancel and Retry must NEVER create a new Mission document.**
They operate on the SAME `mission_id`.

## CONTEXT
Current routes already call:
- `POST /api/missions/:missionId/cancel`
- `POST /api/missions/:missionId/retry`

Current `cancelMission()` appears to update the existing Mission, but the real UI behavior was confusing/wrong. Treat this as a correctness bug and verify the full path, including race conditions with Brain/Runner completion.

Do not redesign architecture.

## FILES / AREAS
Inspect:
- `src/routes/missions.routes.js`
- `src/services/orchestration.js`
- `src/public/app.js`
- Brain completion path
- Task claim/completion path
- tests

## IMPLEMENTATION

### 1. Hard invariant: Mission count
For `cancel`:
- read existing Mission by `mission_id`
- update THAT SAME document to `CANCELLED`
- never call `missions.create`
- never generate a new Mission id

For `retry`:
- reuse the SAME Mission document
- create a NEW Brain Run / attempt only
- never create a new Mission
- preserve all previous Runs/Tasks/Results/Evidence

Add tests asserting mission collection count is unchanged after cancel and retry.

### 2. Make Cancel idempotent
If the same Mission is already `CANCELLED`:
- return the same Mission / success response
- do not create anything
- do not emit duplicate operational work
- no 500

### 3. Prevent resurrection races
After cancellation, late Brain/Runner callbacks must NOT move the Mission back to:
- PLANNING
- RUNNING
- COMPLETED
- FAILED

Before any completion/state-advance handler updates a Mission, verify:
- current Mission is not `CANCELLED`
- `cancellation_requested !== true`

If cancelled:
- keep Mission `CANCELLED`
- mark relevant Run/Task cancelled/skipped/terminated at safe boundary as compatible with existing enums
- do not create a new Task
- do not Git commit/push

This is especially important if Cancel occurs while Brain is still responding.

### 4. UI correctness
Every Retry / Cancel / Dispatch action button must explicitly use:
`type="button"`

This prevents accidental form submission if DOM structure changes.

After Cancel:
- close detail modal
- reload state
- show exactly the same Mission id with state `CANCELLED`
- no synthetic local Mission item
- no optimistic array append

After Retry:
- same Mission row remains
- state changes to PLANNING/RUNNING
- attempt/history is visible through Runs, not as another Mission

### 5. Response contract
Prefer Cancel response:
```json
{
  "ok": true,
  "mission_id": "<same id>",
  "state": "CANCELLED",
  "created_mission": false
}
```

Retry response may return new Brain Run but must also make it explicit that:
`mission_id` is unchanged.

### 6. Tests
Add tests proving:
1. Cancel does not increase Mission count.
2. Retry does not increase Mission count.
3. Cancel updates same Mission id.
4. Retry creates new Run, not new Mission.
5. Cancel is idempotent.
6. Late Brain completion cannot resurrect cancelled Mission.
7. Late Execution completion cannot resurrect cancelled Mission.
8. Cancelled Mission cannot create/claim new Task.
9. Cancelled Mission cannot Git push.
10. UI action buttons are `type="button"`.
11. Existing v0.3.9 health tests pass.
12. Full suite passes.

Run:
`node --test test\cancel-retry-v0391.test.js`
`node --test`

Adapt the scaffold test to actual code if needed; do not weaken the behavioral coverage.

## SUCCESS CRITERIA
- Cancelling a Mission leaves exactly one Mission record with the original id.
- UI shows that same Mission as CANCELLED.
- No new Mission row/id is generated.
- Retry preserves same Mission id and only creates a new attempt Run.
- Cancellation cannot be undone by a late Brain/Runner callback.
- Existing autonomous Git flow remains intact.
- Full test suite passes.

## STOP CONDITIONS
- Do not delete historical Runs/Results/Evidence.
- Do not create replacement Missions.
- Do not auto-retry.
- Do not deploy.
- Do not access GCP from Codex.
- Do not weaken tenant isolation.
- Do not alter Worker/Brain/Executor separation.

## DEPLOY
For this manual fix:
- Codex implements and tests.
- DO NOT deploy.
- DO NOT push from Codex.
- HUMAN MANUAL DEPLOY after tests.
- Restart Brain Adapter + Shadow Runner after deploy if their code changed.
