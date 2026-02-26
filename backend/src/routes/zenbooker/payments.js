/**
 * Zenbooker Payments API (Local DB-backed)
 *
 * GET   /api/zenbooker/payments          — list transactions from local DB
 * GET   /api/zenbooker/payments/:id      — single transaction detail from local DB
 * POST  /api/zenbooker/payments/sync     — sync from Zenbooker API into local DB
 */

const express = require('express');
const router = express.Router();
const paymentsService = require('../../services/paymentsService');

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/zenbooker/payments/sync  — Sync from Zenbooker into local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/sync', async (req, res) => {
    try {
        const companyId = req.user.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const { date_from, date_to } = req.body;
        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        console.log(`[Payments] Sync requested: ${date_from} → ${date_to}, company=${companyId}`);

        const result = await paymentsService.syncPayments(companyId, date_from, date_to);

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] Sync error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments  — List payments from local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    try {
        const companyId = req.user.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const { date_from, date_to, status, payment_method, search, sort_by, sort_order, offset, limit } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        const result = await paymentsService.listPayments(companyId, {
            dateFrom: date_from,
            dateTo: date_to,
            paymentMethod: payment_method || undefined,
            search: search || undefined,
            sortField: sort_by || 'payment_date',
            sortDir: sort_order || 'desc',
            offset: parseInt(offset, 10) || 0,
            limit: parseInt(limit, 10) || 200,
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] List error:', err.message);
        res.status(500).json({
            ok: false,
            error: err.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments/:id  — Payment detail from local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
    try {
        const companyId = req.user.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const paymentId = parseInt(req.params.id, 10);
        if (isNaN(paymentId)) {
            return res.status(400).json({ ok: false, error: 'Invalid payment ID' });
        }
        console.log(`[Payments] Detail for payment ${paymentId}, company=${companyId}`);

        const detail = await paymentsService.getPaymentDetail(companyId, paymentId);

        if (!detail) {
            return res.status(404).json({ ok: false, error: 'Transaction not found' });
        }

        res.json({ ok: true, data: detail });
    } catch (err) {
        console.error('[Payments] Detail error:', err.message);
        res.status(500).json({
            ok: false,
            error: err.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/zenbooker/payments/:id  — Update check_deposited flag
// ═══════════════════════════════════════════════════════════════════════════════

router.patch('/:id', async (req, res) => {
    try {
        const companyId = req.user.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const paymentId = parseInt(req.params.id, 10);
        if (isNaN(paymentId)) {
            return res.status(400).json({ ok: false, error: 'Invalid payment ID' });
        }
        const { check_deposited } = req.body;

        if (typeof check_deposited !== 'boolean') {
            return res.status(400).json({ ok: false, error: 'check_deposited (boolean) is required' });
        }

        const result = await paymentsService.updateCheckDeposited(companyId, paymentId, check_deposited);

        if (!result) {
            return res.status(404).json({ ok: false, error: 'Transaction not found' });
        }

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] Patch error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
