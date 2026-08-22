/**
 * Estimates Service
 * PF002-R2 Estimates Composer Refresh
 */

const crypto = require('crypto');
const db = require('../db/connection');
const estimatesQueries = require('../db/estimatesQueries');
const estimateItemPresetsQueries = require('../db/estimateItemPresetsQueries');
const tasksQueries = require('../db/tasksQueries');
const { renderEstimatePdf } = require('./estimatePdfService');
const { toE164 } = require('../utils/phoneUtils');
const { shortDocNumber } = require('../utils/docNumber');
const {
    dateInTZ,
    normalizeCompanyTimezone,
    todayInTZ,
} = require('../utils/companyTime');
const { recordDocumentSendNote } = require('./documentSendNoteService');
const { logFinancialActivity } = require('./financialActivityService');
const eventBus = require('./eventBus');
const { buildEstimateEmailBody } = require('./documentEmailBody');
const {
    normalizeOrderList,
    stripInternalOrderList,
} = require('../utils/orderList');

const PUBLIC_DECLINE_REASONS = new Set(['price', 'chose_other', 'not_now', 'other']);
const MAX_PUBLIC_DECLINE_COMMENT_LENGTH = 1000;
const DECLINE_TASK_DUE_HOUR = 17;
// Conversion Undo is an immediate "oops" recovery, not an invoice reversal.
// Five minutes covers a missed toast/retry without reopening settled workflows.
const CONVERSION_UNDO_WINDOW_SECONDS = 5 * 60;
const CONVERTIBLE_STATUSES = new Set(['draft', 'sent', 'viewed', 'approved']);

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

function emitEstimateEvent(companyId, eventType, estimateId, activityActor, client = null) {
    return eventBus.emit(companyId, eventType, {
        estimate_id: estimateId,
        record_refs: [{ type: 'estimate', id: estimateId }],
    }, {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'estimate',
        aggregateId: estimateId,
        client,
    });
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

function normalizeItems(items, { optional = false } = {}) {
    if (items === undefined && optional) return null;
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

function invalidTransition() {
    return new EstimatesServiceError(
        'INVALID_TRANSITION',
        'This estimate action is no longer available.',
        409
    );
}

function assertStatusIn(estimate, allowedStatuses) {
    if (!allowedStatuses.includes(estimate.status)) throw invalidTransition();
}

function timestampValue(value) {
    if (!value) return null;
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function conversionUndoConflict(code, message) {
    return new EstimatesServiceError(code, message, 409);
}

function normalizeEvidence(evidence = {}) {
    const ipAddress = asText(evidence.ip_address).slice(0, 64) || null;
    const userAgent = asText(evidence.user_agent).slice(0, 512) || null;
    return {
        ...(ipAddress ? { ip_address: ipAddress } : {}),
        ...(userAgent ? { user_agent: userAgent } : {}),
    };
}

function normalizePublicDeclineInput(data = {}) {
    let reason = null;
    if (data.reason !== undefined && data.reason !== null) {
        if (typeof data.reason !== 'string') {
            throw new EstimatesServiceError('VALIDATION', 'Decline reason is invalid.', 400);
        }
        reason = data.reason.trim();
        if (reason && !PUBLIC_DECLINE_REASONS.has(reason)) {
            throw new EstimatesServiceError('VALIDATION', 'Decline reason is invalid.', 400);
        }
        if (!reason) reason = null;
    }

    if (data.comment !== undefined && data.comment !== null && typeof data.comment !== 'string') {
        throw new EstimatesServiceError('VALIDATION', 'Decline comment must be text.', 400);
    }
    const comment = typeof data.comment === 'string'
        ? data.comment.trim().slice(0, MAX_PUBLIC_DECLINE_COMMENT_LENGTH)
        : '';

    return { reason, comment: comment || null };
}

function declineTaskDescription(reason, comment) {
    const lines = [];
    if (reason) lines.push(`Reason: ${reason}`);
    if (comment) lines.push(`Customer comment:\n${comment}`);
    return lines.length > 0
        ? lines.join('\n\n')
        : 'Customer did not provide a reason or comment.';
}

async function createDeclineFollowupTask(companyId, estimate, reason, comment, client = null) {
    let savepointStarted = false;
    try {
        if (client?.query) {
            await client.query('SAVEPOINT estimate_decline_task');
            savepointStarted = true;
        }

        const context = await estimatesQueries.getDeclineTaskContext(
            companyId,
            estimate.id,
            client
        );
        if (!context) throw new Error('Decline task context was not found');

        const timezone = normalizeCompanyTimezone(context.timezone);
        const [year, month, day] = todayInTZ(timezone).split('-').map(Number);
        const dueAt = dateInTZ(
            year,
            month,
            day,
            DECLINE_TASK_DUE_HOUR,
            0,
            timezone
        ).toISOString();
        const number = shortDocNumber(estimate.estimate_number) || estimate.id;

        const task = await tasksQueries.createTask(companyId, {
            parentType: 'estimate',
            parentId: estimate.id,
            parentIdIsNumeric: true,
            title: `Estimate #${number} declined — win it back`,
            description: declineTaskDescription(reason, comment),
            owner_user_id: context.owner_user_id || null,
            author_user_id: null,
            due_at: dueAt,
            created_by: 'system',
        }, client);

        if (savepointStarted) await client.query('RELEASE SAVEPOINT estimate_decline_task');
        return task;
    } catch (error) {
        if (savepointStarted) {
            try {
                await client.query('ROLLBACK TO SAVEPOINT estimate_decline_task');
            } catch (rollbackError) {
                console.error('[Estimates] DECLINE TASK SAVEPOINT ROLLBACK FAILED', {
                    company_id: companyId,
                    estimate_id: estimate.id,
                    error: rollbackError.message,
                });
            }
        }
        console.error('[Estimates] DECLINE FOLLOW-UP TASK FAILED; customer answer preserved', {
            company_id: companyId,
            estimate_id: estimate.id,
            code: error.code || null,
            error: error.message,
        });
        return null;
    }
}

async function listEstimates(companyId, filters = {}) {
    return estimatesQueries.listEstimates(companyId, filters);
}

async function getEstimate(companyId, id, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    const items = await estimatesQueries.getEstimateItems(companyId, id, client);
    return { ...estimate, items };
}

/** Global public-code resolver; routes establish tenant ownership before hydration. */
async function getEstimateByCode(publicCode, { client = null } = {}) {
    return estimatesQueries.getEstimateByCode(publicCode, client);
}

async function validateLinkedEntities(companyId, data = {}, client = null) {
    if (data.contact_id != null) {
        const contact = await estimatesQueries.getContactContext(companyId, data.contact_id, client);
        if (!contact) throw new EstimatesServiceError('NOT_FOUND', 'Contact not found', 404);
    }
    if (data.lead_id != null) {
        const lead = await estimatesQueries.getLeadContext(companyId, data.lead_id, client);
        if (!lead) throw new EstimatesServiceError('NOT_FOUND', 'Lead not found', 404);
    }
    if (data.job_id != null) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id, client);
        if (!job) throw new EstimatesServiceError('NOT_FOUND', 'Job not found', 404);
    }
}

async function validatePriceBookItems(companyId, items = [], client = null) {
    const ids = [...new Set(items
        .map(item => item?.price_book_item_id)
        .filter(id => id != null)
        .map(Number))];
    if (ids.length === 0) return;
    const owned = await estimateItemPresetsQueries.findActiveIdsScoped(companyId, ids, client);
    if (owned.length !== ids.length) {
        throw new EstimatesServiceError('NOT_FOUND', 'Price Book item not found', 404);
    }
}

async function resolveContext(companyId, data = {}, client = null) {
    await validateLinkedEntities(companyId, data, client);
    if (data.job_id) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id, client);

        const sequence = await estimatesQueries.nextEstimateSequence(
            companyId,
            {
                jobSeq: job.job_seq,
                legacyLeadSerialId: job.lead_serial_id || job.lead_id || job.id,
                jobId: job.id,
            },
            client
        );
        return {
            contact_id: data.contact_id || job.contact_id || null,
            lead_id: data.lead_id || job.lead_id || null,
            job_id: job.id,
            estimate_sequence: sequence,
            estimate_number: estimatesQueries.buildEstimateNumber({
                jobSeq: job.job_seq,
                sequence,
            }),
        };
    }

    if (data.lead_id) {
        const lead = await estimatesQueries.getLeadContext(companyId, data.lead_id, client);

        const sequence = await estimatesQueries.nextEstimateSequence(
            companyId,
            {
                leadSeq: lead.lead_seq,
                legacyLeadSerialId: lead.serial_id || lead.id,
                leadId: lead.id,
            },
            client
        );
        return {
            contact_id: data.contact_id || lead.contact_id || null,
            lead_id: lead.id,
            job_id: null,
            estimate_sequence: sequence,
            estimate_number: estimatesQueries.buildEstimateNumber({
                leadSeq: lead.lead_seq,
                sequence,
            }),
        };
    }

    const sequence = await estimatesQueries.nextEstimateSequence(
        companyId,
        {},
        client
    );
    return {
        contact_id: data.contact_id || null,
        lead_id: null,
        job_id: null,
        estimate_sequence: sequence,
        estimate_number: estimatesQueries.buildEstimateNumber({
            sequence,
        }),
    };
}

