@echo off
setlocal
cd /d C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\runner

set MRAPI_BASE_URL=https://mrapi-dev-orchestrator-604957912671.us-central1.run.app
set MRAPI_TENANT_ID=tenant_facundo_group
set MRAPI_EXECUTOR_ID=executor_shadow_codex_01
set MRAPI_HOST_NAME=Shadow
set MRAPI_EXECUTOR_NAME=Codex
set MRAPI_WORKER_IDS=W01
set MRAPI_REPO_PATH=C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

if "%MRAPI_RUNNER_SECRET%"=="" (
  echo [MRAPI] MRAPI_RUNNER_SECRET is not configured in Windows user environment.
  exit /b 1
)

call npm.cmd start
