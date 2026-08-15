/**
 * PF002 Estimates API
 * Sprint 3: real implementations
 */
const express = require('express');
const router = express.Router();
const estimatesService = require('../services/estimatesService');
const aiEstimateService = require('../services/aiEstimateService');
const aiGenerationLogService = require('../services/aiGenerationLogService');
const reportPolishService = require('../services/reportPolishService');
const marketplaceService = require('../services/marketplaceService');
const { requirePermission } = require('../middleware/authorization');
const { actorFromRequest } = require('../services/documentSendNoteService');
const { userActor } = require('../services/financialActivityService');
const { withTransaction } = require('../services/transactionService');

// Tenant context comes ONLY from requireCompanyAccess (PF007-HARDENING-001)
function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function getUserId(req) {
    return req.user?.crmUser?.id || null;
}

function getUserEmail(req) {
    return req.user?.email || req.user?.preferred_username || null;
}

// =============================================================================
// Estimate CRUD
// =============================================================================

// GET /api/estimates — List estimates with filters
router.get('/', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const {
            status,
            contact_id,
            lead_id,
            job_id,
            search,
            start_date,
            end_date,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (status)     filters.status = status;
        if (contact_id) filters.contactId = contact_id;
        if (lead_id)    filters.leadId = lead_id;
        if (job_id)     filters.jobId = job_id;
        if (search)     filters.search = search;
        if (start_date) filters.startDate = start_date;
        if (end_date)   filters.endDate = end_date;
        if (req.query.include_archived === 'true') filters.includeArchived = true;
        if (limit)      filters.limit = parseInt(limit, 10);
        if (offset)     filters.offset = parseInt(offset, 10);

        const result = await estimatesService.listEstimates(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates — Create estimate
router.post('/', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const data = req.body;

        const result = await withTransaction(client => estimatesService.createEstimate(
            companyId,
            userId,
            data,
            client,
            userActor(userId)
        ));
        // AI-GEN-LOG-002: if this estimate was born from an AI draft, attach the
        // saved outcome to the generation row (fire-and-forget, tenant-scoped).
        if (data?.ai_generation_id) {
            void aiGenerationLogService.linkFinal({
                companyId,
                generationId: data.ai_generation_id,
                estimateId: result?.id,
                finalLineItems: Array.isArray(data?.items)
                    ? data.items.map(i => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price }))
                    : [],
            });
        }
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/ai-draft — Generate an unsaved estimate/invoice editor draft.
// Literal route must stay above /:id.
router.post('/ai-draft', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: { code: 'FORBIDDEN', message: 'Company context is required' },
            });
        }
        const permissions = req.authz?.permissions || [];
        const startedAt = Date.now();
        const result = await aiEstimateService.generateDraft({
            companyId,
            actorId: req.user?.crmUser?.id || null,
            reportText: req.body?.report_text,
            jobId: req.body?.job_id,
            canManagePriceBook: !!req.user?._devMode || permissions.includes('price_book.manage'),
        });
        // AI-GEN-LOG-001: awaited single INSERT (~1ms) so the editor gets
        // generation_id back and can link the eventually-saved document
        // (AI-GEN-LOG-002); a logging failure still never breaks the draft.
        const generationId = await aiGenerationLogService.record({
            companyId,
            crmUserId: req.user?.crmUser?.id || null,
            jobId: req.body?.job_id,
            reportText: req.body?.report_text,
            result,
            model: process.env.AI_ESTIMATE_GEMINI_MODEL || 'gemini-2.5-flash',
            durationMs: Date.now() - startedAt,
        });
        res.json(generationId ? { ...result, generation_id: generationId } : result);
    } catch (err) {
        console.error('[Estimates] POST /ai-draft error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({
            ok: false,
            error: { code: err.code || 'INTERNAL', message: err.message },
        });
    }
});

// POST /api/estimates/polish-report — Turn a provider's rough note into a report.
// The runtime mount supplies authenticate + requireCompanyAccess. This route is
// intentionally not gated by estimates.create; it owns its provider/app gates.
router.post('/polish-report', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: { code: 'FORBIDDEN', message: 'Company context is required' },
            });
        }
        if (req.authz?.membership?.role_key !== 'provider') {
            return res.status(403).json({
                ok: false,
                error: {
                    code: 'provider_only',
                    message: 'Only providers can polish reports.',
                },
            });
        }
        const enabled = await marketplaceService.isAppConnected(
            companyId,
            marketplaceService.REPORT_TO_ESTIMATE_APP_KEY
        );
        if (!enabled) {
            return res.status(409).json({
                ok: false,
                error: {
                    code: 'app_disabled',
                    message: 'Report → Estimate is disabled for this company.',
                },
            });
        }

        const report = await reportPolishService.polishReport({
            companyId,
            text: req.body?.text,
        });
        return res.json({ ok: true, data: { report } });
    } catch (err) {
        console.error('[Estimates] POST /polish-report error:', err.message);
        const status = err.httpStatus || 500;
        return res.status(status).json({
            ok: false,
            error: { code: err.code || 'INTERNAL', message: err.message },
        });
    }
});

// GET /api/estimates/:id — Get estimate by ID
// AI-GEN-LOG-001: the accumulated generation log as one Markdown document.
// Literal route — must stay above /:id.
router.get('/ai-generation-log.md', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: { code: 'FORBIDDEN', message: 'Company context is required' },
            });
        }
        const markdown = await aiGenerationLogService.renderMarkdown(companyId);
        res.set('Content-Type', 'text/markdown; charset=utf-8');
        res.set('Content-Disposition', 'inline; filename="ai-generation-log.md"');
        res.send(markdown);
    } catch (err) {
        console.error('[Estimates] GET /ai-generation-log.md error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to render the log' } });
    }
});

