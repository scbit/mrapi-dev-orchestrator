const crypto = require('crypto');
const { config } = require('../config');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function runnerAuth(req, res, next) {
  if (!config.runnerSharedSecret) {
    if (config.nodeEnv === 'production') {
      return res.status(503).json({
        error: 'RUNNER_AUTH_NOT_CONFIGURED',
        message: 'RUNNER_SHARED_SECRET is required in production.'
      });
    }
    return next();
  }

  const supplied =
    req.header('x-runner-secret') ||
    String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!safeEqual(supplied, config.runnerSharedSecret)) {
    return res.status(401).json({ error: 'UNAUTHORIZED_RUNNER' });
  }

  next();
}

module.exports = { runnerAuth };
