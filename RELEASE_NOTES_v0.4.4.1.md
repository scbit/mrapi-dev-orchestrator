# MRAPI DEV v0.4.4.1

Hotfix for W01 Autopilot start on real Firestore.

## Fix
- Roadmap milestones are stored inside an array. Firestore does not allow `FieldValue.serverTimestamp()` transform sentinels inside array elements.
- Autopilot now uses concrete `Date` values for timestamps nested inside milestone array objects, while keeping server timestamps for top-level documents.
- Covers milestone PLANNING, VERIFYING, RUNNING, COMPLETED and BLOCKED transitions.

## Scope
No change to Brain/Executor roles. Brain programs and decides; Codex remains hands-only. No automatic deploy.
