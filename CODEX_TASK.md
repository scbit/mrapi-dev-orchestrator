# MRAPI DEV v0.3.7-alpha.0 — Clean Results + Artifacts

## OBJECTIVE
Make Results readable and expose Evidence files stored in the existing evidence bucket.

## CONTEXT
Existing `addEvidence()` already uploads `content_base64` to Cloud Storage and stores only metadata in Firestore.
Do not create a second storage system.

## FILES / AREAS
Use the files in this ZIP and modify:
- `src/app.js`
- `src/public/index.html`
- `runner/adapters/codex-desktop-handoff.js`
- `runner/shadow-runner.js`
- `.gitignore`

## IMPLEMENTATION
1. Mount `createEvidenceRouter({ repos })` at `/api/evidence`.
2. In `index.html`:
   - load `/artifact-ui.css` after `/progress.css`
   - convert Evidence placeholder to a real view containing `<div id="evidenceList" class="report-list"></div>`
   - load `/artifact-ui.js` after `/app.js`
   - update visible version to `v0.3.7-alpha.0`
3. Add `.mrapi-artifacts/` to `.gitignore`.
4. Add artifact contract to Codex handoff:
   - source code stays in normal repo paths
   - final user-facing PDF/XLSX/CSV/image/ZIP/dataset files go to `.mrapi-artifacts/<taskId>/`
   - max 10 MB each
5. Shadow Runner after Codex finishes:
   - scan `.mrapi-artifacts/<taskId>/`
   - upload max 20 files through existing `/api/runner/runs/:runId/evidence`
   - use `type: FILE`, filename, MIME type, `content_base64`
   - delete the temporary task artifact directory after upload
   - artifact upload failure must fail the execution if artifacts were present but could not be persisted
   - register capability `ARTIFACT_UPLOAD:AUTO`
   - runner version `v0.3.7-alpha.0`
6. Keep raw stdout/stderr available only as technical detail. Do not delete audit data.
7. Preserve multi-tenant isolation.

## TESTS
- `node --test test\results-artifacts-v037.test.js`
- `node --test`

Add tests for runner artifact scanning/upload and app mounting `/api/evidence`.

## SUCCESS CRITERIA
- Full suite passes.
- Reports shows a concise final result first.
- Raw stdout/stderr is collapsed under Technical details.
- Evidence page lists existing evidence.
- Stored files have a Download button.
- Future PDF/XLSX/etc. deliverables can be uploaded automatically by Runner.
- Artifact temp folder is not left in Git.

## STOP CONDITIONS
- No GCP access by Codex.
- No deploy by Codex.
- No auto push.
- No architecture redesign.
- No files stored directly in Firestore.

## DEPLOY
HUMAN MANUAL DEPLOY after commit/push.
Restart Shadow Runner after pulling the new code.
