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
 * providerScope ({assignedOnly, userId}) restricts visibility for
 * assigned_only providers: own jobs, own tasks, no leads (PF007).
 */
async function getScheduleItems(companyId, filters = {}, providerScope = null) {
    const result = await scheduleQueries.getScheduleItems({
        companyId,
        ...filters,
        providerScope,
    });
    return {
        items: result.rows.map(rowToScheduleItem),
        total: result.total,
    };
}

/**
 * Check whether a fetched row is visible under the provider scope.
 * Non-visible entities are indistinguishable from missing ones (404).
 */
function isRowVisibleToProvider(entityType, row, providerScope) {
    if (!providerScope?.assignedOnly) return true;
    if (!providerScope.userId) return false;
    switch (entityType) {
        case 'job': {
            const mirror = Array.isArray(row.assigned_provider_user_ids) ? row.assigned_provider_user_ids : [];
            return mirror.includes(providerScope.userId);
        }
        case 'task':
            return String(row.assigned_provider_id || '') === providerScope.userId;
        case 'lead':
            return false; // providers never see leads in the schedule
        default:
            return false;
    }
}

/**
 * Get full detail for a single schedule entity.
 */
async function getScheduleItemDetail(companyId, entityType, entityId, providerScope = null) {
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

    if (!row || !isRowVisibleToProvider(entityType, row, providerScope)) {
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
 * Get available appointment slots for inbound call booking.
 *
 * Algorithm:
 *   1. Load dispatch_settings (working hours, work days, slot_duration, timezone)
 *   2. Load already-booked schedule items for the date range
 *   3. For each working day, generate candidate time windows
 *   4. Filter out windows that overlap with existing bookings
 *   5. Return up to maxSlots results, formatted for speech
 *
 * @param {string} companyId
 * @param {Object} opts
 * @param {string} [opts.startDate]          - ISO date string (YYYY-MM-DD), defaults to today
 * @param {number} [opts.days=5]             - how many calendar days to scan
 * @param {number} [opts.slotDurationMin=120] - appointment window length in minutes
 * @param {number} [opts.maxSlots=3]         - max slots to return
 * @returns {Promise<{ slots: Array<{date,label,start,end}>, error?: string }>}
 */
async function getAvailableSlots(companyId, {
    startDate,
    days = 5,
    slotDurationMin = 120,
    maxSlots = 3,
} = {}) {
    // 1. Load dispatch settings
    const settings = await getDispatchSettings(companyId);
    const tz = settings.timezone || 'America/New_York';
    const workStart = settings.work_start_time || '08:00';
    const workEnd   = settings.work_end_time   || '18:00';
    const workDays  = settings.work_days || [1, 2, 3, 4, 5]; // 0=Sun…6=Sat
    const bufferMin = settings.buffer_minutes || 0;
    const windowMin = slotDurationMin + bufferMin;

    // 2. Determine date range
    const todayStr = startDate || new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const endDateObj = new Date(todayStr + 'T00:00:00');
    endDateObj.setDate(endDateObj.getDate() + days);
    const endDateStr = endDateObj.toLocaleDateString('en-CA', { timeZone: tz });

    // 3. Load booked items in range (jobs + leads + tasks that have start_at)
    const { items: bookedItems } = await getScheduleItems(companyId, {
        startDate: todayStr,
        endDate: endDateStr,
    });

    // Build set of booked intervals as [startMs, endMs]
    const bookedIntervals = bookedItems
        .filter(i => i.start_at)
        .map(i => [
            new Date(i.start_at).getTime(),
            i.end_at ? new Date(i.end_at).getTime() : new Date(i.start_at).getTime() + windowMin * 60 * 1000,
        ]);

    // 4. Generate candidate windows for each working day
    const slots = [];
    const [wStartH, wStartM] = workStart.split(':').map(Number);
    const [wEndH,   wEndM]   = workEnd.split(':').map(Number);
    const workStartTotalMin = wStartH * 60 + wStartM;
    const workEndTotalMin   = wEndH   * 60 + wEndM;

    const DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    function ordinal(n) {
        const s = ['th','st','nd','rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function fmtHour(totalMin) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        const suffix = h >= 12 ? 'pm' : 'am';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2,'0')}${suffix}`;
    }

    let cursor = new Date(todayStr + 'T00:00:00');

    for (let d = 0; d < days && slots.length < maxSlots; d++) {
        const dayOfWeek = cursor.getDay(); // local, but we only need dow

        if (workDays.includes(dayOfWeek)) {
            // Offer the FIRST open window of each working day, for day variety
            // (matches the "Tuesday … or Thursday …" choice-without-choice framing).
            for (
                let slotStart = workStartTotalMin;
                slotStart + windowMin <= workEndTotalMin;
                slotStart += windowMin
            ) {
                const slotEnd = slotStart + slotDurationMin; // end without buffer

                // Build absolute ms timestamps for overlap check
                const dateStr = cursor.toLocaleDateString('en-CA', { timeZone: tz });
                const slotStartMs = new Date(`${dateStr}T${String(Math.floor(slotStart/60)).padStart(2,'0')}:${String(slotStart%60).padStart(2,'0')}:00`).getTime();
                const slotEndMs   = slotStartMs + windowMin * 60 * 1000;

                // Check overlap with any booked interval
                const overlaps = bookedIntervals.some(([bs, be]) => slotStartMs < be && slotEndMs > bs);

                if (!overlaps) {
                    const dayName   = DAY_NAMES[cursor.getDay()];
                    const dayNum    = cursor.getDate();
                    const monthName = MONTH_NAMES[cursor.getMonth()];
                    const label     = `${dayName}, ${monthName} ${ordinal(dayNum)} between ${fmtHour(slotStart)} and ${fmtHour(slotEnd)}`;

                    slots.push({
                        date:  dateStr,
                        label,
                        start: `${String(Math.floor(slotStart/60)).padStart(2,'0')}:${String(slotStart%60).padStart(2,'0')}`,
                        end:   `${String(Math.floor(slotEnd/60)).padStart(2,'0')}:${String(slotEnd%60).padStart(2,'0')}`,
                    });
                    break; // one slot per day → move to next day
                }
            }
        }

        if (slots.length >= maxSlots) break;

        cursor.setDate(cursor.getDate() + 1);
    }

    if (slots.length === 0) {
        return { slots: [], error: `No availability found in the next ${days} days` };
    }

    return { slots };
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
    getAvailableSlots,
    ScheduleServiceError,
};
