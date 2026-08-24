const VERSION = 'v0.4.2.1';

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

const config = Object.freeze({
  appName: 'MRAPI DEV ORCHESTRATOR',
  version: VERSION,
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'ia-sentire-customs-broker',
  firestoreDatabase: process.env.FIRESTORE_DATABASE || 'mrapi-dev',
  evidenceBucket: process.env.EVIDENCE_BUCKET || 'mrapi-dev-evidence',
  defaultTenantId: process.env.DEFAULT_TENANT_ID || 'tenant_facundo_group',
  bootstrapOnStart: boolEnv('BOOTSTRAP_ON_START', true),
  runnerSharedSecret: process.env.RUNNER_SHARED_SECRET || ''
});

module.exports = { config, VERSION };
