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
// created_by references crm_users(id); the Keycloak `sub` is a UUID but NOT a
// crm_users.id, so it must never be the fallback (FK violation). crmUser.id or NULL.
function actor(req) { return { id: req.user?.crmUser?.id || null }; }
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

// POST /api/stripe-terminal/payment-intents — create a Tap to Pay (card_present)
// PaymentIntent for the mobile field-tech client (MTECH-T4 / spec §4.4).
// Body: { amount (integer cents), invoice_id?, job_id?, contact_id? }.
// Delegates to the existing createTapToPayIntent → assertCollectable (409 NOT_READY)
// → provider.createTerminalPaymentIntent (capture_method 'automatic'). The idempotency
// key is derived inside the service; CRM ledger recording happens via the
// payment_intent.succeeded webhook (no capture/confirm on the backend).
router.post('/payment-intents', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        const { amount, invoice_id, job_id, contact_id } = req.body || {};
        if (!Number.isInteger(amount) || amount <= 0) {
            return res.status(400).json({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'amount must be a positive integer (cents)' } });
        }
        const data = await stripePaymentsService.createTapToPayIntent(companyId(req), actor(req), {
            amount,
            invoiceId: invoice_id,
            jobId: job_id,
            contactId: contact_id,
        });
        res.json({ ok: true, data });
    } catch (err) { handle(err, req, res); }
});

// POST /api/stripe-terminal/payment-intents/:id/cancel
router.post('/payment-intents/:id/cancel', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        res.json({ ok: true, data: await stripePaymentsService.cancelTerminalIntent(companyId(req), actor(req), req.params.id) });
    } catch (err) { handle(err, req, res); }
});

module.exports = router;
