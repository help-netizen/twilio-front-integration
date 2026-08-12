/**
 * Payments-page ledger routes. The primary surface is composed into /api/payments;
 * the retired Zenbooker path mounts the same router in alias mode.
 */

const express = require('express');
const paymentLedgerService = require('../services/paymentLedgerService');
const { requirePermission } = require('../middleware/authorization');
const { userActor } = require('../services/financialActivityService');
const { withTransaction } = require('../services/transactionService');

function wantsLedger(req, always) {
    return always
        || req.query.view === 'ledger'
        || req.query.date_from !== undefined
        || req.query.date_to !== undefined;
}

function createPaymentLedgerRouter({ always = false } = {}) {
    const router = express.Router();
    const ledgerOnly = (req, _res, next) => (
        wantsLedger(req, always) ? next() : next('route')
    );

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

            const rows = await paymentLedgerService.listPaymentsForExport(companyId, {
                dateFrom: date_from,
                dateTo: date_to,
                paymentMethod: payment_method || undefined,
                search: search || undefined,
            });
            return res.json({ ok: true, data: rows });
        } catch (err) {
            console.error('[Payments] Export error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.get('/', ledgerOnly, requirePermission('payments.view'), async (req, res) => {
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

            const result = await paymentLedgerService.listPayments(companyId, {
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
            return res.json({ ok: true, data: result });
        } catch (err) {
            console.error('[Payments] List error:', err.message);
            const status = err.statusCode || err.httpStatus || 500;
            return res.status(status).json({
                ok: false,
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
            });
        }
    });

    router.get('/:id', ledgerOnly, requirePermission('payments.view'), async (req, res) => {
        try {
            const companyId = req.companyFilter?.company_id;
            if (!companyId) {
                return res.status(403).json({ ok: false, error: 'No company context' });
            }
            const paymentId = parseInt(req.params.id, 10);
            if (isNaN(paymentId)) {
                return res.status(400).json({ ok: false, error: 'Invalid payment ID' });
            }

            const detail = await paymentLedgerService.getPaymentDetail(companyId, paymentId);
            if (!detail) {
                return res.status(404).json({ ok: false, error: 'Transaction not found' });
            }
            return res.json({ ok: true, data: detail });
        } catch (err) {
            console.error('[Payments] Detail error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

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
                paymentLedgerService.updateCheckDeposited(
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
            return res.json({ ok: true, data: result });
        } catch (err) {
            console.error('[Payments] Patch error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
}

module.exports = { createPaymentLedgerRouter };
