/**
 * Schedule Service
 * PF001 Schedule / Dispatcher MVP — Sprint 2
 *
 * Unified schedule operations across jobs, leads and tasks.
 */

const scheduleQueries = require('../db/scheduleQueries');
const { logJobActivity } = require('./jobActivityService');
const { withTransaction } = require('./transactionService');
const eventBus = require('./eventBus');

const US_STATES = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
    'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV',
    'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN',
    'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * TILE-CITY-002: best-effort locality from a formatted US address so the schedule
 * card can still show "Customer, City" when the structured `jobs.city`/`leads.city`
 * column is null (older / free-text / non-structured addresses never populated it).
 * The city is the comma component immediately before the "ST" / "ST ZIP" token
 * (e.g. "100 Test St, New York, NY, 10001" → "New York"; "…, Hanson, MA 02341, USA"
 * → "Hanson"). Display-only, never persisted; returns null if nothing matches.
 */
function deriveLocality(address) {
    if (!address || typeof address !== 'string') return null;
    const parts = address.split(',').map(p => p.trim()).filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
        const firstTok = parts[i].split(/\s+/)[0]?.toUpperCase();
        // The component before the state token is the city — unless it starts with a
        // digit (then the address had no city and we'd be about to return the street).
        if (US_STATES.has(firstTok) && parts[i - 1] && !/^\d/.test(parts[i - 1])) return parts[i - 1];
    }
    return null;
}

function domainActor(activityActor) {
    return {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
    };
}

function emitJobEvent(companyId, eventType, jobId, payload, activityActor) {
    return eventBus.emit(companyId, eventType, {
        job_id: jobId,
        record_refs: [{ type: 'job', id: jobId }],
        ...payload,
    }, {
        ...domainActor(activityActor),
        aggregateType: 'job',
        aggregateId: jobId,
    }).catch(() => {});
}

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
        job_seq: row.job_seq ?? null,
        title: row.title,
        subtitle: row.subtitle,
        status: row.status,
        start_at: row.start_at ? row.start_at.toISOString ? row.start_at.toISOString() : row.start_at : null,
        end_at: row.end_at ? row.end_at.toISOString ? row.end_at.toISOString() : row.end_at : null,
        address_summary: row.address_summary || '',
        // SCHED-ROUTE-VIS-001 (FR-3): city as its own field (jobs/leads from the
        // DB, tasks select NULL). "Customer, City" is composed on the frontend —
        // subtitle stays untouched (INV-10, shared contract).
        // TILE-CITY-002: fall back to the locality parsed from the normalized/raw address
        // when the structured column is null, so the card isn't left with just the name.
        city: row.city || deriveLocality(row.normalized_address) || deriveLocality(row.address_summary) || null,
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
    // SCHED self-heal: a job read here with an address but no coordinates is
    // invisible on the map (coordinate presence is the map's only gate). Enqueue a
    // geocode for it — dedup-guarded so repeated reads never pile up tasks,
    // fire-and-forget so the read never waits, and 'failed' addresses are left alone
    // (retrying the same bad address just fails again). This heals legacy/import
    // jobs and any future job whose async geocode enqueue was swallowed.
    try {
        const routeSeg = require('./routeSegmentService');
        for (const r of result.rows) {
            if (r.entity_type === 'job' && r.entity_id
                && r.address_summary && String(r.address_summary).trim()
                && (r.lat == null || r.lng == null)
                && r.geocoding_status !== 'failed') {
                routeSeg.enqueueGeocodeDeduped(companyId, r.entity_id).catch(() => {});
            }
        }
    } catch { /* self-heal must never break a schedule read */ }
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
 *
 * SHARED function: the dispatcher-UI reschedule AND the voice `rescheduleAppointment`
 * skill (AGENT-SKILLS-001) both call this. The local Albusto write is authoritative
 * and synchronous, and existing callers keep their exact throw/return contract:
 *   - `NOT_FOUND` (404) when the row doesn't exist / isn't in this company,
 *   - `INVALID_ENTITY_TYPE` (400) for a bad type,
 *   - otherwise the result object `{ entity_type, entity_id, start_at, end_at, zb }`.
 * The legacy `zb` outcome field remains for compatibility, but no external write is
 * attempted after Zenbooker decommissioning.
 */
