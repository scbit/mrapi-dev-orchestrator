function createApi(cfg) {
  async function request(path, body = {}) {
    const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runner-secret': cfg.secret,
        'x-tenant-id': cfg.tenantId
      },
      body: JSON.stringify(body)
    });

    if (response.status === 204) return null;
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`${response.status} ${data.error || data.message || text}`);
      error.status = response.status;
      error.code = data.error || data.message || text || `HTTP_${response.status}`;
      error.path = path;
      throw error;
    }
    return data;
  }
  return { request };
}

module.exports = { createApi };
