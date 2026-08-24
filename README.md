# MRAPI DEV ORCHESTRATOR — v0.3-alpha

## Flow

```text
Mission READY
→ Dispatch
→ Task QUEUED
→ Shadow claims
→ BRAIN_RUN / ChatGPT Web
→ Brain plan + evidence
→ EXECUTION_RUN / Codex
→ logs + evidence
→ Result
→ Task DONE / Mission COMPLETED / Worker IDLE
```

Permanent separation:

```text
Worker != Brain != Executor != Host
W01 = Software Engineer
Brain = ChatGPT Web
Executor = Codex
Host = Shadow Windows 11
```

Infrastructure:
- GCP project: `ia-sentire-customs-broker`
- Cloud Run service: `mrapi-dev-orchestrator`
- Firestore: `mrapi-dev`
- Evidence bucket: `mrapi-dev-evidence`

Shadow gets no GCP credentials. It only calls protected MRAPI DEV HTTPS endpoints.

## v0.3

v0.2 proved transport. v0.3 inserts the required Brain phase before Codex execution.

The Runner uses a dedicated Chrome profile and a dedicated W01 ChatGPT Web chat. One worker = one chat.

If Codex command-line execution is not available, Task becomes WAITING after the Brain completes; no fake success is recorded.

## Cloud Run

Keep the same variables as v0.2. No new Cloud Run variable is required.

## Tests

```bash
npm install
npm test
npm run test:syntax
```

## Shadow

See `runner/README.md`.

## Deploy rule

Cloud Run deployment is human/manual. Codex must not receive GCP credentials or deploy access.
