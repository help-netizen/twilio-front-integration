/**
 * Request ID Middleware
 * 
 * Generates a unique request_id (UUID v4) for every incoming request.
 * Attaches to req.requestId and includes in response header X-Request-Id.
 */

const crypto = require('crypto');

function requestId(req, res, next) {
    const id = crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
}

module.exports = requestId;
