/**
 * Billing API — ADR-001 §2.4. Tenant self-service (tenant.company.manage).
 * The webhook endpoint is mounted separately (no auth, raw body).
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const billingService = require('../services/billingService');
const walletService = require('../services/walletService');

function companyId(req) { return req.companyFilter?.company_id; }

// GET /api/billing — subscription + this-period usage + plan catalog + invoices
router.get('/', async (req, res) => {
    try {
        const [subscription, usage, plans, invoices] = await Promise.all([
            billingService.getSubscription(companyId(req)),
            billingService.getUsage(companyId(req)),
            db.query('SELECT id, name, monthly_base_usd, included_seats, per_seat_usd, metered, included_units, max_phone_numbers FROM billing_plans WHERE is_active ORDER BY monthly_base_usd').then(r => r.rows),
            billingService.getInvoices(companyId(req)),
        ]);
        res.json({ ok: true, subscription, usage, plans, invoices, billing_enabled: billingService.providerConfigured() });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to load billing' });
    }
});

// GET /api/billing/invoices — company-scoped invoice history
router.get('/invoices', async (req, res) => {
    try {
        const invoices = await billingService.getInvoices(companyId(req));
        res.json({ ok: true, invoices });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to load invoices' });
    }
});

// POST /api/billing/checkout — subscribe to a plan (charged via the wallet/card)
router.post('/checkout', async (req, res) => {
    try {
        const { plan_id, return_path } = req.body || {};
        if (!plan_id) return res.status(422).json({ ok: false, error: 'plan_id required' });
        // ONBTEL-001 §2.4: optional return_path — path-only (anti-open-redirect).
        // Absent/undefined/null → keep the default hardcoded URLs; validated BEFORE
        // subscribe() so a 422 here has no side effects.
        const opts = {};
        if (return_path !== undefined && return_path !== null) {
            const valid = typeof return_path === 'string'
                && return_path.startsWith('/')
                && !return_path.includes('//')
                && !return_path.includes(':');
            if (!valid) {
                return res.status(422).json({ ok: false, code: 'INVALID_RETURN_PATH', error: 'return_path must be a relative path' });
            }
            opts.successUrl = opts.cancelUrl = 'https://app.albusto.com' + return_path;
        }
        const out = await billingService.subscribe(companyId(req), plan_id, opts);
        res.json({ ok: true, ...out });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ ok: false, code: err.code, error: err.message });
    }
});

// GET /api/billing/wallet — balance, auto-recharge settings, recent ledger
router.get('/wallet', async (req, res) => {
    try {
        const [wallet, ledger] = await Promise.all([
            walletService.getWallet(companyId(req)),
            walletService.getLedger(companyId(req), 30),
        ]);
        res.json({
            ok: true,
            balance_usd: Number(wallet.balance_usd),
            blocked: Number(wallet.balance_usd) <= walletService.GRACE_FLOOR_USD,
            grace_floor_usd: walletService.GRACE_FLOOR_USD,
            min_topup_usd: walletService.MIN_TOPUP_USD,
            auto_recharge: {
                enabled: wallet.auto_recharge_enabled,
                threshold_usd: Number(wallet.auto_recharge_threshold_usd),
                amount_usd: Number(wallet.auto_recharge_amount_usd),
            },
            has_card: !!wallet.default_payment_method_id,
            ledger,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to load wallet' });
    }
});

// POST /api/billing/wallet/topup — hosted Checkout to add funds (min $10)
router.post('/wallet/topup', async (req, res) => {
    try {
        const out = await billingService.createWalletTopup(companyId(req), req.body?.amount);
        res.json({ ok: true, ...out });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ ok: false, code: err.code, error: err.message });
    }
});

// PATCH /api/billing/wallet/auto-recharge — update auto-recharge settings
router.patch('/wallet/auto-recharge', async (req, res) => {
    try {
        const { enabled, threshold, amount } = req.body || {};
        await walletService.updateSettings(companyId(req), { enabled, threshold, amount });
        res.json({ ok: true });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ ok: false, error: err.message });
    }
});

// POST /api/billing/portal — Stripe customer-portal session (manage card / plan)
router.post('/portal', async (req, res) => {
    try {
        const { return_url } = req.body || {};
        const out = await billingService.createPortal(companyId(req), {
            returnUrl: return_url || 'https://app.albusto.com/settings/billing',
        });
        res.json({ ok: true, ...out });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ ok: false, code: err.code, error: err.message });
    }
});

module.exports = router;