async function snapshotEstimate(companyId, id, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    const items = await estimatesQueries.getEstimateItems(companyId, id, client);
    return { ...estimate, items };
}

async function createEstimate(companyId, userId, data = {}, client = null, activityActor = null) {
    const items = normalizeItems(data.items, { optional: true }) || [];
    const orderList = normalizeOrderList(data.order_list ?? []);
    validateSavePayload(data, items);
    validateDiscount(data, itemSubtotal(items));
    await validatePriceBookItems(companyId, items, client);

    const context = await resolveContext(companyId, data, client);
    const estimate = await estimatesQueries.createEstimate(companyId, {
        ...data,
        ...context,
        summary: hasSummary(data) ? asText(data.summary) : null,
        discount_type: data.discount_type || null,
        discount_value: data.discount_value != null ? asNumber(data.discount_value, 0) : 0,
        signature_required: data.signature_required === true,
        order_list: orderList,
        created_by: userId,
    }, client);

    if (items.length > 0) {
        await estimatesQueries.replaceEstimateItems(companyId, estimate.id, items, client);
    }
    await estimatesQueries.recalculateEstimateTotals(companyId, estimate.id, client);
    await estimatesQueries.createEvent(
        companyId,
        estimate.id,
        'created',
        'user',
        userId,
        null,
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.created',
            entity: estimate,
            actor: activityActor,
        }, { client });
    }

    return getEstimate(companyId, estimate.id, client);
}

async function updateEstimate(companyId, userId, id, data = {}, client = null, activityActor = null) {
    const existing = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(existing);
    await validateLinkedEntities(companyId, data, client);

    // ESTIMATE-REDESIGN-001: collection replacement is opt-in by key presence.
    // Omitting `items` preserves the persisted rows; an explicit [] clears them.
    const replacesItems = Object.prototype.hasOwnProperty.call(data, 'items');
    const incomingItems = replacesItems ? normalizeItems(data.items) : null;
    if (replacesItems) await validatePriceBookItems(companyId, incomingItems, client);
    const currentItems = replacesItems
        ? incomingItems
        : await estimatesQueries.getEstimateItems(companyId, id, client);
    validateSavePayload({ ...existing, ...data }, currentItems);
    validateDiscount(data.discount_type !== undefined || data.discount_value !== undefined ? data : existing, itemSubtotal(currentItems));
    // `order_list` follows the same replacement contract as `items`.
    const replacesOrderList = Object.prototype.hasOwnProperty.call(data, 'order_list');
    const orderList = replacesOrderList
        ? normalizeOrderList(data.order_list)
        : null;

    if (existing.status === 'approved') {
        const approvedSnapshot = existing.approved_snapshot
            || await snapshotEstimate(companyId, id, client);
        await estimatesQueries.createRevision(
            companyId,
            id,
            approvedSnapshot,
            userId,
            client
        );
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
    if (replacesOrderList) updateData.order_list = orderList;

    if (existing.status !== 'draft') {
        updateData.status = 'draft';
        updateData.sent_at = null;
        updateData.accepted_at = null;
        updateData.declined_at = null;
    }

    const updated = await estimatesQueries.updateEstimate(id, companyId, updateData, client);
    if (!updated) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    if (replacesItems) {
        await estimatesQueries.replaceEstimateItems(companyId, id, incomingItems, client);
    }
    await estimatesQueries.recalculateEstimateTotals(companyId, id, client);
    await estimatesQueries.createEvent(
        companyId,
        id,
        'updated',
        'user',
        userId,
        { fields: Object.keys(data) },
        client
    );
    if (activityActor) {
        const current = await estimatesQueries.getEstimateById(companyId, id, client);
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.updated',
            entity: current,
            actor: activityActor,
        }, { client });
    }

    return getEstimate(companyId, id, client);
}

