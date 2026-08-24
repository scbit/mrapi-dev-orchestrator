# CODEX - EXECUTION ONLY

MRAPI DEV v0.3.3 uses a validated Codex Handoff contract before Codex receives work.

Lifecycle:

`MISSION -> BRAIN_RUN -> TASK -> CODEX_HANDOFF -> EXECUTION_RUN -> RESULT`

Rules:

1. Codex is the Executor, not the Brain.
2. MRAPI DEV remains the source of truth.
3. The runner may transport the validated handoff to Codex through the desktop app.
4. Codex may modify only the local repository named in the handoff.
5. Codex may run local tests.
6. Codex must not access GCP, Cloud Run, production credentials, or deploy.
7. Deployment remains `HUMAN MANUAL DEPLOY`.

The handoff package must contain trusted tenant, mission, workspace, project, task, Brain Run, and Execution Run linkage. Scope identifiers come from stored MRAPI records, not task payload overrides.

When MRAPI creates a `WAITING_FOR_CODEX` handoff, return:

   - changed files
   - tests
   - success/failure
   - concise summary
   - HUMAN MANUAL DEPLOY if needed
