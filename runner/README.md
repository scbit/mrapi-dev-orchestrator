# MRAPI Shadow Runner v0.3-alpha

Flow:

`MRAPI DEV → W01 → ChatGPT Web Brain → Codex Executor → MRAPI DEV`

Shadow requires no GCP credentials.

## Install

```powershell
cd C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator\runner
npm.cmd install
```

## Prepare W01 ChatGPT Web

```powershell
npm.cmd run brain:setup
```

A dedicated Chrome profile opens. Log into ChatGPT there, create/open the chat used only by W01, and copy that chat URL.

## Required local environment

```powershell
$env:MRAPI_BASE_URL="https://YOUR-CLOUD-RUN"
$env:MRAPI_TENANT_ID="tenant_facundo_group"
$env:MRAPI_EXECUTOR_ID="executor_shadow_codex_01"
$env:MRAPI_HOST_NAME="Shadow"
$env:MRAPI_EXECUTOR_NAME="Codex"
$env:MRAPI_RUNNER_SECRET="SAME_SECRET_AS_CLOUD_RUN"
$env:MRAPI_WORKER_IDS="W01"
$env:MRAPI_REPO_PATH="C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator"
$env:MRAPI_W01_CHAT_URL="https://chatgpt.com/c/..."
```

## Codex

The Runner tries `codex` / `codex.cmd` locally. If your installation exposes another noninteractive command, set:

```powershell
$env:MRAPI_CODEX_COMMAND='YOUR COMMAND HERE'
```

If Codex command execution is unavailable, the Brain Run can still finish and the Task moves to WAITING instead of pretending success.

## Start

```powershell
npm.cmd start
```

Codex receives explicit rules: local repo only, no GCP, no Cloud Run, no deploy. Human deploy stays manual.
