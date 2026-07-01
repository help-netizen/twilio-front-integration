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
    distance_unit: 'mi',
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
        // SCHED-ROUTE-001 (FR-002): geocoding state so the UI can show
        // pending / needs-review / failed without any Google call on read.
        lat: row.lat != null ? Number(row.lat) : null,
        lng: row.lng != null ? Number(row.lng) : null,
        normalized_address: row.normalized_address || null,
        geocoding_status: row.geocoding_status || null,
        // SCHED-ROUTE-001 (C-6/FR-003): clickable Maps link, generated (not
        // persisted). Prefer coordinates when present — they pin the exact
        // location; fall back to the free-text address otherwise.
        google_maps_url: (row.lat != null && row.lng != null)
            ? require('./routeGeo').googleMapsUrl({ lat: Number(row.lat), lng: Number(row.lng), address: row.address_summary })
            : (row.address_summary
                ? require('./routeGeo').googleMapsUrl({ address: row.address_summary })
                : null),
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
    // SCHED-ROUTE-001 C-3: group days in the company timezone so route-day matches
    // the day the user sees. Falls back to the previous UTC behaviour if unresolved.
    let timezone = null;
    try { timezone = (await getDispatchSettings(companyId))?.timezone || null; } catch { /* keep UTC */ }
    const result = await scheduleQueries.getScheduleItems({
        companyId,
        ...filters,
        providerScope,
        timezone,
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
    // SCHED-ROUTE-001: capture the job's technician/days before the date change.
    const before = entityType === 'job' ? await captureJobTechDays(companyId, entityId) : null;
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

    if (entityType === 'job') await recalcAfterJobChange(companyId, entityId, before);
    return { entity_type: entityType, entity_id: entityId, start_at: newStartAt, end_at: newEndAt };
}

/** Tech/day pairs a job currently belongs to (for repair-on-change). */
async function captureJobTechDays(companyId, jobId) {
    try {
        const routeQueries = require('../db/routeQueries');
        const tz = await routeQueries.getCompanyTimezone(companyId);
        return await routeQueries.getTechDaysForJob(companyId, jobId, tz);
    } catch { return []; }
}

/**
 * Reassign a schedule item to a provider.
 * Jobs use assigned_techs (jsonb), tasks use assigned_provider_id.
 * Leads do not support assignment in this version.
 */
async function reassignItem(companyId, entityType, entityId, assignees = []) {
    // JOB-PROVIDER-MULTI-001: one OR many providers. Normalize to [{id,name}] and
    // dedupe by id (a client could send the same provider twice).
    const seenIds = new Set();
    const list = (assignees || [])
        .filter(a => a && a.id != null && String(a.id) !== '')
        .map(a => ({ id: String(a.id), name: a.name || '' }))
        .filter(a => (seenIds.has(a.id) ? false : (seenIds.add(a.id), true)));

    // SCHED-ROUTE-001: capture old technician/days so the vacated route repairs.
    const before = entityType === 'job' ? await captureJobTechDays(companyId, entityId) : null;

    // Capture the job's current providers + ZB linkage BEFORE the write so we can
    // push the assign/unassign diff to Zenbooker (fixes the bug where a card
    // reassignment never reached ZB). assigned_techs ids ARE ZB team-member ids.
    // Also resolve the NEW providers to internal user ids so the visibility mirror
    // (assigned_provider_user_ids) is refreshed → an assigned provider sees the job
    // on their own schedule immediately.
    let oldTechIds = [];
    let zbJobId = null;
    let providerUserIds = null;
    if (entityType === 'job') {
        try {
            const jobsService = require('./jobsService');
            const job = await jobsService.getJobById(entityId, companyId);
            oldTechIds = (job?.assigned_techs || []).map(t => String(t.id)).filter(Boolean);
            zbJobId = job?.zenbooker_job_id || null;
            providerUserIds = await jobsService.resolveAssignedProviderUserIds(companyId, list);
        } catch { /* best-effort — ZB push / mirror refresh skipped if we can't read it */ }
    }

    let updated;
    switch (entityType) {
        case 'job':
            updated = await scheduleQueries.reassignJob(companyId, entityId, list, providerUserIds);
            break;
        case 'task':
            updated = await scheduleQueries.reassignTask(companyId, entityId, list[0]?.id ?? null);
            break;
        case 'lead':
            throw new ScheduleServiceError('NOT_SUPPORTED', 'Leads do not support provider assignment', 400);
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }

    if (!updated) {
        throw new ScheduleServiceError('NOT_FOUND', `${entityType} ${entityId} not found`, 404);
    }

    // Push the assignment change to Zenbooker. Best-effort: a ZB failure is logged
    // but never rolls back the local reassignment.
    if (entityType === 'job' && zbJobId) {
        const newTechIds = list.map(t => t.id);
        const assign = newTechIds.filter(id => !oldTechIds.includes(id));
        const unassign = oldTechIds.filter(id => !newTechIds.includes(id));
        if (assign.length || unassign.length) {
            try {
                const zenbookerClient = require('./zenbookerClient');
                await zenbookerClient.assignProviders(zbJobId, { assign, unassign });
            } catch (err) {
                console.error('[Schedule] ZB assignProviders failed (non-fatal):', err.response?.data || err.message);
            }
        }
    }

    if (entityType === 'job') await recalcAfterJobChange(companyId, entityId, before);
    return { entity_type: entityType, entity_id: entityId, assignees: list, assignee_id: list[0]?.id ?? null };
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
        case 'job': {
            // SCHED-ROUTE-001 FR-001: create a local Albusto job from a slot.
            const jobsService = require('./jobsService');
            const job = await jobsService.createManualJob(companyId, {
                service_name: slotData.title || slotData.service_name,
                address: slotData.address,
                lat: slotData.lat, lng: slotData.lng,
                normalized_address: slotData.normalized_address,
                geocoding_place_id: slotData.place_id,
                start_date: slotData.start_at, end_date: slotData.end_at,
                customer_name: slotData.customer_name, customer_phone: slotData.customer_phone,
                customer_email: slotData.customer_email,
                assignee_id: slotData.assignee_id,           // internal crm_users.id (C-2)
                assigned_techs: slotData.assigned_techs,     // ZB-shaped lane provider (FR-001.4)
                zb_address: slotData.zb_address,             // structured parts for ZB sync (C-12)
            });
            await triggerJobRouteSideEffects(companyId, job.id, {
                hasAddress: !!(slotData.address && String(slotData.address).trim()),
                hasCoords: slotData.lat != null && slotData.lng != null,
            });
            return { entity_type: 'job', entity_id: job.id, data: job };
        }
        case 'lead':
            throw new ScheduleServiceError('NOT_IMPLEMENTED', `Creating ${entityType} from slot is not yet supported`, 501);
        default:
            throw new ScheduleServiceError('INVALID_ENTITY_TYPE', `Unknown entity type: ${entityType}`, 400);
    }
}