async function archiveEstimate(companyId, userId, id, client = null, activityActor = null) {
    const existing = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const updated = await estimatesQueries.archiveEstimate(id, companyId, userId, client);
    if (!updated) return getEstimate(companyId, id, client);

    await estimatesQueries.createEvent(companyId, id, 'archived', 'user', userId, null, client);
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.archived',
            entity: updated,
            actor: activityActor,
        }, { client });
    }
    return getEstimate(companyId, id, client);
}

async function restoreEstimate(companyId, userId, id, client = null, activityActor = null) {
    const existing = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!existing) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const updated = await estimatesQueries.restoreEstimate(id, companyId, userId, client);
    if (!updated) return getEstimate(companyId, id, client);

    await estimatesQueries.createEvent(
        companyId,
        id,
        'restored',
        'user',
        userId,
        { status: 'draft' },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.restored',
            entity: updated,
            actor: activityActor,
            summary: { status: 'draft' },
        }, { client });
    }
    return getEstimate(companyId, id, client);
}

async function resetStatusAfterItemEdit(companyId, userId, estimate, client = null) {
    if (estimate.status === 'approved') {
        const approvedSnapshot = estimate.approved_snapshot
            || await snapshotEstimate(companyId, estimate.id, client);
        await estimatesQueries.createRevision(
            companyId,
            estimate.id,
            approvedSnapshot,
            userId,
            client
        );
    }
    if (estimate.status !== 'draft') {
        await estimatesQueries.updateEstimate(estimate.id, companyId, {
            status: 'draft',
            sent_at: null,
            accepted_at: null,
            declined_at: null,
            updated_by: userId,
        }, client);
    }
}

async function addItem(companyId, estimateId, userId, item, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    await validatePriceBookItems(companyId, [item], client);
    await resetStatusAfterItemEdit(companyId, userId, estimate, client);
    const newItem = await estimatesQueries.addEstimateItem(
        companyId,
        estimateId,
        normalizeItem(item),
        client
    );
    await estimatesQueries.recalculateEstimateTotals(companyId, estimateId, client);
    await estimatesQueries.createEvent(
        companyId,
        estimateId,
        'item_added',
        'user',
        userId,
        { item_id: newItem.id },
        client
    );

    return newItem;
}

// PRICEBOOK-001: bulk add (e.g. a Price Book group expanded into its items).
// One status-reset + ONE recalc + ONE event, vs N round-trips of addItem.
async function addItems(companyId, estimateId, userId, items, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { added: 0, items: [] };

    await validatePriceBookItems(companyId, list, client);
    await resetStatusAfterItemEdit(companyId, userId, estimate, client);
    const created = [];
    for (const item of list) {
        created.push(await estimatesQueries.addEstimateItem(
            companyId,
            estimateId,
            normalizeItem(item),
            client
        ));
    }
    await estimatesQueries.recalculateEstimateTotals(companyId, estimateId, client);
    await estimatesQueries.createEvent(
        companyId,
        estimateId,
        'items_added',
        'user',
        userId,
        { count: created.length },
        client
    );

    return { added: created.length, items: created };
}

async function updateItem(companyId, estimateId, userId, itemId, data, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const items = await estimatesQueries.getEstimateItems(companyId, estimateId, client);
    const existingItem = items.find(item => String(item.id) === String(itemId));
    if (!existingItem) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await validatePriceBookItems(companyId, [{ ...existingItem, ...data }], client);
    await resetStatusAfterItemEdit(companyId, userId, estimate, client);
    const updated = await estimatesQueries.updateEstimateItem(
        companyId,
        estimateId,
        itemId,
        normalizeItem({ ...existingItem, ...data }),
        client
    );
    if (!updated) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await estimatesQueries.recalculateEstimateTotals(companyId, estimateId, client);
    await estimatesQueries.createEvent(
        companyId,
        estimateId,
        'item_updated',
        'user',
        userId,
        { item_id: itemId, fields: Object.keys(data) },
        client
    );

    return updated;
}

