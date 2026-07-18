/**
 * Estimates Service
 * PF002-R2 Estimates Composer Refresh
 */

const crypto = require('crypto');
const estimatesQueries = require('../db/estimatesQueries');
const { renderEstimatePdf } = require('./estimatePdfService');
const { toE164 } = require('../utils/phoneUtils');
const { recordDocumentSendNote } = require('./documentSendNoteService');

class EstimatesServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'EstimatesServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function hasSummary(data = {}) {
    return asText(data.summary).length > 0;
}

function normalizeItem(item = {}, index = 0) {
    const name = asText(item.name || item.title);
    const quantity = asNumber(item.quantity, 1);
    const unitPrice = asNumber(item.unit_price, 0);

    if (!name) {
        throw new EstimatesServiceError('VALIDATION', 'Item title is required', 400);
    }
    if (quantity <= 0) {
        throw new EstimatesServiceError('VALIDATION', 'Qty must be greater than 0', 400);
    }
    if (unitPrice < 0) {
        throw new EstimatesServiceError('VALIDATION', 'Unit price cannot be negative', 400);
    }

    return {
        name,
        description: item.description || null,
        quantity,
        unit_price: unitPrice,
        unit: item.unit || null,
        taxable: item.taxable === true,
        sort_order: item.sort_order != null ? item.sort_order : index,
        metadata: item.metadata || {},
        item_type: item.item_type || null,
        category_id: item.category_id || null,
        price_book_item_id: item.price_book_item_id || null,
    };
}

function normalizeItems(items) {
    if (items == null) return null;
    if (!Array.isArray(items)) {
        throw new EstimatesServiceError('VALIDATION', 'items must be an array', 400);
    }
    return items.map((item, index) => normalizeItem(item, index));
}

function validateSavePayload(data = {}, items) {
    if (!hasSummary(data) && (!items || items.length === 0)) {
        throw new EstimatesServiceError('VALIDATION', 'Estimate requires at least one item or Summary', 400);
    }
}

function validateDiscount(data = {}, subtotal = 0) {
    const type = data.discount_type || null;
    const value = asNumber(data.discount_value, 0);

    if (!type && value === 0) return;
    if (!['fixed', 'percentage'].includes(type)) {
        throw new EstimatesServiceError('VALIDATION', 'discount_type must be fixed or percentage', 400);
    }
    if (value < 0) {
        throw new EstimatesServiceError('VALIDATION', 'Discount cannot be negative', 400);
    }
    if (type === 'percentage' && value > 100) {
        throw new EstimatesServiceError('VALIDATION', 'Discount percentage cannot exceed 100', 400);
    }
    if (type === 'fixed' && value > subtotal) {
        throw new EstimatesServiceError('VALIDATION', 'Discount cannot exceed subtotal', 400);
    }
}

function itemSubtotal(items = []) {
    return items.reduce((sum, item) => sum + asNumber(item.quantity, 1) * asNumber(item.unit_price, 0), 0);
}

function assertNotArchived(estimate) {
    if (estimate.archived_at) {
        throw new EstimatesServiceError('ARCHIVED', 'Archived estimate is read-only. Restore it before editing.', 409);
    }
}

async function listEstimates(companyId, filters = {}) {
    return estimatesQueries.listEstimates(companyId, filters);
}

async function getEstimate(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    const items = await estimatesQueries.getEstimateItems(id);
    return { ...estimate, items };
}

async function resolveContext(companyId, data = {}) {
    if (data.job_id) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id);
        if (!job) throw new EstimatesServiceError('VALIDATION', 'Job not found', 400);

        const sequence = await estimatesQueries.nextEstimateSequence(companyId, { jobId: job.id });
        return {
            contact_id: data.contact_id || job.contact_id || null,
            lead_id: data.lead_id || job.lead_id || null,
            job_id: job.id,
            estimate_sequence: sequence,
            estimate_number: estimatesQueries.buildEstimateNumber({
                leadSerialId: job.lead_serial_id || job.lead_id || job.id,
                sequence,
            }),
        };
    }

    if (data.lead_id) {
        const lead = await estimatesQueries.getLeadContext(companyId, data.lead_id);
        if (!lead) throw new EstimatesServiceError('VALIDATION', 'Lead not found', 400);

        const sequence = await estimatesQueries.nextEstimateSequence(companyId, { leadId: lead.id });
        return {
            contact_id: data.contact_id || lead.contact_id || null,
            lead_id: lead.id,
            job_id: null,
            estimate_sequence: sequence,
            estimate_number: estimatesQueries.buildEstimateNumber({
                leadSerialId: lead.serial_id || lead.id,
                sequence,
            }),
        };
    }

    throw new EstimatesServiceError('VALIDATION', 'lead_id or job_id is required', 400);
}

