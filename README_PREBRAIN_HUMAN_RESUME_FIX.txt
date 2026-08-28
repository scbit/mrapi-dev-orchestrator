MRAPI DEV — PRE-BRAIN HUMAN ACTION RESUME FIX

LIVE BUG
m2 Human Action was a milestone prerequisite evaluated BEFORE a PROGRAM Brain Run.
After LISTO + HOST_VALIDATION PASS:
- checkpoint became RESOLVED
- same Mission returned to PROGRAM
- milestone became RUNNING
- but there was no completed PROGRAM Brain Run to resume into a continuation Task
- therefore Shadow had nothing to claim

CORRECT LIFECYCLE
Pre-Brain checkpoint:
PASS
→ SAME Mission
→ PROGRAM BRAIN_RUN
→ Brain creates canonical executor plan
→ Task
→ Shadow claims EXECUTION_RUN

Post-Brain checkpoint:
PASS
→ existing continuation Task recovery remains unchanged.

IMPLEMENTATION
- New server-owned recovery service:
  src/services/preBrainHumanActionResume.js
- /api/runner/next-task invokes it before Executor task claiming.
- Uses deterministic Brain Run id per checkpoint.
- Idempotent.
- Does not create another Mission or Roadmap.
- Does not let Shadow decide lifecycle.
- No Codex changes.

INSTALL
Unzip over:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

TEST
node -c src/services/preBrainHumanActionResume.js
node --test test/pre-brain-human-action-resume.test.js
node --test test/autopilot-human-action-resume.test.js

THEN
git add .
git commit -m "Fix pre-Brain Human Action resume"
git push

AFTER DEPLOY
No new smoke.
Keep Shadow + W01 Brain Adapter running.
The existing V9B m2 is already in the recoverable live state.
Shadow polling /api/runner/next-task should cause MRAPI to create the missing PROGRAM Brain Run on the SAME Mission.
