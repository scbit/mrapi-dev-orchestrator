# CODEX — EXECUTION ONLY

ChatGPT already designed and programmed MRAPI DEV v0.2-alpha.

Do not redesign architecture.

## Backend

1. Copy this package over the existing repo preserving unrelated valid infra files.
2. Run:
   ```bash
   npm install
   npm test
   npm run test:syntax
   ```
3. Fix only minor operational errors.
4. Do NOT change Firestore schema, state machine or runner protocol.
5. Return test output.

The user is doing the initial Cloud Run deploy manually.

## Shadow

Do not enable Shadow yet unless requested after Cloud Run v0.2 is verified.

When requested, copy only `runner/` to Shadow and configure its environment.