async function snapshotEstimate(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    const items = await estimatesQueries.getEstimateItems(id);
    return { ...estimate, items };
}

async function createEstimate(companyId, userId, data = {}) {
    const items = normalizeItems(data.items) || [];
    validateSavePayload(data, items);
    validateDiscount(data, itemSubtotal(items));

    const context = await resolveContext(companyId, data);
    const estimate = await estimatesQueries.createEstimate(companyId, {
        ...data,
        ...context,
        summary: hasSummary(data) ? asText(data.summary) : null,
        discount_type: data.discount_type || null,
        discount_value: data.discount_value != null ? asNumber(data.discount_value, 0) : 0,
        signature_required: data.signature_required === true,
        created_by: userId,
    });

    if (items.length > 0) {
        await estimatesQueries.replaceEstimateItems(estimate.id, items);
    }
    await estimatesQueries.recalculateEstimateTotals(estimate.id);
    await estimatesQueries.createEvent(estimate.id, 'created', 'user', userId, null);

    return getEstimate(companyId, estimate.id);
}

async function updateEstimate(companyId, userId, id, data = {}) {
    const existing = await estimatesQueries.getEstimateById(companyId, id);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(existing);

    const incomingItems = normalizeItems(data.items);
    const currentItems = incomingItems || await estimatesQueries.getEstimateItems(id);
    validateSavePayload({ ...existing, ...data }, currentItems);
    validateDiscount(data.discount_type !== undefined || data.discount_value !== undefined ? data : existing, itemSubtotal(currentItems));

    if (existing.status === 'approved') {
        const approvedSnapshot = existing.approved_snapshot || await snapshotEstimate(companyId, id);
        await estimatesQueries.createRevision(id, approvedSnapshot, userId);
    }

    const updateData = {
        ...data,
        summary: data.summary !== undefined ? (hasSummary(data) ? asText(data.summary) : null) : undefined,
        discount_type: data.discount_type !== undefined ? data.discount_type || null : undefined,
        discount_value: data.discount_value !== undefined ? asNumber(data.discount_value, 0) : undefined,
        signature_required: data.signature_required !== undefined ? data.signature_required === true : undefined,
        updated_by: userId,
    };
    delete updateData.items;

    if (existing.status !== 'draft') {
        updateData.status = 'draft';
        updateData.sent_at = null;
        updateData.accepted_at = null;
        updateData.declined_at = null;
    }

    const updated = await estimatesQueries.updateEstimate(id, companyId, updateData);
    if (!updated) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    if (incomingItems) {
        await estimatesQueries.replaceEstimateItems(id, incomingItems);
    }
    await estimatesQueries.recalculateEstimateTotals(id);
    await estimatesQueries.createEvent(id, 'updated', 'user', userId, { fields: Object.keys(data) });

    return getEstimate(companyId, id);
}

async function archiveEstimate(companyId, userId, id) {
    const existing = await estimatesQueries.getEstimateById(companyId, id);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const updated = await estimatesQueries.archiveEstimate(id, companyId, userId);
    if (!updated) return getEstimate(companyId, id);

    await estimatesQueries.createEvent(id, 'archived', 'user', userId, null);
    return getEstimate(companyId, id);
}

async function restoreEstimate(companyId, userId, id) {
    const existing = await estimatesQueries.getEstimateById(companyId, id);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const updated = await estimatesQueries.restoreEstimate(id, companyId, userId);
    if (!updated) return getEstimate(companyId, id);

    await estimatesQueries.createEvent(id, 'restored', 'user', userId, { status: 'draft' });
    return getEstimate(companyId, id);
}

async function resetStatusAfterItemEdit(companyId, userId, estimate) {
    if (estimate.status === 'approved') {
        const approvedSnapshot = estimate.approved_snapshot || await snapshotEstimate(companyId, estimate.id);
        await estimatesQueries.createRevision(estimate.id, approvedSnapshot, userId);
    }
    if (estimate.status !== 'draft') {
        await estimatesQueries.updateEstimate(estimate.id, companyId, {
            status: 'draft',
            sent_at: null,
            accepted_at: null,
            declined_at: null,
            updated_by: userId,
        });
    }
}

