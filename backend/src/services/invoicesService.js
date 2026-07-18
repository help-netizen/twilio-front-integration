/**
 * Invoices Service
 * PF003 Invoices MVP — Sprint 4
 *
 * Business logic for invoices, line items, revisions, events, and payments.
 */

const crypto = require('crypto');
const invoicesQueries = require('../db/invoicesQueries');
const estimatesQueries = require('../db/estimatesQueries');
const { toE164 } = require('../utils/phoneUtils');
const { recordDocumentSendNote } = require('./documentSendNoteService');

// =============================================================================
// Error class
// =============================================================================

class InvoicesServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'InvoicesServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// =============================================================================
// Invoice CRUD
// =============================================================================

/**
 * List invoices with filters.
 */
async function listInvoices(companyId, filters = {}) {
    return invoicesQueries.listInvoices(companyId, filters);
}

/**
 * Get a single invoice with its items.
 */
async function getInvoice(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }
    const items = await invoicesQueries.getInvoiceItems(id);
    return { ...invoice, items };
}

/**
 * Create a new invoice with optional line items.
 * Resolves contact_id from the linked job/lead/estimate when not explicitly provided.
 */
async function createInvoice(companyId, userId, data) {
    const resolved = { ...data };

    if (!resolved.contact_id) {
        // Try the linked estimate first (most precise — invoice was converted from one).
        if (resolved.estimate_id) {
            try {
                const est = await estimatesQueries.getEstimateById(companyId, resolved.estimate_id);
                if (est?.contact_id) resolved.contact_id = est.contact_id;
                if (!resolved.lead_id && est?.lead_id) resolved.lead_id = est.lead_id;
                if (!resolved.job_id && est?.job_id) resolved.job_id = est.job_id;
            } catch { /* fall through */ }
        }

        // Then try the linked job's contact.
        if (!resolved.contact_id && resolved.job_id) {
            try {
                const job = await estimatesQueries.getJobContext(companyId, resolved.job_id);
                if (job?.contact_id) resolved.contact_id = job.contact_id;
                if (!resolved.lead_id && job?.lead_id) resolved.lead_id = job.lead_id;
            } catch { /* fall through */ }
        }

        // Finally try the linked lead's contact.
        if (!resolved.contact_id && resolved.lead_id) {
            try {
                const lead = await estimatesQueries.getLeadContext(companyId, resolved.lead_id);
                if (lead?.contact_id) resolved.contact_id = lead.contact_id;
            } catch { /* fall through */ }
        }
    }

    if (!resolved.contact_id) {
        throw new InvoicesServiceError(
            'VALIDATION',
            'contact_id is required (and could not be resolved from job_id/lead_id/estimate_id)',
            400
        );
    }

    // Auto-populate due_date from the invoice template's default_due_days when caller
    // didn't specify one. Falls back to today + 14 days if the template lacks the setting.
    if (!resolved.due_date) {
        try {
            const documentTemplatesService = require('./documentTemplatesService');
            const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'invoice');
            const days = Number(descriptor?.invoice_settings?.default_due_days);
            const effectiveDays = Number.isFinite(days) && days >= 0 ? days : 14;
            const d = new Date();
            d.setDate(d.getDate() + effectiveDays);
            resolved.due_date = d.toISOString().slice(0, 10);
        } catch { /* swallow — fall back to NULL due_date */ }
    }

    // Generate an estimate-style invoice number (`INVOICE L-{leadSerialId}-{seq}`)
    // when the caller didn't supply one. Sequence is per (job_id|lead_id).
    if (!resolved.invoice_number) {
        try {
            let leadSerialId = null;
            let jobIdForNum = resolved.job_id || null;
            if (resolved.job_id) {
                const job = await estimatesQueries.getJobContext(companyId, resolved.job_id);
                leadSerialId = job?.lead_serial_id || job?.lead_id || null;
                jobIdForNum = job?.id || jobIdForNum;
            } else if (resolved.lead_id) {
                const lead = await estimatesQueries.getLeadContext(companyId, resolved.lead_id);
                leadSerialId = lead?.serial_id || lead?.id || null;
            }
            const sequence = await invoicesQueries.nextInvoiceSequence(companyId, {
                jobId: resolved.job_id,
                leadId: resolved.lead_id,
            });
            resolved.invoice_number = invoicesQueries.buildInvoiceNumber({
                leadSerialId,
                jobId: jobIdForNum,
                sequence,
            });
        } catch { /* fall through — let createInvoice pick the legacy date-based number */ }
    }

    const invoice = await invoicesQueries.createInvoice(companyId, {
        ...resolved,
        created_by: userId,
    });

    // Add items if provided
    if (data.items && Array.isArray(data.items)) {
        for (const item of data.items) {
            await invoicesQueries.addInvoiceItem(invoice.id, item);
        }
        await invoicesQueries.recalculateInvoiceTotals(invoice.id);
    }

    // Log creation event
    await invoicesQueries.createEvent(invoice.id, 'created', 'user', userId, null);

    // Return full invoice with items
    return getInvoice(companyId, invoice.id);
}

