/**
 * Jobs Service
 *
 * Local Albusto storage for Jobs with Zenbooker sync.
 * A Job is created when a Lead is converted (status = 'Converted').
 *
 * FSM:
 *   blanc_status  — parent status in Albusto (Submitted, Waiting for parts, etc.)
 *   zb_status     — Zenbooker substatus (scheduled, en-route, complete)
 *   zb_rescheduled, zb_canceled — Zenbooker boolean flags
 */

const { randomUUID } = require('node:crypto');
const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');
const fsmService = require('./fsmService');
const eventService = require('./eventService');
const eventBus = require('./eventBus');
const membershipQueries = require('../db/membershipQueries');
const { isZenbookerSyncEnabled } = require('../config/featureFlags');

// =============================================================================
// Constants
// =============================================================================

const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Part arrived',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
    'On the way',
];

/** Manual transitions allowed in Albusto UI (§7) */
const ALLOWED_TRANSITIONS = {
    'Submitted': ['Follow Up with Client', 'Waiting for parts', 'Canceled', 'On the way'],
    'Waiting for parts': ['Submitted', 'Follow Up with Client', 'Canceled', 'Part arrived'],
    // JOB-FSM-PART-ARRIVED-FORWARD-001: non-blocking — forward (On the way / Visit
    // completed), lateral (Rescheduled), back (Waiting for parts / Submitted), plus the
    // original Follow Up / Canceled. Mirrors the published-graph fix in migration 160.
    'Part arrived': ['On the way', 'Visit completed', 'Rescheduled', 'Waiting for parts', 'Follow Up with Client', 'Submitted', 'Canceled'],
    'Follow Up with Client': ['Waiting for parts', 'Submitted', 'Canceled'],
    'Visit completed': ['Follow Up with Client', 'Job is Done', 'Canceled'],
    'Job is Done': ['Canceled'],
    'Rescheduled': ['Submitted', 'Canceled', 'On the way'],
    'Canceled': [],  // terminal
    'On the way': ['Visit completed', 'Canceled'],
};

/**
 * Albusto → Zenbooker outbound sync matrix (§6).
 * Handled inline in updateBlancStatus. Documented here for reference:
 *
 *   Submitted             → no ZB action (operator-driven reopen; see note below)
 *   Waiting for parts     → no ZB action (Albusto-only operational state)
 *   Visit completed       → no ZB action (Albusto-only operational state)
 *   Job is Done           → markJobComplete                             (finalized)
 *   Canceled              → cancelJob
 *   Follow Up with Client → no ZB action (Albusto-only operational state)
 *   Rescheduled           → no ZB action (operator-driven reopen; see note below)
 *
 * Reopen limitation: Zenbooker API has NO endpoint to un-cancel or un-complete
 * a job. rescheduleJob only updates start_date + sets the rescheduled flag —
 * it does NOT reset status=complete or canceled=true back to scheduled.
 * For operator-driven reopens (Albusto → Submitted or Rescheduled on a job that
 * is still complete/canceled in ZB), Albusto maintains its own state and the
 * inbound syncFromZenbooker logic preserves it (see "operator reopen override").
 *
 * All ZB calls are skipped if the ZB job is already in the target state, to
 * avoid 4xx "already X" errors that previously blocked the local DB update.
 */

// =============================================================================
// Helpers
// =============================================================================

function rowToJob(row) {
    return {
        id: row.id,
        lead_id: row.lead_id,
        lead_serial_id: row.lead_serial_id || null,
        contact_id: row.contact_id,
        zenbooker_job_id: row.zenbooker_job_id,

        blanc_status: row.blanc_status,
        zb_status: row.zb_status,
        zb_rescheduled: row.zb_rescheduled,
        zb_canceled: row.zb_canceled,

        job_number: row.job_number,
        service_name: row.service_name,
        start_date: row.start_date ? row.start_date.toISOString() : null,
        end_date: row.end_date ? row.end_date.toISOString() : null,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        customer_email: row.customer_email,
        address: row.address,
        city: row.city || null,
        territory: row.territory,
        invoice_total: row.invoice_total,
        invoice_status: row.invoice_status,
        assigned_techs: row.assigned_techs || [],
        assigned_provider_user_ids: row.assigned_provider_user_ids || [],
        notes: row.notes || [],
        tags: row.tags || [],

        // Lead-inherited fields
        job_type: row.job_type || null,
        job_source: row.job_source || null,
        description: row.description || null,
        comments: row.comments || null,
        metadata: row.metadata || {},

        company_id: row.company_id,
        created_at: row.created_at ? row.created_at.toISOString() : null,
        updated_at: row.updated_at ? row.updated_at.toISOString() : null,

        // Coordinates stored in Albusto DB
        lat: row.lat || null,
        lng: row.lng || null,

        // Raw Zenbooker data
        zb_raw: row.zb_raw || null,
    };
}

/** Fetch tags for a single job */
async function getTagsForJob(jobId) {
    const { rows } = await db.query(`
        SELECT t.id, t.name, t.color, t.is_active
        FROM job_tag_assignments jta
        JOIN job_tags t ON t.id = jta.tag_id
        WHERE jta.job_id = $1
        ORDER BY t.sort_order, t.id
    `, [jobId]);
    return rows;
}

/** Map a Zenbooker API job object to flat columns for upsert */
function zbJobToColumns(zbJob) {
    return {
        job_number: zbJob.job_number || null,
        service_name: zbJob.service_name || zbJob.services?.[0]?.service_name || null,
        start_date: zbJob.start_date || null,
        // ZB end_date = start + job duration, but UI shows arrival window (time_slot).
        // Use time_slot.arrival_window_minutes to compute the correct end time.
        end_date: (() => {
            if (zbJob.time_slot?.arrival_window_minutes && zbJob.start_date) {
                const arrivalMs = zbJob.time_slot.arrival_window_minutes * 60 * 1000;
                return new Date(new Date(zbJob.start_date).getTime() + arrivalMs).toISOString();
            }
            return zbJob.end_date || null;
        })(),
        customer_name: zbJob.customer?.name || null,
        customer_phone: zbJob.customer?.phone || null,
        customer_email: zbJob.customer?.email || null,
        address: zbJob.service_address?.formatted ||
            [zbJob.service_address?.street, zbJob.service_address?.city,
            zbJob.service_address?.state, zbJob.service_address?.zip].filter(Boolean).join(', ') || null,
        city: zbJob.service_address?.city || null,
        territory: zbJob.territory?.name || null,
        invoice_total: zbJob.invoice?.total || null,
        invoice_status: zbJob.invoice?.status || null,
        assigned_techs: JSON.stringify(zbJob.assigned_providers || []),
        notes: JSON.stringify(zbJob.job_notes || zbJob.notes || []),
        zb_status: zbJob.status || 'scheduled',
        zb_canceled: !!zbJob.canceled,
        zb_rescheduled: !!zbJob.rescheduled,
        zb_raw: JSON.stringify(zbJob),
        lat: zbJob.service_address?.lat || null,
        lng: zbJob.service_address?.lng || null,
    };
}

/**
 * Compute blanc_status from Zenbooker flags/status + event type (priority rules)
 *   Event type is the primary signal (ZB data flags are unreliable).
 *   1. event=job.canceled OR canceled=true  → Canceled
 *   2. event=job.rescheduled OR rescheduled=true → Rescheduled
 *   3. status=complete → Visit completed
 *   4. status=scheduled/en-route → Submitted
 */
function computeBlancStatusFromZb(zbStatus, zbCanceled, zbRescheduled, eventType = '') {
    if (zbCanceled || eventType === 'job.canceled') return 'Canceled';
    if (zbStatus === 'complete' || eventType === 'job.completed') return 'Visit completed';
    if (zbRescheduled || eventType === 'job.rescheduled') return 'Rescheduled';
    return 'Submitted';
}

// =============================================================================
// Provider assignee mirror (PF007-HARDENING-001)
// =============================================================================

/**
 * Resolve a job's external assigned_techs to internal crm_users.id values
 * through the company-scoped provider bridge. Returns a JSON string for the
 * jobs.assigned_provider_user_ids JSONB column.
 *
 * Unmapped external provider ids resolve to nothing — they must never grant
 * visibility to any CRM user. Without a company the mirror stays empty.
 *
 * @param {string|null} companyId
 * @param {Array|string|null} assignedTechs - assigned_techs array or JSON string
 * @returns {Promise<string>} JSON array of crm_users.id strings
 */
