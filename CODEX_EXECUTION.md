# CODEX — EXECUTION ONLY

MRAPI DEV v0.3.1-alpha uses Codex manually inside the ChatGPT desktop app.

When MRAPI creates a `WAITING_FOR_CODEX` handoff:

1. Open the local repository already selected in Codex.
2. Paste the Brain instructions from W01.
3. Execute locally.
4. Run tests.
5. Do not access GCP.
6. Do not deploy.
7. Return:
   - changed files
   - tests
   - success/failure
   - concise summary
   - HUMAN MANUAL DEPLOY if needed
