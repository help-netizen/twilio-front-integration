/**
 * JWT Admin Auth Middleware
 * 
 * Protects internal admin endpoints (integration management).
 * Validates Bearer token from Authorization header.
 * 
 * ENV: JWT_SECRET
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * JWT auth middleware for admin routes.
 * Expects: Authorization: Bearer <token>
 */
function adminAuth(req, res, next) {
    // In development, allow unauthenticated access if JWT_SECRET is not set
    if (!JWT_SECRET) {
        if (process.env.NODE_ENV === 'production') {
            console.error('[AdminAuth] JWT_SECRET not set in production!');
            return res.status(500).json({ error: 'Server misconfiguration' });
        }
        // Dev mode — skip auth
        req.adminUser = { role: 'dev' };
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            code: 'ADMIN_AUTH_REQUIRED',
            message: 'Authorization header with Bearer token is required.',
            request_id: req.requestId,
        });
    }

    try {
        const token = authHeader.slice(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        req.adminUser = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            code: 'ADMIN_AUTH_INVALID',
            message: 'Invalid or expired token.',
            request_id: req.requestId,
        });
    }
}

/**
 * Generate a JWT token for admin access.
 * @param {{ sub: string, role: string }} payload
 * @param {string} expiresIn  e.g. '24h'
 * @returns {string}
 */
function generateAdminToken(payload, expiresIn = '24h') {
    if (!JWT_SECRET) throw new Error('JWT_SECRET not set');
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

module.exports = { adminAuth, generateAdminToken };