async function resolveAssignedProviderUserIds(companyId, assignedTechs) {
    if (!companyId) return '[]';
    let techs = assignedTechs;
    if (typeof techs === 'string') {
        try { techs = JSON.parse(techs); } catch { techs = []; }
    }
    if (!Array.isArray(techs) || techs.length === 0) return '[]';
    const externalIds = techs.map(t => t?.id).filter(Boolean);
    const userIds = await membershipQueries.resolveProviderUserIds(companyId, externalIds);
    return JSON.stringify(userIds);
}

/**
 * Recompute the internal assignee mirror for every job in a company.
 * Called when a tenant admin changes a provider bridge mapping so existing
 * jobs immediately reflect the new ownership. Idempotent and company-scoped.
 */
async function refreshCompanyProviderMirror(companyId) {
    if (!companyId) return { updated: 0 };
    const { rowCount } = await db.query(
        `UPDATE jobs j
         SET assigned_provider_user_ids = sub.user_ids, updated_at = NOW()
         FROM (
             SELECT j2.id AS job_id,
                    COALESCE(
                        jsonb_agg(DISTINCT to_jsonb(m.user_id::text))
                            FILTER (WHERE m.user_id IS NOT NULL),
                        '[]'::jsonb
                    ) AS user_ids
             FROM jobs j2
             LEFT JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(j2.assigned_techs) = 'array'
                      THEN j2.assigned_techs ELSE '[]'::jsonb END
             ) AS tech(value) ON TRUE
             LEFT JOIN company_user_profiles p
                 ON p.zenbooker_team_member_id = tech.value->>'id'
             LEFT JOIN company_memberships m
                 ON m.id = p.membership_id
                AND m.company_id = j2.company_id
                AND m.status = 'active'
             WHERE j2.company_id = $1
             GROUP BY j2.id
         ) sub
         WHERE j.id = sub.job_id
           AND j.assigned_provider_user_ids IS DISTINCT FROM sub.user_ids`,
        [companyId]
    );
    console.log(`[JobsService] Provider mirror refresh for company ${companyId}: ${rowCount} job(s) updated`);
    return { updated: rowCount };
}

// =============================================================================
// CRUD
// =============================================================================

async function createJob({ leadId, contactId, zenbookerJobId, zbData, companyId }) {
    const cols = zbData ? zbJobToColumns(zbData) : {};
    const blancStatus = zbData
        ? computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled)
        : 'Submitted';

    const assignedProviderUserIds = await resolveAssignedProviderUserIds(companyId, cols.assigned_techs);

    const { rows } = await db.query(`
        INSERT INTO jobs (lead_id, contact_id, zenbooker_job_id, blanc_status,
            zb_status, zb_canceled, zb_rescheduled,
            job_number, service_name, start_date, end_date,
            customer_name, customer_phone, customer_email, address, city,
            territory, invoice_total, invoice_status, assigned_techs, notes,
            zb_raw, company_id, lat, lng, assigned_provider_user_ids)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT (zenbooker_job_id) DO UPDATE SET
            lead_id = COALESCE(EXCLUDED.lead_id, jobs.lead_id),
            contact_id = COALESCE(EXCLUDED.contact_id, jobs.contact_id),
            blanc_status = EXCLUDED.blanc_status,
            zb_status = EXCLUDED.zb_status,
            zb_canceled = EXCLUDED.zb_canceled,
            zb_rescheduled = EXCLUDED.zb_rescheduled,
            job_number = EXCLUDED.job_number,
            service_name = EXCLUDED.service_name,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone,
            customer_email = EXCLUDED.customer_email,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            territory = EXCLUDED.territory,
            invoice_total = EXCLUDED.invoice_total,
            invoice_status = EXCLUDED.invoice_status,
            assigned_techs = EXCLUDED.assigned_techs,
            notes = EXCLUDED.notes,
            zb_raw = EXCLUDED.zb_raw,
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            assigned_provider_user_ids = EXCLUDED.assigned_provider_user_ids,
            updated_at = NOW()
        RETURNING *
    `, [
        leadId || null, contactId || null, zenbookerJobId, blancStatus,
        cols.zb_status || 'scheduled', cols.zb_canceled || false, cols.zb_rescheduled || false,
        cols.job_number || null, cols.service_name || null, cols.start_date || null, cols.end_date || null,
        cols.customer_name || null, cols.customer_phone || null, cols.customer_email || null, cols.address || null,
        cols.city || null,
        cols.territory || null, cols.invoice_total || null, cols.invoice_status || null,
        cols.assigned_techs || '[]', cols.notes || '[]',
        cols.zb_raw || '{}', companyId || null, cols.lat || null, cols.lng || null,
        assignedProviderUserIds,
    ]);

    return rowToJob(rows[0]);
}

/**
 * SCHED-ROUTE-001 (FR-001): create a job manually in Albusto (no ZenBooker sync
 * path). Assignment uses INTERNAL crm_users.id directly (C-2): provider lane id
 * → assigned_provider_user_ids. If the caller already has trustworthy coordinates
 * (e.g. from AddressAutocomplete), geocoding_status is set to 'success' so no
 * paid geocode is needed; otherwise 'not_geocoded' and the caller enqueues one.
 * Returns the raw job row.
 */
async function createManualJob(companyId, input = {}) {
    if (!companyId) throw new Error('createManualJob requires companyId');
    const blancStatus = input.blanc_status || 'Submitted';

    // Assignment (FR-001.4 / C-2): the UI groups by assigned_techs[].id (ZenBooker
    // team-member id) but the route engine keys on the INTERNAL crm_users.id.
    // Accept the ZB-shaped assigned_techs from the lane, store it for the UI, and
    // resolve the internal mirror so routing works. A direct assignee_id (already
    // an internal id) is still honoured for internal callers.
    const assignedTechs = Array.isArray(input.assigned_techs) ? input.assigned_techs : [];
    let providerUserIds;
    if (assignedTechs.length) {
        providerUserIds = JSON.parse(await resolveAssignedProviderUserIds(companyId, assignedTechs));
    } else if (Array.isArray(input.assigned_provider_user_ids)) {
        providerUserIds = input.assigned_provider_user_ids.map(String).filter(Boolean);
    } else {
        providerUserIds = input.assignee_id ? [String(input.assignee_id)] : [];
    }
    const hasCoords = input.lat != null && input.lng != null;
    const geocodingStatus = hasCoords ? 'success' : 'not_geocoded';

    const { rows } = await db.query(
        `INSERT INTO jobs
            (company_id, blanc_status, zb_status, service_name, start_date, end_date,
             customer_name, customer_phone, customer_email, address, lat, lng,
             normalized_address, geocoding_status, geocoding_place_id, geocoded_at,
             geocoding_provider, assigned_techs, assigned_provider_user_ids, notes, zb_raw)
         VALUES ($1,$2,'scheduled',$3,$4,$5,$6,$7,$8,$9,$10::double precision,$11::double precision,$12,$13,$14,
                 CASE WHEN $10::double precision IS NOT NULL AND $11::double precision IS NOT NULL THEN now() ELSE NULL END,
                 'google_maps',$16::jsonb,$15::jsonb,'[]'::jsonb,'{}'::jsonb)
         RETURNING *`,
        [companyId, blancStatus, input.service_name || null,
         input.start_date || null, input.end_date || null,
         input.customer_name || null, input.customer_phone || null, input.customer_email || null,
         input.address || null, hasCoords ? input.lat : null, hasCoords ? input.lng : null,
         input.normalized_address || null, geocodingStatus, input.geocoding_place_id || null,
         JSON.stringify(providerUserIds), JSON.stringify(assignedTechs)]
    );
    const job = rows[0];

    // C-12 / FR-001.4: best-effort, dedupe-guarded create back into ZenBooker
    // during the wind-down (flag-gated; async so the HTTP save never blocks).
    if (isZenbookerSyncEnabled() && !job.zenbooker_job_id) {
        await enqueueZbJobSync(companyId, job.id, { address: input.zb_address || null })
            .catch(e => console.error('[JobsService] zb sync enqueue failed (non-fatal):', e.message));
    }
    return job;
}

/**
 * Create a Job directly (no lead → job conversion path). Mirrors the ZenBooker
 * create + sync-back block of leadsService.convertLead, but starting from a small
 * structured input instead of a lead row.
 *
 * input = {
 *   contact: { contact_id:number } | { name:string, phone:string, email?:string },
 *   address: { line1?, line2?, city?, state?, postal_code?, lat?, lng? },
 *   slot:    { start:ISO, end:ISO, tech_id?:string|null },
 *   job_type: string,
 *   description?: string,
 * }
 *
 * Steps:
 *   a. Resolve the contact (existing id is company-scoped; otherwise dedupe).
 *   b. Build the ZB payload (territory from ZIP, custom service, arrival window).
 *   c. Try to create the ZB job. On success: fetch detail (retry once for
 *      job_number) and persist via createJob({ zbData }). On failure: create a
 *      local job with the input data and surface a zb_warning.
 *
 * @param {string} companyId  — ONLY from req.companyFilter (never req.companyId)
 * @param {Object} input
 * @returns {Promise<{ job_id:number, zenbooker_job_id:string|null, zb_warning:string|null }>}
 */
