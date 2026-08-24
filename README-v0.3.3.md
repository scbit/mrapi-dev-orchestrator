# MRAPI DEV v0.3.3 — Codex Desktop Handoff

## Goal

Remove the previous manual step where the operator copied only the MRAPI Task ID into Codex.

## New flow

```text
BRAIN_OUTPUT
→ TASK
→ EXECUTION_RUN
→ Shadow Runner
→ full Codex prompt generated
→ prompt saved to local handoff file
→ prompt copied to Windows clipboard
→ optional ChatGPT/Codex app launch command
→ WAITING_FOR_CODEX
```

Codex remains Executor only.

## Important limitation

The installed ChatGPT/Codex desktop app on Shadow currently exposes no verified local CLI/API.
Therefore this version does **not** fake full automation.

Default operator step becomes only:

1. open Codex (unless `MRAPI_CODEX_APP_COMMAND` is configured),
2. paste,
3. send.

No Task ID lookup or Brain Output copying is required.

## Optional app launch

Set:

```powershell
$env:MRAPI_CODEX_APP_COMMAND='<a PowerShell command that opens/focuses your installed ChatGPT app>'
```

MRAPI deliberately does not hardcode an app identifier.

## Handoff files

Default:

`C:\Users\<user>\AppData\Local\MRAPI\codex-handoffs`

## Deploy

Runner-only behavior changed. Cloud Run code does not require a new deploy for this overlay unless the repository version policy requires it.

HUMAN MANUAL DEPLOY.
