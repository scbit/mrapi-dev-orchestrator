# MRAPI DEV v0.4.2.0 — Fast Stable Orchestration

## OBJECTIVE
Stop the slow/manual regression cycle and stabilize the core workflow so MRAPI DEV can be used for real work now.

Fix the critical stale-execution problem observed after REQUEST CHANGES / RETRY:
a revised Mission was expected to generate a modified PDF, but Codex received old MRAPI v0.4.1.2 development instructions and validated the orchestrator repo instead.

The approved plan revision must be the ONLY source for the execution payload.

## PRODUCT DECISION
Freeze new features temporarily.
Prioritize a small, deterministic v1 execution kernel:

MISSION
→ PLAN
→ APPROVAL
→ immutable EXECUTION SNAPSHOT
→ fresh TASK
→ RUNNER
→ RESULT/EVIDENCE

Do not add more orchestration concepts in this release.

## CRITICAL RULES

### 1. Immutable execution snapshot
When APPROVE & EXECUTE is clicked, persist an immutable snapshot containing:
- tenant_id
- workspace_id
- project_id
- mission_id
- worker_id
- approved_plan_revision_id
- approved_plan_revision_number
- objective
- execution_type
- execution_spec
- permissions
- project runtime context
- artifact/evidence expectations
- created_at

Task handoff must be built ONLY from this snapshot.

Never rebuild execution instructions from:
- previous Tasks
- previous Runs
- previous Brain outputs
- CODEX_TASK.md
- stale in-memory state
- latest arbitrary plan query

### 2. REQUEST CHANGES
REQUEST CHANGES must:
- create a NEW plan revision
- supersede prior plan
- never mutate the prior approved/execution payload
- after revised plan becomes READY, approval creates a NEW immutable execution snapshot
- no Task exists before new approval

### 3. RETRY semantics
Retry must NEVER rerun an unrelated/stale Task payload.

For a failed/blocked execution:
- identify the approved plan revision that owns the execution
- create a fresh retry Task/Run from the SAME immutable execution snapshot
- preserve attempt history
- if Mission was replanned after that attempt, old snapshot is no longer retryable for the current Mission state
- UI must clearly distinguish:
  `Retry execution` vs `Request plan changes`

### 4. Task identity checks
Before Runner claim, validate:
- task.mission_id == snapshot.mission_id
- task.worker_id == snapshot.worker_id
- task.project_id == snapshot.project_id
- task.approved_plan_revision_id == snapshot.approved_plan_revision_id

Mismatch:
- do not execute
- BLOCK with `EXECUTION_SNAPSHOT_MISMATCH`
- show clear diagnostics

### 5. Project/runtime isolation
Do not let a generic W01 mission accidentally use the MRAPI DEV repo.

Execution must resolve repository/local_path from the selected MRAPI Project.

If the selected Project has no repository/local_path and the task requires code changes:
- BLOCK with `PROJECT_RUNTIME_CONTEXT_MISSING`
- do not default to the orchestrator repo

Non-code artifact tasks (e.g. generate PDF) may execute in an isolated task workspace and must not inspect/modify a repo unless the approved execution spec explicitly requires one.

### 6. Remove CODEX_TASK.md leakage
`CODEX_TASK.md` is for human-directed development of MRAPI DEV, not a runtime source for arbitrary Mission execution.

Ensure Runner/Codex handoff never implicitly reads or adopts CODEX_TASK.md unless the approved Mission explicitly instructs it.

### 7. Fast testing strategy
Add a deterministic local integration test harness that simulates the full orchestration without ChatGPT Web or manual browser interaction.

Create canonical smoke scenarios:

A. BRAIN_ONLY
Mission → plan → approve → result

B. ARTIFACT
Mission: "Crear un PDF que diga OK"
→ plan → approve → Task → fake/local executor result → Evidence contract

C. REPLAN
Mission PDF
→ plan rev1
→ request changes
→ plan rev2
→ approve
→ verify Task payload contains ONLY rev2 instructions

D. RETRY
Failed execution
→ retry
→ verify fresh Task uses same immutable snapshot and no stale task payload

E. CODE_PROJECT
Mission bound to a project repo/path
→ approved execution snapshot includes correct repo/path

F. WRONG_PROJECT
Missing runtime context
→ explicit BLOCK, never fallback to MRAPI DEV repo

These tests must run in seconds and not require Chrome, ChatGPT, GCP, or Codex CLI.

### 8. Manual acceptance reduced to 3 tests
After full automated suite passes, human should only need:

1. W01 Brain-only planning smoke
2. W01 artifact PDF with one REQUEST CHANGES before approval
3. W01 real code Mission on a configured test Project

Do not require manual retesting of every internal branch after each release.

### 9. UI
Mission detail should show:
- Plan revision
- Approved revision
- Execution snapshot id/revision (friendly label, not primary raw id)
- Current attempt number
- Retry execution
- Request changes

When BLOCKED, show exact blocker code/reason.

### 10. Version
Bump consistently:
- v0.4.2.0
- 0.4.2-0

## FILES / AREAS
Inspect and modify only what is needed:
- orchestration service
- mission planning/approval routes
- task/run creation
- retry logic
- runner handoff generation
- project runtime context resolution
- mission detail UI
- tests
- version/package files

Do not add new external services.

## TESTS
Must prove:
1. execution snapshot immutable
2. task generated only from approved snapshot
3. replan rev2 cannot execute rev1 payload
4. retry cannot use stale/unrelated task payload
5. mismatch blocks with EXECUTION_SNAPSHOT_MISMATCH
6. code task cannot default to MRAPI repo
7. missing project runtime context blocks clearly
8. artifact-only task can execute without repo
9. CODEX_TASK.md never leaks into normal Mission handoff
10. canonical A-F harness scenarios pass
11. existing tenant isolation passes
12. existing Runner claim/complete passes
13. Evidence passes
14. W01-W05 worker isolation passes
15. full suite passes

Run:
node --test
npm.cmd test

## SUCCESS CRITERIA
The exact regression must be impossible:

Mission:
"Crear un PDF que diga OK"
→ request changes:
"Cambiar el texto a OK MODIFICADO"
→ approve

Codex/Runner handoff MUST contain:
"OK MODIFICADO"

It MUST NOT contain:
- v0.4.1.2
- planning dispatch fix
- CODEX_TASK.md instructions
- unrelated previous task instructions

Retry of that execution must use the same approved rev2 snapshot.

## STOP CONDITIONS
- no deploy
- no GCP
- no push
- no architecture redesign
- no new feature work
- no shared/stale mutable handoff
- no fallback to orchestrator repo for unrelated Missions

## DEPLOY
Codex:
- inspect root cause
- implement
- run deterministic harness
- run full suite
- report exact stale-payload source
- STOP

Human:
- commit/push
- manual Cloud Run deploy
- restart only components whose local code changed