async function addItem(companyId, estimateId, userId, item) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    await resetStatusAfterItemEdit(companyId, userId, estimate);
    const newItem = await estimatesQueries.addEstimateItem(estimateId, normalizeItem(item));
    await estimatesQueries.recalculateEstimateTotals(estimateId);
    await estimatesQueries.createEvent(estimateId, 'item_added', 'user', userId, { item_id: newItem.id });

    return newItem;
}

// PRICEBOOK-001: bulk add (e.g. a Price Book group expanded into its items).
// One status-reset + ONE recalc + ONE event, vs N round-trips of addItem.
async function addItems(companyId, estimateId, userId, items) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { added: 0, items: [] };

    await resetStatusAfterItemEdit(companyId, userId, estimate);
    const created = [];
    for (const item of list) {
        created.push(await estimatesQueries.addEstimateItem(estimateId, normalizeItem(item)));
    }
    await estimatesQueries.recalculateEstimateTotals(estimateId);
    await estimatesQueries.createEvent(estimateId, 'items_added', 'user', userId, { count: created.length });

    return { added: created.length, items: created };
}

async function updateItem(companyId, estimateId, userId, itemId, data) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const items = await estimatesQueries.getEstimateItems(estimateId);
    const existingItem = items.find(item => String(item.id) === String(itemId));
    if (!existingItem) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await resetStatusAfterItemEdit(companyId, userId, estimate);
    const updated = await estimatesQueries.updateEstimateItem(itemId, normalizeItem({ ...existingItem, ...data }));
    if (!updated) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await estimatesQueries.recalculateEstimateTotals(estimateId);
    await estimatesQueries.createEvent(estimateId, 'item_updated', 'user', userId, { item_id: itemId, fields: Object.keys(data) });

    return updated;
}

