/**
 * PF005 Client Portal API
 * Sprint 6: full implementation
 *
 * Three auth zones:
 *   1. Public (no auth) — token request and verify
 *   2. Internal (keycloak authenticate) — generate portal links for CRM users
 *   3. Portal-session authenticated — all client-facing endpoints
 */
const express = require('express');
const router = express.Router();
const portalService = require('../services/portalService');
const { authenticate } = require('../middleware/keycloakAuth');

// =============================================================================
// Helpers
// =============================================================================

function handleError(res, err, label) {
    console.error(`[Portal] ${label} error:`, err.message);
    const status = err.httpStatus || 500;
    res.status(status).json({
        ok: false,
        error: { code: err.code || 'INTERNAL', message: err.message },
    });
}

/**
 * Portal session auth middleware.
 * Reads Authorization: Bearer <sessionId>, validates session,
 * attaches session to req.portalSession.
 */
async function portalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                ok: false,
                error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
            });
        }

        const sessionId = authHeader.slice(7);
        const session = await portalService.getSession(sessionId);
        req.portalSession = session;
        next();
    } catch (err) {
        const status = err.httpStatus || 401;
        res.status(status).json({
            ok: false,
            error: { code: err.code || 'UNAUTHORIZED', message: err.message },
        });
    }
}

// =============================================================================
// Public (no auth)
// =============================================================================

// POST /api/portal/auth/request-access
router.post('/auth/request-access', async (req, res) => {
    try {
        const { company_id, contact_id, scope, document_type, document_id } = req.body;

        if (!company_id || !contact_id) {
            return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION', message: 'company_id and contact_id are required' },
            });
        }

        const result = await portalService.requestAccess(company_id, contact_id, {
            scope,
            documentType: document_type,
            documentId: document_id,
        });

        res.json({
            ok: true,
            data: {
                token: result.rawToken,
                expires_at: result.expiresAt,
            },
        });
    } catch (err) {
        handleError(res, err, 'POST /auth/request-access');
    }
});

// POST /api/portal/auth/verify
router.post('/auth/verify', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION', message: 'token is required' },
            });
        }

        const ipAddress = req.ip || req.connection?.remoteAddress || null;
        const userAgent = req.headers['user-agent'] || null;

        const result = await portalService.verifyToken(token, ipAddress, userAgent);

        res.json({
            ok: true,
            data: {
                session_id: result.sessionId,
                contact_id: result.contactId,
                scope: result.scope,
                expires_at: result.expiresAt,
            },
        });
    } catch (err) {
        handleError(res, err, 'POST /auth/verify');
    }
});

// =============================================================================
// Internal (requires authenticate middleware — for CRM users)
// =============================================================================

// GET /api/portal/links
router.get('/links', authenticate, async (req, res) => {
    try {
        const companyId = req.companyId;
        const { contact_id, scope, document_type, document_id } = req.query;

        if (!contact_id) {
            return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION', message: 'contact_id is required' },
            });
        }

        const userId = req.user?.sub || req.userId;

        const result = await portalService.generatePortalLink(companyId, contact_id, {
            scope,
            documentType: document_type,
            documentId: document_id,
            createdBy: userId,
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        handleError(res, err, 'GET /links');
    }
});

// =============================================================================
// Portal-session authenticated routes
// =============================================================================

// GET /api/portal/session
router.get('/session', portalAuth, async (req, res) => {
    try {
        const session = req.portalSession;
        res.json({
            ok: true,
            data: {
                id: session.id,
                contact_id: session.contact_id,
                company_id: session.company_id,
                scope: session.scope,
                document_type: session.document_type,
                document_id: session.document_id,
                started_at: session.started_at,
                last_active_at: session.last_active_at,
                token_expires_at: session.token_expires_at,
            },
        });
    } catch (err) {
        handleError(res, err, 'GET /session');
    }
});

// GET /api/portal/documents
router.get('/documents', portalAuth, async (req, res) => {
    try {
        const documents = await portalService.getDocuments(req.portalSession.id);
        res.json({ ok: true, data: documents });
    } catch (err) {
        handleError(res, err, 'GET /documents');
    }
});

// GET /api/portal/documents/:type/:id
router.get('/documents/:type/:id', portalAuth, async (req, res) => {
    try {
        const { type, id } = req.params;
        const document = await portalService.getDocument(req.portalSession.id, type, id);
        res.json({ ok: true, data: document });
    } catch (err) {
        handleError(res, err, 'GET /documents/:type/:id');
    }
});

// POST /api/portal/documents/:type/:id/accept
router.post('/documents/:type/:id/accept', portalAuth, async (req, res) => {
    try {
        const { type, id } = req.params;
        const result = await portalService.acceptDocument(req.portalSession.id, type, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        handleError(res, err, 'POST /documents/:type/:id/accept');
    }
});

// POST /api/portal/documents/:type/:id/decline
router.post('/documents/:type/:id/decline', portalAuth, async (req, res) => {
    try {
        const { type, id } = req.params;
        const result = await portalService.declineDocument(req.portalSession.id, type, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        handleError(res, err, 'POST /documents/:type/:id/decline');
    }
});

// POST /api/portal/payments
router.post('/payments', portalAuth, async (req, res) => {
    try {
        const { invoice_id, amount, payment_method } = req.body;
        const result = await portalService.submitPayment(req.portalSession.id, {
            invoiceId: invoice_id,
            amount,
            paymentMethod: payment_method,
        });
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        handleError(res, err, 'POST /payments');
    }
});

// GET /api/portal/payments/history
router.get('/payments/history', portalAuth, async (req, res) => {
    try {
        const history = await portalService.getPaymentHistory(req.portalSession.id);
        res.json({ ok: true, data: history });
    } catch (err) {
        handleError(res, err, 'GET /payments/history');
    }
});

// GET /api/portal/bookings
router.get('/bookings', portalAuth, async (req, res) => {
    try {
        const bookings = await portalService.getBookings(req.portalSession.id);
        res.json({ ok: true, data: bookings });
    } catch (err) {
        handleError(res, err, 'GET /bookings');
    }
});

// GET /api/portal/profile
router.get('/profile', portalAuth, async (req, res) => {
    try {
        const profile = await portalService.getProfile(req.portalSession.id);
        res.json({ ok: true, data: profile });
    } catch (err) {
        handleError(res, err, 'GET /profile');
    }
});

// PATCH /api/portal/profile
router.patch('/profile', portalAuth, async (req, res) => {
    try {
        const { name, email, phone } = req.body;
        const result = await portalService.updateProfile(req.portalSession.id, { name, email, phone });
        res.json({ ok: true, data: result });
    } catch (err) {
        handleError(res, err, 'PATCH /profile');
    }
});

module.exports = router;
