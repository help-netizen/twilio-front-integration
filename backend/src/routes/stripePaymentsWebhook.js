/**
 * stripePaymentsWebhook.js — F018 tenant-payments Stripe webhook.
 *
 * Mounted in src/server.js BEFORE express.json and SEPARATE from the platform
 * billing webhook (/api/billing/webhook):
 *   app.use('/api/stripe-payments/webhook',
 *           express.raw({ type: '*\/*', limit: '1mb' }), router)
 *
 * No auth — the Stripe-Signature header (verified with STRIPE_CONNECT_WEBHOOK_SECRET)
 * is the credential. Idempotent per event id and per payment external id.
 */
const express = require('express');
const router = express.Router();
const stripePaymentsService = require('../services/stripePaymentsService');

router.post('/', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    try {
        const result = await stripePaymentsService.handleWebhook(rawBody, signature);
        res.json(result);
    } catch (err) {
        // Bad/missing signature → 400 (Stripe will not retry a 4xx for signature).
        const status = err.httpStatus || 400;
        res.status(status).json({ ok: false, error: err.message });
    }
});

module.exports = router;