/**
 * Update an invoice. If status is not 'draft', create a revision snapshot first.
 */
async function updateInvoice(companyId, userId, id, data) {
    const existing = await invoicesQueries.getInvoiceById(companyId, id);
    if (!existing) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    // Create revision snapshot if not draft
    if (existing.status !== 'draft') {
        const items = await invoicesQueries.getInvoiceItems(id);
        const snapshot = { ...existing, items };
        await invoicesQueries.createRevision(id, snapshot, userId);
    }

    // `updateInvoice`'s allowlist ignores `items`, so passing the full `data`
    // (scalars + items) is safe — only whitelisted scalar columns are written.
    const updated = await invoicesQueries.updateInvoice(id, companyId, data);
    if (!updated) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    // INVOICE-EDIT-ITEMS-PERSIST-001 — reconcile line items when (and ONLY when)
    // the caller sends an `items` array. The full editor always posts the complete
    // array (no per-item id); an empty array is a valid "clear all items" instruction.
    // Scalar-only patches from InvoiceDetailPanel.persist() (e.g. { notes }, { tax_rate })
    // omit `items` entirely — those must NOT touch the persisted items.
    const itemsReconciled = Array.isArray(data.items);
    if (itemsReconciled) {
        await invoicesQueries.replaceInvoiceItems(id, data.items);
    }

    // Recalculate totals when items were reconciled OR a totals-affecting scalar changed.
    const TOTALS_AFFECTING = new Set(['tax_rate', 'discount_amount']);
    const scalarTotalsChanged = Object.keys(data).some(k => TOTALS_AFFECTING.has(k));
    if (itemsReconciled || scalarTotalsChanged) {
        await invoicesQueries.recalculateInvoiceTotals(id);
    }

    // Log update event
    await invoicesQueries.createEvent(id, 'updated', 'user', userId, {
        fields: Object.keys(data),
    });

    return getInvoice(companyId, id);
}

/**
 * Delete an invoice. Hard delete if draft; void if not draft.
 */
async function deleteInvoice(companyId, id) {
    const existing = await invoicesQueries.getInvoiceById(companyId, id);
    if (!existing) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    if (existing.status === 'draft') {
        await invoicesQueries.deleteInvoice(id, companyId);
        return { deleted: true };
    } else {
        const updated = await invoicesQueries.updateInvoiceStatus(id, companyId, 'void', 'voided_at');
        return { voided: true, invoice: updated };
    }
}

// =============================================================================
// Line items
// =============================================================================

/**
 * Add a line item to an invoice.
 */
async function addItem(companyId, invoiceId, userId, item) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const newItem = await invoicesQueries.addInvoiceItem(invoiceId, item);
    await invoicesQueries.recalculateInvoiceTotals(invoiceId);

    await invoicesQueries.createEvent(invoiceId, 'item_added', 'user', userId, {
        item_id: newItem.id,
        name: item.name,
    });

    return newItem;
}

/**
 * PRICEBOOK-001: bulk add (Price Book group expanded into items).
 * ONE recalc + ONE event vs N round-trips.
 */
