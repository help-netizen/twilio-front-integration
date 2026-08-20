/**
 * Invoices Service
 * PF003 Invoices MVP — Sprint 4
 *
 * Business logic for invoices, line items, revisions, events, and payments.
 */

const crypto = require('crypto');
const invoicesQueries = require('../db/invoicesQueries');
const estimatesQueries = require('../db/estimatesQueries');
const paymentsService = require('./paymentsService');
const invoiceRemovalService = require('./invoiceRemovalService');
const { toE164 } = require('../utils/phoneUtils');
const { shortDocNumber } = require('../utils/docNumber');
const { recordDocumentSendNote } = require('./documentSendNoteService');
const { logFinancialActivity } = require('./financialActivityService');
const eventBus = require('./eventBus');
const { buildInvoiceEmailBody } = require('./documentEmailBody');
const {
    normalizeOrderList,
    stripInternalOrderList,
} = require('../utils/orderList');

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

const WORKFLOW_CONTROLLED_UPDATE_FIELDS = new Set([
    'company_id',
    'invoice_number',
    'status',
    'subtotal',
    'tax_amount',
    'total',
    'amount_paid',
    'balance_due',
    'sent_at',
    'paid_at',
    'voided_at',
    'created_by',
    'updated_by',
    'created_at',
    'updated_at',
]);
const PUBLIC_LINK_LIFETIME_MONTHS = 18;

function asNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function validateDiscount(data = {}, subtotal = 0) {
    const type = data.discount_type || null;
    const value = asNumber(data.discount_value, 0);

    if (!type && value === 0) return;
    if (!['fixed', 'percentage'].includes(type)) {
        throw new InvoicesServiceError('VALIDATION', 'discount_type must be fixed or percentage', 400);
    }
    if (value < 0) {
        throw new InvoicesServiceError('VALIDATION', 'Discount cannot be negative', 400);
    }
    if (type === 'percentage' && value > 100) {
        throw new InvoicesServiceError('VALIDATION', 'Discount percentage cannot exceed 100', 400);
    }
    if (type === 'fixed' && value > subtotal) {
        throw new InvoicesServiceError('VALIDATION', 'Discount cannot exceed subtotal', 400);
    }
}

function itemSubtotal(items = []) {
    return items.reduce(
        (sum, item) => sum + asNumber(item.quantity, 1) * asNumber(item.unit_price, 0),
        0
    );
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
async function getInvoice(companyId, id, client = null) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }
    const items = await invoicesQueries.getInvoiceItems(companyId, id, client);
    return { ...invoice, items };
}

/** Global public-code resolver; routes establish tenant ownership before hydration. */
async function getInvoiceByCode(publicCode, { client = null } = {}) {
    return invoicesQueries.getInvoiceByCode(publicCode, client);
}

async function validateLinkedEntities(companyId, data = {}, client = null) {
    if (data.contact_id != null) {
        const contact = await estimatesQueries.getContactContext(companyId, data.contact_id, client);
        if (!contact) throw new InvoicesServiceError('NOT_FOUND', 'Contact not found', 404);
    }
    if (data.lead_id != null) {
        const lead = await estimatesQueries.getLeadContext(companyId, data.lead_id, client);
        if (!lead) throw new InvoicesServiceError('NOT_FOUND', 'Lead not found', 404);
    }
    if (data.job_id != null) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id, client);
        if (!job) throw new InvoicesServiceError('NOT_FOUND', 'Job not found', 404);
    }
    if (data.estimate_id != null) {
        const estimate = await estimatesQueries.getEstimateById(
            companyId,
            data.estimate_id,
            client
        );
        if (!estimate) throw new InvoicesServiceError('NOT_FOUND', 'Estimate not found', 404);
    }
}

/**
 * Create a new invoice with optional line items.
 * Resolves contact_id from the linked job/lead/estimate when not explicitly provided.
 */
