MRAPI DEV — REUSE RESOLVED REPOSITORY PREFLIGHT FIX

LIVE BUG
m2 prerequisite repository_clean was validated:
LISTO → HOST_VALIDATION PASS.

After the pre-Brain resume, Brain PROGRAM completed and deterministic preflight
asked for the same repository_clean prerequisite again, creating generation 2.

FIX
Server recovery detects:
- current checkpoint WAITING/NEED_HUMAN_ACTION
- validator is git_worktree_clean/repository_clean
- it has parent/superseded checkpoint
- parent has persisted HOST_VALIDATION PASS
- same tenant/roadmap/milestone/Mission
- zero EXECUTION_RUN occurred after that validation
- current PROGRAM Brain Run is COMPLETED

Then MRAPI:
1. canonicalizes checkpoint back to the ORIGINAL checkpoint id
2. preserves it as RESOLVED/PASS
3. does NOT require another LISTO
4. calls existing resumeAutopilotProgramAfterHumanAction()
5. creates/reuses exactly one continuation Task
6. Shadow can claim exactly one EXECUTION_RUN

This is intentionally limited to repository-clean validation.
Other Human Actions are NOT automatically reused.

FILES
src/services/resolvedPreflightReuse.js
src/routes/runner.routes.js
test/resolved-preflight-reuse.test.js

TEST
node -c src/services/resolvedPreflightReuse.js
node --test test/resolved-preflight-reuse.test.js
node --test test/pre-brain-human-action-resume.test.js
node --test test/autopilot-human-action-resume.test.js

INSTALL
Unzip over repository and push.

AFTER DEPLOY
DO NOT press LISTO again.
Keep Shadow running.
Its next /api/runner/next-task poll triggers server recovery on existing V9B.
Expected:
same checkpoint RESOLVED → continuation Task → Shadow claimed → EXECUTION_RUN.