async function removeItem(companyId, estimateId, userId, itemId, client = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, estimateId, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${estimateId} not found`, 404);
    assertNotArchived(estimate);

    const items = await estimatesQueries.getEstimateItems(companyId, estimateId, client);
    if (!items.some(item => String(item.id) === String(itemId))) {
        throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);
    }

    await resetStatusAfterItemEdit(companyId, userId, estimate, client);
    const deleted = await estimatesQueries.deleteEstimateItem(
        companyId,
        estimateId,
        itemId,
        client
    );
    if (!deleted) throw new EstimatesServiceError('NOT_FOUND', `Item ${itemId} not found`, 404);

    await estimatesQueries.recalculateEstimateTotals(companyId, estimateId, client);
    await estimatesQueries.createEvent(
        companyId,
        estimateId,
        'item_removed',
        'user',
        userId,
        { item_id: itemId },
        client
    );

    return { deleted: true };
}

async function assertHasItems(companyId, estimateId, client = null) {
    const items = await estimatesQueries.getEstimateItems(companyId, estimateId, client);
    if (!items || items.length === 0) {
        throw new EstimatesServiceError('VALIDATION', 'В эстимейте нет items', 400);
    }
    return items;
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

function replacePriorPublicLink(message, priorToken, currentLink) {
    const text = String(message || '');
    if (!priorToken || !currentLink) return text;
    const escapedToken = String(priorToken).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const priorLink = new RegExp(
        `(?:https?:\\/\\/[^\\s<>'"]+)?\\/e\\/${escapedToken}(?=$|[\\s<>'"),.!?])`,
        'g'
    );
    return text.replace(priorLink, currentLink);
}

function recipientKey(channel, value) {
    const text = asText(value);
    if (!text) return '';
    if (channel === 'email') return text.toLowerCase();
    return toE164(text) || text;
}

function resolveSendRecipient(estimate, channel, recipient, recipientOverride) {
    if (recipientOverride !== undefined) {
        const override = asText(recipientOverride);
        if (!override) {
            throw new EstimatesServiceError(
                'VALIDATION',
                'recipient_override must be a non-empty address or phone number.',
                400
            );
        }
        return { value: override, source: 'override' };
    }

    const canonical = asText(channel === 'email'
        ? estimate.contact_email
        : estimate.contact_phone);
    if (!canonical) {
        throw new EstimatesServiceError(
            'VALIDATION',
            `The estimate contact has no ${channel === 'email' ? 'email address' : 'phone number'}.`,
            400
        );
    }

    if (recipient !== undefined) {
        const asserted = asText(recipient);
        if (!asserted) {
            throw new EstimatesServiceError('VALIDATION', 'Recipient is required.', 400);
        }
        if (recipientKey(channel, asserted) !== recipientKey(channel, canonical)) {
            throw new EstimatesServiceError(
                'RECIPIENT_MISMATCH',
                'Recipient does not match this estimate contact. Use recipient_override for a deliberate override.',
                409
            );
        }
    }

    return { value: canonical, source: 'contact' };
}

/**
 * SEND-DOC-001 (SD-5) — actually dispatch the estimate by email or SMS, then
 * (and only then) flip status → 'sent' + stamp sent_at and log the `sent` event.
 *
 * Coded errors carry { code, httpStatus } so routes/estimates.js maps them to
 * the SEND-DOC-001 §2.5 matrix; anything unexpected surfaces as 500.
 */
async function sendEstimate(
    companyId,
    userId,
    id,
    { channel, recipient, recipientOverride, message, userEmail, noteActor } = {},
    client = null,
    activityActor = null
) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);
    assertStatusIn(estimate, ['draft', 'sent', 'viewed', 'approved']);
    await assertHasItems(companyId, id, client);

    const normalizedChannel = channel === 'text' ? 'sms' : channel;
    if (!['email', 'sms'].includes(normalizedChannel)) {
        throw new EstimatesServiceError('VALIDATION', 'channel must be email or sms', 400);
    }
    const resolvedRecipient = resolveSendRecipient(
        estimate,
        normalizedChannel,
        recipient,
        recipientOverride
    );
    const to = resolvedRecipient.value;
    const number = estimate.estimate_number || `estimate-${id}`;
    // "ESTIMATE L-53-5" → "L-53-5" wherever we say the word "Estimate" ourselves.
    const shortNumber = shortDocNumber(number) || number;
    let noteRecipient = to;

    try {
        // Every send gets a fresh bearer URL. Under the route transaction a
        // failed dispatch rolls this rotation back, preserving the prior link.
        const { url: link } = await ensurePublicLink(
            companyId,
            id,
            client,
            activityActor,
            { rotate: true }
        );
        const currentMessage = replacePriorPublicLink(message, estimate.public_token, link);

        if (normalizedChannel === 'email') {
        // Pre-check: a mailbox that is missing / disconnected / reconnect_required
        // must surface as 409, never reach Gmail, and never flip status.
        const emailMailboxService = require('./emailMailboxService');
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox || mailbox.status !== 'connected') {
            throw new EstimatesServiceError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
        }

        let companyName = '';
        let senderName = '';
        let companyTimeZone = '';
        try {
            const companyQueries = require('../db/companyQueries');
            const company = await companyQueries.getCompanyById(companyId);
            companyName = asText(company?.name);
            senderName = asText(company?.settings?.email_sender_name);
            companyTimeZone = asText(company?.timezone);
        } catch { /* subject falls back to no company suffix */ }
        const subject = companyName
            ? `Estimate ${shortNumber} from ${companyName}`
            : `Estimate ${shortNumber}`;

        const { estimate: documentEstimate, buffer, brand } = await generatePdf(companyId, id, client);
        const safeFile = String(shortNumber).replace(/[^a-z0-9_-]+/gi, '_');

        const emailService = require('./emailService');
        try {
            await emailService.sendEmail(companyId, {
                to,
                subject,
                body: buildEstimateEmailBody({
                    message: currentMessage,
                    estimateLink: link,
                    estimate: documentEstimate,
                    brand,
                    companyName,
                    senderName: noteActor?.name,
                    timeZone: companyTimeZone,
                }),
                files: [{
                    mimetype: 'application/pdf',
                    originalname: `Estimate-${safeFile}.pdf`,
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
            await conversationsService.sendMessage(conv.id, { companyId, body: buildSmsBody(currentMessage, link) });
        }
    } catch (err) {
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'estimate',
                action: 'estimate.send_failed',
                entity: estimate,
                actor: activityActor,
                summary: { channel: normalizedChannel },
            });
        }
        await emitEstimateEvent(companyId, 'estimate.send_failed', id, activityActor);
        throw err;
    }

    // Dispatch resolved → NOW flip status and record the send (never before).
    const nextStatus = estimate.status === 'draft' ? 'sent' : estimate.status;
    const statusPatch = {
        status: nextStatus,
        sent_at: new Date().toISOString(),
    };
    if (client) {
        await estimatesQueries.updateEstimate(id, companyId, statusPatch, client);
        await estimatesQueries.createEvent(companyId, id, 'sent', 'user', userId, {
            channel: normalizedChannel,
            recipient: to,
            recipient_source: resolvedRecipient.source,
        }, client);
    } else {
        await estimatesQueries.updateEstimate(id, companyId, statusPatch);
        await estimatesQueries.createEvent(companyId, id, 'sent', 'user', userId, {
            channel: normalizedChannel,
            recipient: to,
            recipient_source: resolvedRecipient.source,
        });
    }
    if (activityActor) {
        const current = await estimatesQueries.getEstimateById(companyId, id, client);
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.sent',
            entity: current,
            actor: activityActor,
            summary: { channel: normalizedChannel, status: nextStatus },
        }, { client });
    }

    await recordDocumentSendNote({
        companyId,
        jobId: estimate.job_id,
        actor: noteActor,
        documentType: 'estimate',
        number,
        channel: normalizedChannel,
        recipient: noteRecipient,
    });

    return getEstimate(companyId, id, client);
}

