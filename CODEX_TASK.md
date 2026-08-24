# MRAPI DEV v0.4.1.0 — Mission Planning + Approval + Automatic Execution

## OBJECTIVE
Implement a common planning/approval workflow for ALL workers W01-W05:

MISSION → BRAIN PLAN → USER APPROVAL → AUTOMATIC EXECUTION → RESULT / EVIDENCE

The user describes a goal in natural language, reviews the Brain plan, optionally requests changes, then presses `APPROVE & EXECUTE`. After approval MRAPI DEV continues automatically until COMPLETED, FAILED, CANCELLED, or genuinely BLOCKED.

This is a common Orchestrator capability, not W01-specific.

## CONTEXT
Current system already supports:
- tenants/workspaces/projects/missions/tasks/runs/results/evidence
- W01-W05 workers
- worker-specific ChatGPT Web Brain chats
- Brain-only missions
- Brain → Codex execution
- Shadow Runner
- Evidence/Results
- multi-tenant isolation
- W04 persistent ChatGPT profile

Current gap: direct execution exists, but there is no user-controlled planning gate with revision/approval before execution.

UX rule: Mission is the main unit. Do not turn MRAPI DEV into Jira.

## CORE FLOW

### 1. New Mission
Default normal Mission behavior:
- create Mission
- state = `PLANNING`
- create `BRAIN_RUN`
- Brain returns a structured PLAN only

### 2. Plan Ready
When a valid plan is returned:
- persist plan revision
- Mission = `READY`
- `approval_status = PENDING`
- DO NOT create/dispatch Task yet

Mission UI shows:
- objective
- approach
- planned actions
- deliverables
- risks / assumptions
- permissions required
- requires execution yes/no
- revision

Buttons:
- `APPROVE & EXECUTE`
- `REQUEST CHANGES`

### 3. Request Changes
User enters a short correction.
MRAPI must:
- persist request
- increment revision
- Mission = `PLANNING`
- create NEW `BRAIN_RUN`
- send previous plan summary + requested changes to SAME worker Brain
- preserve old revisions/runs
- revised plan returns to READY/PENDING

### 4. Approve & Execute
Approval must atomically/idempotently:
- validate tenant + mission + worker + current plan
- require Mission READY and approval PENDING
- mark current plan APPROVED
- set Mission approval APPROVED
- set Mission RUNNING
- automatically create required Task(s)
- dispatch through EXISTING execution pipeline
- require no more user action unless genuine blocker/permission issue

Double-click approval must never duplicate Tasks/Runs.

If plan requires no Executor, approval may finalize Brain-only without fake execution Tasks.

### 5. Automatic Completion
After approval:
Task(s) → Runs → Result/Evidence → Mission COMPLETED

Reuse existing Runner/Executor logic. Do not build a second orchestration engine.

## DATA MODEL
Keep current Mission states.

Add/normalize Mission fields:
- `planning_mode`: `REQUIRED | SKIP`
- `approval_status`: `NOT_REQUIRED | PENDING | APPROVED | CHANGES_REQUESTED`
- `current_plan_revision_id`
- `approved_plan_revision_id`
- `plan_revision_number`
- `approved_at`
- `approved_by`
- `blocked_reason` when needed

Create `mission_plans` if cleanest, tenant-scoped:
- id
- tenant_id
- workspace_id
- project_id
- mission_id
- worker_id
- revision
- status: `DRAFT | READY | APPROVED | SUPERSEDED`
- objective
- approach
- planned_actions[]
- expected_deliverables[]
- risks[]
- assumptions[]
- permissions_required[]
- requires_execution
- execution_type
- execution_spec
- user_change_request
- brain_run_id
- created_at
- approved_at
- approved_by

Never overwrite revision history.
Every query/write must enforce tenant_id.

## BRAIN CONTRACT
Add a planning contract such as `MISSION_PLAN_V1`.

Minimum JSON:
```json
{
  "contract": "MISSION_PLAN_V1",
  "objective": "string",
  "approach": "string",
  "planned_actions": [
    {
      "title": "string",
      "description": "string",
      "executor_required": true
    }
  ],
  "expected_deliverables": ["string"],
  "risks": ["string"],
  "assumptions": ["string"],
  "permissions_required": ["string"],
  "requires_execution": true,
  "execution_type": "EXECUTOR",
  "execution_spec": {
    "instructions": "string",
    "success_criteria": ["string"],
    "stop_conditions": ["string"]
  }
}
```

Rules:
- Brain plans; Executor executes
- concise user-readable plan
- avoid microtask explosion
- execution_spec precise enough for Executor after approval
- worker profile remains authoritative
- 1 WORKER = 1 CHAT unchanged

## AUTOMATIC TASK CREATION
On approval convert approved plan into internal Task(s).

For v1:
- prefer ONE execution Task per Mission
- only multiple Tasks when genuinely sequential/independent
- preserve order/dependency if multiple

Task handoff includes:
- mission objective
- approved plan summary
- exact execution instructions
- files/areas when relevant
- tests/verification
- success criteria
- stop conditions
- permissions
- project runtime context
- evidence expectations

## BLOCKING RULES
After approval, do not ask user for routine implementation details.
Only BLOCK when continuation needs a real decision or missing permission.

Examples:
- destructive production change without permission
- deploy without allow_deploy
- publish without allow_publish
- ambiguous external recipient/account
- missing required session/credential

