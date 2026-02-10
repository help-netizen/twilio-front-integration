/**
 * Rate Limiter Middleware
 * 
 * In-memory sliding window rate limiter by key_id and IP.
 * Uses Map<string, { count, resetAt }> with periodic cleanup.
 * 
 * ENV:
 *   RATE_LIMIT_WINDOW_SEC   (default 60)
 *   RATE_LIMIT_MAX_PER_KEY  (default 60)
 *   RATE_LIMIT_MAX_PER_IP   (default 120)
 */

const WINDOW_SEC = parseInt(process.env.RATE_LIMIT_WINDOW_SEC || '60', 10);
const MAX_PER_KEY = parseInt(process.env.RATE_LIMIT_MAX_PER_KEY || '60', 10);
const MAX_PER_IP = parseInt(process.env.RATE_LIMIT_MAX_PER_IP || '120', 10);

const buckets = new Map(); // key → { count, resetAt }

// Periodic cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
            buckets.delete(key);
        }
    }
}, 5 * 60 * 1000).unref();

/**
 * Check rate limit for a given identifier.
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
function check(identifier) {
    const now = Date.now();
    const windowMs = WINDOW_SEC * 1000;
    let bucket = buckets.get(identifier);

    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(identifier, bucket);
    }

    bucket.count++;

    const isKey = identifier.startsWith('key:');
    const limit = isKey ? MAX_PER_KEY : MAX_PER_IP;

    return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt,
        limit,
    };
}

/**
 * Express middleware that enforces rate limits.
 * Must be applied AFTER auth middleware (uses req.integrationKeyId).
 */
function rateLimiterMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const keyId = req.integrationKeyId; // set by auth middleware

    // Check IP limit
    const ipResult = check(`ip:${ip}`);
    if (!ipResult.allowed) {
        return res.status(429).json({
            success: false,
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests from this IP',
            request_id: req.requestId,
        });
    }

    // Check key limit (if authenticated)
    if (keyId) {
        const keyResult = check(`key:${keyId}`);
        res.setHeader('X-RateLimit-Limit', keyResult.limit);
        res.setHeader('X-RateLimit-Remaining', keyResult.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(keyResult.resetAt / 1000));
        if (!keyResult.allowed) {
            return res.status(429).json({
                success: false,
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests for this API key',
                request_id: req.requestId,
            });
        }
    }

    next();
}

module.exports = rateLimiterMiddleware;