/**
 * SCHED-ROUTE-001: async route side-effects after a job create. Never blocks the
 * HTTP response on Google latency — geocode + route calc run on the agentWorker.
 * Failures are logged, not fatal (the local job is already saved).
 */
async function triggerJobRouteSideEffects(companyId, jobId, { hasAddress, hasCoords } = {}) {
    try {
        const routeSeg = require('./routeSegmentService');
        if (hasAddress && !hasCoords) await routeSeg.enqueueGeocode(companyId, jobId);
        await routeSeg.recalcForJob(companyId, jobId, { coordsChanged: true });
    } catch (e) {
        console.error('[Schedule] job route side-effects failed (non-fatal):', e.message);
    }
}

/**
 * SCHED-ROUTE-001 FR-002: recalc a job's route segments after a reschedule or
 * reassign. The caller captures the technician/days the job belonged to BEFORE
 * the change so vacated sequences are repaired; reconcile runs over before ∪
 * after. Non-fatal.
 */
async function recalcAfterJobChange(companyId, jobId, beforeTechDays) {
    try {
        const routeSeg = require('./routeSegmentService');
        await routeSeg.recalcForJob(companyId, jobId, { beforeTechDays });
    } catch (e) {
        console.error('[Schedule] route recalc failed (non-fatal):', e.message);
    }
}

/**
 * SCHED-ROUTE-001 FR-009: read stored route segments for the Schedule. NO Google
 * calls. PF007 provider scope: assigned_only providers see only their own
 * (technician_id = their crm_users.id) segments.
 */
async function getRouteSegments(companyId, { from, to, technicianId } = {}, providerScope = null) {
    const routeQueries = require('../db/routeQueries');
    let techFilter = technicianId || null;
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return { segments: [] };  // unresolved provider → nothing
        techFilter = providerScope.userId;                   // force own scope
    }
    const segments = await routeQueries.getSegmentsForRange(companyId, { from, to, technicianId: techFilter });
    return { segments };
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
    getRouteSegments,
    getDispatchSettings,
    updateDispatchSettings,
    getAvailableSlots,
    ScheduleServiceError,
};