async function createInvoice(companyId, userId, data, client = null, activityActor = null) {
    const resolved = { ...data };
    resolved.order_list = normalizeOrderList(data.order_list ?? []);
    validateDiscount(data, itemSubtotal(Array.isArray(data.items) ? data.items : []));
    if (data.discount_type !== undefined) {
        resolved.discount_type = data.discount_type || null;
        resolved.discount_amount = 0;
    }
    if (data.discount_value !== undefined) {
        resolved.discount_value = asNumber(data.discount_value, 0);
    }
    await validateLinkedEntities(companyId, resolved, client);

    if (!resolved.contact_id) {
        // Try the linked estimate first (most precise — invoice was converted from one).
        if (resolved.estimate_id) {
            try {
                const est = await estimatesQueries.getEstimateById(
                    companyId,
                    resolved.estimate_id,
                    client
                );
                if (est?.contact_id) resolved.contact_id = est.contact_id;
                if (!resolved.lead_id && est?.lead_id) resolved.lead_id = est.lead_id;
                if (!resolved.job_id && est?.job_id) resolved.job_id = est.job_id;
            } catch { /* fall through */ }
        }

        // Then try the linked job's contact.
        if (!resolved.contact_id && resolved.job_id) {
            try {
                const job = await estimatesQueries.getJobContext(
                    companyId,
                    resolved.job_id,
                    client
                );
                if (job?.contact_id) resolved.contact_id = job.contact_id;
                if (!resolved.lead_id && job?.lead_id) resolved.lead_id = job.lead_id;
            } catch { /* fall through */ }
        }

        // Finally try the linked lead's contact.
        if (!resolved.contact_id && resolved.lead_id) {
            try {
                const lead = await estimatesQueries.getLeadContext(
                    companyId,
                    resolved.lead_id,
                    client
                );
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
            const descriptor = await documentTemplatesService.resolveTemplate(
                companyId,
                'invoice',
                client
            );
            const days = Number(descriptor?.invoice_settings?.default_due_days);
            const effectiveDays = Number.isFinite(days) && days >= 0 ? days : 14;
            const d = new Date();
            d.setDate(d.getDate() + effectiveDays);
            resolved.due_date = d.toISOString().slice(0, 10);
        } catch { /* swallow — fall back to NULL due_date */ }
    }

    // Generate a per-company parent number when the caller did not supply one.
    if (!resolved.invoice_number) {
        try {
            let numberContext = {};
            if (resolved.job_id) {
                const job = await estimatesQueries.getJobContext(
                    companyId,
                    resolved.job_id,
                    client
                );
                numberContext = {
                    jobSeq: job?.job_seq || null,
                    legacyLeadSerialId: job?.lead_serial_id || job?.lead_id || null,
                    legacyJobId: job?.id || resolved.job_id,
                    jobId: job?.id || resolved.job_id,
                };
            } else if (resolved.lead_id) {
                const lead = await estimatesQueries.getLeadContext(
                    companyId,
                    resolved.lead_id,
                    client
                );
                numberContext = {
                    leadSeq: lead?.lead_seq || null,
                    legacyLeadSerialId: lead?.serial_id || lead?.id || null,
                    leadId: lead?.id || resolved.lead_id,
                };
            }
            const sequence = await invoicesQueries.nextInvoiceSequence(
                companyId,
                numberContext,
                client
            );
            resolved.invoice_number = invoicesQueries.buildInvoiceNumber({
                ...numberContext,
                sequence,
            });
        } catch { /* fall through — let createInvoice pick the legacy date-based number */ }
    }

    const invoice = await invoicesQueries.createInvoice(companyId, {
        ...resolved,
        created_by: userId,
    }, client);

    // Add items if provided
    if (Array.isArray(data.items)) {
        for (const item of data.items) {
            await invoicesQueries.addInvoiceItem(companyId, invoice.id, item, client);
        }
    }
    if (
        Array.isArray(data.items)
        || data.discount_type !== undefined
        || data.discount_value !== undefined
    ) {
        await invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id, client);
    }

    // Log creation event
    await invoicesQueries.createEvent(
        companyId,
        invoice.id,
        'created',
        'user',
        userId,
        null,
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.created',
            entity: invoice,
            actor: activityActor,
        }, { client });
    }

    // Return full invoice with items
    return getInvoice(companyId, invoice.id, client);
}

