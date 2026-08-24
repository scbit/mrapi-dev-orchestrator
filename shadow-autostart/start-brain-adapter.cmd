@echo off
setlocal
cd /d C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\brain-adapter

set MRAPI_BASE_URL=https://mrapi-dev-orchestrator-604957912671.us-central1.run.app
set MRAPI_TENANT_ID=tenant_facundo_group
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w01_01
set MRAPI_WORKER_IDS=W01
set MRAPI_REPO_PATH=C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator
set MRAPI_W01_CHAT_URL=https://chatgpt.com/c/6a8badd8-7b54-83e9-a66b-df386e5cd3c6
set MRAPI_CHROME_PROFILE_DIR=C:\Users\Shadow\AppData\Local\MRAPI\chrome-w01

if "%MRAPI_RUNNER_SECRET%"=="" (
  echo [MRAPI] MRAPI_RUNNER_SECRET is not configured in Windows user environment.
  exit /b 1
)

call npm.cmd start
