MRAPI DEV — BRAIN-ONLY ADAPTER FIX

ROOT CAUSE
The ChatGPT Web Brain Adapter treated every AUTOPILOT PROGRAM response as
executor-required. hasValidAutopilotProgramControl() only accepted
requires_execution=true, and the self-repair prompt forced an EXECUTOR contract.

That contradicts MRAPI backend support for trusted executor_required=false
milestones and caused repeated BRAIN_RESULT_MISSING / malformed Brain-only flows.

FIX
- Read trusted run.brain_context.current_milestone.executor_required.
- executor_required=false:
  require MRAPI_CONTROL requires_execution=false + execution_type=BRAIN_ONLY
  AND a non-empty MRAPI_RESULT.
- If malformed, request a Brain-only repair. Never force Executor/Codex.
- executor_required=true keeps the existing strict Executor contract.
- Unknown legacy metadata accepts either valid contract for compatibility.

FILES
brain-adapter/lib/autopilot-contract.js
brain-adapter/adapters/chatgpt-web.js
test/brain-only-adapter-fix.test.js

TEST
node --test test/brain-only-adapter-fix.test.js
node --test test/brain-adapter-response-detection.test.js
node --test test/brain-only-result-v0402.test.js

IMPORTANT
After git push/deploy of the server, the local Brain Adapter on Shadow also
needs the updated repo files loaded. Restart the W01 Brain Adapter process once
so Node loads the new adapter code.

No Codex changes.
No Executor changes.
