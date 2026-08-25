# MRAPI DEV v0.4.4.6 — Stale Mission Reopen Fix

- Fixes `MILESTONE_ALREADY_HAS_MISSION` after reopening a blocked roadmap whose milestone was already PENDING.
- Reopen now clears stale runtime Mission/verification linkage from PENDING milestones.
- Historical Missions and Runs are preserved for audit.
- No change to Brain/Executor role separation.
