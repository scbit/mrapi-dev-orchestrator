const { Firestore } = require('@google-cloud/firestore');
const { config } = require('../config');

let instance;

function getFirestore() {
  if (!instance) {
    instance = new Firestore({
      projectId: config.googleCloudProject,
      databaseId: config.firestoreDatabase
    });
  }
  return instance;
}

module.exports = { getFirestore };
