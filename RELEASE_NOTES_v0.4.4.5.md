# MRAPI DEV v0.4.4.5 — Roadmap Reopen Edge Fix

- Fixes reopening a Goal that is `BLOCKED` when its target milestone is already `PENDING`.
- `REOPEN BLOCKED MILESTONE` now restores the Goal to `ACTIVE` even when there is no milestone currently marked `BLOCKED`.
- Keeps the existing safety rule: if neither the Goal nor any milestone is blocked, reopen still returns `NO_BLOCKED_MILESTONE_TO_REOPEN`.
- No changes to Codex/Executor permissions, Git policy, or deploy behavior.
