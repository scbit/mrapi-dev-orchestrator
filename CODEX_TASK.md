# MRAPI DEV v0.3.8.1 — GitHub Desktop Git resolver fix

## OBJECTIVE
Fix `GIT_COMMAND_NOT_FOUND` on Shadow without requiring the human to install another Git or edit Windows PATH.

## CONTEXT
The real Shadow execution proved:
- Codex completed successfully.
- 71/71 tests passed.
- Git exists at a GitHub Desktop bundled path similar to:
  `%LOCALAPPDATA%\GitHubDesktop\app-<version>\resources\app\git\cmd\git.exe`
- Runner failed only because its Git resolver currently checks PATH and `C:\Program Files\Git\...`.
- GitHub Desktop app version changes over time, so NEVER hardcode `app-3.6.4`.

## FILES / AREAS
- Replace/integrate `runner/adapters/git-flow.js` from this package.
- Add `test/git-flow-githubdesktop-v0381.test.js`.
- Update runner version to `v0.3.8.1-alpha.0` if runner version is centrally declared.

## IMPLEMENTATION
1. Keep existing Git resolution order:
   - PATH `git.exe`
   - `C:\Program Files\Git\cmd\git.exe`
   - `C:\Program Files\Git\bin\git.exe`

2. Add dynamic GitHub Desktop discovery:
   - Read `%LOCALAPPDATA%\GitHubDesktop`
   - Find directories beginning with `app-`
   - Prefer newest version
   - Probe:
     - `resources\app\git\cmd\git.exe`
     - `resources\app\git\mingw64\bin\git.exe`

3. Do NOT hardcode a GitHub Desktop version number.

4. Runner owns Git commit/push. Codex remaining unable to write `.git` inside its sandbox is acceptable and must NOT block Runner Git.

5. Preserve all v0.3.8 safety rules:
   - commit/push only from trusted server permissions
   - no force push
   - no deploy
   - one commit/push attempt max

6. If Git cannot be resolved after all candidates, keep the explicit `GIT_COMMAND_NOT_FOUND` failure.

## TESTS
Run:
`node --test test\git-flow-githubdesktop-v0381.test.js`
`node --test`

Also locally verify with a Node one-liner or test that `resolveGitCommand()` returns a real path on Shadow.

## SUCCESS CRITERIA
- Full test suite passes.
- On Shadow, `resolveGitCommand()` resolves the GitHub Desktop bundled `git.exe`.
- No Windows PATH change required.
- Existing v0.3.8 permissions and safety behavior remain unchanged.
- No deploy and no push by Codex.

## STOP CONDITIONS
- Do not install software.
- Do not modify global Windows PATH.
- Do not access GCP.
- Do not deploy.
- Do not push during this fix.
- Do not hardcode the current GitHub Desktop version.

## DEPLOY
HUMAN MANUAL DEPLOY only if server-side code/version changed.
Runner must be restarted after applying this fix.