async function removeItem(companyId, estimateId, userId, itemId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const items = await estimatesQueries.getEstimateItems(estimateId);
    if (!items.some(item => String(item.id) === String(itemId))) {
        throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await resetStatusAfterItemEdit(companyId, userId, estimate);
    const deleted = await estimatesQueries.deleteEstimateItem(itemId);
    if (!deleted) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await estimatesQueries.recalculateEstimateTotals(estimateId);
    await estimatesQueries.createEvent(estimateId, 'item_removed', 'user', userId, { item_id: itemId });

    return { deleted: true };
}

async function assertHasItems(estimateId) {
    const items = await estimatesQueries.getEstimateItems(estimateId);
    if (!items || items.length === 0) {
        throw new EstimatesServiceError('VALIDATION', 'В эстимейте нет items', 400);
    }
    return items;
}

/**
 * Build the HTML email body: the operator `message` (newlines → <br>) followed
 * by an anchor to the public estimate page. The PDF rides along as an attachment.
 */
function buildEmailBody(message, link) {
    const safe = String(message || '').replace(/\r\n|\r|\n/g, '<br>');
    const anchor = link ? `<p><a href="${link}">View your estimate online</a></p>` : '';
    return `<div>${safe}</div>${anchor}`;
}

/**
 * Compose the SMS body: the operator `message`; append the link only if it is
 * not already embedded (the dialog default already includes it → usually a no-op).
 */
function buildSmsBody(message, link) {
    const base = String(message || '').trim();
    if (link && !base.includes(link)) {
        return base ? `${base} ${link}` : link;
    }
    return base;
}

/**
 * SEND-DOC-001 (SD-5) — actually dispatch the estimate by email or SMS, then
 * (and only then) flip status → 'sent' + stamp sent_at and log the `sent` event.
 *
 * Coded errors carry { code, httpStatus } so routes/estimates.js maps them to
 * the SEND-DOC-001 §2.5 matrix; anything unexpected surfaces as 500.
 */
async function sendEstimate(companyId, userId, id, { channel, recipient, message, userEmail, noteActor } = {}) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);
    await assertHasItems(id);

    const normalizedChannel = channel === 'text' ? 'sms' : channel;
    if (!['email', 'sms'].includes(normalizedChannel)) {
        throw new EstimatesServiceError('VALIDATION', 'channel must be email or sms', 400);
    }
    const to = asText(recipient);
    if (!to) {
        throw new EstimatesServiceError('VALIDATION', 'Recipient is required.', 400);
    }
    const number = estimate.estimate_number || `estimate-${id}`;
    let noteRecipient = to;

    // Public page link is shared by both channels (idempotent — never re-mints).
    const { url: link } = await ensurePublicLink(companyId, id);

    if (normalizedChannel === 'email') {
        // Pre-check: a mailbox that is missing / disconnected / reconnect_required
        // must surface as 409, never reach Gmail, and never flip status.
        const emailMailboxService = require('./emailMailboxService');
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox || mailbox.status !== 'connected') {
            throw new EstimatesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
        }

        let companyName = '';
        try {
            const companyQueries = require('../db/companyQueries');
            const company = await companyQueries.getCompanyById(companyId);
            companyName = asText(company?.name);
        } catch { /* subject falls back to no company suffix */ }
        const subject = companyName
            ? `Estimate ${number} from ${companyName}`
            : `Estimate ${number}`;

        const { buffer } = await generatePdf(companyId, id);
        const safeFile = String(number).replace(/[^a-z0-9_-]+/gi, '_');

        const emailService = require('./emailService');
        try {
            await emailService.sendEmail(companyId, {
                to,
                subject,
                body: buildEmailBody(message, link),
                files: [{
                    mimetype: 'application/pdf',
                    originalname: `Estimate-${safeFile}.pdf`,
                    buffer,
                }],
                userId,
                userEmail,
            });
        } catch (err) {
            // sendEmail throws a PLAIN Error('Mailbox is not connected') (no statusCode)
            // or Error('Mailbox requires reconnection') with statusCode 409 — both mean
            // "mailbox not connected". Map to 409, not 500. Re-throw anything else as-is.
            const m = err && err.message ? err.message : '';
            if (err && (err.statusCode === 409 || /mailbox is not connected|requires reconnection/i.test(m))) {
                throw new EstimatesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
            }
            throw err;
        }
        // NOTE: outbound contact-timeline stamp (emailQueries.linkMessageToContact)
        // is intentionally skipped here — it needs a resolved timeline_id which is not
        // trivially available on the estimate row, and the invoice path doesn't stamp
        // either. The EMAIL-TIMELINE-001 sent-mail projection self-heals the stamp.
    } else {
        // SMS — resolve the company sending number BEFORE any side effects.
        const { resolveCompanyProxyE164 } = require('./messagingHelper');
        const proxy = await resolveCompanyProxyE164(companyId);
        if (!proxy) {
            throw new EstimatesServiceError('NO_PROXY', 'No company sending number is configured.', 422);
        }
        const customerE164 = toE164(to);
        if (!customerE164) {
            throw new EstimatesServiceError('NO_PHONE', 'A valid phone number is required.', 422);
        }
        noteRecipient = customerE164;

        const conversationsService = require('./conversationsService');
        const conv = await conversationsService.getOrCreateConversation(customerE164, proxy, companyId);
        // Wallet gate lives INSIDE sendMessage → propagates as { httpStatus:402, code:'WALLET_BLOCKED' }.
        await conversationsService.sendMessage(conv.id, { body: buildSmsBody(message, link) });
    }

    // Dispatch resolved → NOW flip status and record the send (never before).
    await estimatesQueries.updateEstimate(id, companyId, {
        status: 'sent',
        sent_at: new Date().toISOString(),
    });
    await estimatesQueries.createEvent(id, 'sent', 'user', userId, {
        channel: normalizedChannel,
        recipient: to,
    });

    await recordDocumentSendNote({
        companyId,
        jobId: estimate.job_id,
        actor: noteActor,
        documentType: 'estimate',
        number,
        channel: normalizedChannel,
        recipient: noteRecipient,
    });

    return getEstimate(companyId, id);
}

async function approveEstimate(companyId, id, actorType, actorId, options = {}) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);
    const items = await assertHasItems(id);

    if (estimate.signature_required && actorType === 'client') {
        if (!asText(options.signature_name) || options.signature_consent !== true) {
            throw new EstimatesServiceError('VALIDATION', 'Signature name and consent are required', 400);
        }
    }

    const approvedAt = new Date().toISOString();
    const signatureName = asText(options.signature_name) || null;
    const signatureConsentedAt = options.signature_consent === true ? new Date().toISOString() : null;
    const snapshot = {
        ...estimate,
        status: 'approved',
        accepted_at: approvedAt,
        signature_name: signatureName,
        signature_consented_at: signatureConsentedAt,
        items,
    };
    await estimatesQueries.createRevision(id, snapshot, actorId);

    const updated = await estimatesQueries.updateEstimate(id, companyId, {
        status: 'approved',
        accepted_at: approvedAt,
        approved_snapshot: snapshot,
        signature_name: signatureName,
        signature_consented_at: signatureConsentedAt,
    });

    await estimatesQueries.createEvent(id, 'approved', actorType || 'user', actorId, {
        signature_required: !!estimate.signature_required,
    });

    return updated;
}