async function createDirectJob(companyId, input = {}) {
    if (!companyId) {
        const err = new Error('createDirectJob requires companyId');
        err.httpStatus = 403;
        throw err;
    }

    const contactDedupeService = require('./contactDedupeService');
    const contactInput = input.contact || {};
    const address = input.address || {};
    const slot = input.slot || {};
    const jobType = input.job_type || 'General Service';
    const description = input.description || '';
    // Shared lead/job fields (same data model as the New Lead form): lead source
    // + Additional-info custom fields, persisted onto the local job's metadata jsonb.
    const leadSource = (input.lead_source || '').trim();
    const customMeta = (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata))
        ? input.metadata : {};

    // ── a. Resolve contact ────────────────────────────────────────────────────
    let contactId = null;
    if (contactInput.contact_id != null) {
        // Existing contact — must belong to this company (tenant isolation).
        const { rows } = await db.query(
            'SELECT id FROM contacts WHERE id = $1 AND company_id = $2',
            [contactInput.contact_id, companyId]
        );
        if (rows.length === 0) {
            const err = new Error('Contact not found');
            err.httpStatus = 404;
            throw err;
        }
        contactId = rows[0].id;
    } else {
        // New/unknown contact — split name on first space, dedupe-resolve.
        const name = (contactInput.name || '').trim();
        const spaceIdx = name.indexOf(' ');
        const firstName = spaceIdx === -1 ? name : name.slice(0, spaceIdx);
        const lastName = spaceIdx === -1 ? null : name.slice(spaceIdx + 1).trim() || null;
        const resolved = await contactDedupeService.resolveContact({
            first_name: firstName || null,
            last_name: lastName,
            phone: contactInput.phone || null,
            email: contactInput.email || null,
        }, companyId);
        contactId = resolved.contact_id || null;
    }

    // ── b. Build ZB payload ───────────────────────────────────────────────────
    // Contact display data for the customer block + local fallback insert.
    let customerName = contactInput.name || null;
    let customerPhone = contactInput.phone || null;
    let customerEmail = contactInput.email || null;
    if (contactInput.contact_id != null && contactId) {
        const { rows } = await db.query(
            'SELECT full_name, phone_e164, email FROM contacts WHERE id = $1 AND company_id = $2',
            [contactId, companyId]
        );
        if (rows[0]) {
            customerName = rows[0].full_name || customerName;
            customerPhone = rows[0].phone_e164 || customerPhone;
            customerEmail = rows[0].email || customerEmail;
        }
    }

    const territoryId = await zenbookerClient.findTerritoryByPostalCode(address.postal_code);

    const customer = {};
    if (customerName) customer.name = customerName;
    if (customerPhone) customer.phone = customerPhone;
    if (customerEmail) customer.email = customerEmail;

    // zenbookerClient.createJob → ensureAddressState backfills state from the ZIP.
    const zbAddress = { country: 'US' };
    if (address.line1) zbAddress.line1 = address.line1;
    if (address.line2) zbAddress.line2 = address.line2;
    if (address.city) zbAddress.city = address.city;
    if (address.state) zbAddress.state = address.state;
    if (address.postal_code) zbAddress.postal_code = address.postal_code;

    const zbPayload = {
        territory_id: territoryId,
        customer,
        address: zbAddress,
        services: [{
            custom_service: {
                name: jobType,
                description,
                price: 0,
                duration: 120,
                taxable: false,
            },
        }],
        timeslot: { type: 'arrival_window', start: slot.start, end: slot.end },
        sms_notifications: true,
        email_notifications: true,
    };
    if (slot.tech_id) {
        // ZB rejects assigned_providers + assignment_method:'auto' together.
        zbPayload.assigned_providers = [slot.tech_id];
    } else {
        zbPayload.assignment_method = 'auto';
    }

    // ── c. Create ZB job; persist local job either way ────────────────────────
    let zenbookerJobId = null;
    let zbWarning = null;
    let localJob = null;

    try {
        const zbResult = await zenbookerClient.createJob(zbPayload);
        zenbookerJobId = zbResult.job_id;

        // ZB may not assign job_number immediately — retry once after a short delay.
        let detail = await zenbookerClient.getJob(zenbookerJobId);
        if (!detail?.job_number) {
            await new Promise(r => setTimeout(r, 2000));
            detail = await zenbookerClient.getJob(zenbookerJobId);
        }

        localJob = await createJob({ contactId, zenbookerJobId, zbData: detail, companyId });
        console.log(`[CreateDirectJob] Zenbooker job ${zenbookerJobId} created → local job ${localJob.id}`);
    } catch (err) {
        // ZB nests the reason under error.message (e.g. INVALID_ADDRESS).
        const errData = err.response?.data;
        zbWarning = errData?.error?.message || errData?.message || err.message;
        console.error('[CreateDirectJob] Zenbooker create error:', errData || err.message);

        // No ZB link — persist a local-only job with the input data
        // (mirror of claimLocalJobForConversion's local insert shape).
        const addressStr = [address.line1, address.line2, address.city, address.state, address.postal_code]
            .filter(Boolean).join(', ') || null;
        // No geocode in this path; the structured create input already carries the
        // city, so persist it directly (TILE-CITY-001).
        const cityValue = address.city || null;
        const assignedTechs = slot.tech_id ? JSON.stringify([{ id: slot.tech_id }]) : '[]';
        const { rows } = await db.query(`
            INSERT INTO jobs (
                contact_id, company_id, blanc_status, service_name,
                customer_name, customer_phone, customer_email, address, city,
                start_date, end_date, assigned_techs
            ) VALUES ($1, $2, 'Submitted', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            RETURNING *
        `, [
            contactId, companyId, jobType,
            customerName, customerPhone, customerEmail, addressStr, cityValue,
            slot.start || null, slot.end || null, assignedTechs,
        ]);
        localJob = rowToJob(rows[0]);
        console.log(`[CreateDirectJob] Local job ${localJob.id} created without ZB link: ${zbWarning}`);
    }

    // Merge shared fields into the local job's metadata (best-effort; never blocks
    // the create). lead_source lives under metadata.lead_source alongside the
    // Additional-info custom fields, mirroring the New Lead form's data shape.
    const jobMetadata = { ...customMeta };
    if (leadSource) jobMetadata.lead_source = leadSource;
    if (localJob && Object.keys(jobMetadata).length > 0) {
        try {
            await db.query(
                `UPDATE jobs SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = now()
                 WHERE id = $2 AND company_id = $3`,
                [JSON.stringify(jobMetadata), localJob.id, companyId]
            );
        } catch (e) {
            console.error('[CreateDirectJob] metadata merge failed (non-fatal):', e.message);
        }
    }

    // [CHANGE START] REPAIR-ADVISOR-001 (T6): post-commit domain event for the
    // AI Repair Advisor subscriber (kb-diagnostics). Additive only — fire-and-forget
    // so a failing bus never breaks the create; emit itself also never throws into
    // the producer (§3.2). The human create-path always emits.
    eventBus.emit(
        companyId,
        'job.created',
        { id: localJob.id, jobId: localJob.id, companyId },
        { actorType: 'user', aggregateType: 'job', aggregateId: localJob.id }
    ).catch(() => {});
    // [CHANGE END]

    // JOB-CONTACT-SYNC-001: the form's phone/email must also land on the linked
    // contact (dedupe can match by name alone; the picked contact may be a bare
    // ZB import) — otherwise inbound calls/SMS never match and the Pulse
    // timeline stays orphaned. Fill-empty-only; never blocks the create.
    if (contactId && (contactInput.phone || contactInput.email)) {
        try {
            const { propagateContactDetails } = require('./contactPropagationService');
            await propagateContactDetails(companyId, contactId,
                { phone: contactInput.phone || null, email: contactInput.email || null },
                { source: 'job_create' });
        } catch (e) {
            console.error('[CreateDirectJob] contact propagation failed (non-fatal):', e.message);
        }
    }

    return { job_id: localJob.id, zenbooker_job_id: zenbookerJobId, zb_warning: zbWarning };
}