async function addItems(companyId, invoiceId, userId, items) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { added: 0, items: [] };

    const created = [];
    for (const item of list) {
        created.push(await invoicesQueries.addInvoiceItem(invoiceId, item));
    }
    await invoicesQueries.recalculateInvoiceTotals(invoiceId);
    await invoicesQueries.createEvent(invoiceId, 'items_added', 'user', userId, { count: created.length });

    return { added: created.length, items: created };
}

/**
 * Update a line item.
 */
async function updateItem(companyId, invoiceId, userId, itemId, data) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const updated = await invoicesQueries.updateInvoiceItem(itemId, data);
    if (!updated) {
        throw new InvoicesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await invoicesQueries.recalculateInvoiceTotals(invoiceId);

    await invoicesQueries.createEvent(invoiceId, 'item_updated', 'user', userId, {
        item_id: itemId,
        fields: Object.keys(data),
    });

    return updated;
}

/**
 * Remove a line item.
 */
async function removeItem(companyId, invoiceId, userId, itemId) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const deleted = await invoicesQueries.deleteInvoiceItem(itemId);
    if (!deleted) {
        throw new InvoicesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await invoicesQueries.recalculateInvoiceTotals(invoiceId);

    await invoicesQueries.createEvent(invoiceId, 'item_removed', 'user', userId, {
        item_id: itemId,
    });

    return { deleted: true };
}

// =============================================================================
// Invoice actions
// =============================================================================

/**
 * Trim a free-text value to a string ('' when absent).
 */
function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the HTML email body: the operator `message` (newlines → <br>) followed
 * by an anchor to the branded pay page. The PDF rides along as an attachment.
 */
function buildEmailBody(message, link) {
    const safe = String(message || '').replace(/\r\n|\r|\n/g, '<br>');
    const anchor = link ? `<p><a href="${link}">View &amp; pay your invoice online</a></p>` : '';
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
 * SEND-DOC-001 (SD-6) — actually dispatch the invoice by email or SMS, then
 * (and only then) flip status → 'sent' + stamp sent_at and log the `sent` event.
 *
 * Mirrors estimatesService.sendEstimate. The link is the branded **pay page**
 * `/pay/<token>` (derived from ensurePublicLink's token), NOT the `/i/<token>`
 * PDF short link; `includePaymentLink === false` omits it from the body.
 *
 * FIX (flip-first bug): the old stub flipped status to 'sent' + sent_at BEFORE
 * doing any work. Status is now written ONLY after dispatch resolves, so any
 * throw before that point leaves the invoice unchanged (never falsely Sent).
 *
 * Coded errors carry { code, httpStatus } so routes/invoices.js maps them to
 * the SEND-DOC-001 §2.5 matrix; anything unexpected surfaces as 500.
 */
async function sendInvoice(companyId, userId, id, { channel, recipient, message, includePaymentLink, userEmail, noteActor } = {}) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    const normalizedChannel = channel === 'text' ? 'sms' : channel;
    if (!['email', 'sms'].includes(normalizedChannel)) {
        throw new InvoicesServiceError('VALIDATION', 'channel must be email or sms', 400);
    }
    const to = asText(recipient);
    if (!to) {
        throw new InvoicesServiceError('VALIDATION', 'Recipient is required.', 400);
    }
    const number = invoice.invoice_number || `invoice-${id}`;
    let noteRecipient = to;

    // Branded pay page link, derived from the token ensurePublicLink mints
    // (ensurePublicLink itself returns the /i/<token> PDF redirect — we want /pay).
    // Idempotent: ensurePublicLink never re-mints. Omitted when includePaymentLink === false.
    const { token } = await ensurePublicLink(companyId, id);
    const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
    const payPath = `/pay/${token}`;
    const link = includePaymentLink === false ? '' : (base ? `${base}${payPath}` : payPath);

    if (normalizedChannel === 'email') {
        // Pre-check: a mailbox that is missing / disconnected / reconnect_required
        // must surface as 409, never reach Gmail, and never flip status.
        const emailMailboxService = require('./emailMailboxService');
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox || mailbox.status !== 'connected') {
            throw new InvoicesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
        }

        let companyName = '';
        try {
            const companyQueries = require('../db/companyQueries');
            const company = await companyQueries.getCompanyById(companyId);
            companyName = asText(company?.name);
        } catch { /* subject falls back to no company suffix */ }
        const subject = companyName
            ? `Invoice #${number} from ${companyName}`
            : `Invoice #${number}`;

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
                    originalname: `Invoice-${safeFile}.pdf`,
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
                throw new InvoicesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
            }
            throw err;
        }
        // NOTE: the outbound contact-timeline stamp (emailQueries.linkMessageToContact)
        // is intentionally skipped here — same as sendEstimate; the EMAIL-TIMELINE-001
        // sent-mail projection self-heals the stamp.
    } else {
        // SMS — resolve the company sending number BEFORE any side effects.
        const { resolveCompanyProxyE164 } = require('./messagingHelper');
        const proxy = await resolveCompanyProxyE164(companyId);
        if (!proxy) {
            throw new InvoicesServiceError('NO_PROXY', 'No company sending number is configured.', 422);
        }
        const customerE164 = toE164(to);
        if (!customerE164) {
            throw new InvoicesServiceError('NO_PHONE', 'A valid phone number is required.', 422);
        }
        noteRecipient = customerE164;

        const conversationsService = require('./conversationsService');
        const conv = await conversationsService.getOrCreateConversation(customerE164, proxy, companyId);
        // Wallet gate lives INSIDE sendMessage → propagates as { httpStatus:402, code:'WALLET_BLOCKED' }.
        await conversationsService.sendMessage(conv.id, { body: buildSmsBody(message, link) });
    }

    // Dispatch resolved → NOW flip status and record the send (never before).
    const updated = await invoicesQueries.updateInvoiceStatus(id, companyId, 'sent', 'sent_at');
    await invoicesQueries.createEvent(id, 'sent', 'user', userId, {
        channel: normalizedChannel,
        recipient: to,
        message: message || null,
    });

    await recordDocumentSendNote({
        companyId,
        jobId: invoice.job_id,
        actor: noteActor,
        documentType: 'invoice',
        number,
        channel: normalizedChannel,
        recipient: noteRecipient,
    });

    return updated;
}

