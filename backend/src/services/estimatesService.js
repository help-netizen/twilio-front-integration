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
 * Copy estimate items to a new invoice (Sprint 4 — not yet implemented).
 */
async function copyToInvoice(companyId, userId, id) {
    throw new EstimatesServiceError('NOT_IMPLEMENTED', 'Copy to invoice is planned for Sprint 4', 501);
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
    copyToInvoice,
    getRevisions,
    getEvents,
    EstimatesServiceError,
};
