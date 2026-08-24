# MRAPI DEV v0.3.9-alpha.0 — Operations Readiness

## OBJECTIVE
Make MRAPI usable as the daily Control Room so the human can operate W01 from MRAPI without watching local terminals.

Deliver:
- real Runner/Executor health
- real Brain Adapter health
- ONLINE/OFFLINE/BUSY visibility
- Need Attention
- retry failed/blocked missions
- cancel running/queued missions safely
- concise operational errors
- keep existing autonomous Git flow intact

## CONTEXT
Current system already has:
- Mission → Brain Run → Task → Execution Run → Result
- automatic Codex execution
- automatic artifacts/evidence
- automatic Git commit/push for authorized W01
- Runner heartbeat endpoint exists
- Runner already sends `state`, `runner_status`, and `current_run_id`
- MRAPI remains the source of truth
- Brain and Executor are separate components
- no automatic deploy in this milestone

The goal is NOT a redesign. Extend the current architecture.

## FILES / AREAS
Inspect and modify only what is needed:
- `src/services/orchestration.js`
- `src/routes/runner.routes.js`
- brain routes/services used by Brain Adapter
- executor repository/model
- worker/mission repositories if needed
- `runner/shadow-runner.js`
- Brain Adapter process
- `src/public/app.js`
- `src/public/index.html`
- CSS
- tests
- package/version metadata if applicable

## IMPLEMENTATION

### 1. Executor / Runner health
Use existing heartbeats as the canonical signal.

Persist at least:
- `last_heartbeat_at`
- `runner_status`: `IDLE | BUSY`
- `current_run_id`
- `runner_version`
- capabilities
- host name
- executor type

Derive UI state:
- ONLINE: heartbeat <= 45 seconds old
- STALE: >45 and <=120 seconds
- OFFLINE: >120 seconds

Do NOT write OFFLINE continuously from a background server loop.
Derive it from timestamps when reading.

Dashboard and Executors view must show:
- Executor name
- Host
- ONLINE / STALE / OFFLINE
- IDLE / BUSY
- current Run if any
- last heartbeat age
- runner version

### 2. Brain Adapter health
Add the same outbound heartbeat concept for Brain Adapter.

Brain Adapter must periodically call MRAPI and report:
- brain_adapter_id
- worker_ids
- state
- current_brain_run_id
- adapter version
- host name
- last heartbeat

Use a separate Brain Adapter registration/heartbeat endpoint or a generic connection/agent heartbeat endpoint.
Do NOT pretend Brain=Executor.

UI must show W01 Brain:
- ONLINE / STALE / OFFLINE
- IDLE / BUSY
- current Brain Run
- last heartbeat age

### 3. Worker health aggregation
For W01 derive a compact health summary from:
- Brain availability
- Executor availability
- worker state
- active mission/task

Examples:
- READY: Brain online + Executor online + worker not blocked
- BUSY: active run
- DEGRADED: one component stale
- OFFLINE: required Brain or Executor offline
- BLOCKED: current Mission/Task blocked

Do not persist this derived status as a second source of truth unless necessary.

### 4. Need Attention
Create a server-side derived endpoint or extend dashboard summary.

Need Attention must include:
- FAILED missions
- BLOCKED missions
- FAILED tasks
- BLOCKED tasks
- stale/offline required Brain or Executor
- Git failures
- execution errors

Each item needs:
- severity
- entity type
- entity id
- short human-readable message
- timestamp
- action hint

UI:
- Dashboard metric count
- dedicated Need Attention list/card
- newest first

Avoid raw JSON.

### 5. Retry
Add safe Mission Retry.

Allowed when Mission is:
- FAILED
- BLOCKED

Behavior:
- NEVER overwrite old Runs/Tasks/Results
- create a new attempt / new Brain Run following current orchestration pattern
- preserve mission objective/workspace/project/worker
- store retry metadata:
  - `retry_of_run_id` or equivalent
  - attempt number
- old evidence/history remains immutable

