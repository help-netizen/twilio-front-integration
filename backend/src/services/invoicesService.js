/**
 * Invoices Service
 * PF003 Invoices MVP — Sprint 4
 *
 * Business logic for invoices, line items, revisions, events, and payments.
 */

const invoicesQueries = require('../db/invoicesQueries');
const estimatesQueries = require('../db/estimatesQueries');

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
 */
async function createInvoice(companyId, userId, data) {
    if (!data.contact_id) {
        throw new InvoicesServiceError('VALIDATION', 'contact_id is required', 400);
    }

    const invoice = await invoicesQueries.createInvoice(companyId, {
        ...data,
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

    const updated = await invoicesQueries.updateInvoice(id, companyId, data);
    if (!updated) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
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
 * Send an invoice to a client (MVP: record the delivery, no actual sending).
 */
async function sendInvoice(companyId, userId, id, { channel, recipient, message }) {
    const invoice = await invoicesQueries.getInvoiceById(companyId, id);
    if (!invoice) {
        throw new InvoicesServiceError('NOT_FOUND', `Invoice ${id} not found`, 404);
    }

    // Update status to sent
    const updated = await invoicesQueries.updateInvoiceStatus(id, companyId, 'sent', 'sent_at');

    // Log event
    await invoicesQueries.createEvent(id, 'sent', 'user', userId, {
        channel: channel || 'email',
        recipient: recipient || null,
        message: message || null,
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
    updateItem,
    removeItem,
    sendInvoice,
    voidInvoice,
    recordPayment,
    syncItemsFromEstimate,
    getRevisions,
    getEvents,
    getPayments,
    InvoicesServiceError,
};
