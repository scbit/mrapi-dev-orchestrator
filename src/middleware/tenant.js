const { config } = require('../config');

function tenantMiddleware(req, _res, next) {
  const tenantId = String(req.header('x-tenant-id') || config.defaultTenantId).trim();
  req.tenantId = tenantId;
  next();
}

module.exports = { tenantMiddleware };
