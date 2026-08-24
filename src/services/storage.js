const { Storage } = require('@google-cloud/storage');
const { config } = require('../config');

let storageInstance;

function getStorage() {
  if (!storageInstance) {
    storageInstance = new Storage({
      projectId: config.googleCloudProject
    });
  }
  return storageInstance;
}

function getEvidenceBucket() {
  return getStorage().bucket(config.evidenceBucket);
}

function getEvidenceConfig() {
  return {
    project_id: config.googleCloudProject,
    bucket: config.evidenceBucket,
    uri: `gs://${config.evidenceBucket}`
  };
}

module.exports = {
  getStorage,
  getEvidenceBucket,
  getEvidenceConfig
};
