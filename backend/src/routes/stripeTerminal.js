/**
 * stripeTerminal.js — F018 Phase 4 Terminal / Tap to Pay backend endpoints.
 *
 * Mounted: app.use('/api/stripe-terminal', authenticate, requireCompanyAccess, router)
 * The on-device NFC client requires a native/RN mobile shell (not the web SPA);
 * these endpoints provide the backend the mobile client will call.
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const stripePaymentsService = require('../services/stripePaymentsService');

function companyId(req) { return req.companyFilter?.company_id; }
function actor(req) { return { id: req.user?.crmUser?.id || req.user?.sub || null }; }
function handle(err, req, res) {
    if (err instanceof stripePaymentsService.StripePaymentsError) {
        return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error('[StripeTerminal] error:', err.message);
    return res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
}

// POST /api/stripe-terminal/connection-token
router.post('/connection-token', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        res.json({ ok: true, data: await stripePaymentsService.getConnectionToken(companyId(req)) });
    } catch (err) { handle(err, req, res); }
});

// POST /api/stripe-terminal/payment-intents/:id/cancel
router.post('/payment-intents/:id/cancel', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        res.json({ ok: true, data: await stripePaymentsService.cancelTerminalIntent(companyId(req), actor(req), req.params.id) });
    } catch (err) { handle(err, req, res); }
});

module.exports = router;