async function rescheduleItem(
    companyId,
    entityType,
    entityId,
    newStartAt,
    newEndAt,
    activityActor = null
) {
    // SCHED-ROUTE-001: capture the job's technician/days before the date change.
    const before = entityType === 'job' ? await captureJobTechDays(companyId, entityId) : null;
    let updated;
    switch (entityType) {
        case 'job': {
            if (activityActor) {
                updated = await withTransaction(async (client) => {
                    const row = await scheduleQueries.rescheduleJob(
                        companyId,
                        entityId,
                        newStartAt,
                        newEndAt,
                        client
                    );
                    if (!row) {
                        throw new ScheduleServiceError(
                            'NOT_FOUND',
                            `${entityType} ${entityId} not found`,
                            404
                        );
                    }
                    await logJobActivity({
                        companyId,
                        action: 'job.rescheduled',
                        jobId: entityId,
                        actor: activityActor,
                    }, { client });
                    return row;
                });
            } else {
                updated = await scheduleQueries.rescheduleJob(
                    companyId,
                    entityId,
                    newStartAt,
                    newEndAt
                );
            }
            break;
        }
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

    // Non-job entities retain the not-applicable compatibility signal.
    if (entityType !== 'job') {
        return { entity_type: entityType, entity_id: entityId, start_at: newStartAt, end_at: newEndAt, zb: { linked: false, pushed: false, skipped: 'not_a_job' } };
    }

    // Read the job once for the typed-event assignee snapshot and historical-link
    // compatibility signal.
    const jobsService = require('./jobsService');
    let job = null;
    try {
        job = await jobsService.getJobById(entityId, companyId);
    } catch (err) {
        // The authoritative local write already succeeded.
        console.error('[Schedule] reschedule job read failed (non-fatal for local write):', err.message);
    }

    const zb = {
        linked: Boolean(job?.zenbooker_job_id),
        pushed: false,
        skipped: job?.zenbooker_job_id ? 'decommissioned' : 'not_linked',
    };

    await recalcAfterJobChange(companyId, entityId, before);
    await emitJobEvent(companyId, 'job.rescheduled', entityId, {
        assignee_user_ids: (job?.assigned_provider_user_ids || []).map(String).filter(Boolean),
    }, activityActor);
    return { entity_type: entityType, entity_id: entityId, start_at: newStartAt, end_at: newEndAt, zb };
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
async function reassignItem(
    companyId,
    entityType,
    entityId,
    assignees = [],
    activityActor = null
) {
    // JOB-PROVIDER-MULTI-001: one OR many providers. Normalize to [{id,name}] and
    // dedupe by id (a client could send the same provider twice).
    const seenIds = new Set();
    let list = (assignees || [])
        .filter(a => a && a.id != null && String(a.id) !== '')
        .map(a => ({ id: String(a.id), name: a.name || '' }))
        .filter(a => (seenIds.has(a.id) ? false : (seenIds.add(a.id), true)));
    if (entityType === 'job') {
        const technicianRosterService = require('./technicianRosterService');
        try {
            list = await technicianRosterService.canonicalizeAssignments(companyId, list);
        } catch (error) {
            throw new ScheduleServiceError(
                'INVALID_TECHNICIAN',
                error.message || 'Technician is not on the active roster',
                400
            );
        }
    }

    // SCHED-ROUTE-001: capture old technician/days so the vacated route repairs.
    const before = entityType === 'job' ? await captureJobTechDays(companyId, entityId) : null;

    // Capture the job's current providers before the write. Also resolve the new
    // providers to internal user ids so the visibility mirror
    // (assigned_provider_user_ids) is refreshed → an assigned provider sees the job
    // on their own schedule immediately.
    let oldProviderUserIds = [];
    let providerUserIds = null;
    if (entityType === 'job') {
        try {
            const jobsService = require('./jobsService');
            const job = await jobsService.getJobById(entityId, companyId);
            // MTECH-T2: internal assignee mirror (crm_users.id) BEFORE the write,
            // so assignment events target only providers newly added to the job.
            oldProviderUserIds = (job?.assigned_provider_user_ids || []).map(String).filter(Boolean);
            providerUserIds = await jobsService.resolveAssignedProviderUserIds(companyId, list);
        } catch { /* best-effort — mirror refresh skipped if we can't read it */ }
    }

    let updated;
    switch (entityType) {
        case 'job':
            if (activityActor) {
                updated = await withTransaction(async (client) => {
                    const row = await scheduleQueries.reassignJob(
                        companyId,
                        entityId,
                        list,
                        providerUserIds,
                        client
                    );
                    if (!row) {
                        throw new ScheduleServiceError(
                            'NOT_FOUND',
                            `${entityType} ${entityId} not found`,
                            404
                        );
                    }
                    await logJobActivity({
                        companyId,
                        action: list.length > 0 ? 'job.assigned' : 'job.unassigned',
                        jobId: entityId,
                        actor: activityActor,
                        summary: { count: list.length },
                    }, { client });
                    return row;
                });
            } else {
                updated = await scheduleQueries.reassignJob(
                    companyId,
                    entityId,
                    list,
                    providerUserIds
                );
            }
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

    // Emit assignment changes once. The notification subscriber resolves live
    // recipients and delivers to every active destination after this mutation.
    if (entityType === 'job') {
        try {
            const newProviderUserIds = providerUserIds ? JSON.parse(providerUserIds) : [];
            const oldSet = new Set(oldProviderUserIds);
            const addedUserIds = newProviderUserIds.map(String).filter(id => id && !oldSet.has(id));
            const newSet = new Set(newProviderUserIds.map(String));
            const removedUserIds = oldProviderUserIds.filter(id => !newSet.has(String(id)));
            if (addedUserIds.length) {
                await emitJobEvent(companyId, 'job.assigned', entityId, {
                    assignee_user_ids: addedUserIds,
                }, activityActor);
            }
            if (removedUserIds.length) {
                await emitJobEvent(companyId, 'job.unassigned', entityId, {
                    previous_recipient_user_ids: removedUserIds,
                    previous_assigned_provider_user_ids: oldProviderUserIds,
                }, activityActor);
            }
        } catch (err) {
            console.error('[Schedule] reassign event hook failed (non-fatal):', err.message);
        }
    }

    if (entityType === 'job') await recalcAfterJobChange(companyId, entityId, before);
    return { entity_type: entityType, entity_id: entityId, assignees: list, assignee_id: list[0]?.id ?? null };
}

/**
 * ZB-DECOUPLE Phase C2 (spec deferred #2): from-slot assignment ids are CLIENT
 * input, but they land in authz-bearing columns (tasks.assigned_provider_id;
 * jobs.assigned_provider_user_ids via createManualJob's direct assignee path).
 * Resolve them against the owning planes BEFORE any write:
 *   • assignee_id lives on the crm_users plane — provider scope filters match it
 *     against crm ids — so it must be an ACTIVE member of THIS company;
 *   • assigned_techs[].id lives on the roster plane — both a native UUID and a
 *     legacy ZB id are accepted, then canonicalized to technicians.id before
 *     the write, so an off-roster or cross-company id cannot be injected.
 */
async function assertFromSlotAssignment(companyId, slotData) {
    const membershipQueries = require('../db/membershipQueries');
    const technicianRosterService = require('./technicianRosterService');

    const assigneeId = slotData?.assignee_id;
    if (assigneeId != null && String(assigneeId).trim() !== '') {
        const membership = await membershipQueries.getActiveMembershipInCompany(String(assigneeId), companyId);
        if (!membership) {
            throw new ScheduleServiceError(
                'INVALID_ASSIGNEE',
                'assignee_id is not an active member of this company',
                400
            );
        }
    }

    try {
        return await technicianRosterService.canonicalizeAssignments(
            companyId,
            Array.isArray(slotData?.assigned_techs) ? slotData.assigned_techs : []
        );
    } catch (error) {
        throw new ScheduleServiceError(
            'INVALID_TECHNICIAN',
            error.message || 'assigned_techs contains a technician outside the active roster',
            400
        );
    }
}

/**
 * Create a new entity from a schedule time slot.
 * Currently only supports 'task'. Lead/Job shells can be added later.
 */
async function createFromSlot(companyId, entityType, slotData, activityActor = null) {
    // C2: validate client-supplied assignment ids before either branch writes.
    const canonicalAssignedTechs = await assertFromSlotAssignment(companyId, slotData);
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
                assigned_techs: canonicalAssignedTechs,
                zb_address: slotData.zb_address,             // structured parts for ZB sync (C-12)
            }, activityActor);
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
    const routeSeg = require('./routeSegmentService');
    let techFilter = technicianId || null;
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return { segments: [] };  // unresolved provider → nothing
        techFilter = providerScope.userId;                   // force own scope
    }
    const segments = await routeQueries.getSegmentsForRange(companyId, { from, to, technicianId: techFilter });
    // SCHED-ROUTE-VIS-001 (FR-2): lazy-on-read self-heal. Fire-and-forget on
    // setImmediate — the response never waits for it and stays structurally
    // identical. techFilter already carries the provider assigned_only scope
    // (PF007), so a provider only seeds their own tech-day pairs (S-10, INV-3).
    setImmediate(() => Promise.resolve(
        routeSeg.seedMissingForRange(companyId, { from, to, technicianId: techFilter })
    ).catch(e => console.error('[Schedule] lazy route seed failed (non-fatal):', e.message)));
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
    deriveLocality,
};