/**
 * Void an invoice.
 */
async function voidInvoice(companyId, id, userId) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    if (['void', 'refunded'].includes(invoice.status)) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            `Cannot void invoice with status '${invoice.status}'.`,
            400
        );
    }

    const updated = await invoicesQueries.updateInvoiceStatus(id, companyId, 'void', 'voided_at');

    await invoicesQueries.createEvent(id, 'voided', 'user', userId, null);

    return updated;
}

/**
 * Record a payment against an invoice.
 */
async function recordPayment(companyId, userId, id, { amount, payment_method, reference }) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    if (['void', 'refunded'].includes(invoice.status)) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            `Cannot record payment for invoice with status '${invoice.status}'.`,
            400
        );
    }

    if (!amount || amount <= 0) {
        throw new InvoicesServiceError('VALIDATION', 'amount must be greater than 0', 400);
    }

    const updated = await invoicesQueries.recordPayment(id, companyId, amount);
    if (!updated) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    // Update status based on balance
    if (updated.balance_due <= 0) {
        await invoicesQueries.updateInvoiceStatus(id, companyId, 'paid', null);
    } else if (updated.amount_paid > 0) {
        await invoicesQueries.updateInvoiceStatus(id, companyId, 'partial', null);
    }

    // Log event
    await invoicesQueries.createEvent(id, 'payment_recorded', 'user', userId, {
        amount,
        payment_method: payment_method || null,
        reference: reference || null,
    });

    return getInvoice(companyId, id);
}

/**
 * Sync line items from an estimate to this invoice.
 */
