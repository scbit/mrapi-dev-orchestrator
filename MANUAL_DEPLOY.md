# MRAPI DEV v0.2-alpha — Manual Deploy

Update the existing Cloud Run service `mrapi-dev-orchestrator` in GCP project:

`ia-sentire-customs-broker`

## Environment

Keep:

- `GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker`
- `FIRESTORE_DATABASE=mrapi-dev`
- `EVIDENCE_BUCKET=mrapi-dev-evidence`
- `DEFAULT_TENANT_ID=tenant_facundo_group`
- `BOOTSTRAP_ON_START=true`
- `NODE_ENV=production`

Add:

- `RUNNER_SHARED_SECRET=<LONG RANDOM SECRET>`

Do not create `PORT`.

## After deploy

1. Dashboard must still show the 5 workers.
2. Existing mission must remain intact.
3. A READY mission should now show a `Dispatch` button.
4. Do not click Dispatch on a mission you want actually executed until Shadow v0.3 has the Codex adapter.
5. Executors should remain 0 until Shadow registers.
