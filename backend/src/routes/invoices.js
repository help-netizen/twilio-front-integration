/**
 * PF003 Invoices API
 * Sprint 4: real implementations
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const invoicesService = require('../services/invoicesService');
const aiGenerationLogService = require('../services/aiGenerationLogService');
const { actorFromRequest } = require('../services/documentSendNoteService');
const { userActor } = require('../services/financialActivityService');
const { withTransaction } = require('../services/transactionService');

// Resolve the active company scope from any of the supported middleware shapes.
function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

// Return a valid UUID userId or null (dev-mode injects "dev-user" which would break UUID columns).
// created_by/updated_by FK → crm_users(id): use the resolved CRM user id, NOT the Keycloak sub
// (they differ — crm_users.id ≠ keycloak_sub — so writing the sub violates the created_by FK).
function getUserId(req) {
    return req.user?.crmUser?.id || null;
}

// FK/audit-bound writes must never fall back to the Keycloak subject.
function getCrmUserId(req) {
    return req.user?.crmUser?.id || null;
}

// Actor email — tags the sender on outbound mail (EMAIL-TIMELINE-001).
function getUserEmail(req) {
    return req.user?.email || req.user?.preferred_username || null;
}

// =============================================================================
// Invoice CRUD
// =============================================================================

// GET /api/invoices — List invoices with filters
router.get('/', requirePermission('invoices.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const {
            status,
            contact_id,
            lead_id,
            job_id,
            estimate_id,
            search,
            start_date,
            end_date,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (status)      filters.status = status;
        if (contact_id)  filters.contactId = contact_id;
        if (lead_id)     filters.leadId = lead_id;
        if (job_id)      filters.jobId = job_id;
        if (estimate_id) filters.estimateId = estimate_id;
        if (search)      filters.search = search;
        if (start_date)  filters.startDate = start_date;
        if (end_date)    filters.endDate = end_date;
        if (limit)       filters.limit = parseInt(limit, 10);
        if (offset)      filters.offset = parseInt(offset, 10);

        const result = await invoicesService.listInvoices(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices — Create invoice
router.post('/', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const data = req.body;

        const result = await withTransaction(client => invoicesService.createInvoice(
            companyId,
            userId,
            data,
            client,
            userActor(userId)
        ));
        // AI-GEN-LOG-002: if this invoice was born from an AI draft, attach the
        // saved outcome to the generation row (fire-and-forget, tenant-scoped).
        if (data?.ai_generation_id) {
            void aiGenerationLogService.linkFinal({
                companyId,
                generationId: data.ai_generation_id,
                invoiceId: result?.id,
                finalLineItems: Array.isArray(data?.items)
                    ? data.items.map(i => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price }))
                    : [],
            });
        }
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id — Get invoice by ID
router.get('/:id', requirePermission('invoices.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getInvoice(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/invoices/:id — Update invoice
router.put('/:id', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const data = req.body;

        // A list-row invoice intentionally omits `items`. Requiring the hydrated
        // update seam for whole-array replacement prevents an editor initialized
        // from that summary from accidentally clearing the persisted item set.
        // This caller-asserted header is an accidental-loss guard, NOT a security
        // or authorization boundary; tenant scope + invoices.create remain the
        // write boundary. Scalar-only detail edits do not need it, and create uses POST.
        if (
            Array.isArray(data?.items)
            && req.get('x-invoice-items-hydrated') !== 'true'
        ) {
            return res.status(409).json({
                ok: false,
                error: {
                    code: 'INVOICE_ITEMS_NOT_HYDRATED',
                    message: 'Reload the full invoice before replacing its line items.',
                },
            });
        }

        const result = await withTransaction(client => invoicesService.updateInvoice(
            companyId,
            userId,
            id,
            data,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] PUT /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/invoices/:id — Delete a draft (issued records use POST /:id/void)
router.delete('/:id', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => invoicesService.deleteInvoice(
            companyId,
            id,
            userId,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] DELETE /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Invoice actions
// =============================================================================

// POST /api/invoices/:id/send — Send invoice to client
router.post('/:id/send', requirePermission('invoices.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { channel, recipient, message, includePaymentLink } = req.body || {};
        const userEmail = getUserEmail(req);

        const result = await withTransaction(client => invoicesService.sendInvoice(
            companyId,
            userId,
            id,
            {
                channel,
                recipient,
                message,
                includePaymentLink,
                userEmail,
                noteActor: actorFromRequest(req),
            },
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices/:id/void — Void invoice
router.post('/:id/void', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => invoicesService.voidInvoice(
            companyId,
            id,
            userId,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/void error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices/:invoiceId/payments/:paymentId/void — Keep a manual
// payment in the ledger while reversing its contribution to invoice totals.
router.post(
    '/:invoiceId/payments/:paymentId/void',
    requirePermission('payments.collect_offline'),
    async (req, res) => {
        try {
            const companyId = getCompanyId(req);
            const actorId = getCrmUserId(req);
            const { invoiceId, paymentId } = req.params;
            const { reason } = req.body || {};

            const result = await withTransaction(client => invoicesService.voidPayment(
                companyId,
                actorId,
                invoiceId,
                paymentId,
                client,
                userActor(actorId),
                reason
            ));
            res.json({ ok: true, data: result });
        } catch (err) {
            console.error('[Invoices] POST /:invoiceId/payments/:paymentId/void error:', err.message);
            const status = err.httpStatus || 500;
            res.status(status).json({
                ok: false,
                error: { code: err.code || 'INTERNAL', message: err.message },
            });
        }
    }
);

// POST /api/invoices/:id/sync-items — Sync line items from estimate
router.post('/:id/sync-items', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        let { estimate_id } = req.body || {};

        // If no estimate_id supplied, fall back to the invoice's linked estimate.
        if (!estimate_id) {
            const existing = await invoicesService.getInvoice(companyId, id);
            estimate_id = existing.estimate_id;
        }

        if (!estimate_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'estimate_id is required (invoice not linked to any estimate)' } });
        }

        const result = await withTransaction(client => invoicesService.syncItemsFromEstimate(
            companyId,
            userId,
            id,
            estimate_id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/sync-items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Invoice history
// =============================================================================

// GET /api/invoices/:id/revisions — List invoice revisions
router.get('/:id/revisions', requirePermission('invoices.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getRevisions(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id/revisions error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/events — List invoice events
router.get('/:id/events', requirePermission('invoices.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getEvents(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id/events error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/payments — List payments for invoice
router.get(
    '/:id/payments',
    requirePermission('invoices.view'),
    requirePermission('payments.view'),
    async (req, res) => {
        try {
            const companyId = getCompanyId(req);
            const { id } = req.params;

            const result = await invoicesService.getPayments(companyId, id);
            res.json({ ok: true, data: result });
        } catch (err) {
            console.error('[Invoices] GET /:id/payments error:', err.message);
            const status = err.httpStatus || 500;
            res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
        }
    }
);

// =============================================================================
// Line items
// =============================================================================

// POST /api/invoices/:id/items — Add line item
router.post('/:id/items', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const item = req.body;

        const result = await invoicesService.addItem(companyId, id, userId, item);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PRICEBOOK-001: bulk add (a Price Book group expanded into its items).
router.post('/:id/items/bulk', requirePermission('invoices.create'), async (req, res) => {
    try {
        const result = await invoicesService.addItems(getCompanyId(req), req.params.id, getUserId(req), req.body?.items);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/items/bulk error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/invoices/:id/items/:itemId — Update line item
router.put('/:id/items/:itemId', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;
        const data = req.body;

        const result = await invoicesService.updateItem(companyId, id, userId, itemId, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] PUT /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/invoices/:id/items/:itemId — Remove line item
router.delete('/:id/items/:itemId', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;

        const result = await invoicesService.removeItem(companyId, id, userId, itemId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] DELETE /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Attachments & PDF (stubs — not in MVP scope)
// =============================================================================

router.get('/:id/attachments', requirePermission('invoices.view'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.post('/:id/attachments', requirePermission('invoices.create'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

// POST /api/invoices/:id/public-link — Idempotently mint (or fetch) a tokenized public PDF URL.
router.post('/:id/public-link', requirePermission('invoices.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const actorId = getUserId(req);
        const { id } = req.params;
        const result = await withTransaction(client => invoicesService.ensurePublicLink(
            companyId,
            id,
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/public-link error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/pdf — Render the invoice as a PDF buffer (F015 templates).
router.get('/:id/pdf', requirePermission('invoices.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { invoice, buffer } = await invoicesService.generatePdf(companyId, id);
        const safeNumber = String(invoice.invoice_number || `invoice-${id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Invoices] GET /:id/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// F018 Stripe Payments — invoice payment links
// =============================================================================
const stripePaymentsService = require('../services/stripePaymentsService');

function stripeError(err, req, res, tag) {
    if (err instanceof stripePaymentsService.StripePaymentsError) {
        return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error(`[Invoices] ${tag} error:`, err.message);
    return res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
}

// GET /api/invoices/:id/stripe-payment-link — active link + attempt history.
router.get(
    '/:id/stripe-payment-link',
    requirePermission('invoices.view'),
    requirePermission('payments.view'),
    async (req, res) => {
        try {
            const data = await stripePaymentsService.getPaymentLink(getCompanyId(req), req.params.id);
            res.json({ ok: true, data });
        } catch (err) { stripeError(err, req, res, 'stripe-payment-link GET'); }
    }
);

// POST /api/invoices/:id/stripe-payment-link — create/reuse an invoice-bound link.
router.post('/:id/stripe-payment-link', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const actorId = getCrmUserId(req);
        const data = await withTransaction(client => stripePaymentsService.ensurePaymentLink(
            companyId,
            { id: actorId },
            req.params.id,
            { amount: req.body?.amount },
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data });
    } catch (err) { stripeError(err, req, res, 'stripe-payment-link POST'); }
});

// POST /api/invoices/:id/stripe-manual-card-session — keyed card, invoice-bound.
router.post('/:id/stripe-manual-card-session', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const actorId = getCrmUserId(req);
        const data = await withTransaction(client => stripePaymentsService.createManualCardSession(
            companyId,
            { id: actorId },
            { invoiceId: req.params.id, amount: req.body?.amount },
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data });
    } catch (err) { stripeError(err, req, res, 'stripe-manual-card-session POST'); }
});

// POST /api/invoices/:id/record-payment — cash/check, invoice-bound.
router.post('/:id/record-payment', requirePermission('payments.collect_offline'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const actorId = getCrmUserId(req);
        const data = await withTransaction(client => invoicesService.recordOfflinePayment(
            companyId,
            actorId,
            req.params.id,
            req.body,
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Invoices] POST /:id/record-payment error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
