MRAPI DEV — RECOVERY MODAL UI FIX

Backend Recovery already returns:
200 / recoverable=true / BRAIN_REPLAY / Replay Brain.

Bug:
openMissionDetail renders content while the modal is still hidden.
The previous recovery-ui.js attempted decoration too early and did not observe
the later hidden -> visible attribute change.

Fix:
Observe #missionDetailModal hidden attribute and decorate only after it becomes visible.

INSTALL:
Unzip over:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Then:
git add .
git commit -m "Fix Recovery modal decoration timing"
git push

After deploy:
Ctrl+F5
Open V9B.
Expected button: Replay Brain.