async function approveEstimate(
    companyId,
    id,
    actorType,
    actorId,
    options = {},
    client = null,
    activityActor = null
) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);
    if (estimate.status === 'approved') return estimate;
    assertStatusIn(estimate, ['sent', 'viewed']);
    const items = await assertHasItems(companyId, id, client);

    if (estimate.signature_required
        && actorType === 'client'
        && options.enforce_signature !== false) {
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
    await estimatesQueries.createRevision(
        companyId,
        id,
        snapshot,
        actorType === 'user' ? actorId : null,
        client
    );

    const updated = await estimatesQueries.updateEstimate(id, companyId, {
        status: 'approved',
        accepted_at: approvedAt,
        approved_snapshot: snapshot,
        signature_name: signatureName,
        signature_consented_at: signatureConsentedAt,
    }, client);

    await estimatesQueries.createEvent(
        companyId,
        id,
        'approved',
        actorType || 'user',
        actorId,
        {
            signature_required: !!estimate.signature_required,
            ...normalizeEvidence(options.evidence),
        },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: actorType === 'client'
                ? 'estimate.client_accepted'
                : 'estimate.approved',
            entity: updated,
            actor: activityActor,
            summary: { status: 'approved' },
        }, { client });
    }
    await eventBus.emit(companyId, 'estimate.approved', {
        estimate_id: updated.id,
        estimate_number: updated.estimate_number || null,
        public_code: updated.public_code || null,
        job_id: updated.job_id || null,
        contact_id: updated.contact_id || null,
        order_list_count: Array.isArray(updated.order_list) ? updated.order_list.length : 0,
        record_refs: [{ type: 'estimate', id: updated.id }],
    }, {
        actorType: activityActor?.type || actorType || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'estimate',
        aggregateId: updated.id,
        client,
    });
    if (actorType === 'client') {
        await emitEstimateEvent(
            companyId,
            'estimate.client_accepted',
            id,
            activityActor || { type: 'client' },
            client
        );
    }

    return updated;
}

async function declineEstimate(
    companyId,
    id,
    actorType,
    actorId,
    { reason, comment, evidence } = {},
    client = null,
    activityActor = null
) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);
    if (estimate.status === 'declined') return estimate;
    assertStatusIn(estimate, ['sent', 'viewed']);

    const normalizedReason = asText(reason) || null;
    const normalizedComment = asText(comment) || null;
    if (actorType !== 'client' && !normalizedReason && !normalizedComment) {
        throw new EstimatesServiceError('VALIDATION', 'Decline reason is required', 400);
    }

    const updated = await estimatesQueries.updateEstimateStatus(
        id,
        companyId,
        'declined',
        'declined_at',
        client
    );
    await estimatesQueries.createEvent(
        companyId,
        id,
        'declined',
        actorType || 'user',
        actorId,
        {
            reason: normalizedReason,
            comment: normalizedComment,
            ...normalizeEvidence(evidence),
        },
        client
    );
    if (actorType === 'client') {
        await createDeclineFollowupTask(
            companyId,
            estimate,
            normalizedReason,
            normalizedComment,
            client
        );
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: actorType === 'client'
                ? 'estimate.client_declined'
                : 'estimate.declined',
            entity: updated,
            actor: activityActor,
            summary: { status: 'declined' },
        }, { client });
    }
    if (actorType === 'client') {
        await emitEstimateEvent(
            companyId,
            'estimate.client_declined',
            id,
            activityActor || { type: 'client' },
            client
        );
    }

    return updated;
}

async function linkJob(companyId, userId, id, jobId, client = null, activityActor = null) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    assertNotArchived(estimate);

    const job = await estimatesQueries.getJobContext(companyId, jobId, client);
    if (!job) throw new EstimatesServiceError('VALIDATION', 'Job not found', 400);

    const sequence = await estimatesQueries.nextEstimateSequence(
        companyId,
        {
            jobSeq: job.job_seq,
            legacyLeadSerialId: job.lead_serial_id || job.lead_id || job.id,
            jobId: job.id,
        },
        client,
    );
    const updated = await estimatesQueries.updateEstimate(id, companyId, {
        job_id: job.id,
        lead_id: estimate.lead_id || job.lead_id || null,
        contact_id: estimate.contact_id || job.contact_id || null,
        estimate_sequence: sequence,
        estimate_number: estimatesQueries.buildEstimateNumber({ jobSeq: job.job_seq, sequence }),
        status: estimate.status === 'draft' ? undefined : 'draft',
        updated_by: userId,
    }, client);

    await estimatesQueries.createEvent(
        companyId,
        id,
        'job_linked',
        'user',
        userId,
        { job_id: jobId },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.linked_job',
            entity: updated,
            actor: activityActor,
            summary: { job_id: job.id },
        }, { client });
    }
    return updated;
}

