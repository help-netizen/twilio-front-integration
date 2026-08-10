/**
 * Zenbooker Payments API (Local DB-backed)
 *
 * GET   /api/zenbooker/payments          — list transactions from local DB
 * GET   /api/zenbooker/payments/:id      — single transaction detail from local DB
 */

const express = require('express');
const router = express.Router();
const paymentsService = require('../../services/zenbookerPaymentsSyncService');
const { requirePermission } = require('../../middleware/authorization');
const { userActor } = require('../../services/financialActivityService');
const { withTransaction } = require('../../services/transactionService');

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments/export  — Export data enriched with Albusto job info
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/export', requirePermission('payments.view'), async (req, res) => {
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

router.get('/', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'No company context' });
        }

        const {
            date_from,
            date_to,
            payment_method,
            search,
            provider,
            paid_status,
            sort_by,
            sort_order,
            offset,
            limit,
            cursor,
            quick_filter,
        } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        const result = await paymentsService.listPayments(companyId, {
            dateFrom: date_from,
            dateTo: date_to,
            paymentMethod: payment_method || undefined,
            quickFilter: quick_filter || undefined,
            search: search || undefined,
            provider: provider || undefined,
            paidStatus: paid_status || undefined,
            sortField: sort_by || 'payment_date',
            sortDir: sort_order || 'desc',
            offset: offset === undefined ? undefined : offset,
            limit: limit === undefined ? 50 : limit,
            cursor: cursor || undefined,
        });

        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] List error:', err.message);
        const status = err.statusCode || err.httpStatus || 500;
        res.status(status).json({
            ok: false,
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments/:id  — Payment detail from local DB
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/:id', requirePermission('payments.view'), async (req, res) => {
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

router.patch('/:id', requirePermission('payments.collect_offline'), async (req, res) => {
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

        const actorId = req.user?.crmUser?.id || null;
        const result = await withTransaction(client => (
            paymentsService.updateCheckDeposited(
                companyId,
                paymentId,
                check_deposited,
                client,
                userActor(actorId)
            )
        ));

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
