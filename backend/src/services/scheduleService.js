/**
 * Schedule Service
 * PF001 Schedule / Dispatcher MVP — Sprint 2
 *
 * Unified schedule operations across jobs, leads and tasks.
 */

const scheduleQueries = require('../db/scheduleQueries');

// =============================================================================
// Defaults for dispatch settings
// =============================================================================

const DEFAULT_DISPATCH_SETTINGS = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
    slot_duration: 60,
    buffer_minutes: 0,
    settings_json: {},
};

// =============================================================================
// Row → unified schedule item
// =============================================================================

function rowToScheduleItem(row) {
    return {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        title: row.title,
        subtitle: row.subtitle,
        status: row.status,
        start_at: row.start_at ? row.start_at.toISOString ? row.start_at.toISOString() : row.start_at : null,
        end_at: row.end_at ? row.end_at.toISOString ? row.end_at.toISOString() : row.end_at : null,
        address_summary: row.address_summary || '',
        customer_name: row.customer_name || '',
        customer_phone: row.customer_phone || '',
        customer_email: row.customer_email || '',
        assigned_techs: row.assigned_techs || [],
        job_type: row.job_type || null,
        job_source: row.job_source || null,
        tags: row.tags || [],
        company_id: row.company_id,
        created_at: row.created_at,
    };
}

// =============================================================================
// Service methods
// =============================================================================

/**
 * List schedule items with filters.
 */
async function getScheduleItems(companyId, filters = {}) {
    const result = await scheduleQueries.getScheduleItems({
        companyId,
        ...filters,
    });
    return {
        items: result.rows.map(rowToScheduleItem),
        total: result.total,
    };
}

/**
 * Get full detail for a single schedule entity.
 */
async function getScheduleItemDetail(companyId, entityType, entityId) {
    let row;
    switch (entityType) {
        case 'job':
            row = await scheduleQueries.getJobRow(companyId, entityId);
            break;
        case 'lead':
            row = await scheduleQueries.getLeadRow(companyId, entityId);
            break;
        case 'task':
            row = await scheduleQueries.getTaskRow(companyId, entityId);
            break;
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }

    if (!row) {
        throw new ScheduleServiceError('NOT_FOUND', `${entityType} ${entityId} not found`, 404);
    }

    return { entity_type: entityType, entity_id: entityId, data: row };
}

/**
 * Reschedule a schedule item (update start/end times).
 */
async function rescheduleItem(companyId, entityType, entityId, newStartAt, newEndAt) {
    let updated;
    switch (entityType) {
        case 'job':
            updated = await scheduleQueries.rescheduleJob(companyId, entityId, newStartAt, newEndAt);
            break;
        case 'lead':
            updated = await scheduleQueries.rescheduleLead(companyId, entityId, newStartAt, newEndAt);
            break;
        case 'task':
            updated = await scheduleQueries.rescheduleTask(companyId, entityId, newStartAt, newEndAt);
            break;
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }

    if (!updated) {
        throw new ScheduleServiceError('NOT_FOUND', `${entityType} ${entityId} not found`, 404);
    }

    return { entity_type: entityType, entity_id: entityId, start_at: newStartAt, end_at: newEndAt };
}

/**
 * Reassign a schedule item to a provider.
 * Jobs use assigned_techs (jsonb), tasks use assigned_provider_id.
 * Leads do not support assignment in this version.
 */
async function reassignItem(companyId, entityType, entityId, assigneeId) {
    let updated;
    switch (entityType) {
        case 'job':
            updated = await scheduleQueries.reassignJob(companyId, entityId, assigneeId);
            break;
        case 'task':
            updated = await scheduleQueries.reassignTask(companyId, entityId, assigneeId);
            break;
        case 'lead':
            throw new ScheduleServiceError('NOT_SUPPORTED', 'Leads do not support provider assignment', 400);
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }

    if (!updated) {
        throw new ScheduleServiceError('NOT_FOUND', `${entityType} ${entityId} not found`, 404);
    }

    return { entity_type: entityType, entity_id: entityId, assignee_id: assigneeId };
}

/**
 * Create a new entity from a schedule time slot.
 * Currently only supports 'task'. Lead/Job shells can be added later.
 */
async function createFromSlot(companyId, entityType, slotData) {
    switch (entityType) {
        case 'task': {
            const row = await scheduleQueries.createTask(companyId, {
                title: slotData.title,
                description: slotData.description,
                startAt: slotData.start_at,
                endAt: slotData.end_at,
                assignedProviderId: slotData.assignee_id,
                threadId: slotData.thread_id,
                priority: slotData.priority,
            });
            return { entity_type: 'task', entity_id: row.id, data: row };
        }
        case 'lead':
        case 'job':
            throw new ScheduleServiceError('NOT_IMPLEMENTED', `Creating ${entityType} from slot is not yet supported`, 501);
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }
}

/**
 * Get dispatch settings for a company, returning defaults if none exist.
 */
async function getDispatchSettings(companyId) {
    const row = await scheduleQueries.getDispatchSettings(companyId);
    if (!row) {
        return { company_id: companyId, ...DEFAULT_DISPATCH_SETTINGS };
    }
    return row;
}

/**
 * Upsert dispatch settings for a company.
 */
async function updateDispatchSettings(companyId, updates) {
    const row = await scheduleQueries.upsertDispatchSettings(companyId, updates);
    return row;
}

// =============================================================================
// Error class
// =============================================================================

class ScheduleServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'ScheduleServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

module.exports = {
    getScheduleItems,
    getScheduleItemDetail,
    rescheduleItem,
    reassignItem,
    createFromSlot,
    getDispatchSettings,
    updateDispatchSettings,
    ScheduleServiceError,
};