async function convertToInvoiceInTransaction(
    companyId,
    userId,
    id,
    client,
    activityActor = null
) {
    const locked = await estimatesQueries.lockEstimateForConversion(companyId, id, client);
    if (!locked) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    const invoicesService = require('./invoicesService');
    if (estimate.invoice_id) {
        const existing = await invoicesService.getInvoice(
            companyId,
            estimate.invoice_id,
            client
        );
        return { ...existing, already_converted: true };
    }

    assertNotArchived(estimate);
    if (!CONVERTIBLE_STATUSES.has(estimate.status)) {
        throw new EstimatesServiceError(
            'INVALID_STATUS',
            `Estimate cannot be converted from status '${estimate.status}'. Revive a declined estimate first.`,
            409
        );
    }

    const invoicesQueries = require('../db/invoicesQueries');
    const items = await estimatesQueries.getEstimateItems(companyId, id, client);
    const previousApproval = {
        status: estimate.status,
        accepted_at: estimate.accepted_at || null,
        approved_snapshot: estimate.approved_snapshot || null,
        signature_name: estimate.signature_name || null,
        signature_consented_at: estimate.signature_consented_at || null,
    };
    const markedApproved = estimate.status !== 'approved';
    let conversionEstimate = estimate;

    // For a live, non-approved estimate, conversion records the on-site verbal
    // approval before creating the invoice. Both writes share this transaction.
    if (markedApproved) {
        const approvedAt = new Date().toISOString();
        const approvedSnapshot = {
            ...estimate,
            status: 'approved',
            accepted_at: approvedAt,
            signature_name: null,
            signature_consented_at: null,
            items,
        };
        await estimatesQueries.createRevision(
            companyId,
            id,
            approvedSnapshot,
            userId,
            client
        );
        conversionEstimate = await estimatesQueries.updateEstimate(id, companyId, {
            status: 'approved',
            accepted_at: approvedAt,
            approved_snapshot: approvedSnapshot,
            signature_name: null,
            signature_consented_at: null,
            updated_by: userId,
        }, client);
        await estimatesQueries.createEvent(
            companyId,
            id,
            'approved',
            'user',
            userId,
            {
                signature_required: !!estimate.signature_required,
                source: 'internal_conversion',
                recorded_internally: true,
            },
            client
        );
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'estimate',
                action: 'estimate.approved',
                entity: conversionEstimate,
                actor: activityActor,
                summary: { status: 'approved', source: 'crm' },
            }, { client });
        }
        await eventBus.emit(companyId, 'estimate.approved', {
            estimate_id: conversionEstimate.id,
            estimate_number: conversionEstimate.estimate_number || null,
            public_code: conversionEstimate.public_code || null,
            job_id: conversionEstimate.job_id || null,
            contact_id: conversionEstimate.contact_id || null,
            order_list_count: Array.isArray(conversionEstimate.order_list)
                ? conversionEstimate.order_list.length
                : 0,
            record_refs: [{ type: 'estimate', id: conversionEstimate.id }],
        }, {
            actorType: activityActor?.type || 'user',
            actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
            aggregateType: 'estimate',
            aggregateId: conversionEstimate.id,
            client,
        });
    }

    // Auto-populate due_date from the invoice template's default_due_days (Net X policy).
    // The enrichment is OPTIONAL, but it may execute queries on the caller's
    // transaction client (directly in the future, or via test harnesses that
    // route db.query through the tx client). A plain try/catch is a lie inside
    // a transaction — the first error poisons the tx and every later statement
    // fails with "current transaction is aborted". A SAVEPOINT makes the
    // fall-back genuinely safe.
    let dueDate = null;
    await client.query('SAVEPOINT conversion_due_date');
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
        dueDate = d.toISOString().slice(0, 10);
        await client.query('RELEASE SAVEPOINT conversion_due_date');
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT conversion_due_date'); // fall back to NULL
    }

    // Conversion preserves the visible estimate number. Only the stored
    // document-type word changes so the invoice remains distinguishable in its
    // own table while rendering the same customer-facing number.
    const invoiceNumber = `INVOICE ${shortDocNumber(estimate.estimate_number)}`;

    const invoice = await invoicesQueries.createInvoice(companyId, {
        contact_id: estimate.contact_id,
        lead_id: estimate.lead_id,
        job_id: estimate.job_id,
        estimate_id: estimate.id,
        invoice_number: invoiceNumber,
        title: estimate.estimate_number,
        notes: estimate.summary || estimate.notes,
        internal_note: estimate.internal_note,
        order_list: estimate.order_list || [],
        tax_rate: estimate.tax_rate,
        discount_type: estimate.discount_type,
        discount_value: estimate.discount_value,
        discount_amount: estimate.discount_amount,
        currency: estimate.currency,
        due_date: dueDate,
        created_by: userId,
    }, client);

    for (const item of items) {
        await invoicesQueries.addInvoiceItem(companyId, invoice.id, {
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            amount: item.amount,
            taxable: item.taxable,
            sort_order: item.sort_order,
        }, client);
    }

    await invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id, client);
    await invoicesQueries.createEvent(
        companyId,
        invoice.id,
        'created_from_estimate',
        'user',
        userId,
        { estimate_id: estimate.id },
        client
    );
    const created = await invoicesService.getInvoice(companyId, invoice.id, client);
    const conversionEvent = await estimatesQueries.createEvent(
        companyId,
        id,
        'converted_to_invoice',
        'user',
        userId,
        {
            invoice_id: invoice.id,
            previous_status: previousApproval.status,
            previous_accepted_at: previousApproval.accepted_at,
            previous_approved_snapshot: previousApproval.approved_snapshot,
            previous_signature_name: previousApproval.signature_name,
            previous_signature_consented_at: previousApproval.signature_consented_at,
            approval_recorded: markedApproved,
            approval_source: markedApproved ? 'internal_conversion' : null,
            estimate_updated_at: timestampValue(conversionEstimate.updated_at),
            invoice_updated_at: timestampValue(created.updated_at),
            undo_window_seconds: CONVERSION_UNDO_WINDOW_SECONDS,
        },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.converted',
            entity: conversionEstimate,
            actor: activityActor,
            summary: { invoice_id: invoice.id },
        }, { client });
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.created',
            entity: invoice,
            actor: activityActor,
            summary: { estimate_id: estimate.id },
        }, { client });
    }

    const conversionCreatedAt = timestampValue(conversionEvent?.created_at) || new Date().toISOString();
    return {
        ...created,
        already_converted: false,
        marked_approved: markedApproved,
        undo_expires_at: new Date(
            new Date(conversionCreatedAt).getTime() + CONVERSION_UNDO_WINDOW_SECONDS * 1000
        ).toISOString(),
    };
}

