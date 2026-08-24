# CODEX — EXECUTION ONLY

ChatGPT already designed and programmed MRAPI DEV v0.1-alpha.

Do not redesign architecture.

## Objective

Install this delivered code into the existing `mrapi-dev-orchestrator` repository, preserving any valid existing repository-only infrastructure files when they do not conflict.

## Execute

1. Copy the delivered v0.1-alpha files into the repo.
2. Run:
   ```bash
   npm install
   npm test
   npm run test:syntax
   ```
3. Fix only minor operational/syntax/dependency issues if encountered. Do not change the data model or architecture.
4. Confirm GCP auth and that the target resources exist:
   - project `mrapi-dev-orchestrator`
   - Firestore database `mrapi-dev`
   - bucket `mrapi-dev-evidence`
5. Deploy to the existing Cloud Run region/service. If no service exists, use service `mrapi-dev-orchestrator`.
6. Verify:
   - `/health`
   - dashboard shows SYSTEM RUNNING
   - 5 workers are visible and IDLE
   - create one temporary validation mission only if requested by the user; otherwise do not create fake missions.
7. Capture desktop/mobile screenshots.
8. Commit and return:
   - commit hash
   - Cloud Run URL
   - health response
   - test output
   - bootstrap output
   - screenshots
   - deploy result

## Stop

Stop instead of redesigning if credentials/resources/repo access are unavailable or deployment would destroy existing infrastructure.