async function syncItemsFromEstimate(companyId, userId, invoiceId, estimateId) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const estimateItems = await estimatesQueries.getEstimateItems(estimateId);
    if (!estimateItems || estimateItems.length === 0) {
        throw new InvoicesServiceError('VALIDATION', `No items found on estimate ${estimateId}`, 400);
    }

    for (const item of estimateItems) {
        await invoicesQueries.addInvoiceItem(invoiceId, {
            name: item.description || '',
            description: item.description || '',
            quantity: item.quantity,
            unit_price: item.unit_price,
            unit: item.unit,
            sort_order: item.sort_order,
        });
    }

    await invoicesQueries.recalculateInvoiceTotals(invoiceId);

    await invoicesQueries.createEvent(invoiceId, 'items_synced_from_estimate', 'user', userId, {
        estimate_id: estimateId,
        items_count: estimateItems.length,
    });

    return getInvoice(companyId, invoiceId);
}

// =============================================================================
// History
// =============================================================================

/**
 * Get revisions for an invoice.
 */
async function getRevisions(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }
    return invoicesQueries.listRevisions(id);
}

/**
 * Get events for an invoice.
 */
async function getEvents(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }
    return invoicesQueries.listEvents(id);
}

/**
 * Generate a PDF buffer for an invoice using the F015 document-templates pipeline.
 * Returns { invoice, buffer } in parallel with estimatesService.generatePdf.
 */
async function generatePdf(companyId, id) {
    const invoice = await getInvoice(companyId, id);
    const documentTemplatesService = require('./documentTemplatesService');
    const rendererRegistry = require('./documentTemplates');
    const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'invoice');
    const adapter = rendererRegistry.get('invoice');
    if (!adapter) {
        throw new InvoicesServiceError('INTERNAL', 'Invoice renderer adapter not registered', 500);
    }
    const buffer = await adapter.render(invoice, descriptor);
    return { invoice, buffer };
}

/**
 * Get payments for an invoice (from invoice_events with payment_recorded type).
 */
async function getPayments(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    // Query payment events as payment records
    const db = require('../db/connection');
    const { rows } = await db.query(
        `SELECT * FROM invoice_events
         WHERE invoice_id = $1 AND event_type = 'payment_recorded'
         ORDER BY created_at DESC`,
        [id]
    );
    return rows;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    deleteInvoice,
    addItem,
    addItems,
    updateItem,
    removeItem,
    sendInvoice,
    voidInvoice,
    recordPayment,
    syncItemsFromEstimate,
    getRevisions,
    getEvents,
    getPayments,
    generatePdf,
    ensurePublicLink,
    generatePdfByPublicToken,
    InvoicesServiceError,
};

/**
 * Return (creating if necessary) a public link for the invoice. Idempotent —
 * subsequent calls return the same token + URL.
 */
async function ensurePublicLink(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);

    let token = invoice.public_token;
    if (!token) {
        // 8 bytes of entropy → 11 url-safe chars. 2^64 keyspace is plenty for unguessability.
        token = crypto.randomBytes(8).toString('base64url');
        await invoicesQueries.setPublicToken(invoice.id, companyId, token);
    }

    const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
    // Short, friendly path: GET /i/:token redirects to the full PDF route.
    const path = `/i/${token}`;
    return { token, url: base ? `${base}${path}` : path };
}

/**
 * Render the PDF for an invoice resolved by its `public_token`.
 * No auth/scoping — the token is the credential.
 */
async function generatePdfByPublicToken(publicToken) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(publicToken);
    if (!invoice) throw new InvoicesServiceError('NOT_FOUND', 'Invoice not found', 404);
    const items = await invoicesQueries.getInvoiceItems(invoice.id);
    const fullInvoice = { ...invoice, items };

    const documentTemplatesService = require('./documentTemplatesService');
    const rendererRegistry = require('./documentTemplates');
    const descriptor = await documentTemplatesService.resolveTemplate(invoice.company_id, 'invoice');
    const adapter = rendererRegistry.get('invoice');
    if (!adapter) {
        throw new InvoicesServiceError('INTERNAL', 'Invoice renderer adapter not registered', 500);
    }
    const buffer = await adapter.render(fullInvoice, descriptor);
    return { invoice: fullInvoice, buffer };
}