/**
 * Enqueue a one-shot ZenBooker sync for a locally-created job on the agentWorker
 * (kind='agent', FOR UPDATE SKIP LOCKED → processed once). Marks the job
 * zb_sync_status='pending'. The dedupe-guard lives in the handler (skips if a
 * zenbooker_job_id already exists). `parts.address` carries structured address
 * fields (line1/city/state/postal_code) captured at create time.
 */
async function enqueueZbJobSync(companyId, jobId, parts = {}) {
    await db.query(
        `INSERT INTO tasks (company_id, kind, agent_type, agent_status, agent_input, status, title, created_by)
         VALUES ($1,'agent','zb_job_sync','queued',$2::jsonb,'open',$3,'system')`,
        [companyId, JSON.stringify({ job_id: jobId, ...parts }), `ZB sync job ${jobId}`]
    );
    await db.query(
        `UPDATE jobs SET zb_sync_status='pending', updated_at=now() WHERE id=$1 AND company_id=$2`,
        [jobId, companyId]
    );
}

async function getJobById(id, companyId = null, providerScope = null) {
    const conditions = ['j.id = $1'];
    const params = [id];
    if (companyId) {
        conditions.push('j.company_id = $2');
        params.push(companyId);
    }
    // assigned_only providers see only jobs whose internal assignee mirror
    // contains their crm_users.id; without a resolved user — nothing (PF007).
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return null;
        params.push(JSON.stringify([providerScope.userId]));
        conditions.push(`j.assigned_provider_user_ids @> $${params.length}::jsonb`);
    }
    const { rows } = await db.query(
        `SELECT j.*, l.serial_id AS lead_serial_id
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    if (rows.length === 0) return null;
    const job = rowToJob(rows[0]);
    job.tags = await getTagsForJob(id);
    return job;
}

async function getJobByZbId(zbJobId) {
    const { rows } = await db.query('SELECT * FROM jobs WHERE zenbooker_job_id = $1', [zbJobId]);
    if (rows.length === 0) return null;
    return rowToJob(rows[0]);
}

async function listJobs({ blancStatus, zbCanceled, search, offset = 0, limit = 50, companyId, contactId, sortBy, sortOrder, onlyOpen, startDate, endDate, serviceName, provider, tagIds, tagMatch, providerScope } = {}) {
    const conditions = [];
    const params = [];
    let idx = 0;

    if (companyId) {
        idx++; conditions.push(`j.company_id = $${idx}`); params.push(companyId);
    }
    // assigned_only visibility (PF007): only jobs whose internal assignee
    // mirror contains the current crm_users.id. No user → empty result.
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) {
            conditions.push('FALSE');
        } else {
            idx++; conditions.push(`j.assigned_provider_user_ids @> $${idx}::jsonb`);
            params.push(JSON.stringify([providerScope.userId]));
        }
    }
    if (blancStatus) {
        // Support comma-separated multi-value: "Submitted,Rescheduled"
        const statuses = blancStatus.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
            idx++; conditions.push(`j.blanc_status = $${idx}`); params.push(statuses[0]);
        } else if (statuses.length > 1) {
            const placeholders = statuses.map(() => { idx++; return `$${idx}`; });
            conditions.push(`j.blanc_status IN (${placeholders.join(',')})`);
            params.push(...statuses);
        }
    }
    if (zbCanceled !== undefined) {
        idx++; conditions.push(`j.zb_canceled = $${idx}`); params.push(zbCanceled === 'true' || zbCanceled === true);
    }
    if (search) {
        idx++;
        const searchClauses = [
            `j.job_number ILIKE $${idx}`,
            `j.service_name ILIKE $${idx}`,
            `j.customer_name ILIKE $${idx}`,
            `j.customer_phone ILIKE $${idx}`,
            `j.address ILIKE $${idx}`,
            `EXISTS (
                SELECT 1 FROM job_tag_assignments jta2
                JOIN job_tags t2 ON t2.id = jta2.tag_id
                WHERE jta2.job_id = j.id AND t2.name ILIKE $${idx}
            )`,
        ];

        // Add searchable metadata fields
        try {
            const { rows: searchableFields } = await db.query(
                `SELECT api_name FROM lead_custom_fields WHERE is_searchable = true AND is_system = false`
            );
            for (const f of searchableFields) {
                const key = f.api_name.replace(/[^a-zA-Z0-9_]/g, ''); // sanitize
                if (key) {
                    searchClauses.push(`j.metadata->>'${key}' ILIKE $${idx}`);
                }
            }
        } catch (err) {
            console.warn('[JobsService] Could not load searchable fields:', err.message);
        }

        conditions.push(`(${searchClauses.join(' OR\n            ')})`);
        params.push(`%${search}%`);
    }
    if (contactId) {
        idx++; conditions.push(`j.contact_id = $${idx}`); params.push(contactId);
    }
    if (onlyOpen) {
        conditions.push(`j.blanc_status NOT IN ('Job is Done', 'Canceled')`);
    }
    if (startDate) {
        idx++; conditions.push(`j.start_date >= $${idx}`); params.push(startDate);
    }
    if (endDate) {
        idx++; conditions.push(`j.start_date <= $${idx}`); params.push(endDate + ' 23:59:59');
    }
    if (serviceName) {
        const names = serviceName.split(',').map(s => s.trim()).filter(Boolean);
        if (names.length === 1) {
            idx++; conditions.push(`j.service_name = $${idx}`); params.push(names[0]);
        } else if (names.length > 1) {
            const placeholders = names.map(() => { idx++; return `$${idx}`; });
            conditions.push(`j.service_name IN (${placeholders.join(',')})`);
            params.push(...names);
        }
    }
    if (provider) {
        const providers = provider.split(',').map(s => s.trim()).filter(Boolean);
        // assigned_techs is JSONB array — search for matching provider name
        const providerConditions = providers.map(() => {
            idx++; return `j.assigned_techs::text ILIKE $${idx}`;
        });
        conditions.push(`(${providerConditions.join(' OR ')})`);
        params.push(...providers.map(p => `%${p}%`));
    }
    if (tagIds) {
        const ids = tagIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (ids.length > 0) {
            if (tagMatch === 'all' && ids.length > 1) {
                // ALL mode: job must have ALL selected tags
                const placeholders = ids.map(() => { idx++; return `$${idx}`; });
                conditions.push(`(
                    SELECT COUNT(DISTINCT jta3.tag_id) FROM job_tag_assignments jta3
                    WHERE jta3.job_id = j.id AND jta3.tag_id IN (${placeholders.join(',')})
                ) = ${ids.length}`);
                params.push(...ids);
            } else {
                // ANY mode (default): job has at least one of selected tags
                const placeholders = ids.map(() => { idx++; return `$${idx}`; });
                conditions.push(`EXISTS (
                    SELECT 1 FROM job_tag_assignments jta3
                    WHERE jta3.job_id = j.id AND jta3.tag_id IN (${placeholders.join(',')})
                )`);
                params.push(...ids);
            }
        }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const { rows: countRows } = await db.query(
        `SELECT COUNT(*) as total FROM jobs j ${whereClause}`, params
    );
    const total = parseInt(countRows[0].total, 10);

    // Sort — whitelist columns to prevent SQL injection
    const SORTABLE_COLUMNS = {
        job_number: 'j.job_number',
        customer_name: 'j.customer_name',
        customer_phone: 'j.customer_phone',
        customer_email: 'j.customer_email',
        service_name: 'j.service_name',
        start_date: 'j.start_date',
        end_date: 'j.end_date',
        blanc_status: 'j.blanc_status',
        zb_status: 'j.zb_status',
        address: 'j.address',
        territory: 'j.territory',
        invoice_total: 'j.invoice_total',
        invoice_status: 'j.invoice_status',
        job_type: 'j.job_type',
        job_source: 'j.job_source',
        description: 'j.description',
        created_at: 'j.created_at',
        updated_at: 'j.updated_at',
    };
    let sortCol = SORTABLE_COLUMNS[sortBy] || 'j.created_at';
    // Support sorting by metadata fields: meta:field_name → j.metadata->>'field_name'
    if (sortBy && sortBy.startsWith('meta:')) {
        const metaKey = sortBy.slice(5).replace(/[^a-zA-Z0-9_]/g, ''); // sanitize
        if (metaKey) sortCol = `j.metadata->>'${metaKey}'`;
    }
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const orderClause = `ORDER BY ${sortCol} ${sortDir} NULLS LAST`;

    // Data
    idx++; params.push(limit);
    idx++; params.push(offset);
    const { rows } = await db.query(`
        SELECT j.* FROM jobs j
        ${whereClause}
        ${orderClause}
        LIMIT $${idx - 1} OFFSET $${idx}
    `, params);

    // Fetch tags for all jobs in batch
    const jobIds = rows.map(r => r.id);
    let tagsMap = {};
    if (jobIds.length > 0) {
        const { rows: tagRows } = await db.query(`
            SELECT jta.job_id, t.id, t.name, t.color, t.is_active
            FROM job_tag_assignments jta
            JOIN job_tags t ON t.id = jta.tag_id
            WHERE jta.job_id = ANY($1)
            ORDER BY t.sort_order, t.id
        `, [jobIds]);
        for (const tr of tagRows) {
            if (!tagsMap[tr.job_id]) tagsMap[tr.job_id] = [];
            tagsMap[tr.job_id].push({ id: tr.id, name: tr.name, color: tr.color, is_active: tr.is_active });
        }
    }

    // Fetch actual paid + outstanding amounts from invoices for all jobs in batch.
    // Exclude void/refunded invoices (not real money owed) so they can't skew the
    // totals. A job present in this map has local invoices → both amounts are
    // strings; a job absent from it has no local invoice → amount_paid/balance_due
    // stay null, which is the signal the tile uses to fall back to Zenbooker.
    let paymentsMap = {};
    if (jobIds.length > 0 && companyId) {
        const { rows: paidRows } = await db.query(`
            SELECT i.job_id,
                   SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.amount_paid, 0) ELSE 0 END) AS total_paid,
                   SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.balance_due, 0) ELSE 0 END) AS total_due
            FROM invoices i
            WHERE i.job_id = ANY($1) AND i.company_id = $2
            GROUP BY i.job_id
        `, [jobIds, companyId]);
        for (const pr of paidRows) {
            paymentsMap[pr.job_id] = { total_paid: pr.total_paid, total_due: pr.total_due };
        }
    }

    const results = rows.map(r => {
        const job = rowToJob(r);
        job.tags = tagsMap[r.id] || [];
        const pay = paymentsMap[r.id];
        // No local invoice → leave both null so the tile uses the Zenbooker fallback.
        job.amount_paid = pay ? pay.total_paid : null;
        job.balance_due = pay ? pay.total_due : null;
        return job;
    });

    return {
        results,
        total,
        offset,
        limit,
        has_more: offset + rows.length < total,
    };
}

/**
 * Sum a single job's LOCAL invoice money (dollars), company-scoped, EXCLUDING
 * void/voided/refunded — the SAME exclusion set as listJobs' payments rollup
 * (see ~L815). Used by the outbound "part arrived" call flow so the voice agent
 * can answer "how much do I owe?" without a live DB lookup during the call.
 *
 * Returns dollar Numbers (pg NUMERIC comes back as strings → coerced), or null
 * for ALL three fields when the job has NO local invoice row — mirroring
 * listJobs' "absent from paymentsMap" signal. NEVER invents 0 for a job that has
 * no invoice (a job whose only invoices are void/refunded still counts as having
 * invoices → sums to 0, not null, exactly as listJobs behaves).
 *
 * @param {number|string} jobId    Job whose invoices to sum.
 * @param {string}        companyId Tenant scope (mandatory; missing → null result).
 * @returns {Promise<{ balanceDue:number|null, total:number|null, amountPaid:number|null }>}
 */
async function getJobBalanceDue(jobId, companyId) {
    const NONE = { balanceDue: null, total: null, amountPaid: null };
    // Company scoping is mandatory — without it we neither query nor guess.
    if (!jobId || !companyId) return NONE;

    const { rows } = await db.query(`
        SELECT
            SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.total, 0)       ELSE 0 END) AS total,
            SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.amount_paid, 0) ELSE 0 END) AS amount_paid,
            SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.balance_due, 0) ELSE 0 END) AS balance_due
        FROM invoices i
        WHERE i.job_id = $1 AND i.company_id = $2
        GROUP BY i.job_id
    `, [jobId, companyId]);

    // GROUP BY yields NO row when the job has no local invoice → the "no invoice"
    // signal (all null). Any invoice row present → one row of numeric sums.
    if (rows.length === 0) return NONE;
    const r = rows[0];
    const num = (v) => (v == null ? null : Number(v));
    return { balanceDue: num(r.balance_due), total: num(r.total), amountPaid: num(r.amount_paid) };
}

// =============================================================================
// FSM — Manual status transitions
// =============================================================================

/**
 * OUTBOUND-PARTS-CALL-CANCEL-001 (CC-02) — the leave-hook seam, symmetric to the
 * onPartArrived enter-hook below. Fired (fire-and-forget — NEVER awaited into the
 * caller's failure path) after ANY committed write that takes a job OUT of
 * 'Part arrived': updateBlancStatus, cancelJob, markComplete, and the
 * syncFromZenbooker `zb_canceled` false→true flip (the sync cannot exit the
 * status via blanc_status — 'Part arrived' ∉ autoStatuses, preserved below).
 * Cancels the queued robot call (pending flip / dialing marker), writes the FR-3
 * job note and stamps the task — all inside
 * partsCallService.cancelScheduledRobotCalls, which is idempotent and never
 * throws. Same idiom as the enter-hook (lazy-require against the circular dep,
 * sync try/catch + async .catch, console.warn only — a cancel failure must never
 * fail the status change, S1/S10).
 */
function fireRobotCallLeaveHook(jobId, companyId, newStatus) {
    try {
        require('./partsCallService')
            .cancelScheduledRobotCalls({ jobId }, companyId, { kind: 'status_change', newStatus })
            .catch(err => console.warn('[jobsService] robot-call leave-hook failed (non-blocking):', err.message));
    } catch (err) {
        console.warn('[jobsService] robot-call leave-hook failed (non-blocking):', err.message);
    }
}

async function updateBlancStatus(jobId, newStatus, companyId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    // Try FSM resolution first
    if (companyId) {
        const result = await fsmService.resolveTransition(companyId, 'job', job.blanc_status, newStatus);
        if (result.valid === true) {
            // FSM approved the transition — proceed with DB update below
        } else if (result.valid === false) {
            throw new Error(result.error || `Transition ${job.blanc_status} → ${newStatus} is not allowed`);
        }
        // If result.fallback === true, fall through to hardcoded check
        if (!result.fallback) {
            // FSM gave a definitive answer, skip hardcoded validation
        } else {
            // Fallback: original hardcoded validation
            if (!BLANC_STATUSES.includes(newStatus)) {
                throw new Error(`Invalid blanc_status: ${newStatus}`);
            }
            const allowed = ALLOWED_TRANSITIONS[job.blanc_status] || [];
            if (!allowed.includes(newStatus)) {
                throw new Error(`Transition ${job.blanc_status} → ${newStatus} is not allowed`);
            }
        }
    } else {
        // No companyId — use hardcoded validation
        if (!BLANC_STATUSES.includes(newStatus)) {
            throw new Error(`Invalid blanc_status: ${newStatus}`);
        }
        const allowed = ALLOWED_TRANSITIONS[job.blanc_status] || [];
        if (!allowed.includes(newStatus)) {
            throw new Error(`Transition ${job.blanc_status} → ${newStatus} is not allowed`);
        }
    }

    // $1 (blanc_status, varchar) must NOT be reused in the CASE comparison —
    // Postgres then deduces two types for it ("inconsistent types deduced for
    // parameter $1") and the whole UPDATE fails for every status change. Pass the
    // canceled flag as its own boolean param.
    await db.query(
        `UPDATE jobs
         SET blanc_status = $1,
             zb_canceled = CASE WHEN $2 THEN true ELSE zb_canceled END,
             updated_at = NOW()
         WHERE id = $3`,
        [newStatus, newStatus === 'Canceled', jobId]
    );

    // Outbound sync to Zenbooker — full mapping with no-op guards (§6).
    // Errors are logged but NOT thrown — local DB is source of truth and must not
    // be rolled back if ZB sync fails.
    //
    // Note: Submitted and Rescheduled intentionally do NOT call ZB. Zenbooker
    // has no API to un-cancel or un-complete a job (reschedule only updates
    // start_date + rescheduled flag, not status/canceled). For operator-driven
    // reopens, Albusto diverges intentionally; the inbound sync preserves the
    // override (see syncFromZenbooker "operator reopen override").
    if (job.zenbooker_job_id) {
        try {
            if (newStatus === 'Job is Done') {
                if (job.zb_status !== 'complete') {
                    await zenbookerClient.markJobComplete(job.zenbooker_job_id);
                    console.log(`[JobsService] Outbound: job ${jobId} → ${newStatus} (ZB markComplete)`);
                }
            } else if (newStatus === 'Canceled') {
                if (!job.zb_canceled) {
                    await zenbookerClient.cancelJob(job.zenbooker_job_id);
                    console.log(`[JobsService] Outbound: job ${jobId} → Canceled (ZB cancel)`);
                }
            }
            // Submitted, Rescheduled, Follow Up with Client, Part arrived — no ZB action
            // (Part arrived is an Albusto-only operational state, like Waiting for parts)
        } catch (err) {
            console.error(`[JobsService] Outbound sync error for ${newStatus}:`, err.response?.data || err.message);
        }
    }

    // Fail-safe trigger seam (OUTBOUND-PARTS-CALL-001 §B.2 / S13): entering
    // 'Part arrived' fires the idempotent auto-task creation. Fire-and-forget —
    // NEVER awaited, NEVER rolls back or blocks the already-committed transition
    // (mirrors eventService.logEvent discipline). Lazy-require partsCallService to
    // avoid a circular dependency (partsCallService → tasksQueries).
    if (newStatus === 'Part arrived' && job.blanc_status !== 'Part arrived') {
        try {
            require('./partsCallService')
                .onPartArrived(jobId, companyId)
                .catch(err => console.warn('[jobsService] onPartArrived hook failed (non-blocking):', err.message));
        } catch (err) {
            console.warn('[jobsService] onPartArrived hook failed (non-blocking):', err.message);
        }
    }

    // CANCEL-001 leave-hook (CC-02 S1/S2): the job just left 'Part arrived' — any
    // queued robot call must not survive the exit. companyId can be null on the
    // legacy no-company path → fall back to the job row's own tenant.
    if (job.blanc_status === 'Part arrived' && newStatus !== 'Part arrived') {
        fireRobotCallLeaveHook(jobId, companyId || job.company_id, newStatus);
    }

    return { ...job, blanc_status: newStatus, _prev_status: job.blanc_status };
}

// =============================================================================
// Sync — Inbound from Zenbooker webhook
// =============================================================================

/**
 * Sync a Zenbooker job event into the local jobs table.
 * Creates or updates the local job, recalculates blanc_status.
 */
/**
 * Merge incoming Zenbooker notes with existing local notes, preserving Albusto-side
 * metadata (author, created, attachments) when a match is found.
 *
 * Match priority:
 *   1. by zb_note_id captured from previous addNote response
 *   2. by raw ZB id (for idempotent re-sync after a merge has already happened)
 *   3. by text match against any not-yet-correlated local note (no zb_note_id) —
 *      INCLUDING freshly-created in-app notes, which carry a local `id` but no ZB
 *      id until their `job.note_added` echo arrives. Matching by text preserves
 *      that local id so the client's edit/delete keep working (NOTES-ID-STABLE-001;
 *      previously the echo re-id'd the note and edits 404'd until a page refresh).
 * Finally, Albusto-authored notes ZB hasn't echoed yet are carried forward instead
 * of dropped (a sync firing before the echo must not lose or re-id a fresh note).
 */
function mergeNotes(localNotes, zbNotes) {
    const byZbId = new Map();          // zb id → local note
    const unmatchedLocalByText = [];   // [{ note, used }]
    const matched = new Set();         // local notes folded into a ZB note (by ref)
    for (const ln of (localNotes || [])) {
        const lid = ln.zb_note_id || ln.id;
        if (lid) byZbId.set(String(lid), ln);
        // Any not-yet-correlated local note (no zb_note_id) with text is a text-match
        // candidate — including in-app notes that already have a local `id`
        // (NOTES-ID-STABLE-001). No `author` gate: it must stay aligned with the
        // `unechoed` filter below, else an author-less local note would be appended
        // AND left un-text-matched → a persistent duplicate.
        if (!ln.zb_note_id && ln.text) {
            unmatchedLocalByText.push({ note: ln, used: false });
        }
    }

    // Always carry these Albusto-side fields forward when a ZB note matches a local
    // one. When the local note was edited (edited_at set) we keep the local text —
    // otherwise an edit would silently revert on the next re-sync (NOTES-001).
    const preserveLocal = (ln) => ({
        ...(ln.author ? { author: ln.author } : {}),
        ...(ln.created ? { created: ln.created } : {}),
        ...(ln.attachments && ln.attachments.length ? { attachments: ln.attachments } : {}),
        ...(ln.id ? { id: ln.id } : {}),
        ...(ln.created_by ? { created_by: ln.created_by } : {}),
        ...(ln.deleted_at ? { deleted_at: ln.deleted_at, deleted_by: ln.deleted_by || null } : {}),
        ...(ln.edited_at ? { edited_at: ln.edited_at, edited_by: ln.edited_by || null, text: ln.text } : {}),
    });

    const merged = (zbNotes || []).map(zn => {
        const znId = zn.id ? String(zn.id) : null;
        if (znId && byZbId.has(znId)) {
            const ln = byZbId.get(znId);
            matched.add(ln);
            return {
                ...zn,
                ...preserveLocal(ln),
                zb_note_id: znId,
            };
        }
        if (zn.text) {
            const znText = String(zn.text).trim();
            for (const entry of unmatchedLocalByText) {
                if (!entry.used && String(entry.note.text || '').trim() === znText) {
                    entry.used = true;
                    matched.add(entry.note);
                    return {
                        ...zn,
                        ...preserveLocal(entry.note),
                        author: entry.note.author,
                        ...(znId ? { zb_note_id: znId } : {}),
                    };
                }
            }
        }
        return zn;
    });

    // Carry forward Albusto-authored notes ZB hasn't echoed yet: created in-app
    // (local id + created_by), not soft-deleted, and never correlated to a ZB id
    // (a correlated note ZB no longer returns is a genuine ZB-side delete → drop).
    const unechoed = (localNotes || []).filter(ln =>
        ln && ln.id && ln.created_by && !ln.deleted_at && !ln.zb_note_id && !matched.has(ln)
    );
    return [...merged, ...unechoed];
}

async function syncFromZenbooker(zbJobId, zbData, companyId = null, eventType = '') {
    const cols = zbJobToColumns(zbData);
    const newBlancStatus = computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled, eventType);

    // Try to match ZB customer → Albusto contact
    let contactId = null;
    const zbCustomerId = zbData.customer?.id ? String(zbData.customer.id) : null;
    if (zbCustomerId) {
        const { rows: contactRows } = await db.query(
            'SELECT id FROM contacts WHERE zenbooker_customer_id = $1 LIMIT 1',
            [zbCustomerId]
        );
        if (contactRows.length > 0) {
            contactId = contactRows[0].id;
            console.log(`[JobsService] Matched ZB customer ${zbCustomerId} → contact ${contactId}`);
        }
    }

    // Check if job exists
    const existing = await getJobByZbId(zbJobId);

    // JOB-CONTACT-SYNC-001: ZB imports routinely create bare contacts (no
    // phone/email) while the ZB job carries them — then inbound calls never
    // match and Pulse timelines stay orphaned (prod case: job 1359 / timeline
    // 2911). Enrich the matched contact from the ZB customer data.
    // Fill-empty-only + never-steal; cheap no-op guard for the bulk-sync path.
    const propagationCompanyId = companyId || existing?.company_id || null;
    if (contactId && propagationCompanyId && (cols.customer_phone || cols.customer_email)) {
        try {
            const { propagateContactDetails } = require('./contactPropagationService');
            await propagateContactDetails(propagationCompanyId, contactId,
                { phone: cols.customer_phone || null, email: cols.customer_email || null },
                { source: 'zb_sync' });
        } catch (e) {
            console.error('[JobsService] contact propagation failed (non-fatal):', e.message);
        }
    }

    if (existing) {
        // Preserve manually-set blanc_status (e.g. "Waiting for parts", "Follow Up with Client")
        // when the inbound ZB webhook was triggered by our own outbound sync.
        // Only overwrite blanc_status if it's one of the auto-computed statuses.
        const autoStatuses = ['Submitted', 'Visit completed', 'Rescheduled', 'Canceled'];
        let shouldUpdateBlancStatus = autoStatuses.includes(existing.blanc_status);

        // Operator-reopen override: Albusto can be reset to Submitted/Rescheduled by an
        // operator even when the ZB job is still canceled or complete. Zenbooker has no
        // API to un-cancel or un-complete, so Albusto maintains this divergence on purpose.
        // Without this override the next inbound webhook would snap blanc back to
        // Canceled / Visit completed.
        if (
            ['Submitted', 'Rescheduled'].includes(existing.blanc_status) &&
            (cols.zb_canceled || cols.zb_status === 'complete')
        ) {
            shouldUpdateBlancStatus = false;
        }

        const effectiveBlancStatus = shouldUpdateBlancStatus ? newBlancStatus : existing.blanc_status;

        // Merge notes: keep Albusto-side metadata (author, created, attachments) for notes
        // that originated in Albusto and were echoed back by Zenbooker.
        const incomingZbNotes = JSON.parse(cols.notes || '[]');
        const mergedNotes = mergeNotes(existing.notes || [], incomingZbNotes);
        cols.notes = JSON.stringify(mergedNotes);

        // Internal assignee mirror (PF007): must mirror the EFFECTIVE techs value —
        // when the incoming list is empty we keep the existing assigned_techs,
        // so the mirror has to be computed from the kept value too.
        const incomingTechs = JSON.parse(cols.assigned_techs || '[]');
        const effectiveTechs = incomingTechs.length === 0 ? (existing.assigned_techs || []) : incomingTechs;
        const effectiveCompanyId = companyId || existing.company_id || null;
        const assignedProviderUserIds = await resolveAssignedProviderUserIds(effectiveCompanyId, effectiveTechs);

        // Update existing job + link contact if not already linked
        await db.query(`
            UPDATE jobs SET
                zb_status = $1, zb_canceled = $2, zb_rescheduled = $3,
                blanc_status = $4,
                job_number = COALESCE($5, job_number),
                service_name = COALESCE($6, service_name),
                start_date = COALESCE($7, start_date),
                end_date = COALESCE($8, end_date),
                customer_name = COALESCE($9, customer_name),
                customer_phone = COALESCE($10, customer_phone),
                customer_email = COALESCE($11, customer_email),
                address = COALESCE($12, address),
                city = COALESCE($25, city),
                territory = COALESCE($13, territory),
                invoice_total = COALESCE($14, invoice_total),
                invoice_status = COALESCE($15, invoice_status),
                assigned_techs = CASE WHEN $16::jsonb = '[]'::jsonb THEN COALESCE(assigned_techs, '[]'::jsonb) ELSE $16::jsonb END,
                notes = $17::jsonb,
                zb_raw = $18::jsonb,
                contact_id = COALESCE($20, contact_id),
                lat = COALESCE($21, lat),
                lng = COALESCE($22, lng),
                company_id = COALESCE($23, company_id),
                assigned_provider_user_ids = $24::jsonb,
                updated_at = NOW()
            WHERE zenbooker_job_id = $19
        `, [
            cols.zb_status, cols.zb_canceled, cols.zb_rescheduled,
            effectiveBlancStatus,
            cols.job_number, cols.service_name, cols.start_date, cols.end_date,
            cols.customer_name, cols.customer_phone, cols.customer_email, cols.address,
            cols.territory, cols.invoice_total, cols.invoice_status,
            cols.assigned_techs, cols.notes, cols.zb_raw,
            zbJobId, contactId, cols.lat, cols.lng, companyId,
            assignedProviderUserIds,
            cols.city ?? null,
        ]);

        // CANCEL-001 leave-hook (CC-02 S3): the sync can never move a job out of
        // 'Part arrived' via blanc_status (∉ autoStatuses — preserved above), so
        // the ONLY sync-borne exit is the zb_canceled false→true FLIP (written
        // unconditionally by the UPDATE). Fire exactly on that flip, scoped to
        // the row being synced.
        if (existing.blanc_status === 'Part arrived' && !existing.zb_canceled && cols.zb_canceled) {
            fireRobotCallLeaveHook(existing.id, effectiveCompanyId, 'Canceled (Zenbooker)');
        }

        if (!shouldUpdateBlancStatus) {
            console.log(`[JobsService] Synced job ${zbJobId}: preserved manual blanc_status "${existing.blanc_status}" (ZB would set "${newBlancStatus}")`);
        } else {
            console.log(`[JobsService] Synced job ${zbJobId}: blanc_status ${existing.blanc_status} → ${effectiveBlancStatus}`);
        }
        return { updated: true, job_id: existing.id, blanc_status: effectiveBlancStatus };
    } else {
        // Create new job linked to contact
        const job = await createJob({ zenbookerJobId: zbJobId, zbData, companyId, contactId });
        console.log(`[JobsService] Created local job for zb_id=${zbJobId}, id=${job.id}, contact=${contactId}`);

        // ZB auto-assigns providers asynchronously — re-fetch after delay to catch it
        if ((!zbData.assigned_providers || zbData.assigned_providers.length === 0) && !zbData.unable_to_auto_assign) {
            setImmediate(async () => {
                try {
                    await new Promise(r => setTimeout(r, 5000));
                    const zbRefresh = await zenbookerClient.getJob(zbJobId);
                    if (zbRefresh?.assigned_providers?.length > 0) {
                        const refreshedMirror = await resolveAssignedProviderUserIds(
                            companyId || job.company_id,
                            zbRefresh.assigned_providers
                        );
                        await db.query(
                            `UPDATE jobs SET assigned_techs = $1::jsonb, zb_raw = $2::jsonb, assigned_provider_user_ids = $3::jsonb, updated_at = NOW() WHERE zenbooker_job_id = $4`,
                            [JSON.stringify(zbRefresh.assigned_providers), JSON.stringify(zbRefresh), refreshedMirror, zbJobId]
                        );
                        console.log(`[JobsService] Delayed re-fetch: auto-assigned ${zbRefresh.assigned_providers.length} provider(s) for job ${job.id}`);
                    }
                } catch (err) {
                    console.warn(`[JobsService] Delayed re-fetch error for ${zbJobId}:`, err.message);
                }
            });
        }

        return { updated: true, job_id: job.id, blanc_status: job.blanc_status, created: true };
    }
}

// =============================================================================
// Notes
// =============================================================================

async function addNote(jobId, text, attachments = [], author = null, createdBy = null, noteId = null) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    const note = { id: noteId || randomUUID(), text, created: new Date().toISOString(), created_by: createdBy || null };
    if (author) note.author = author;
    if (attachments.length > 0) {
        note.attachments = attachments.map(a => ({
            id: a.id,
            fileName: a.file_name,
            contentType: a.content_type,
            fileSize: a.file_size,
        }));
    }

    let notes = [...(job.notes || []), note];
    await db.query('UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(notes), jobId]);

    // Also push text to Zenbooker if linked (attachments are local-only).
    // Capture the resulting ZB note id so that when Zenbooker echoes this note back
    // via job.note_added webhook, syncFromZenbooker can merge by id and preserve author.
    if (job.zenbooker_job_id && text) {
        try {
            const resp = await zenbookerClient.addJobNote(job.zenbooker_job_id, { text });
            // ZB response shape isn't documented in our codebase; try common layouts.
            const zbId = resp?.id
                || resp?.note?.id
                || (Array.isArray(resp?.job_notes) ? resp.job_notes[resp.job_notes.length - 1]?.id : null);
            if (zbId) {
                note.zb_note_id = String(zbId);
                notes = [...(job.notes || []), note];
                await db.query('UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2',
                    [JSON.stringify(notes), jobId]);
            }
        } catch (err) {
            console.error(`[JobsService] Note sync error:`, err.response?.data || err.message);
        }
    }

    return { notes };
}

// =============================================================================
// Zenbooker pass-through actions (update local + call Zenbooker)
// =============================================================================

/**
 * Helper: when a ZB API action fails, force-sync the job from ZB to get correct state.
 * Throws a user-friendly error after syncing.
 */
async function forceSyncOnZbError(job, action, error) {
    console.warn(`[JobsService] ZB ${action} failed for ${job.zenbooker_job_id}: ${error.message}`);
    console.log(`[JobsService] Force-syncing job ${job.id} from ZB...`);
    try {
        const zbJobData = await zenbookerClient.getJob(job.zenbooker_job_id);
        if (zbJobData) {
            await syncFromZenbooker(job.zenbooker_job_id, zbJobData, job.company_id);
            console.log(`[JobsService] Force-sync completed for job ${job.id}`);
        }
    } catch (syncErr) {
        console.error(`[JobsService] Force-sync failed for job ${job.id}: ${syncErr.message}`);
    }
    const err = new Error('An error occurred. Please refresh the page and try again in 5 seconds. If the problem persists, contact the developer.');
    err.statusCode = 409;
    throw err;
}

async function cancelJob(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    // Pre-check: skip ZB call if already canceled to avoid 4xx → forceSync → 409
    if (job.zenbooker_job_id && !job.zb_canceled) {
        try {
            await zenbookerClient.cancelJob(job.zenbooker_job_id);
        } catch (e) {
            await forceSyncOnZbError(job, 'cancel', e);
        }
    }
    await db.query(
        'UPDATE jobs SET zb_canceled = true, blanc_status = $1, updated_at = NOW() WHERE id = $2',
        ['Canceled', jobId]
    );
    // CANCEL-001 leave-hook (CC-02 S2): this writer sets blanc_status DIRECTLY
    // (bypasses updateBlancStatus — fsm.js /apply + the jobs.js cancel route), so
    // it needs its own exit hook. Pre-state from the job loaded above.
    if (job.blanc_status === 'Part arrived') {
        fireRobotCallLeaveHook(jobId, job.company_id, 'Canceled');
    }
    return { ...job, blanc_status: 'Canceled', zb_canceled: true };
}

async function markEnroute(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    // Pre-check: skip ZB call if already en-route
    if (job.zenbooker_job_id && job.zb_status !== 'en-route') {
        try {
            await zenbookerClient.markJobEnroute(job.zenbooker_job_id);
        } catch (e) {
            await forceSyncOnZbError(job, 'enroute', e);
        }
    }
    await db.query(
        "UPDATE jobs SET zb_status = 'en-route', updated_at = NOW() WHERE id = $1",
        [jobId]
    );
    return { ...job, zb_status: 'en-route' };
}

async function markInProgress(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    // Pre-check: skip ZB call if already in-progress
    if (job.zenbooker_job_id && job.zb_status !== 'in-progress') {
        try {
            await zenbookerClient.markJobInProgress(job.zenbooker_job_id);
        } catch (e) {
            await forceSyncOnZbError(job, 'start', e);
        }
    }
    await db.query(
        "UPDATE jobs SET zb_status = 'in-progress', updated_at = NOW() WHERE id = $1",
        [jobId]
    );
    return { ...job, zb_status: 'in-progress' };
}

async function markComplete(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    // Pre-check: skip ZB call if already complete
    if (job.zenbooker_job_id && job.zb_status !== 'complete') {
        try {
            await zenbookerClient.markJobComplete(job.zenbooker_job_id);
        } catch (e) {
            await forceSyncOnZbError(job, 'complete', e);
        }
    }
    await db.query(
        "UPDATE jobs SET zb_status = 'complete', blanc_status = 'Visit completed', updated_at = NOW() WHERE id = $1",
        [jobId]
    );
    // CANCEL-001 leave-hook (CC-02 S2): direct blanc_status writer, same as
    // cancelJob above — a completed visit ends the robot-call plan.
    if (job.blanc_status === 'Part arrived') {
        fireRobotCallLeaveHook(jobId, job.company_id, 'Visit completed');
    }
    return { ...job, zb_status: 'complete', blanc_status: 'Visit completed' };
}

// =============================================================================
// Job Tags
// =============================================================================

/**
 * Update tags assigned to a job.
 * Only active tags can be newly assigned; existing inactive tags are preserved if re-sent.
 */
async function updateJobTags(jobId, tagIds) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Get currently assigned tag IDs
        const { rows: currentRows } = await client.query(
            'SELECT tag_id FROM job_tag_assignments WHERE job_id = $1', [jobId]
        );
        const currentTagIds = new Set(currentRows.map(r => r.tag_id));

        // Validate: new tags must be active
        if (tagIds && tagIds.length > 0) {
            const newTagIds = tagIds.filter(id => !currentTagIds.has(id));
            if (newTagIds.length > 0) {
                const { rows: tagRows } = await client.query(
                    'SELECT id, is_active FROM job_tags WHERE id = ANY($1)', [newTagIds]
                );
                const inactiveNew = tagRows.filter(r => !r.is_active);
                if (inactiveNew.length > 0) {
                    throw Object.assign(
                        new Error(`Cannot assign archived tags: ${inactiveNew.map(r => r.id).join(', ')}`),
                        { statusCode: 400 }
                    );
                }
            }
        }

        // Remove all existing assignments
        await client.query('DELETE FROM job_tag_assignments WHERE job_id = $1', [jobId]);

        // Insert new assignments
        if (tagIds && tagIds.length > 0) {
            for (const tagId of tagIds) {
                await client.query(
                    'INSERT INTO job_tag_assignments (job_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [jobId, tagId]
                );
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    const tags = await getTagsForJob(jobId);
    return { ...job, tags };
}

// =============================================================================
// FSM — Available transitions for UI
// =============================================================================

async function getJobTransitions(companyId, currentState, userRoles) {
    const result = await fsmService.getAvailableActions(companyId, 'job', currentState, userRoles);
    if (!result.fallback) {
        return result.actions;
    }
    // Fallback to hardcoded
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.map((target, i) => ({
        event: `TO_${target.toUpperCase().replace(/ /g, '_')}`,
        label: target,
        targetStatusName: target,
        action: true,
        confirm: target === 'Canceled',
        confirmText: target === 'Canceled' ? 'Are you sure you want to cancel this job?' : null,
        order: (i + 1) * 10,
    }));
}

// =============================================================================
// Exports
// =============================================================================

/** Update lat/lng for a job (e.g. after geocoding on the frontend) */
async function updateCoords(jobId, lat, lng) {
    await db.query('UPDATE jobs SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3', [lat, lng, jobId]);
}

/**
 * SCHED-ROUTE-001 FR-002: edit a job's route-affecting location (service address
 * and/or coordinates) in Albusto. Sets geocoding_status, triggers async geocode
 * when an address arrives without coords, and recalculates the affected
 * technician/day route segments (capturing the BEFORE tech-days so a moved job
 * repairs the sequence it left). Best-effort ZB sync if the job is linked.
 *
 * Semantics: changing the address invalidates old coords — when no coords are
 * supplied the stored lat/lng are cleared and a fresh geocode is enqueued.
 */
async function updateJobLocation(companyId, jobId, { address, lat, lng, normalized_address, place_id } = {}) {
    if (!companyId) throw new Error('updateJobLocation requires companyId');
    const routeQueries = require('../db/routeQueries');
    const routeSeg = require('./routeSegmentService');

    // Capture the tech/days this job currently occupies so vacated pairs repair.
    let beforeTechDays = [];
    try {
        const tz = await routeQueries.getCompanyTimezone(companyId);
        beforeTechDays = await routeQueries.getTechDaysForJob(companyId, jobId, tz);
    } catch { /* non-fatal */ }

    const hasCoords = lat != null && lng != null;
    const geocodingStatus = hasCoords ? 'success' : 'not_geocoded';
    const { rows } = await db.query(
        `UPDATE jobs SET
            address            = COALESCE($3::text, address),
            lat                = $4::double precision,
            lng                = $5::double precision,
            normalized_address = $6::text,
            geocoding_status   = $7::text,
            geocoding_place_id = $8::text,
            geocoded_at        = CASE WHEN $4::double precision IS NOT NULL AND $5::double precision IS NOT NULL THEN now() ELSE NULL END,
            geocoding_provider = 'google_maps',
            geocoding_error_code = NULL,
            geocoding_error_message = NULL,
            updated_at         = now()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [jobId, companyId, address ?? null, hasCoords ? lat : null, hasCoords ? lng : null,
         normalized_address ?? null, geocodingStatus, place_id ?? null]
    );
    const job = rows[0];
    if (!job) return null;

    // No coords but an address present → geocode async (FR-004).
    if (!hasCoords && job.address && String(job.address).trim()) {
        await routeSeg.enqueueGeocode(companyId, jobId).catch(() => {});
    }
    // Recalc affected route segments (coords changed → force surviving pairs).
    await routeSeg.recalcForJob(companyId, jobId, { beforeTechDays, coordsChanged: true })
        .catch(e => console.error('[JobsService] recalc after location edit failed (non-fatal):', e.message));

    // FR-002: best-effort push the edit to ZenBooker if linked + flag on. ZB has
    // no generic job-address PATCH, so a not-yet-synced job is (re)enqueued for
    // create with the new address; an already-synced job records the local edit.
    if (isZenbookerSyncEnabled() && !job.zenbooker_job_id && job.zb_sync_status !== 'pending') {
        await enqueueZbJobSync(companyId, jobId, {})   // handler falls back to job.address
            .catch(e => console.error('[JobsService] zb sync re-enqueue failed (non-fatal):', e.message));
    }
    return job;
}

module.exports = {
    createJob,
    createManualJob,
    createDirectJob,
    getJobById,
    getJobByZbId,
    listJobs,
    getJobBalanceDue,
    updateBlancStatus,
    syncFromZenbooker,
    mergeNotes,
    addNote,
    cancelJob,
    markEnroute,
    markInProgress,
    markComplete,
    BLANC_STATUSES,
    ALLOWED_TRANSITIONS,
    zbJobToColumns,
    computeBlancStatusFromZb,
    updateJobTags,
    getTagsForJob,
    updateCoords,
    updateJobLocation,
    enqueueZbJobSync,
    getJobTransitions,
    resolveAssignedProviderUserIds,
    refreshCompanyProviderMirror,
};
