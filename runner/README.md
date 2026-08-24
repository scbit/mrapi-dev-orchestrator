# Shadow Runner v0.2-alpha

This runner proves the outbound connection pattern:

`Shadow → MRAPI DEV`

It registers, heartbeats, asks for work and atomically claims a Task.

## Important

The included `executeTaskStub()` intentionally does **not** launch Codex yet.

If a Task is claimed in this transport-validation version, it records evidence and closes the Run as failed with:

`EXECUTOR_ADAPTER_NOT_IMPLEMENTED`

This prevents fake successful execution.

## Configure on Shadow

```bash
export MRAPI_BASE_URL="https://YOUR-CLOUD-RUN-URL"
export MRAPI_TENANT_ID="tenant_facundo_group"
export MRAPI_EXECUTOR_ID="executor_shadow_codex_01"
export MRAPI_HOST_NAME="Shadow"
export MRAPI_EXECUTOR_NAME="Codex"
export MRAPI_RUNNER_SECRET="SAME_SECRET_AS_CLOUD_RUN"
export MRAPI_WORKER_IDS="W01"
export MRAPI_POLL_SECONDS="10"
npm start
```

Windows PowerShell can use `$env:NAME="value"` instead.
