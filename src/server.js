const { config } = require('./config');
const { getFirestore } = require('./services/firestore');
const { bootstrapInitialData } = require('./services/bootstrap');
const { startMissionTelegramWatcher } = require('./services/telegramNotifications');
const { createApp } = require('./app');

async function runBootstrap(db) {
  if (!config.bootstrapOnStart) {
    console.log('[MRAPI BOOTSTRAP] disabled');
    return;
  }

  try {
    const summary = await bootstrapInitialData(db, {
      tenantId: config.defaultTenantId
    });
    console.log('[MRAPI BOOTSTRAP]', JSON.stringify(summary));
  } catch (error) {
    // IMPORTANT:
    // Cloud Run must stay alive even if an external dependency is temporarily
    // unavailable. /health will expose dependency failure while logs retain
    // the exact bootstrap error for diagnosis.
    console.error('[MRAPI BOOTSTRAP ERROR]', {
      message: error.message,
      code: error.code || null,
      stack: error.stack
    });
  }
}

function start() {
  const db = getFirestore();
  const app = createApp({ db });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[MRAPI DEV] ${config.version} listening on 0.0.0.0:${config.port} ` +
      `(runtimeProject=${process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'unknown'}, ` +
      `configuredProject=${config.googleCloudProject}, ` +
      `firestore=${config.firestoreDatabase}, bucket=${config.evidenceBucket})`
    );

    // Bootstrap AFTER the HTTP listener is ready.
    // This prevents Firestore/IAM/configuration errors from being reported
    // misleadingly by Cloud Run as a PORT startup failure.
    void runBootstrap(db);

    // Telegram is observability only. It watches persisted Mission state
    // changes and never participates in lifecycle decisions.
    startMissionTelegramWatcher(db);
  });

  server.on('error', (error) => {
    console.error('[MRAPI SERVER ERROR]', error);
    process.exitCode = 1;
  });
}

start();