Persist blocker code, user-facing question, completed work, and resume point.
One blocked worker must not block others.

## UI
Mission detail Plan section:

PLANNING:
`Brain is preparing the plan…`

READY/PENDING:
- Objective
- Approach
- Planned actions
- Deliverables
- Risks / assumptions
- Permissions
- Plan Revision N
- `APPROVE & EXECUTE`
- `REQUEST CHANGES`

REQUEST CHANGES opens small textarea/modal:
`What should the worker change?`

RUNNING:
- approved plan read-only
- current task/run progress
- no approval buttons

COMPLETED:
- approved plan
- result
- evidence

Responsive/mobile required.
Do not expose Firestore IDs as primary UX.

## API
Using existing routing conventions, implement equivalent tenant-scoped behavior:
- `GET /api/missions/:missionId/plan`
- `POST /api/missions/:missionId/plan/request-changes`
  body `{ "message": "..." }`
- `POST /api/missions/:missionId/plan/approve`

Approval must be idempotent.
Request changes must reject RUNNING/COMPLETED/CANCELLED missions.

## BACKWARD COMPATIBILITY
Existing Missions must continue working/rendering.
No destructive Firestore migration.
Legacy Missions without planning fields get safe defaults only.
Existing Brain-only, W01/W04, Runner, Evidence, Git, cancel/retry flows remain green.

## PROJECT CONTEXT PREPARATION
Execution handoff should consume Project-level runtime context when present:
- repository_url / repository_full_name
- local_path
- default_branch
- default_worker_id
- workspace_id
- permissions
- runtime_context

Do not require the user to repeat repo/path in every Mission if Project already has it.
If missing in schema, add optional non-destructive fields. Do not build a large Project settings UI in this version.

## COMMON WORKER BEHAVIOR
W01: technical plan → approval → Codex code/test/evidence
W02: analysis plan → approval → browser/data execution → report/evidence
W03: commercial plan → approval → browser/data execution → report/evidence
W04: campaign plan → approval → Codex/browser/HeyGen/Meta as allowed → assets/evidence
W05: analytics plan → approval → browser/Meta metrics → Brain analysis → report/evidence

Do not hardcode planning to W01.

## FILES / AREAS
Inspect existing code first, then modify only necessary areas, likely:
- Mission service/routes
- Brain run service
- Brain output parser/contracts
- task creation/orchestration service
- worker profiles/common runtime
- Firestore persistence helpers
- Mission detail UI
- frontend app.js/modules/styles
- tests
- bootstrap only for safe defaults
- package/version files

Do not rewrite working Runner logic unnecessarily.

## TESTS
Add focused tests proving:
1. New normal Mission enters PLANNING.
2. Planning Brain Run creates revision 1.
3. Mission becomes READY + PENDING.
4. No Task before approval.
5. Approve changes Mission to RUNNING.
6. Approve auto-creates execution Task.
7. Double approve creates no duplicates.
8. Execution uses approved execution_spec.
9. Request Changes creates revision 2 + NEW Brain Run.
10. Revision 1 remains preserved.
11. Revised plan becomes READY/PENDING.
12. Cannot request changes after execution starts.
13. Brain-only plan completes after approval without fake Executor Task.
14. Missing permission causes BLOCKED.
15. tenant A cannot read/approve/revise tenant B mission.
16. W01 works.
17. W02 works.
18. W03 works.
19. W04 works.
20. W05 works.
21. W04 persistent chat remains green.
22. Shadow Runner flow remains green.
23. Evidence/result flow remains green.
24. cancel/retry remains green.
25. legacy missions still render.
26. responsive Plan controls work.
27. full suite passes.

Run:
`node --test`

Also use `npm.cmd test` where the repo expects package tests.

## SUCCESS CRITERIA
Manual acceptance:

Create W01 Mission:
`Mejorar el HUB. Necesito agregar un botón de WhatsApp en cada trato para abrir la conversación correspondiente.`

Expected:
1. Mission = PLANNING
2. W01 Brain creates concise plan
3. Mission = READY
4. Plan visible
5. No Codex Task yet
6. User clicks APPROVE & EXECUTE
7. Mission = RUNNING automatically
8. Task created automatically
9. Shadow Runner/Codex executes without further user action
10. tests/evidence/results recorded
11. Mission ends COMPLETED or legitimately BLOCKED

Also test REQUEST CHANGES before approval:
`No tocar producción. Primero hacer backup y probarlo sin deploy.`

Expected:
- revision 2 created
- revision 1 preserved
- new Brain Run
- revised plan shown
- approval then auto-executes

Run one lightweight W04 smoke test to prove this is common runtime.

## STOP CONDITIONS
Stop/report instead of guessing if:
- architecture has conflicting canonical transitions
- destructive Firestore migration would be required
- tenant isolation cannot be preserved
- approval cannot be idempotent
- Task dispatch would bypass current Runner safety model
- tests expose production-critical regression

Do not:
- deploy
- access GCP
- push
- redesign Worker/Brain/Executor/Host separation
- introduce a second task engine
- create Jira-like microtask management
- remove existing Mission states
- break current W01/W04 behavior

## DEPLOY
Codex:
- inspect
- implement
- test
- report changed files + test totals
- STOP

Human:
- review
- commit/push
- deploy Cloud Run manually if backend/frontend changed
- restart Brain adapters only if local Brain Adapter code changed
- restart Runner only if Runner code changed