async function declineEstimate(companyId, id, actorType, actorId, { reason } = {}) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);

    const comment = asText(reason);
    if (!comment) {
        throw new EstimatesServiceError('VALIDATION', 'Decline reason is required', 400);
    }

    const updated = await estimatesQueries.updateEstimateStatus(id, companyId, 'declined', 'declined_at');
    await estimatesQueries.createEvent(id, 'declined', actorType || 'user', actorId, { reason: comment });

    return updated;
}

async function linkJob(companyId, userId, id, jobId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);

    const job = await estimatesQueries.getJobContext(companyId, jobId);
    if (!job) throw new EstimatesServiceError('VALIDATION', 'Job not found', 400);

    const sequence = await estimatesQueries.nextEstimateSequence(companyId, { jobId: job.id });
    const updated = await estimatesQueries.updateEstimate(id, companyId, {
        job_id: job.id,
        lead_id: estimate.lead_id || job.lead_id || null,
        contact_id: estimate.contact_id || job.contact_id || null,
        estimate_sequence: sequence,
        estimate_number: estimatesQueries.buildEstimateNumber({ leadSerialId: job.lead_serial_id || job.lead_id || job.id, sequence }),
        status: estimate.status === 'draft' ? undefined : 'draft',
        updated_by: userId,
    });

    await estimatesQueries.createEvent(id, 'job_linked', 'user', userId, { job_id: jobId });
    return updated;
}

async function convertToInvoice(companyId, userId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);

    if (estimate.status !== 'approved') {
        throw new EstimatesServiceError(
            'INVALID_STATUS',
            `Estimate must be approved before converting (current status: '${estimate.status}')`,
            400
        );
    }

    if (estimate.invoice_id) {
        throw new EstimatesServiceError('ALREADY_CONVERTED', 'Invoice already exists for this estimate', 409);
    }

    const invoicesQueries = require('../db/invoicesQueries');

    // Auto-populate due_date from the invoice template's default_due_days (Net X policy).
    let dueDate = null;
    try {
        const documentTemplatesService = require('./documentTemplatesService');
        const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'invoice');
        const days = Number(descriptor?.invoice_settings?.default_due_days);
        const effectiveDays = Number.isFinite(days) && days >= 0 ? days : 14;
        const d = new Date();
        d.setDate(d.getDate() + effectiveDays);
        dueDate = d.toISOString().slice(0, 10);
    } catch { /* fall back to NULL */ }

    // Build an estimate-style invoice number — `INVOICE L-{leadSerialId}-{seq}`.
    let invoiceNumber = null;
    try {
        let leadSerialId = null;
        let jobIdForNum = estimate.job_id || null;
        if (estimate.job_id) {
            const job = await estimatesQueries.getJobContext(companyId, estimate.job_id);
            leadSerialId = job?.lead_serial_id || job?.lead_id || estimate.lead_id || null;
            jobIdForNum = job?.id || jobIdForNum;
        } else if (estimate.lead_id) {
            const lead = await estimatesQueries.getLeadContext(companyId, estimate.lead_id);
            leadSerialId = lead?.serial_id || lead?.id || null;
        }
        const sequence = await invoicesQueries.nextInvoiceSequence(companyId, {
            jobId: estimate.job_id,
            leadId: estimate.lead_id,
        });
        invoiceNumber = invoicesQueries.buildInvoiceNumber({
            leadSerialId,
            jobId: jobIdForNum,
            sequence,
        });
    } catch { /* leave null → createInvoice falls back to the legacy date scheme */ }

    const invoice = await invoicesQueries.createInvoice(companyId, {
        contact_id: estimate.contact_id,
        lead_id: estimate.lead_id,
        job_id: estimate.job_id,
        estimate_id: estimate.id,
        invoice_number: invoiceNumber,
        title: estimate.estimate_number,
        notes: estimate.summary || estimate.notes,
        internal_note: estimate.internal_note,
        tax_rate: estimate.tax_rate,
        discount_amount: estimate.discount_amount,
        currency: estimate.currency,
        due_date: dueDate,
        created_by: userId,
    });

    const items = await estimatesQueries.getEstimateItems(id);
    for (const item of items) {
        await invoicesQueries.addInvoiceItem(invoice.id, {
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            amount: item.amount,
            taxable: item.taxable,
            sort_order: item.sort_order,
        });
    }

    await invoicesQueries.recalculateInvoiceTotals(invoice.id);
    await invoicesQueries.createEvent(invoice.id, 'created_from_estimate', 'user', userId, { estimate_id: estimate.id });
    await estimatesQueries.createEvent(id, 'converted_to_invoice', 'user', userId, { invoice_id: invoice.id });

    const invoicesService = require('./invoicesService');
    return invoicesService.getInvoice(companyId, invoice.id);
}

