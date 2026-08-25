# MRAPI DEV v0.4.4.0 — W01 Autopilot Loop E2E

## What changed
- Added Roadmap `START NEXT MILESTONE` action.
- Roadmap can create an approved AUTOPILOT Mission for the next executable milestone.
- W01 Brain receives project context + roadmap/milestone objective.
- Brain remains responsible for design/programming/correction decisions; Codex is hands-only Executor.
- Executor completion now returns to W01 as a dedicated verification `BRAIN_RUN` for autopilot Missions.
- Verification Brain returns one bounded action: `COMPLETE`, `RETRY`, or `BLOCKED`.
- RETRY requires Brain-authored exact executor instructions and is capped at 3 attempts by default.
- Invalid verification output fails safe to `BLOCKED` instead of looping.
- `auto_advance` can start the next executable milestone only after Brain verifies `COMPLETE`.
- Cloud Run deploy remains HUMAN MANUAL DEPLOY / forbidden to Codex.

## E2E lifecycle
Roadmap -> Autopilot Mission -> W01 Brain -> Codex Executor -> execution report -> W01 verification Brain -> COMPLETE / RETRY / BLOCKED -> optional next milestone.

## Validation
- New Autopilot service tests: start, COMPLETE, RETRY, executor->Brain verification.
- Brain contract/parser/UI tests.
- Existing full-flow, Brain separation, planning approval, immutable snapshot, roadmap tests.
- 45/45 selected regression tests passed plus the additional executor->Brain verification test.
