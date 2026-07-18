/**
 * Zenbooker Payments API (Local DB-backed)
 *
 * GET   /api/zenbooker/payments          — list transactions from local DB
 * GET   /api/zenbooker/payments/:id      — single transaction detail from local DB
 * POST  /api/zenbooker/payments/sync     — sync from Zenbooker API into local DB
 */

const express = require('express');
const router = express.Router();
const paymentsService = require('../../services/zenbookerPaymentsSyncService');

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/zenbooker/payments/sync  — Sync from Zenbooker into local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/sync', async (req, res) => {
    // Sync can take minutes for large date ranges (many ZB API calls).
    // Override the global 15s server.setTimeout for this request only.
    req.setTimeout(300000);   // 5 min
    res.setTimeout(300000);

    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        // ZBPAY-MIGRATE-001: the shared Zenbooker payment account belongs to
        // exactly one company. Reject before validation, client resolution,
        // network fetches, or writes so a foreign tenant cannot stamp its id on
        // the default company's transactions.
        if (!paymentsService.isDefaultSyncCompany(companyId)) {
            return res.status(403).json({ ok: false, error: 'Zenbooker payment sync is not available for this company' });
        }

        const { date_from, date_to, full_history, cursor } = req.body || {};
        const hasFrom = !!date_from;
        const hasTo = !!date_to;
        const noRange = !hasFrom && !hasTo;
        const wantsFullHistory = full_history === true || noRange;
        const invalidFullFlag = full_history != null && typeof full_history !== 'boolean';
        const invalidRange = hasFrom !== hasTo;
        const mixedModes = full_history === true && (hasFrom || hasTo);
        const cursorWithRange = cursor != null && !wantsFullHistory;
        if (invalidFullFlag || invalidRange || mixedModes || cursorWithRange) {
            return res.status(400).json({ ok: false, error: 'Choose either date_from/date_to or full_history, not both' });
        }

        console.log(`[Payments] ${wantsFullHistory ? 'Full-history' : 'Range'} sync requested, company=${companyId}`);

        const result = await paymentsService.syncPayments(
            companyId,
            wantsFullHistory ? null : date_from,
            wantsFullHistory ? null : date_to,
            { fullHistory: wantsFullHistory, cursor: cursor ?? null },
        );

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] Sync error:', err.response?.data || err.message);
        const status = err.httpStatus || err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments/export  — Export data enriched with Albusto job info
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/export', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const { date_from, date_to, payment_method, search } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        const rows = await paymentsService.listPaymentsForExport(companyId, {
            dateFrom: date_from,
            dateTo: date_to,
            paymentMethod: payment_method || undefined,
            search: search || undefined,
        });

        res.json({ ok: true, data: rows });
    } catch (err) {
        console.error('[Payments] Export error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments  — List payments from local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const { date_from, date_to, status, payment_method, search, sort_by, sort_order, offset, limit, quick_filter } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        const result = await paymentsService.listPayments(companyId, {
            dateFrom: date_from,
            dateTo: date_to,
            paymentMethod: payment_method || undefined,
            quickFilter: quick_filter || undefined,
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
        const companyId = req.companyFilter?.company_id;
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
        const companyId = req.companyFilter?.company_id;
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
