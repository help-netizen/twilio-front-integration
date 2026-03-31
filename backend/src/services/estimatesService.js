/**
 * Estimates Service
 * PF002 Estimates MVP — Sprint 3
 *
 * Business logic for estimates, line items, revisions, and events.
 */

const estimatesQueries = require('../db/estimatesQueries');

// =============================================================================
// Error class
// =============================================================================

class EstimatesServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'EstimatesServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// =============================================================================
// Estimate CRUD
// =============================================================================

/**
 * List estimates with filters.
 */
async function listEstimates(companyId, filters = {}) {
    return estimatesQueries.listEstimates(companyId, filters);
}

/**
 * Get a single estimate with its items.
 */
async function getEstimate(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    const items = await estimatesQueries.getEstimateItems(id);
    return { ...estimate, items };
}

/**
 * Create a new estimate with optional line items.
 */
async function createEstimate(companyId, userId, data) {
    if (!data.contact_id) {
        throw new EstimatesServiceError('VALIDATION', 'contact_id is required', 400);
    }
    if (!data.lead_id && !data.job_id) {
        throw new EstimatesServiceError('VALIDATION', 'At least one of lead_id or job_id is required', 400);
    }

    const estimate = await estimatesQueries.createEstimate(companyId, {
        ...data,
        created_by: userId,
    });

    // Add items if provided
    if (data.items && Array.isArray(data.items)) {
        for (const item of data.items) {
            await estimatesQueries.addEstimateItem(estimate.id, item);
        }
        await estimatesQueries.recalculateEstimateTotals(estimate.id);
    }

    // Log creation event
    await estimatesQueries.createEvent(estimate.id, 'created', 'user', userId, null);

    // Return full estimate with items
    return getEstimate(companyId, estimate.id);
}

/**
 * Update an estimate. If status is not 'draft', create a revision snapshot first.
 */
async function updateEstimate(companyId, userId, id, data) {
    const existing = await estimatesQueries.getEstimateById(companyId, id);
    if (!existing) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    // Create revision snapshot if not draft
    if (existing.status !== 'draft') {
        const items = await estimatesQueries.getEstimateItems(id);
        const snapshot = { ...existing, items };
        await estimatesQueries.createRevision(id, snapshot, userId);
    }

    const updated = await estimatesQueries.updateEstimate(id, companyId, data);
    if (!updated) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    // Log update event
    await estimatesQueries.createEvent(id, 'updated', 'user', userId, {
        fields: Object.keys(data),
    });

    return getEstimate(companyId, id);
}

/**
 * Delete an estimate. Soft-delete (archive) if not draft; hard delete if draft.
 */
async function deleteEstimate(companyId, id) {
    const existing = await estimatesQueries.getEstimateById(companyId, id);
    if (!existing) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    if (existing.status === 'draft') {
        await estimatesQueries.deleteEstimate(id, companyId);
        return { deleted: true };
    } else {
        const updated = await estimatesQueries.updateEstimateStatus(id, companyId, 'archived', null);
        return { archived: true, estimate: updated };
    }
}

// =============================================================================
// Line items
// =============================================================================

/**
 * Add a line item to an estimate.
 */
async function addItem(companyId, estimateId, userId, item) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    }

    const newItem = await estimatesQueries.addEstimateItem(estimateId, item);
    await estimatesQueries.recalculateEstimateTotals(estimateId);

    await estimatesQueries.createEvent(estimateId, 'item_added', 'user', userId, {
        item_id: newItem.id,
        description: item.description,
    });

    return newItem;
}

/**
 * Update a line item.
 */
async function updateItem(companyId, estimateId, userId, itemId, data) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    }

    const updated = await estimatesQueries.updateEstimateItem(itemId, data);
    if (!updated) {
        throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await estimatesQueries.recalculateEstimateTotals(estimateId);

    await estimatesQueries.createEvent(estimateId, 'item_updated', 'user', userId, {
        item_id: itemId,
        fields: Object.keys(data),
    });

    return updated;
}

/**
 * Remove a line item.
 */
