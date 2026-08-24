const { config } = require('./config');
const { getFirestore } = require('./services/firestore');
const { bootstrapInitialData } = require('./services/bootstrap');
const { createApp } = require('./app');

async function start() {
  const db = getFirestore();

  if (config.bootstrapOnStart) {
    const summary = await bootstrapInitialData(db, {
      tenantId: config.defaultTenantId
    });
    console.log('[MRAPI BOOTSTRAP]', JSON.stringify(summary));
  }

  const app = createApp({ db });

  app.listen(config.port, () => {
    console.log(
      `[MRAPI DEV] ${config.version} listening on port ${config.port} ` +
      `(project=${config.googleCloudProject}, firestore=${config.firestoreDatabase}, ` +
      `bucket=${config.evidenceBucket})`
    );
  });
}

start().catch((error) => {
  console.error('[MRAPI FATAL]', error);
  process.exit(1);
});