/**
 * Update an invoice. If status is not 'draft', create a revision snapshot first.
 */
async function updateInvoice(companyId, userId, id, data, client = null, activityActor = null) {
    const existing = await invoicesQueries.getInvoiceById(companyId, id, client);
    if (!existing) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }
    const attemptedWorkflowField = Object.keys(data || {})
        .find(field => WORKFLOW_CONTROLLED_UPDATE_FIELDS.has(field));
    if (attemptedWorkflowField) {
        throw new InvoicesServiceError(
            'WORKFLOW_FIELD_READ_ONLY',
            `Invoice field '${attemptedWorkflowField}' can only be changed by its dedicated workflow.`,
            400
        );
    }
    await validateLinkedEntities(companyId, data, client);
    const discountFieldsChanged = data.discount_type !== undefined
        || data.discount_value !== undefined;
    if (discountFieldsChanged) {
        const discountItems = Array.isArray(data.items)
            ? data.items
            : await invoicesQueries.getInvoiceItems(companyId, id, client);
        validateDiscount(data, itemSubtotal(discountItems));
    }
    const updateData = {
        ...data,
        discount_type: data.discount_type !== undefined
            ? data.discount_type || null
            : undefined,
        discount_value: data.discount_value !== undefined
            ? asNumber(data.discount_value, 0)
            : undefined,
        discount_amount: data.discount_type !== undefined ? 0 : data.discount_amount,
        order_list: data.order_list !== undefined
            ? normalizeOrderList(data.order_list)
            : undefined,
    };

    // Create revision snapshot if not draft
    if (existing.status !== 'draft') {
        const items = await invoicesQueries.getInvoiceItems(companyId, id, client);
        const snapshot = { ...existing, items };
        await invoicesQueries.createRevision(companyId, id, snapshot, userId, client);
    }

    // `updateInvoice`'s allowlist ignores `items`, so passing the full `data`
    // (scalars + items) is safe — only whitelisted scalar columns are written.
    const updated = await invoicesQueries.updateInvoice(id, companyId, updateData, client);
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
        await invoicesQueries.replaceInvoiceItems(companyId, id, data.items, client);
    }

    // Recalculate totals when items were reconciled OR a totals-affecting scalar changed.
    const TOTALS_AFFECTING = new Set([
        'tax_rate',
        'discount_type',
        'discount_value',
        'discount_amount',
    ]);
    const scalarTotalsChanged = Object.keys(data).some(k => TOTALS_AFFECTING.has(k));
    if (itemsReconciled || scalarTotalsChanged) {
        await invoicesQueries.recalculateInvoiceTotals(companyId, id, client);
    }

    // Log update event
    await invoicesQueries.createEvent(
        companyId,
        id,
        'updated',
        'user',
        userId,
        { fields: Object.keys(data) },
        client
    );
    if (activityActor) {
        const current = await invoicesQueries.getInvoiceById(companyId, id, client);
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.updated',
            entity: current,
            actor: activityActor,
        }, { client });
    }

    return getInvoice(companyId, id, client);
}

/** Delete a draft invoice. Issued invoices must use the explicit void action. */
async function deleteInvoice(companyId, id, userId, client = null, activityActor = null) {
    const locked = await invoicesQueries.lockInvoiceById(companyId, id, client);
    if (!locked) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    if (locked.status !== 'draft') {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            `Only draft invoices can be deleted; '${locked.status}' invoices must be voided.`,
            409
        );
    }

    const existing = await invoicesQueries.getInvoiceById(companyId, id, client);
    const deleted = await invoicesQueries.deleteInvoice(id, companyId, client);
    if (!deleted) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            'Invoice status changed before the draft delete completed.',
            409
        );
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.deleted',
            entity: existing,
            actor: activityActor,
        }, { client });
    }
    return { deleted: true };
}