UI:
- Retry button only when valid
- confirmation
- refresh state immediately

### 6. Cancel
Add safe Mission Cancel.

Allowed for:
- READY
- PLANNING
- RUNNING
- BLOCKED

Behavior:
- Mission → CANCELLED
- queued/waiting tasks → SKIPPED or CANCELLED-compatible current model
- future claim must not claim cancelled Mission tasks
- if an Execution Run is already running, mark cancellation requested and let Runner stop at a safe boundary
- do NOT kill arbitrary OS processes unless current architecture can do it safely
- Runner checks cancellation before expensive next phases (artifact upload / Git push)
- absolutely no Git push after cancellation request

UI:
- Cancel button when allowed
- confirmation
- clear final state

### 7. Operational error UX
Reports/Mission Detail should show:
- concise error title
- stage: Brain / Executor / Tests / Artifact / Git
- actionable reason
- Retry when valid
- technical details collapsed

Examples:
- `Executor offline`
- `Brain Adapter offline`
- `Tests failed`
- `Git push failed`
- `Artifact upload failed`

Do not expose huge stdout/stderr by default.

### 8. Dashboard
Make Dashboard operational:

Top metrics:
- Active Workers
- Running Missions
- Queued Tasks
- Need Attention
- Completed
- Executors Online

Add:
- W01 Brain health
- W01 Executor health
- current action
- most recent failures
- quick Retry where applicable

Refresh approximately every 5 seconds without full-page reload.

### 9. Safety / architecture
Preserve:
- tenant isolation on every endpoint
- Worker != Brain != Executor != Host
- existing W01 Git permissions
- no auto deploy
- no GCP access from Codex
- immutable historical Runs
- no open retry loops

Retry is human-triggered only in this milestone.

### 10. Version
Set UI/Runner/Brain Adapter operational version to:
`v0.3.9-alpha.0`

Do not break existing v0.3.8.1 autonomous Git flow.

## TESTS
Add strong tests for at least:

1. executor heartbeat tenant isolation
2. executor ONLINE/STALE/OFFLINE derivation
3. brain heartbeat tenant isolation
4. brain ONLINE/STALE/OFFLINE derivation
5. worker health aggregation
6. Need Attention includes FAILED/BLOCKED
7. Need Attention includes offline required components
8. retry only valid from FAILED/BLOCKED
9. retry creates new history and does not overwrite old Run
10. cancel changes Mission state correctly
11. cancelled Mission cannot be newly claimed
12. cancellation blocks Git push
13. UI exposes health / Need Attention / Retry / Cancel
14. existing Git flow tests still pass
15. existing artifact/evidence tests still pass

Run:
`node --test test\operations-readiness-v039.test.js`
`node --test`

If the supplied scaffold test needs adaptation to current filenames, adapt it rather than weakening coverage.

## SUCCESS CRITERIA
- Full suite passes.
- Dashboard shows real Brain and Executor health.
- Turning off Runner eventually shows OFFLINE.
- Turning off Brain Adapter eventually shows OFFLINE.
- Failed/blocked work appears in Need Attention.
- User can Retry from MRAPI.
- User can Cancel from MRAPI.
- Retry preserves full old history.
- Cancellation prevents automatic Git push.
- Existing autonomous W01 execution still works.
- No deploy is performed by Codex.

## STOP CONDITIONS
Stop and report instead of improvising if:
- implementation requires merging Brain and Executor concepts
- tenant isolation cannot be guaranteed
- retry would overwrite prior Runs
- cancellation could cause an unsafe force-kill
- implementation requires automatic deploy
- existing autonomous Git flow would be weakened

## DEPLOY
Codex:
- may implement
- may test
- with current trusted W01 flow, Runner may commit/push after successful Mission if this package is executed later through MRAPI

For this one-time local implementation initiated manually:
- DO NOT deploy
- DO NOT push from Codex
- HUMAN MANUAL DEPLOY after tests
- restart Runner and Brain Adapter after deploy if their local code changed