async function removeItem(companyId, estimateId, userId, itemId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    }

    const deleted = await estimatesQueries.deleteEstimateItem(itemId);
    if (!deleted) {
        throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await estimatesQueries.recalculateEstimateTotals(estimateId);

    await estimatesQueries.createEvent(estimateId, 'item_removed', 'user', userId, {
        item_id: itemId,
    });

    return { deleted: true };
}

// =============================================================================
// Estimate actions
// =============================================================================

/**
 * Send an estimate to a client (MVP: record the delivery, no actual sending).
 */
async function sendEstimate(companyId, userId, id, { channel, recipient, message }) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    // Update status to sent
    const updated = await estimatesQueries.updateEstimateStatus(id, companyId, 'sent', 'sent_at');

    // Log event
    await estimatesQueries.createEvent(id, 'sent', 'user', userId, {
        channel: channel || 'email',
        recipient: recipient || null,
        message: message || null,
    });

    return updated;
}

/**
 * Approve (accept) an estimate.
 */
async function approveEstimate(companyId, id, actorType, actorId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    if (!['sent', 'viewed'].includes(estimate.status)) {
        throw new EstimatesServiceError(
            'INVALID_STATUS',
            `Cannot approve estimate with status '${estimate.status}'. Must be 'sent' or 'viewed'.`,
            400
        );
    }

    const updated = await estimatesQueries.updateEstimateStatus(id, companyId, 'accepted', 'accepted_at');

    await estimatesQueries.createEvent(id, 'accepted', actorType || 'user', actorId, null);

    return updated;
}

/**
 * Decline an estimate.
 */
async function declineEstimate(companyId, id, actorType, actorId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    if (!['sent', 'viewed'].includes(estimate.status)) {
        throw new EstimatesServiceError(
            'INVALID_STATUS',
            `Cannot decline estimate with status '${estimate.status}'. Must be 'sent' or 'viewed'.`,
            400
        );
    }

    const updated = await estimatesQueries.updateEstimateStatus(id, companyId, 'declined', 'declined_at');

    await estimatesQueries.createEvent(id, 'declined', actorType || 'user', actorId, null);

    return updated;
}

/**
 * Link an estimate to a job.
 */
async function linkJob(companyId, id, jobId) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    const updated = await estimatesQueries.updateEstimate(id, companyId, { job_id: jobId });

    await estimatesQueries.createEvent(id, 'job_linked', 'system', null, { job_id: jobId });

    return updated;
}

/**
 * Convert an accepted estimate to a new invoice, copying all line items.
 */
async function convertToInvoice(companyId, userId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    if (estimate.status !== 'accepted') {
        throw new EstimatesServiceError(
            'INVALID_STATUS',
            `Estimate must be accepted before converting (current status: '${estimate.status}')`,
            400
        );
    }

    if (estimate.invoice_id) {
        throw new EstimatesServiceError(
            'ALREADY_CONVERTED',
            'Invoice already exists for this estimate',
            409
        );
    }

    const invoicesQueries = require('../db/invoicesQueries');

    const invoice = await invoicesQueries.createInvoice(companyId, {
        contact_id: estimate.contact_id,
        lead_id: estimate.lead_id,
        job_id: estimate.job_id,
        estimate_id: estimate.id,
        title: estimate.title,
        notes: estimate.notes,
        internal_note: estimate.internal_note,
        tax_rate: estimate.tax_rate,
        discount_amount: estimate.discount_amount,
        currency: estimate.currency,
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

/**
 * Copy estimate items to a new invoice (Sprint 4 — alias kept for compat).
 */
async function copyToInvoice(companyId, userId, id) {
    return convertToInvoice(companyId, userId, id);
}

// =============================================================================
// History
// =============================================================================

/**
 * Get revisions for an estimate.
 */
async function getRevisions(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    return estimatesQueries.listRevisions(id);
}

/**
 * Get events for an estimate.
 */
async function getEvents(companyId, id) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    return estimatesQueries.listEvents(id);
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    listEstimates,
    getEstimate,
    createEstimate,
    updateEstimate,
    deleteEstimate,
    addItem,
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
    EstimatesServiceError,
};
