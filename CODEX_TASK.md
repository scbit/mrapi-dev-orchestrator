# MRAPI DEV v0.4.0.7 — W04 Persistent ChatGPT Profile

## OBJECTIVE
Make W04 use its own persistent Chrome profile for ChatGPT Web so the human logs in once and the session survives restarts.

## CONTEXT
Current W04 runtime shows:
[BRAIN] adapter brain_shadow_chatgpt_w04_01 [ 'W04' ]
[BRAIN] W01 chat (missing)
[BRAIN] claimed ... W04
[BRAIN WEB] prompt sent
[BRAIN WEB] assistant response detected
[BRAIN] COMPLETE ...

Configured:
MRAPI_W04_CHAT_URL=https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24

Expected W04 persistent Chrome profile does not currently exist.

## FILES / AREAS
- brain-adapter/brain-adapter.js
- brain-adapter/lib/*
- brain-adapter/adapters/*
- brain-adapter/start-brain-w04.ps1 or equivalent
- shadow-autostart/* only if needed
- .gitignore
- tests

## IMPLEMENTATION
1. Create deterministic worker-specific persistent Chrome profiles:
   W01 -> brain-adapter/chrome-profiles/W01
   W02 -> brain-adapter/chrome-profiles/W02
   W03 -> brain-adapter/chrome-profiles/W03
   W04 -> brain-adapter/chrome-profiles/W04
   W05 -> brain-adapter/chrome-profiles/W05

2. Auto-create profile directory if missing. Never use temp/incognito/shared profile.

3. W04 must use only MRAPI_W04_CHAT_URL. No fallback to W01.

4. Fix misleading hardcoded W01 log. For W04 startup print:
   [BRAIN] W04 chat <url>
   [BRAIN] W04 profile <path>

5. Add browser profile directory to .gitignore.

6. Add:
   brain-adapter/setup-w04-chatgpt-profile.ps1

   It must:
   - resolve installed Chrome
   - create/open W04 persistent profile
   - open MRAPI_W04_CHAT_URL
   - leave Chrome visible
   - tell human to log in once if needed
   - never request/store credentials
   - use the same profile path as runtime

7. Detect logged-out/login ChatGPT page. Do not treat it as successful Brain response. Surface CHATGPT_LOGIN_REQUIRED / WAITING.

8. Preserve:
   - ChatGPT Web = Brain
   - Codex = Executor
   - Shadow = Host
   - 1 WORKER = 1 CHAT
   - W01-W05 isolation
   - no GCP/deploy

9. Bump to v0.4.0.7 / 0.4.0-7 as appropriate.

## TESTS
Prove:
- W01-W05 profile paths are distinct
- W04 maps to chrome-profiles/W04
- W04 never falls back to W01 chat
- missing W04 URL gives explicit config error
- setup script and runtime use same W04 profile
- .gitignore excludes profile data
- W04 logs say W04, not W01
- login page is not accepted as success
- existing W04 Brain-only and Brain->Codex flows stay green
- W01 remains green
- full suite passes

Run:
node --test

## SUCCESS CRITERIA
After implementation, human runs:

cd C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\brain-adapter
powershell -ExecutionPolicy Bypass -File .\setup-w04-chatgpt-profile.ps1

Chrome opens with W04 profile and W04 chat:
https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24

Human logs into ChatGPT once if required, closes Chrome, then restarts W04 Brain Adapter.

Expected startup:
[BRAIN] adapter brain_shadow_chatgpt_w04_01 [ 'W04' ]
[BRAIN] W04 chat https://chatgpt.com/c/...
[BRAIN] W04 profile C:\...\chrome-profiles\W04

## STOP CONDITIONS
- no credentials in code
- no shared worker profile
- no W01 fallback
- no GCP
- no deploy
- no push

## DEPLOY
Codex implements/tests only.
Human handles commit/push and any manual deploy.