async function copyToInvoice(companyId, userId, id) {
    return convertToInvoice(companyId, userId, id);
}

async function getRevisions(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    return estimatesQueries.listRevisions(id);
}

async function getEvents(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    return estimatesQueries.listEvents(id);
}

async function generatePdf(companyId, id) {
    const estimate = await getEstimate(companyId, id);
    // F015: resolve company-specific document template; falls back to factory descriptor.
    const documentTemplatesService = require('./documentTemplatesService');
    const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'estimate');
    return {
        estimate,
        buffer: await renderEstimatePdf(estimate, descriptor),
    };
}

// =============================================================================
// Public link (SEND-DOC-001) — mirrors invoicesService ensurePublicLink /
// getPublicInvoice / generatePdfByPublicToken.
// =============================================================================

/**
 * Return (creating if necessary) a public link for the estimate. Idempotent —
 * subsequent calls return the same token + URL. Re-send never re-mints.
 */
async function ensurePublicLink(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    let token = estimate.public_token;
    if (!token) {
        // 8 bytes of entropy → 11 url-safe chars. 2^64 keyspace is plenty for unguessability.
        token = crypto.randomBytes(8).toString('base64url');
        await estimatesQueries.setPublicToken(estimate.id, companyId, token);
    }

    const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
    // Customer-facing SPA page: GET /e/:token (PublicEstimateViewPage).
    const path = `/e/${token}`;
    return { token, url: base ? `${base}${path}` : path };
}

/**
 * Customer-safe view of an estimate resolved by its `public_token`.
 * No auth/scoping — the token is the credential. Returns null when not found
 * (route maps to 404). Exposes ONLY doc-safe fields — never internal IDs,
 * contact email/phone, costs/margins, or other tenant data.
 */
async function getPublicEstimate(publicToken) {
    const estimate = await estimatesQueries.getEstimateByPublicToken(publicToken);
    if (!estimate) return null;
    const items = await estimatesQueries.getEstimateItems(estimate.id);

    return {
        estimate_number: estimate.estimate_number,
        status: estimate.status,
        currency: estimate.currency || 'USD',
        company_name: estimate.company_name || null,
        contact_name: estimate.contact_name || null,
        summary: estimate.summary || null,
        notes: estimate.notes || null,
        items: items.map((item) => ({
            title: item.name,
            description: item.description || null,
            qty: Number(item.quantity),
            unit_price: Number(item.unit_price),
            line_total: Number(item.amount),
        })),
        subtotal: Number(estimate.subtotal),
        discount_amount: Number(estimate.discount_amount),
        tax_amount: Number(estimate.tax_amount),
        total: Number(estimate.total),
    };
}

/**
 * Render the PDF for an estimate resolved by its `public_token`.
 * No auth/scoping — the token is the credential. Reuses generatePdf.
 */
async function generatePdfByPublicToken(publicToken) {
    const estimate = await estimatesQueries.getEstimateByPublicToken(publicToken);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', 'Estimate not found', 404);
    return generatePdf(estimate.company_id, estimate.id);
}

module.exports = {
    listEstimates,
    getEstimate,
    createEstimate,
    updateEstimate,
    archiveEstimate,
    restoreEstimate,
    addItem,
    addItems,
    updateItem,
    removeItem,
    sendEstimate,
    approveEstimate,
    declineEstimate,
    linkJob,
    convertToInvoice,
    copyToInvoice,
    getRevisions,
    getEvents,
    generatePdf,
    ensurePublicLink,
    getPublicEstimate,
    generatePdfByPublicToken,
    EstimatesServiceError,
};