async function convertToInvoice(companyId, userId, id, client = null, activityActor = null) {
    if (client?.query) {
        return convertToInvoiceInTransaction(
            companyId,
            userId,
            id,
            client,
            activityActor
        );
    }

    const ownedClient = await db.pool.connect();
    try {
        await ownedClient.query('BEGIN');
        const result = await convertToInvoiceInTransaction(
            companyId,
            userId,
            id,
            ownedClient,
            activityActor
        );
        await ownedClient.query('COMMIT');
        return result;
    } catch (err) {
        await ownedClient.query('ROLLBACK');
        throw err;
    } finally {
        ownedClient.release();
    }
}

async function undoInvoiceConversionInTransaction(
    companyId,
    userId,
    id,
    invoiceId,
    client,
    activityActor = null
) {
    const lockedEstimate = await estimatesQueries.lockEstimateForConversion(
        companyId,
        id,
        client
    );
    if (!lockedEstimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }
    if (!invoiceId || String(estimate.invoice_id) !== String(invoiceId)) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_MISMATCH',
            'This invoice is not the current invoice created from this estimate.'
        );
    }

    const invoicesQueries = require('../db/invoicesQueries');
    const invoicesService = require('./invoicesService');
    const lockedInvoice = await invoicesQueries.lockInvoiceById(companyId, invoiceId, client);
    if (!lockedInvoice) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_MISMATCH',
            'The invoice created by this conversion no longer exists.'
        );
    }

    const conversion = await estimatesQueries.getConversionEventForUndo(
        companyId,
        id,
        invoiceId,
        CONVERSION_UNDO_WINDOW_SECONDS,
        client
    );
    if (!conversion) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_MISMATCH',
            'This invoice is not tied to an undoable conversion of this estimate.'
        );
    }
    if (conversion.undo_expired) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_EXPIRED',
            'Undo is available for 5 minutes after creating the invoice.'
        );
    }

    const metadata = conversion.metadata || {};
    if (!CONVERTIBLE_STATUSES.has(metadata.previous_status)) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_UNAVAILABLE',
            'The conversion audit record cannot safely restore the estimate.'
        );
    }

    const invoice = await invoicesService.getInvoice(companyId, invoiceId, client);
    if (!invoice || String(invoice.estimate_id) !== String(id)) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_MISMATCH',
            'This invoice is not the one created from this estimate.'
        );
    }

    if (
        ['void', 'voided', 'refunded'].includes(lockedInvoice.status)
        || invoice.voided_at
    ) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_INVOICE_VOIDED',
            'This conversion cannot be undone because the invoice was voided or refunded.'
        );
    }
    if (lockedInvoice.status !== 'draft' || invoice.sent_at) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_INVOICE_SENT',
            'This conversion cannot be undone because the invoice was sent or moved beyond draft.'
        );
    }

    const blockers = await invoicesQueries.getConversionUndoBlockers(
        companyId,
        invoiceId,
        id,
        client
    );
    if (!blockers) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_MISMATCH',
            'This invoice is not the one created from this estimate.'
        );
    }
    if (
        Number(invoice.amount_paid || 0) !== 0
        || Number(invoice.job_payment_allocated || 0) !== 0
        || blockers.has_payment_activity
    ) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_PAYMENT_ALLOCATED',
            'This conversion cannot be undone because payment activity is allocated to the invoice.'
        );
    }

    const invoiceChanged = timestampValue(invoice.updated_at) !== metadata.invoice_updated_at;
    const estimateChanged = timestampValue(estimate.updated_at) !== metadata.estimate_updated_at;
    if (
        invoiceChanged
        || estimateChanged
        || Number(blockers.linked_invoice_count) !== 1
        || blockers.has_payment_session
        || blockers.has_revision
        || blockers.has_task
        || blockers.has_generation_link
        || blockers.has_unexpected_event
    ) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_INVOICE_CHANGED',
            'This conversion cannot be undone because the estimate or invoice was edited or otherwise used.'
        );
    }

    const deleted = await invoicesQueries.deleteConvertedInvoice(
        companyId,
        invoiceId,
        id,
        client
    );
    if (!deleted) {
        throw conversionUndoConflict(
            'CONVERSION_UNDO_INVOICE_CHANGED',
            'The invoice changed before the conversion could be undone.'
        );
    }

    const restored = await estimatesQueries.updateEstimate(id, companyId, {
        status: metadata.previous_status,
        accepted_at: metadata.previous_accepted_at ?? null,
        approved_snapshot: metadata.previous_approved_snapshot ?? null,
        signature_name: metadata.previous_signature_name ?? null,
        signature_consented_at: metadata.previous_signature_consented_at ?? null,
        updated_by: userId,
    }, client);
    if (!restored) {
        throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);
    }

    await estimatesQueries.createEvent(
        companyId,
        id,
        'conversion_undone',
        'user',
        userId,
        {
            invoice_id: invoiceId,
            restored_status: metadata.previous_status,
            source: 'internal_undo',
            conversion_event_id: conversion.id,
        },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'estimate',
            action: 'estimate.conversion_undone',
            entity: restored,
            actor: activityActor,
            summary: {
                invoice_id: invoiceId,
                status: metadata.previous_status,
            },
        }, { client });
    }

    return {
        estimate: await getEstimate(companyId, id, client),
        invoice_id: invoiceId,
        undone: true,
    };
}

async function undoInvoiceConversion(
    companyId,
    userId,
    id,
    invoiceId,
    client = null,
    activityActor = null
) {
    if (client?.query) {
        return undoInvoiceConversionInTransaction(
            companyId,
            userId,
            id,
            invoiceId,
            client,
            activityActor
        );
    }

    const ownedClient = await db.pool.connect();
    try {
        await ownedClient.query('BEGIN');
        const result = await undoInvoiceConversionInTransaction(
            companyId,
            userId,
            id,
            invoiceId,
            ownedClient,
            activityActor
        );
        await ownedClient.query('COMMIT');
        return result;
    } catch (err) {
        await ownedClient.query('ROLLBACK');
        throw err;
    } finally {
        ownedClient.release();
    }
}