async function previewInvoiceRemoval(companyId, id, client = null) {
    return invoiceRemovalService.previewInvoiceRemoval(companyId, id, client);
}

async function removeInvoice(
    companyId,
    id,
    userId,
    data,
    client = null,
    activityActor = null
) {
    return invoiceRemovalService.removeInvoice(
        companyId,
        id,
        userId,
        data,
        client,
        activityActor
    );
}

// =============================================================================
// Line items
// =============================================================================

/**
 * Add a line item to an invoice.
 */
async function addItem(companyId, invoiceId, userId, item, client = null) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const newItem = await invoicesQueries.addInvoiceItem(
        companyId,
        invoiceId,
        item,
        client
    );
    await invoicesQueries.recalculateInvoiceTotals(companyId, invoiceId, client);

    await invoicesQueries.createEvent(
        companyId,
        invoiceId,
        'item_added',
        'user',
        userId,
        {
            item_id: newItem.id,
            name: item.name,
        },
        client
    );

    return newItem;
}

/**
 * PRICEBOOK-001: bulk add (Price Book group expanded into items).
 * ONE recalc + ONE event vs N round-trips.
 */
async function addItems(companyId, invoiceId, userId, items, client = null) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { added: 0, items: [] };

    const created = [];
    for (const item of list) {
        created.push(await invoicesQueries.addInvoiceItem(
            companyId,
            invoiceId,
            item,
            client
        ));
    }
    await invoicesQueries.recalculateInvoiceTotals(companyId, invoiceId, client);
    await invoicesQueries.createEvent(
        companyId,
        invoiceId,
        'items_added',
        'user',
        userId,
        { count: created.length },
        client
    );

    return { added: created.length, items: created };
}

/**
 * Update a line item.
 */
async function updateItem(companyId, invoiceId, userId, itemId, data, client = null) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const updated = await invoicesQueries.updateInvoiceItem(
        companyId,
        invoiceId,
        itemId,
        data,
        client
    );
    if (!updated) {
        throw new InvoicesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await invoicesQueries.recalculateInvoiceTotals(companyId, invoiceId, client);

    await invoicesQueries.createEvent(
        companyId,
        invoiceId,
        'item_updated',
        'user',
        userId,
        {
            item_id: itemId,
            fields: Object.keys(data),
        },
        client
    );

    return updated;
}

/**
 * Remove a line item.
 */
