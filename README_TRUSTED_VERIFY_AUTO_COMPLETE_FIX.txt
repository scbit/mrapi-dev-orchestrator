MRAPI DEV — TRUSTED VERIFY AUTO-COMPLETE FIX

PROBLEM
After:
- repository_clean HOST_VALIDATION PASS
- PROGRAM Brain
- exactly one continuation Task
- exactly one Shadow EXECUTION_RUN
- required tests pass
- execution completes

VERIFY_EXECUTION could still return NEED_HUMAN_ACTION with
validation_method=manual_runtime_continuity_validation.

That asks the human to confirm facts MRAPI already has as persisted evidence.

FIX
Server-owned recovery runs from /api/runner/next-task polling.

It auto-completes ONLY when ALL are true:
1. current milestone is NEED_HUMAN_ACTION
2. checkpoint is runtime-continuity verification
3. same tenant/roadmap/milestone/Mission
4. exactly one continuation Task and it is DONE/COMPLETED
5. exactly one EXECUTION_RUN for that Task and it is COMPLETED
6. matching VERIFY_EXECUTION Brain Run is COMPLETED
7. Brain asked NEED_HUMAN_ACTION
8. executor report success=true
9. required tests passed
10. no diagnostic-only failure
11. process exit is clean when supplied
12. persisted repository-clean HOST_VALIDATION PASS exists

Then:
- no second LISTO
- verification checkpoint is RESOLVED by TRUSTED_RUNTIME_EVIDENCE
- Mission becomes COMPLETED
- milestone becomes COMPLETED
- Roadmap becomes COMPLETED when all milestones are done
- verification Brain decision remains persisted for audit
- trusted_verification_override is persisted separately

It is fail-closed. Missing/ambiguous evidence does NOT auto-complete.

FILES
src/services/trustedVerificationRecovery.js
src/routes/runner.routes.js
test/trusted-verification-recovery.test.js

TEST
node -c src/services/trustedVerificationRecovery.js
node -c src/routes/runner.routes.js
node --test test/trusted-verification-recovery.test.js
node --test test/resolved-preflight-reuse.test.js
node --test test/pre-brain-human-action-resume.test.js
node --test test/autopilot-human-action-resume.test.js

AFTER DEPLOY
Do NOT press LISTO.
Keep Shadow running.
Existing V9B should be detected on the next poll and close automatically.
