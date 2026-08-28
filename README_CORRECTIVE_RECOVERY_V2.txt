MRAPI DEV — CORRECTIVE RECOVERY V2

WHAT CHANGES
Blind Brain replay becomes corrective recovery.

For BRAIN failures the new Brain Run receives:
- prior failure code
- previous Brain Run id
- prior error
- previous output excerpt
- automatic correction instruction
- optional operator recovery instruction
- same Mission / Roadmap / Milestone / trusted scope

UI
- Recover & Correct
- Edit & Recover

Recover & Correct:
uses MRAPI automatic correction.

Edit & Recover:
lets the operator add one extra correction, e.g.
"Milestone is Brain-only. Do not create a Task. Return the final canonical Brain result."

IMPORTANT
It does NOT edit the Roadmap or Mission objective.
The correction is attached only to the NEW Brain Run objective/context.
Business Mission identity remains unchanged.

FILES
src/app.js
src/routes/recovery.routes.js
src/services/correctiveRecovery.js
src/public/recovery-ui.js
test/corrective-recovery.test.js

INSTALL
Unzip over:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

TEST
node -c src/services/correctiveRecovery.js
node -c src/routes/recovery.routes.js
node --test test/corrective-recovery.test.js
node --test test/mission-recovery.test.js

THEN
git add .
git commit -m "Add corrective Brain recovery"
git push