async function copyToInvoice(companyId, userId, id, client = null) {
    return convertToInvoice(companyId, userId, id, client);
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

async function generatePdf(companyId, id, client = null) {
    const estimate = await getEstimate(companyId, id, client);
    const customerEstimate = stripInternalOrderList(estimate);
    // F015: resolve company-specific document template; falls back to factory descriptor.
    const documentTemplatesService = require('./documentTemplatesService');
    const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'estimate', client);
    return {
        estimate: customerEstimate,
        buffer: await renderEstimatePdf(customerEstimate, descriptor),
        brand: descriptor?.brand || {},
    };
}

// =============================================================================
// Public link (SEND-DOC-001) — mirrors invoicesService ensurePublicLink /
// getPublicInvoice / generatePdfByPublicToken.
// =============================================================================

const PUBLIC_LINK_LIFETIME_MONTHS = 18;

/**
 * Return (creating if necessary) a public link for the estimate. A plain lookup
 * reuses a live token; a resend rotates it so previously forwarded URLs stop
 * resolving. Expired and legacy tokens are always replaced.
 */
async function ensurePublicLink(
    companyId,
    id,
    client = null,
    activityActor = null,
    { rotate = false } = {}
) {
    const estimate = await estimatesQueries.getEstimateById(companyId, id, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', `Estimate ${id} not found`, 404);

    let token = estimate.public_token;
    const expiresAt = estimate.public_token_expires_at
        ? new Date(estimate.public_token_expires_at).getTime()
        : NaN;
    const hasLiveToken = !!token && Number.isFinite(expiresAt) && expiresAt > Date.now();
    if (rotate || !hasLiveToken) {
        // 8 bytes of entropy → 11 url-safe chars. 2^64 keyspace is plenty for unguessability.
        token = crypto.randomBytes(8).toString('base64url');
        if (client) {
            await estimatesQueries.setPublicToken(
                estimate.id,
                companyId,
                token,
                client,
                PUBLIC_LINK_LIFETIME_MONTHS
            );
        } else {
            await estimatesQueries.setPublicToken(
                estimate.id,
                companyId,
                token,
                null,
                PUBLIC_LINK_LIFETIME_MONTHS
            );
        }
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'estimate',
                action: 'estimate.link_created',
                entity: estimate,
                actor: activityActor,
            }, { client });
        }
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
async function publicEstimateView(estimate, client = null) {
    const items = await estimatesQueries.getEstimateItems(
        estimate.company_id,
        estimate.id,
        client
    );
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
        deposit_paid: Number(estimate.deposit_paid || 0),
        balance_due: Number(estimate.balance_due ?? estimate.total),
    };
}

async function approvePublicEstimate(publicToken, evidence = {}, client = null) {
    const estimate = await estimatesQueries.lockEstimateByPublicToken(
        publicToken,
        'approve',
        client
    );
    if (!estimate) return null;

    await approveEstimate(
        estimate.company_id,
        estimate.id,
        'client',
        null,
        {
            enforce_signature: false,
            evidence,
        },
        client,
        { id: null, type: 'client', label: 'Customer', source: 'portal' }
    );
    return getPublicEstimate(publicToken, { client });
}

async function declinePublicEstimate(publicToken, data = {}, evidence = {}, client = null) {
    const estimate = await estimatesQueries.lockEstimateByPublicToken(
        publicToken,
        'decline',
        client
    );
    if (!estimate) return null;
    const normalized = normalizePublicDeclineInput(data);

    await declineEstimate(
        estimate.company_id,
        estimate.id,
        'client',
        null,
        { ...normalized, evidence },
        client,
        { id: null, type: 'client', label: 'Customer', source: 'portal' }
    );
    return getPublicEstimate(publicToken, { client });
}

async function getPublicEstimate(publicToken, { recordView = false, client = null } = {}) {
    let estimate = await estimatesQueries.getEstimateByPublicToken(publicToken, client);
    if (!estimate) return null;
    if (recordView) {
        const changed = await estimatesQueries.markEstimateViewed(
            estimate.company_id,
            estimate.id,
            client
        );
        if (changed) estimate = { ...estimate, status: 'viewed' };
        const { clientActor } = require('./financialActivityService');
        await logFinancialActivity({
            companyId: estimate.company_id,
            entityType: 'estimate',
            action: 'estimate.viewed',
            entity: estimate,
            actor: clientActor('Client', 'portal'),
        }, { client });
    }
    return publicEstimateView(estimate, client);
}

/**
 * Render the PDF for an estimate resolved by its `public_token`.
 * No auth/scoping — the token is the credential. Reuses generatePdf.
 */
async function generatePdfByPublicToken(publicToken, { recordView = false, client = null } = {}) {
    let estimate = await estimatesQueries.getEstimateByPublicToken(publicToken, client);
    if (!estimate) throw new EstimatesServiceError('NOT_FOUND', 'Estimate not found', 404);
    if (recordView) {
        const changed = await estimatesQueries.markEstimateViewed(
            estimate.company_id,
            estimate.id,
            client
        );
        if (changed) estimate = { ...estimate, status: 'viewed' };
        const { clientActor } = require('./financialActivityService');
        await logFinancialActivity({
            companyId: estimate.company_id,
            entityType: 'estimate',
            action: 'estimate.viewed',
            entity: estimate,
            actor: clientActor('Client', 'portal'),
        }, { client });
    }
    return generatePdf(estimate.company_id, estimate.id, client);
}

module.exports = {
    listEstimates,
    getEstimate,
    getEstimateByCode,
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
    undoInvoiceConversion,
    copyToInvoice,
    getRevisions,
    getEvents,
    generatePdf,
    ensurePublicLink,
    approvePublicEstimate,
    declinePublicEstimate,
    getPublicEstimate,
    generatePdfByPublicToken,
    EstimatesServiceError,
};
