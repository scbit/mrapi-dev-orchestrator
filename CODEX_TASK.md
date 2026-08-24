# MRAPI DEV v0.3.8-alpha.0 — Autonomous Git Flow

## OBJECTIVE
Make W01 able to finish software missions without the human opening Codex or GitHub Desktop:
Mission → Brain → Codex → tests → optional commit → optional push → Result/Evidence.

Deploy remains HUMAN MANUAL DEPLOY.

## CONTEXT
- W01 autonomous execution already works.
- Artifacts/Evidence v0.3.7 already works.
- Git is installed on Shadow but is not visible in the Codex PowerShell PATH.
- MRAPI is the source of truth.
- Never hardcode Worker=Codex or Host=Shadow.
- Preserve multi-tenancy.
- Current permission model lives in `src/constants/autonomy.js` / worker profiles.
- Current Codex handoff carries trusted server-side execution constraints.
- This package includes `runner/adapters/git-flow.js` and tests as a starting implementation.

## FILES / AREAS
- `src/constants/autonomy.js`
- `src/services/bootstrapData.js`
- `src/services/codexHandoff.js`
- `src/services/orchestration.js` only if needed to carry trusted permissions
- `runner/lib/config.js`
- `runner/shadow-runner.js`
- `runner/adapters/git-flow.js`
- `src/public/app.js` / mission result UI only if needed to show Git outcome
- tests

## IMPLEMENTATION

### 1. Permissions
Add explicit permissions:
- `allow_git_commit`
- `allow_git_push`

Defaults MUST be false.

For initial W01 bootstrap profile set:
- `allow_git_commit: true`
- `allow_git_push: true`
- `allow_deploy` must NOT be used by Runner/Codex in this milestone.
- Do not grant these permissions to W02-W05.

Important:
Do not rely only on environment variables for authorization.
The trusted permission decision must originate from MRAPI server-side worker/profile data and be included in the validated handoff/task claim.

### 2. Trusted handoff
Upgrade the Codex handoff contract version for this change.

Include a trusted block such as:
`git_permissions: { allow_commit, allow_push, allowed_branch }`

Initial allowed branch:
`main`

The Runner must trust ONLY the server-issued handoff permissions, never Codex stdout or Brain prose.

Update execution rules so:
- Codex itself does NOT run git push.
- Runner owns commit/push after Codex exits successfully.
- Deploy remains forbidden.

### 3. Fix Git availability
Use `runner/adapters/git-flow.js`.

On Windows resolve Git in this order:
- PATH `git.exe`
- `C:\Program Files\Git\cmd\git.exe`
- `C:\Program Files\Git\bin\git.exe`

Do not require changing Windows global PATH to make the system work.

### 4. Automatic Git flow
After Codex completes:

A. If Codex execution failed:
- no commit
- no push

B. Upload artifacts/evidence as today.

C. If there are repository changes:
- only proceed if trusted `allow_git_commit=true`
- `git add --all`
- commit
- commit message format:
  `MRAPI <mission_id>: <short objective>`
- capture commit SHA

D. Push only if:
- commit succeeded
- trusted `allow_git_push=true`
- branch is exactly an allowed branch (`main` initially)

E. If there are no changes:
- no empty commit
- execution can still complete successfully

### 5. Safety
Before commit/push:
- verify repo is a Git work tree
- verify no unresolved merge/rebase state
- verify current branch/target policy
- never force push
- never amend
- never delete remote branches
- never push credentials or `.env`
- `.mrapi-artifacts/` stays ignored
- maximum one commit + one push attempt per Execution Run
- no retry loop

If Git preconditions fail:
- task/run should become BLOCKED or FAILED with a clear reason
- do not pretend success

### 6. Result / Evidence
Persist in final execution Result:
- `git.changed`
- `git.committed`
- `git.pushed`
- `git.commit_sha`
- `git.branch`
- `git.error` if any

Add Evidence type `LOG` or `DIFF` with concise Git operation result.

UI should show a compact section:
- Git: No changes / Committed / Pushed
- Commit SHA when available

Do not expose giant Git output by default.

### 7. Runner registration
Set:
- runner version `v0.3.8-alpha.0`
- capability `GIT_COMMIT:AUTO`
- capability `GIT_PUSH:AUTO`

## TESTS
At minimum add tests proving:
1. default permissions are false
2. only W01 gets git commit/push initially
3. trusted handoff carries Git permissions
4. Runner never derives permission from Codex text
5. Codex failure => no Git write
6. tests/success required before Git flow
7. no changes => no empty commit
8. allow_commit=false => no commit
9. allow_push=false => commit may occur but no push
10. branch outside allowlist => no push
11. Windows absolute Git fallback works
12. one commit/push maximum
13. final Result contains Git metadata
14. existing full suite still passes

Run:
`node --test test\git-flow-v038.test.js`
`node --test`

## SUCCESS CRITERIA
- Full suite passes.
- W01 software mission can complete and push without opening Codex or GitHub Desktop.
- Git works even if `git` is absent from PowerShell PATH.
- Push happens only from trusted MRAPI permissions.
- Commit SHA is visible in Result.
- Failed execution never pushes.
- No force push.
- No deploy.
- Existing v0.3.7 artifacts/results remain working.

## STOP CONDITIONS
- Do not access GCP from Codex.
- Do not deploy.
- Do not implement auto-deploy.
- Do not make Git authorization depend on Brain prose.
- Do not grant git push to all workers.
- Do not redesign the Worker/Brain/Executor/Host architecture.
- Stop if safe Git repository state cannot be verified.

## DEPLOY
HUMAN MANUAL DEPLOY after this one-time v0.3.8 commit/push.

After deployment:
- restart Shadow Runner once.
- From then on, future approved W01 software missions should be able to commit/push automatically.
