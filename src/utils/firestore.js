function serializeFirestore(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(serializeFirestore);

  if (typeof value?.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeFirestore(item)])
    );
  }

  return value;
}

module.exports = { serializeFirestore };