async function removeItem(companyId, invoiceId, userId, itemId, client = null) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const deleted = await invoicesQueries.deleteInvoiceItem(
        companyId,
        invoiceId,
        itemId,
        client
    );
    if (!deleted) {
        throw new InvoicesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await invoicesQueries.recalculateInvoiceTotals(companyId, invoiceId, client);

    await invoicesQueries.createEvent(
        companyId,
        invoiceId,
        'item_removed',
        'user',
        userId,
        { item_id: itemId },
        client
    );

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
async function sendInvoice(
    companyId,
    userId,
    id,
    { channel, recipient, message, includePaymentLink, userEmail, noteActor } = {},
    client = null,
    activityActor = null
) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id, client);
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
    // "INVOICE L-1439-1" → "L-1439-1" wherever we say the word "Invoice" ourselves.
    const shortNumber = shortDocNumber(number) || number;
    let noteRecipient = to;

    try {
        // Branded pay page link, derived from the token ensurePublicLink mints
        // (ensurePublicLink itself returns the /i/<token> PDF redirect — we want /pay).
        // Every resend rotates the bearer credential. A failed transactional
        // dispatch rolls the rotation back with the rest of the send.
        const { token } = await ensurePublicLink(
            companyId,
            id,
            client,
            activityActor,
            { rotate: true }
        );
        const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
        const payPath = `/pay/${token}`;
        const payUrl = base ? `${base}${payPath}` : payPath;
        const link = includePaymentLink === false ? '' : payUrl;

        if (normalizedChannel === 'email') {
        // Pre-check: a mailbox that is missing / disconnected / reconnect_required
        // must surface as 409, never reach Gmail, and never flip status.
        const emailMailboxService = require('./emailMailboxService');
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox || mailbox.status !== 'connected') {
            throw new InvoicesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
        }

        let companyName = '';
        let senderName = '';
        let companyTimeZone = '';
        try {
            const companyQueries = require('../db/companyQueries');
            const company = await companyQueries.getCompanyById(companyId);
            companyName = asText(company?.name);
            companyTimeZone = asText(company?.timezone);
            // Preferred outbound display name (stored in the settings bag); falls back
            // to the company name below.
            senderName = asText(company?.settings?.email_sender_name);
        } catch { /* subject falls back to no company suffix */ }
        const subject = companyName ? `Your invoice from ${companyName}` : 'Your invoice';

        const { invoice: documentInvoice, buffer } = await generatePdf(companyId, id, client);
        const safeFile = String(shortNumber).replace(/[^a-z0-9_-]+/gi, '_');

        const emailService = require('./emailService');
        try {
            await emailService.sendEmail(companyId, {
                to,
                subject,
                body: buildInvoiceEmailBody({
                    message,
                    paymentLink: payUrl,
                    includePaymentLink: includePaymentLink !== false,
                    invoice: documentInvoice,
                    companyName,
                    timeZone: companyTimeZone,
                }),
                files: [{
                    mimetype: 'application/pdf',
                    originalname: `Invoice-${safeFile}.pdf`,
                    buffer,
                }],
                userId,
                userEmail,
                fromName: senderName || companyName || undefined,
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
            await conversationsService.sendMessage(conv.id, { companyId, body: buildSmsBody(message, link) });
        }
    } catch (err) {
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.send_failed',
                entity: invoice,
                actor: activityActor,
                summary: { channel: normalizedChannel },
            });
        }
        await eventBus.emit(companyId, 'invoice.send_failed', {
            invoice_id: id,
            record_refs: [{ type: 'invoice', id }],
        }, {
            actorType: activityActor?.type || 'system',
            actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
            aggregateType: 'invoice',
            aggregateId: id,
        });
        throw err;
    }

    // Dispatch resolved → NOW flip status and record the send (never before).
    let updated;
    if (client) {
        updated = await invoicesQueries.updateInvoiceStatus(
            id,
            companyId,
            'sent',
            'sent_at',
            client
        );
        await invoicesQueries.createEvent(companyId, id, 'sent', 'user', userId, {
            channel: normalizedChannel,
            recipient: to,
            message: message || null,
        }, client);
    } else {
        updated = await invoicesQueries.updateInvoiceStatus(id, companyId, 'sent', 'sent_at');
        await invoicesQueries.createEvent(companyId, id, 'sent', 'user', userId, {
            channel: normalizedChannel,
            recipient: to,
            message: message || null,
        });
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.sent',
            entity: updated,
            actor: activityActor,
            summary: { channel: normalizedChannel, status: 'sent' },
        }, { client });
    }
    await eventBus.emit(companyId, 'invoice.sent', {
        invoice_id: updated.id,
        invoice_number: updated.invoice_number || null,
        public_code: updated.public_code || null,
        job_id: updated.job_id || null,
        total: Number(updated.total),
        record_refs: [{ type: 'invoice', id: updated.id }],
    }, {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'invoice',
        aggregateId: updated.id,
        client,
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
async function voidInvoice(
    companyId,
    id,
    userId,
    client = null,
    activityActor = null
) {
    const locked = await invoicesQueries.lockInvoiceById(companyId, id, client);
    if (!locked) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    if (locked.status === 'draft' || ['void', 'refunded'].includes(locked.status)) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            locked.status === 'draft'
                ? 'Draft invoices must be deleted, not voided.'
                : `Cannot void invoice with status '${locked.status}'.`,
            409
        );
    }

    const updated = await invoicesQueries.voidIssuedInvoice(id, companyId, client);
    if (!updated) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            'Invoice status changed before the void completed.',
            409
        );
    }

    await invoicesQueries.createEvent(
        companyId,
        id,
        'voided',
        'user',
        userId,
        null,
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.voided',
            entity: updated,
            actor: activityActor,
            summary: { status: 'void' },
        }, { client });
    }

    return updated;
}

