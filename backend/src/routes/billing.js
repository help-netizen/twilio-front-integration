/**
 * Billing API — ADR-001 §2.4. Tenant self-service (tenant.company.manage).
 * The webhook endpoint is mounted separately (no auth, raw body).
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const billingService = require('../services/billingService');

function companyId(req) { return req.companyFilter?.company_id; }

// GET /api/billing — subscription + this-period usage + plan catalog
router.get('/', async (req, res) => {
    try {
        const [subscription, usage, plans] = await Promise.all([
            billingService.getSubscription(companyId(req)),
            billingService.getUsage(companyId(req)),
            db.query('SELECT id, name, monthly_base_usd, included_seats, per_seat_usd, metered FROM billing_plans WHERE is_active ORDER BY monthly_base_usd').then(r => r.rows),
        ]);
        res.json({ ok: true, subscription, usage, plans });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to load billing' });
    }
});

// POST /api/billing/checkout — Stripe Checkout session for a paid plan
router.post('/checkout', async (req, res) => {
    try {
        const { plan_id, success_url, cancel_url } = req.body || {};
        if (!plan_id) return res.status(422).json({ ok: false, error: 'plan_id required' });
        const out = await billingService.createCheckout(companyId(req), plan_id, {
            successUrl: success_url || 'https://app.albusto.com/settings/billing?status=success',
            cancelUrl: cancel_url || 'https://app.albusto.com/settings/billing?status=cancel',
        });
        res.json({ ok: true, ...out });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
