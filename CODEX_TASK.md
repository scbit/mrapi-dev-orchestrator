# MRAPI DEV v0.4.1.1 — Setup scripts for W01-W05 persistent ChatGPT profiles

## OBJECTIVE
Generalize the existing W04 one-time ChatGPT profile setup so every Brain worker W01-W05 has the same safe setup flow.

## CONTEXT
W04 already has:
- dedicated persistent profile
- setup-w04-chatgpt-profile.ps1
- worker-specific chat URL
- login persistence

W01 currently maps to its own profile at runtime but has no setup-w01-chatgpt-profile.ps1, so the human cannot initialize/login that profile cleanly.

## IMPLEMENTATION
Create/normalize one-time setup scripts:

- brain-adapter/setup-w01-chatgpt-profile.ps1
- brain-adapter/setup-w02-chatgpt-profile.ps1
- brain-adapter/setup-w03-chatgpt-profile.ps1
- brain-adapter/setup-w04-chatgpt-profile.ps1
- brain-adapter/setup-w05-chatgpt-profile.ps1

Requirements:
- each script uses the SAME deterministic profile path as runtime:
  - W01 -> brain-adapter/chrome-profiles/W01
  - W02 -> brain-adapter/chrome-profiles/W02
  - W03 -> brain-adapter/chrome-profiles/W03
  - W04 -> brain-adapter/chrome-profiles/W04
  - W05 -> brain-adapter/chrome-profiles/W05
- each script reads only its own MRAPI_W0X_CHAT_URL env var
- no fallback to another worker
- visible Chrome, not incognito/headless
- human logs in manually once if needed
- no credential capture/storage
- clear worker-specific logs
- reuse/refactor shared PowerShell helper if cleaner, but keep double-clickable worker scripts
- preserve 1 WORKER = 1 CHAT
- preserve W04 behavior
- add focused tests if practical
- bump version to v0.4.1.1 / 0.4.1-1 consistently

## TESTS
Run full suite:
node --test

Verify:
1. W01-W05 setup scripts exist.
2. Each references only its matching chat env var.
3. Each setup path matches runtime path.
4. No cross-worker fallback.
5. Existing W04 setup remains green.
6. Full suite passes.

## SUCCESS CRITERIA
Human can run:

powershell -ExecutionPolicy Bypass -File .\setup-w01-chatgpt-profile.ps1

and Chrome opens W01 dedicated profile + W01 chat.

Same for W02-W05.

## STOP CONDITIONS
- no GCP
- no deploy
- no push
- no credentials in repo
- do not share browser profiles
- do not redesign Brain/Executor architecture

## DEPLOY
Codex implements and tests only.
Human commits/pushes.
No Cloud Run deploy should be needed unless shared backend/version files changed.