/**
 * Void a manual/offline payment while preserving its canonical ledger row.
 */
async function voidPayment(
    companyId,
    userId,
    invoiceId,
    paymentId,
    client = null,
    activityActor = null,
    reason = null
) {
    return paymentsService.voidInvoicePayment(
        companyId,
        userId,
        invoiceId,
        paymentId,
        client,
        activityActor,
        reason
    );
}

/**
 * Record an offline payment from an invoice surface. The canonical payment
 * service owns the ledger write; this adapter owns invoice eligibility and the
 * balance ceiling so a client cannot over-collect or create an orphan payment.
 */
async function recordOfflinePayment(
    companyId,
    userId,
    invoiceId,
    data = {},
    client = null,
    activityActor = null
) {
    // Serialize invoice-level offline collections inside the route transaction.
    // Without the row lock, two simultaneous cash/check requests could both
    // validate against the same pre-payment balance and over-collect it.
    if (client?.query) {
        const { rows } = await client.query(
            `SELECT id
             FROM invoices
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [invoiceId, companyId]
        );
        if (!rows[0]) {
            throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
        }
    }
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }
    if (!['sent', 'viewed', 'partial', 'overdue'].includes(invoice.status)) {
        throw new InvoicesServiceError(
            'INVALID_STATUS',
            `Cannot collect on invoice with status '${invoice.status}'.`,
            409
        );
    }
    if (invoice.job_id == null) {
        throw new InvoicesServiceError(
            'JOB_REQUIRED',
            'This invoice must be linked to a job before it can accept payment.',
            409
        );
    }

    const numericAmount = Number(data.amount);
    const amountCents = Number.isFinite(numericAmount)
        ? Math.round(numericAmount * 100)
        : NaN;
    const balanceCents = Math.round(Number(invoice.balance_due || 0) * 100);
    const hasSubCentPrecision = Number.isFinite(numericAmount)
        && Math.abs(numericAmount - (amountCents / 100)) > 1e-8;
    if (
        !Number.isInteger(amountCents)
        || amountCents <= 0
        || hasSubCentPrecision
        || amountCents > balanceCents
    ) {
        throw new InvoicesServiceError(
            'INVALID_AMOUNT',
            'Amount must be greater than 0 and no more than the invoice balance.',
            400
        );
    }
    if (!['cash', 'check'].includes(data.payment_method)) {
        throw new InvoicesServiceError(
            'VALIDATION',
            'payment_method must be one of: cash, check',
            400
        );
    }

    return paymentsService.recordManualPayment(
        companyId,
        userId,
        {
            invoice_id: invoice.id,
            job_id: invoice.job_id,
            contact_id: invoice.contact_id || null,
            amount: amountCents / 100,
            payment_method: data.payment_method,
            reference_number: data.reference_number,
            memo: data.memo,
            processed_at: data.payment_date || data.processed_at || undefined,
        },
        client,
        activityActor
    );
}

/**
 * Sync line items from an estimate to this invoice.
 */
async function syncItemsFromEstimate(
    companyId,
    userId,
    invoiceId,
    estimateId,
    client = null,
    activityActor = null
) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId, client);
    if (!estimate) {
        throw new InvoicesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    }
    const estimateItems = await estimatesQueries.getEstimateItems(companyId, estimateId, client);
    if (!estimateItems || estimateItems.length === 0) {
        throw new InvoicesServiceError('VALIDATION', `No items found on estimate ${estimateId}`, 400);
    }

    for (const item of estimateItems) {
        await invoicesQueries.addInvoiceItem(companyId, invoiceId, {
            name: item.description || '',
            description: item.description || '',
            quantity: item.quantity,
            unit_price: item.unit_price,
            unit: item.unit,
            sort_order: item.sort_order,
        }, client);
    }

    await invoicesQueries.recalculateInvoiceTotals(companyId, invoiceId, client);

    await invoicesQueries.createEvent(companyId, invoiceId, 'items_synced_from_estimate', 'user', userId, {
        estimate_id: estimateId,
        items_count: estimateItems.length,
    }, client);
    if (activityActor) {
        const current = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.items_synced',
            entity: current,
            actor: activityActor,
            summary: {
                estimate_id: estimateId,
                count: estimateItems.length,
            },
        }, { client });
    }

    return getInvoice(companyId, invoiceId, client);
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
async function generatePdf(companyId, id, client = null) {
    const invoice = await getInvoice(companyId, id, client);
    const customerInvoice = stripInternalOrderList(invoice);
    const documentTemplatesService = require('./documentTemplatesService');
    const rendererRegistry = require('./documentTemplates');
    const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'invoice', client);
    const adapter = rendererRegistry.get('invoice');
    if (!adapter) {
        throw new InvoicesServiceError('INTERNAL', 'Invoice renderer adapter not registered', 500);
    }
    const buffer = await adapter.render(customerInvoice, descriptor);
    return { invoice: customerInvoice, buffer };
}

/**
 * Get canonical ledger payments for an invoice.
 */
async function getPayments(companyId, id) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    return paymentsService.getTransactionsForInvoice(companyId, id);
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    listInvoices,
    getInvoice,
    getInvoiceByCode,
    createInvoice,
    updateInvoice,
    deleteInvoice,
    previewInvoiceRemoval,
    removeInvoice,
    addItem,
    addItems,
    updateItem,
    removeItem,
    sendInvoice,
    voidInvoice,
    voidPayment,
    recordOfflinePayment,
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
 * Return a public link for the invoice. Plain lookups reuse a live token; sends
 * rotate it so previously forwarded bearer URLs stop resolving.
 */
async function ensurePublicLink(
    companyId,
    id,
    client = null,
    activityActor = null,
    { rotate = false } = {}
) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id, client);
    if (!invoice) throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);

    let token = invoice.public_token;
    const expiresAt = invoice.public_token_expires_at
        ? new Date(invoice.public_token_expires_at).getTime()
        : NaN;
    const hasLiveToken = !!token && Number.isFinite(expiresAt) && expiresAt > Date.now();
    if (rotate || !hasLiveToken) {
        // 8 bytes of entropy → 11 url-safe chars. 2^64 keyspace is plenty for unguessability.
        token = crypto.randomBytes(8).toString('base64url');
        if (client) {
            await invoicesQueries.setPublicToken(
                invoice.id,
                companyId,
                token,
                client,
                PUBLIC_LINK_LIFETIME_MONTHS
            );
        } else {
            await invoicesQueries.setPublicToken(
                invoice.id,
                companyId,
                token,
                null,
                PUBLIC_LINK_LIFETIME_MONTHS
            );
        }
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.link_created',
                entity: invoice,
                actor: activityActor,
            }, { client });
        }
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
async function generatePdfByPublicToken(publicToken, { recordView = false } = {}) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(publicToken);
    if (!invoice) throw new InvoicesServiceError('NOT_FOUND', 'Invoice not found', 404);
    if (recordView) {
        const { clientActor } = require('./financialActivityService');
        await logFinancialActivity({
            companyId: invoice.company_id,
            entityType: 'invoice',
            action: 'invoice.viewed',
            entity: invoice,
            actor: clientActor('Client', 'portal'),
        });
    }
    const items = await invoicesQueries.getInvoiceItems(invoice.company_id, invoice.id);
    const fullInvoice = stripInternalOrderList({ ...invoice, items });

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
