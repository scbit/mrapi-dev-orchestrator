# Manual deploy — v0.1-alpha.2

## Critical check

The Cloud Run service MUST be deployed in:

`ia-sentire-customs-broker`

Your previous failed revision log referenced:

`ia-sentire-customs-broker`

That is a different GCP project.

## Cloud Run variables

Set:

- `GOOGLE_CLOUD_PROJECT=ia-sentire-customs-broker`
- `FIRESTORE_DATABASE=mrapi-dev`
- `EVIDENCE_BUCKET=mrapi-dev-evidence`
- `DEFAULT_TENANT_ID=tenant_facundo_group`
- `BOOTSTRAP_ON_START=true`
- `NODE_ENV=production`

Do NOT create `PORT`. Cloud Run provides it automatically.

## Expected startup log

You should see something similar to:

`[MRAPI DEV] v0.1-alpha.2 listening on 0.0.0.0:8080 ...`

Then:

`[MRAPI BOOTSTRAP] ...`

or, if IAM/Firestore still needs fixing:

`[MRAPI BOOTSTRAP ERROR] ...`

In the latter case the web container remains online, and the exact Firestore error can be diagnosed from logs.

## Recommended manual deployment

In Cloud Run console:

1. Switch GCP project to `ia-sentire-customs-broker`.
2. Create/update service `mrapi-dev-orchestrator`.
3. Deploy the source/repository containing this version.
4. Confirm the service account has Firestore and Storage access in this same project.
5. Do not set PORT manually.