router.get('/:id', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getEstimate(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/estimates/:id — Update estimate
router.put('/:id', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const data = req.body;

        const result = await withTransaction(client => estimatesService.updateEstimate(
            companyId,
            userId,
            id,
            data,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] PUT /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/archive — Archive estimate
router.post('/:id/archive', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => estimatesService.archiveEstimate(
            companyId,
            userId,
            id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/archive error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/restore — Restore archived estimate to draft
router.post('/:id/restore', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => estimatesService.restoreEstimate(
            companyId,
            userId,
            id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/restore error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE kept as a compatibility alias for old callers; it archives, never hard-deletes.
router.delete('/:id', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => estimatesService.archiveEstimate(
            companyId,
            userId,
            id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] DELETE /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Estimate actions
// =============================================================================

// POST /api/estimates/:id/send — Send estimate to client
router.post('/:id/send', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { channel, recipient, message } = req.body || {};
        const userEmail = getUserEmail(req);

        const result = await withTransaction(client => estimatesService.sendEstimate(
            companyId,
            userId,
            id,
            {
                channel,
                recipient,
                message,
                userEmail,
                noteActor: actorFromRequest(req),
            },
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/public-link — mint (or reuse) the customer page link
router.post('/:id/public-link', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const userId = getUserId(req);
        const { url } = await withTransaction(client => estimatesService.ensurePublicLink(
            companyId,
            id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: { url } });
    } catch (err) {
        console.error('[Estimates] POST /:id/public-link error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/approve — Mark estimate approved
router.post('/:id/approve', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { signature_name, signature_consent } = req.body || {};
        const actorId = getUserId(req);

        const result = await withTransaction(client => estimatesService.approveEstimate(
            companyId,
            id,
            'user',
            actorId,
            {
                signature_name,
                signature_consent,
            },
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/approve error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/decline — Mark estimate declined
router.post('/:id/decline', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { reason } = req.body || {};
        const actorId = getUserId(req);

        const result = await withTransaction(client => estimatesService.declineEstimate(
            companyId,
            id,
            'user',
            actorId,
            { reason },
            client,
            userActor(actorId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/decline error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/convert — Convert any live estimate to invoice
router.post('/:id/convert', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await withTransaction(client => estimatesService.convertToInvoice(
            companyId,
            userId,
            id,
            client,
            userActor(userId)
        ));
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/convert error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/convert/undo — Undo a fresh, untouched conversion.
router.post('/:id/convert/undo', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const invoiceId = Number(req.body?.invoice_id);

        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
            return res.status(400).json({
                ok: false,
                error: {
                    code: 'MISSING_FIELD',
                    message: 'invoice_id is required to undo a conversion.',
                },
            });
        }

        const result = await withTransaction(client => estimatesService.undoInvoiceConversion(
            companyId,
            userId,
            id,
            invoiceId,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/convert/undo error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({
            ok: false,
            error: { code: err.code || 'INTERNAL', message: err.message },
        });
    }
});

// POST /api/estimates/:id/link-job — Link estimate to job
router.post('/:id/link-job', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { job_id } = req.body;

        if (!job_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'job_id is required' } });
        }

        const result = await withTransaction(client => estimatesService.linkJob(
            companyId,
            userId,
            id,
            job_id,
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/link-job error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/copy-to-invoice — Copy items to new invoice (stub — Sprint 4)
router.post('/:id/copy-to-invoice', requirePermission('invoices.create'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Copy to invoice is planned for Sprint 4' } });
});

// =============================================================================
// Estimate history
// =============================================================================

// GET /api/estimates/:id/revisions — List estimate revisions
router.get('/:id/revisions', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getRevisions(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id/revisions error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/estimates/:id/events — List estimate events
router.get('/:id/events', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getEvents(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id/events error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/estimates/:id/payments — List payments linked to estimate (stub — Sprint 4)
router.get('/:id/payments', requirePermission('payments.view'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Payments are planned for Sprint 4' } });
});

// =============================================================================
// Line items
// =============================================================================

// POST /api/estimates/:id/items — Add line item
router.post('/:id/items', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const item = req.body;

        const result = await estimatesService.addItem(companyId, id, userId, item);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PRICEBOOK-001: bulk add (a Price Book group expanded into its items).
router.post('/:id/items/bulk', requirePermission('estimates.create'), async (req, res) => {
    try {
        const result = await estimatesService.addItems(getCompanyId(req), req.params.id, getUserId(req), req.body?.items);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/items/bulk error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/estimates/:id/items/:itemId — Update line item
router.put('/:id/items/:itemId', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;
        const data = req.body;

        const result = await estimatesService.updateItem(companyId, id, userId, itemId, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] PUT /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/estimates/:id/items/:itemId — Remove line item
router.delete('/:id/items/:itemId', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;

        const result = await estimatesService.removeItem(companyId, id, userId, itemId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] DELETE /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Attachments & PDF
// =============================================================================

router.get('/:id/attachments', requirePermission('estimates.view'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.post('/:id/attachments', requirePermission('estimates.create'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.get('/:id/pdf', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { estimate, buffer } = await estimatesService.generatePdf(companyId, id);
        const safeNumber = String(estimate.estimate_number || `estimate-${id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Estimates] GET /:id/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
