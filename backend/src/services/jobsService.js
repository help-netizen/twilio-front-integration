/**
 * Jobs Service
 *
 * Local Albusto storage for Jobs, including historical Zenbooker provenance.
 * A Job is created when a Lead is converted (status = 'Converted').
 *
 * FSM:
 *   blanc_status  — parent status in Albusto (Submitted, Waiting for parts, etc.)
 *   zb_status     — Zenbooker substatus (scheduled, en-route, complete)
 *   zb_rescheduled, zb_canceled — Zenbooker boolean flags
 */

const { randomUUID } = require('node:crypto');
const db = require('../db/connection');
const fsmService = require('./fsmService');
const eventService = require('./eventService');
const eventBus = require('./eventBus');
const { convertLeadWithJob } = require('./leadConversionService');
const { logJobActivity } = require('./jobActivityService');
const { withTransaction } = require('./transactionService');
const { deduplicateNotesByIdentity } = require('./noteDeduplication');
const membershipQueries = require('../db/membershipQueries');
const jobFinanceQueries = require('../db/jobFinanceQueries');
const jobProviderMirrorQueries = require('../db/jobProviderMirrorQueries');
const technicianRosterService = require('./technicianRosterService');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');
const { companyDateFilterBounds } = require('../utils/companyTime');
const {
    ALLOWED_TRANSITIONS,
    BLANC_STATUSES,
    getFallbackJobActions,
} = require('./jobWorkflowFallback');

// =============================================================================
// Constants
// =============================================================================

// Human status changes are local-only: blanc_status is authoritative.

// =============================================================================
// Helpers
// =============================================================================

async function mutateWithActivity(activityActor, activity, work, { client = null } = {}) {
    if (client) {
        const result = await work(client);
        const activityEvent = typeof activity === 'function' ? activity(result) : activity;
        if (activityActor && activityEvent) {
            await logJobActivity({
                ...activityEvent,
                actor: activityActor,
            }, { client });
        }
        return result;
    }
    if (!activityActor) return work(db);
    return withTransaction(async (client) => {
        const result = await work(client);
        const activityEvent = typeof activity === 'function' ? activity(result) : activity;
        if (activityEvent) {
            await logJobActivity({
                ...activityEvent,
                actor: activityActor,
            }, { client });
        }
        return result;
    });
}

async function updateOwnedJob(client, sql, params, jobId) {
    const result = await client.query(sql, params);
    if (result.rowCount === 0) {
        throw Object.assign(new Error(`Job #${jobId} not found`), { statusCode: 404 });
    }
    return result;
}

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
        job_seq: row.job_seq ?? null,
        public_code: row.public_code || null,
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
async function getTagsForJob(jobId, companyId, queryable = db) {
    if (!companyId) throw new Error('getTagsForJob requires companyId');
    const { rows } = await queryable.query(`
        SELECT t.id, t.name, t.color, t.is_active
        FROM job_tag_assignments jta
        JOIN jobs j ON j.id = jta.job_id AND j.company_id = $2
        JOIN job_tags t ON t.id = jta.tag_id
        WHERE jta.job_id = $1 AND j.company_id = $2
        ORDER BY t.sort_order, t.id
    `, [jobId, companyId]);
    return rows;
}

/** Map a Zenbooker API job object to flat columns for upsert */
function zbJobToColumns(zbJob) {
    return {
        job_number: zbJob.job_number || null,
        service_name: zbJob.service_name || zbJob.services?.[0]?.service_name || null,
        description: Array.isArray(zbJob.services)
            ? zbJob.services
                .map(service => typeof service?.description === 'string' ? service.description.trim() : null)
                .filter(Boolean)
                .join('\n') || null
            : null,
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
 * Resolve a job's assignment-compatible technician ids to internal crm_users.id
 * values through the company-scoped provider bridge. Returns a JSON string for the
 * jobs.assigned_provider_user_ids JSONB column.
 *
 * Unmapped provider ids resolve to nothing — they must never grant
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

async function canonicalizeAssignedTechs(companyId, assignedTechs) {
    let values = assignedTechs;
    if (typeof values === 'string') {
        try { values = JSON.parse(values); } catch { values = []; }
    }
    return technicianRosterService.canonicalizeAssignments(companyId, values);
}

/**
 * Recompute the internal assignee mirror for every job in a company.
 * Idempotent and company-scoped.
 */
async function refreshCompanyProviderMirror(companyId) {
    const result = await jobProviderMirrorQueries.refreshProviderMirror(companyId);
    console.log(`[JobsService] Provider mirror refresh for company ${companyId}: ${result.updated} job(s) updated`);
    return result;
}

// =============================================================================
// CRUD
// =============================================================================

async function createJob({
    leadId,
    contactId,
    zenbookerJobId,
    zbData,
    companyId,
    activityActor = null,
}) {
    if (!companyId) {
        const err = new Error('createJob requires companyId');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const cols = zbData ? zbJobToColumns(zbData) : {};
    const blancStatus = zbData
        ? computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled)
        : 'Submitted';

    const canonicalAssignedTechs = await canonicalizeAssignedTechs(
        companyId,
        cols.assigned_techs
    );
    cols.assigned_techs = JSON.stringify(canonicalAssignedTechs);
    const assignedProviderUserIds = await resolveAssignedProviderUserIds(
        companyId,
        canonicalAssignedTechs
    );

    const upsert = async (queryable) => {
        const { rows } = await queryable.query(`
            INSERT INTO jobs (lead_id, contact_id, zenbooker_job_id, blanc_status,
                zb_status, zb_canceled, zb_rescheduled,
                job_number, service_name, description, start_date, end_date,
                customer_name, customer_phone, customer_email, address, city,
                territory, invoice_total, invoice_status, assigned_techs, notes,
                zb_raw, company_id, lat, lng, assigned_provider_user_ids)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
            ON CONFLICT (zenbooker_job_id) DO UPDATE SET
                lead_id = COALESCE(EXCLUDED.lead_id, jobs.lead_id),
                contact_id = COALESCE(EXCLUDED.contact_id, jobs.contact_id),
                blanc_status = EXCLUDED.blanc_status,
                zb_status = EXCLUDED.zb_status,
                zb_canceled = EXCLUDED.zb_canceled,
                zb_rescheduled = EXCLUDED.zb_rescheduled,
                job_number = EXCLUDED.job_number,
                service_name = EXCLUDED.service_name,
                description = COALESCE(NULLIF(jobs.description, ''), EXCLUDED.description),
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
            WHERE jobs.company_id = EXCLUDED.company_id
            RETURNING *, (xmax = 0) AS local_job_created
        `, [
            leadId || null, contactId || null, zenbookerJobId, blancStatus,
            cols.zb_status || 'scheduled', cols.zb_canceled || false, cols.zb_rescheduled || false,
            cols.job_number || null, cols.service_name || null, cols.description || null,
            cols.start_date || null, cols.end_date || null,
            cols.customer_name || null, cols.customer_phone || null, cols.customer_email || null, cols.address || null,
            cols.city || null,
            cols.territory || null, cols.invoice_total || null, cols.invoice_status || null,
            cols.assigned_techs || '[]', cols.notes || '[]',
            cols.zb_raw || '{}', companyId, cols.lat || null, cols.lng || null,
            assignedProviderUserIds,
        ]);
        return rows[0] || null;
    };

    if (leadId) {
        const conversion = await convertLeadWithJob({
            companyId,
            leadId,
            activityActor,
            createOrReuseJob: async ({ client }) => {
                const { rows: existingRows } = await client.query(
                    `SELECT *
                     FROM jobs
                     WHERE lead_id = $1 AND company_id = $2
                     ORDER BY id ASC
                     LIMIT 1
                     FOR UPDATE`,
                    [leadId, companyId]
                );
                const row = existingRows[0] || await upsert(client);
                if (!row) {
                    throw Object.assign(
                        new Error('Zenbooker job id is already owned by another company'),
                        { code: 'ZENBOOKER_ID_CONFLICT', httpStatus: 409 }
                    );
                }
                return {
                    jobId: row.id,
                    jobCreated: existingRows.length === 0 && row.local_job_created === true,
                    jobStatus: row.blanc_status || blancStatus,
                    jobRow: row,
                    leadUpdates: {
                        ...(contactId ? { contact_id: contactId } : {}),
                        ...(zenbookerJobId ? { zenbooker_job_id: zenbookerJobId } : {}),
                    },
                };
            },
        });
        return rowToJob(conversion.jobRow);
    }

    const row = await upsert(db);
    if (!row) {
        const err = new Error('Zenbooker job id is already owned by another company');
        err.code = 'ZENBOOKER_ID_CONFLICT';
        err.httpStatus = 409;
        throw err;
    }
    return rowToJob(row);
}

/**
 * SCHED-ROUTE-001 (FR-001): create a job manually in Albusto (no ZenBooker sync
 * path). Assignment uses INTERNAL crm_users.id directly (C-2): provider lane id
 * → assigned_provider_user_ids. If the caller already has trustworthy coordinates
 * (e.g. from AddressAutocomplete), geocoding_status is set to 'success' so no
 * paid geocode is needed; otherwise 'not_geocoded' and the caller enqueues one.
 * Returns the raw job row.
 */
async function createManualJob(companyId, input = {}, activityActor = null) {
    if (!companyId) throw new Error('createManualJob requires companyId');
    const blancStatus = input.blanc_status || 'Submitted';

    // Assignment (FR-001.4 / C-2): assigned_techs stores technicians.id UUIDs;
    // older clients may still send ZB ids, which are resolved before persistence.
    // The route engine separately keys visibility on INTERNAL crm_users.id.
    const assignedTechs = await canonicalizeAssignedTechs(
        companyId,
        Array.isArray(input.assigned_techs) ? input.assigned_techs : []
    );
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

    const job = await mutateWithActivity(
        activityActor,
        created => ({
            companyId,
            action: 'job.created',
            jobId: created.id,
            summary: { status: blancStatus },
        }),
        async (client) => {
            const { rows } = await client.query(
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
            return rows[0];
        }
    );

    await eventBus.emit(companyId, 'job.created', {
        id: job.id,
        job_id: job.id,
        record_refs: [{ type: 'job', id: job.id }],
    }, {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'job',
        aggregateId: job.id,
    });
    return job;
}

/**
 * Create a Job directly in Albusto (no lead → job conversion path), starting from
 * a small structured input.
 *
 * input = {
 *   contact: { contact_id:number } | { name:string, phone:string, email?:string },
 *   address: { line1?, line2?, city?, state?, postal_code?, lat?, lng? },
 *   slot:    { start:ISO, end:ISO, tech_id?:string|null },
 *   job_type: string,
 *   description?: string,
 * }
 *
 * Resolves the company-scoped contact, then creates the local job.
 *
 * @param {string} companyId  — ONLY from req.companyFilter (never req.companyId)
 * @param {Object} input
 * @returns {Promise<{ job_id:number, zenbooker_job_id:string|null, zb_warning:string|null }>}
 */
async function createDirectJob(companyId, input = {}, activityActor = null) {
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
        }, companyId, { activityActor });
        contactId = resolved.contact_id || null;
    }

    // ── b. Resolve contact display data and create the local job ──────────────
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

    const addressStr = [address.line1, address.line2, address.city, address.state, address.postal_code]
        .filter(Boolean).join(', ') || null;
    // No geocode in this path; the structured create input already carries the
    // city, so persist it directly (TILE-CITY-001).
    const cityValue = address.city || null;
    const canonicalAssignedTechs = await canonicalizeAssignedTechs(
        companyId,
        slot.tech_id ? [{ id: String(slot.tech_id) }] : []
    );
    const assignedTechs = JSON.stringify(canonicalAssignedTechs);
    const assignedProviderUserIds = await resolveAssignedProviderUserIds(
        companyId,
        canonicalAssignedTechs
    );
    const { rows } = await db.query(`
        INSERT INTO jobs (
            contact_id, company_id, blanc_status, service_name, description,
            customer_name, customer_phone, customer_email, address, city,
            start_date, end_date, assigned_techs, assigned_provider_user_ids
        ) VALUES ($1, $2, 'Submitted', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
        RETURNING *
    `, [
        contactId, companyId, jobType, description,
        customerName, customerPhone, customerEmail, addressStr, cityValue,
        slot.start || null, slot.end || null, assignedTechs, assignedProviderUserIds,
    ]);
    const localJob = rowToJob(rows[0]);
    console.log(`[CreateDirectJob] Local job ${localJob.id} created`);

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

    if (activityActor) {
        await logJobActivity({
            companyId,
            action: 'job.created',
            jobId: localJob.id,
            actor: activityActor,
            summary: { status: localJob.blanc_status || 'Submitted' },
        });
    }

    // [CHANGE START] REPAIR-ADVISOR-001 (T6): post-commit domain event for the
    // AI Repair Advisor subscriber (kb-diagnostics). Additive only — fire-and-forget
    // so a failing bus never breaks the create; emit itself also never throws into
    // the producer (§3.2). The human create-path always emits.
    eventBus.emit(
        companyId,
        'job.created',
        {
            id: localJob.id,
            job_id: localJob.id,
            record_refs: [{ type: 'job', id: localJob.id }],
        },
        {
            actorType: activityActor?.type || 'system',
            actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
            aggregateType: 'job',
            aggregateId: localJob.id,
        }
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

    // SCHED-ROUTE-VIS-001 (FR-1, S-1..S-3): best-effort route recalc for the
    // direct-create path. Job is new, so no beforeTechDays. Fire-and-forget: a
    // failing recalc never breaks the create.
    {
        const routeSeg = require('./routeSegmentService');
        routeSeg.recalcForJob(companyId, localJob.id, { coordsChanged: true })
            .catch(e => console.error('[CreateDirectJob] route recalc failed (non-fatal):', e.message));
        // Address present without coords → async geocode; the job_geocode handler
        // re-runs recalc itself once coordinates land (agentHandlers, existing).
        if (localJob.address && String(localJob.address).trim() && (localJob.lat == null || localJob.lng == null)) {
            routeSeg.enqueueGeocode(companyId, localJob.id)
                .catch(e => console.error('[CreateDirectJob] geocode enqueue failed (non-fatal):', e.message));
        }
    }

    return {
        job_id: localJob.id,
        job_seq: localJob.job_seq,
        public_code: localJob.public_code,
        zenbooker_job_id: null,
        zb_warning: null,
    };
}

async function getJobById(id, companyId = null, providerScope = null, { client = null, forUpdate = false } = {}) {
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
    const queryable = client || db;
    const { rows } = await queryable.query(
        `SELECT j.*, l.serial_id AS lead_serial_id,
                COALESCE(c.full_name, j.customer_name) AS customer_name,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}
         ${forUpdate ? 'FOR UPDATE OF j' : ''}`,
        params
    );
    if (rows.length === 0) return null;
    const job = rowToJob(rows[0]);
    // Never take the historical ID-only tag path. Legacy unscoped callers get
    // no tag child rows; tenant-aware callers resolve tags through the owned Job.
    job.tags = companyId ? await getTagsForJob(id, companyId, queryable) : [];
    return job;
}

async function getJobBySeq(companyId, jobSeq, providerScope = null, { client = null, forUpdate = false } = {}) {
    if (!companyId) throw jobsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);

    const conditions = ['j.company_id = $1', 'j.job_seq = $2'];
    const params = [companyId, jobSeq];
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return null;
        params.push(JSON.stringify([providerScope.userId]));
        conditions.push(`j.assigned_provider_user_ids @> $${params.length}::jsonb`);
    }

    const queryable = client || db;
    const { rows } = await queryable.query(
        `SELECT j.*, l.serial_id AS lead_serial_id,
                COALESCE(c.full_name, j.customer_name) AS customer_name,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}
         ${forUpdate ? 'FOR UPDATE OF j' : ''}`,
        params
    );
    if (rows.length === 0) return null;

    const job = rowToJob(rows[0]);
    job.tags = await getTagsForJob(job.id, companyId, queryable);
    return job;
}

/**
 * Deliberately global resolver for durable /j/:code links. public_code is globally
 * unique; the returned company_id and job_seq let the caller establish company
 * context and redirect to that tenant's /jobs/:seq route.
 */
async function getJobByCode(publicCode, { client = null } = {}) {
    const queryable = client || db;
    const { rows } = await queryable.query(
        `SELECT j.*, l.serial_id AS lead_serial_id,
                COALESCE(c.full_name, j.customer_name) AS customer_name,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
         WHERE j.public_code = $1`,
        [publicCode]
    );
    return rows.length === 0 ? null : rowToJob(rows[0]);
}

async function getJobByZbId(zbJobId, companyId) {
    const { rows } = await db.query(
        `SELECT j.*,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email
         FROM jobs j
         LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
         WHERE j.zenbooker_job_id = $1 AND j.company_id = $2`,
        [zbJobId, companyId]
    );
    if (rows.length === 0) return null;
    return rowToJob(rows[0]);
}

const JOB_LIST_SORTS = Object.freeze({
    job_number: { expression: `LOWER(COALESCE(j.job_number, '')) COLLATE "C"`, type: 'text' },
    customer_name: { expression: `LOWER(COALESCE(c.full_name, j.customer_name, '')) COLLATE "C"`, type: 'text' },
    customer_phone: { expression: `LOWER(COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, ''), '')) COLLATE "C"`, type: 'text' },
    customer_email: { expression: `LOWER(COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, ''), '')) COLLATE "C"`, type: 'text' },
    service_name: { expression: `LOWER(COALESCE(j.service_name, '')) COLLATE "C"`, type: 'text' },
    start_date: { expression: 'j.start_date', type: 'timestamp', nullable: true },
    end_date: { expression: 'j.end_date', type: 'timestamp', nullable: true },
    blanc_status: { expression: `LOWER(COALESCE(j.blanc_status, '')) COLLATE "C"`, type: 'text' },
    zb_status: { expression: `LOWER(COALESCE(j.zb_status, '')) COLLATE "C"`, type: 'text' },
    address: { expression: `LOWER(COALESCE(j.address, '')) COLLATE "C"`, type: 'text' },
    territory: { expression: `LOWER(COALESCE(j.territory, '')) COLLATE "C"`, type: 'text' },
    invoice_total: { expression: `NULLIF(j.invoice_total, '')::numeric`, type: 'numeric', nullable: true },
    invoice_status: { expression: `LOWER(COALESCE(j.invoice_status, '')) COLLATE "C"`, type: 'text' },
    job_type: { expression: `LOWER(COALESCE(j.job_type, '')) COLLATE "C"`, type: 'text' },
    job_source: { expression: `LOWER(COALESCE(j.job_source, '')) COLLATE "C"`, type: 'text' },
    description: { expression: `LOWER(COALESCE(j.description, '')) COLLATE "C"`, type: 'text' },
    created_at: { expression: 'j.created_at', type: 'timestamp' },
    updated_at: { expression: 'j.updated_at', type: 'timestamp' },
});

function jobsListError(code, message, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function splitList(value) {
    if (value === undefined || value === null || value === '') return [];
    const items = Array.isArray(value) ? value : String(value).split(',');
    return [...new Set(items.map(item => String(item).trim()).filter(Boolean))].sort();
}

/**
 * Bounded, projection-only search for relationship pickers. Unlike listJobs it
 * does not calculate totals/facets or hydrate tags and finance data.
 */
async function searchJobsForPicker({ companyId, search, limit = 20, providerScope } = {}) {
    if (!companyId) throw jobsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 50) {
        throw jobsListError('INVALID_QUERY', 'limit must be an integer from 1 to 50', 400);
    }

    const normalizedSearch = typeof search === 'string' ? search.trim() : '';
    if (normalizedSearch.length > 200) {
        throw jobsListError('INVALID_QUERY', 'search must be at most 200 characters', 400);
    }

    const conditions = ['j.company_id = $1'];
    const params = [companyId];
    let idx = 1;

    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) {
            conditions.push('FALSE');
        } else {
            idx++;
            conditions.push(`j.assigned_provider_user_ids @> $${idx}::jsonb`);
            params.push(JSON.stringify([providerScope.userId]));
        }
    }

    let relevanceOrder = '';
    if (normalizedSearch) {
        idx++;
        const searchParam = `$${idx}`;
        params.push(`%${normalizedSearch}%`);
        conditions.push(`(
            j.job_number ILIKE ${searchParam}
            OR COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) ILIKE ${searchParam}
            OR COALESCE(j.address, '') ILIKE ${searchParam}
            OR COALESCE(j.service_name, '') ILIKE ${searchParam}
        )`);
        relevanceOrder = `CASE
            WHEN LOWER(COALESCE(j.job_number, '')) = LOWER($${idx + 1}) THEN 0
            WHEN LOWER(COALESCE(j.job_number, '')) LIKE LOWER($${idx + 1}) || '%' THEN 1
            WHEN LOWER(COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, ''))) LIKE LOWER($${idx + 1}) || '%' THEN 2
            ELSE 3
        END, `;
        idx++;
        params.push(normalizedSearch);
    }

    idx++;
    params.push(Number(limit));
    const { rows } = await db.query(
        `SELECT j.id,
                j.job_number,
                COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) AS customer_name,
                j.address,
                j.service_name,
                j.start_date,
                j.blanc_status
         FROM jobs j
         LEFT JOIN contacts c
           ON c.id = j.contact_id
          AND c.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${relevanceOrder}j.start_date DESC NULLS LAST, j.id DESC
         LIMIT $${idx}`,
        params
    );

    return {
        results: rows.map(row => ({
            id: row.id,
            job_number: row.job_number || null,
            customer_name: row.customer_name || null,
            address: row.address || null,
            service_name: row.service_name || null,
            start_date: row.start_date instanceof Date
                ? row.start_date.toISOString()
                : row.start_date || null,
            status: row.blanc_status || null,
        })),
    };
}

async function listJobs({ blancStatus, zbCanceled, search, offset, limit = 50, cursor, companyId, companyTimezone, contactId, sortBy = 'start_date', sortOrder = 'desc', onlyOpen, paymentStatus, startDate, endDate, serviceName, jobSource, provider, tagIds, tagMatch, providerScope } = {}) {
    if (!companyId) throw jobsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) {
        throw jobsListError('INVALID_QUERY', 'limit must be an integer from 1 to 500', 400);
    }
    const pageLimit = Number(limit);
    if (offset !== undefined && (!Number.isInteger(Number(offset)) || Number(offset) < 0)) {
        throw jobsListError('INVALID_QUERY', 'offset must be a non-negative integer', 400);
    }
    assertCursorOffsetExclusive(cursor, offset);
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
        throw jobsListError('INVALID_QUERY', 'Invalid job sort direction', 400);
    }

    let sortTemplate = JOB_LIST_SORTS[sortBy];
    let metaKey = null;
    if (!sortTemplate && typeof sortBy === 'string' && sortBy.startsWith('meta:')) {
        metaKey = sortBy.slice(5);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(metaKey)) {
            throw jobsListError('INVALID_QUERY', 'Invalid metadata sort field', 400);
        }
        sortTemplate = { type: 'text', nullable: false };
    }
    if (!sortTemplate) throw jobsListError('INVALID_QUERY', 'Invalid job sort field', 400);

    const statuses = splitList(blancStatus);
    const serviceNames = splitList(serviceName);
    const jobSources = splitList(jobSource);
    const providers = splitList(provider);
    const normalizedSearch = typeof search === 'string' ? search.trim() : '';
    const normalizedTagIds = splitList(tagIds)
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value > 0)
        .sort((left, right) => left - right);
    const normalizedCanceled = zbCanceled === undefined
        ? null
        : (zbCanceled === true || zbCanceled === 'true');
    const dateBounds = companyDateFilterBounds(startDate, endDate, companyTimezone);
    const mode = offset === undefined ? 'cursor' : 'offset';
    const visibility = {
        assignedOnly: providerScope?.assignedOnly === true,
        userId: providerScope?.assignedOnly ? String(providerScope.userId || '') : null,
    };
    const fingerprint = createCursorFingerprint({
        endpoint: 'jobs',
        company: String(companyId),
        visibility,
        filters: {
            blanc_status: statuses,
            canceled: normalizedCanceled,
            search: normalizedSearch.toLocaleLowerCase('en-US'),
            contact_id: contactId == null ? null : String(contactId),
            only_open: Boolean(onlyOpen),
            payment_status: paymentStatus === 'unpaid' ? 'unpaid' : null,
            start_date: startDate || null,
            end_date: endDate || null,
            company_timezone: dateBounds.timezone,
            service_name: serviceNames,
            job_source: jobSources,
            provider: providers,
            tag_ids: normalizedTagIds,
            tag_match: tagMatch === 'all' ? 'all' : 'any',
        },
        sort: sortBy,
        direction: sortOrder,
        limit: pageLimit,
    });
    const cursorValueTypes = sortTemplate.nullable
        ? ['boolean', { type: sortTemplate.type, nullable: true }, 'bigint']
        : [sortTemplate.type, 'bigint'];
    const cursorExpectation = {
        endpoint: 'jobs',
        sort: sortBy,
        direction: sortOrder,
        fingerprint,
        valueTypes: cursorValueTypes,
    };
    const decodedCursor = cursor ? decodeCursor(cursor, cursorExpectation) : null;

    if (metaKey) {
        const fieldResult = await db.query(
            `SELECT 1
             FROM lead_custom_fields
             WHERE company_id = $1 AND api_name = $2 AND is_system = false
             LIMIT 1`,
            [companyId, metaKey],
        );
        if (fieldResult.rows.length === 0) {
            throw jobsListError('INVALID_QUERY', 'Unknown metadata sort field', 400);
        }
    }

    const conditions = [];
    const params = [];
    let idx = 0;

    idx++; conditions.push(`j.company_id = $${idx}`); params.push(companyId);
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
    if (statuses.length > 0) {
        idx++; conditions.push(`j.blanc_status = ANY($${idx}::text[])`); params.push(statuses);
    }
    if (normalizedCanceled !== null) {
        idx++; conditions.push(`j.zb_canceled = $${idx}::boolean`); params.push(normalizedCanceled);
    }
    if (normalizedSearch) {
        idx++;
        const searchClauses = [
            `j.job_number ILIKE $${idx}`,
            `j.service_name ILIKE $${idx}`,
            `COALESCE(c.full_name, j.customer_name) ILIKE $${idx}`,
            `COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) ILIKE $${idx}`,
            `COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) ILIKE $${idx}`,
            `j.address ILIKE $${idx}`,
            `EXISTS (
                SELECT 1 FROM job_tag_assignments jta2
                JOIN job_tags t2 ON t2.id = jta2.tag_id
                WHERE jta2.job_id = j.id AND t2.name ILIKE $${idx}
            )`,
            `EXISTS (
                SELECT 1
                FROM lead_custom_fields lcf
                WHERE lcf.company_id = j.company_id
                  AND lcf.is_searchable = true
                  AND lcf.is_system = false
                  AND COALESCE(j.metadata ->> lcf.api_name, '') ILIKE $${idx}
            )`,
        ];

        conditions.push(`(${searchClauses.join(' OR\n            ')})`);
        params.push(`%${normalizedSearch}%`);
    }
    if (contactId) {
        idx++; conditions.push(`j.contact_id = $${idx}`); params.push(contactId);
    }
    if (onlyOpen) {
        conditions.push(`j.blanc_status NOT IN ('Job is Done', 'Canceled')`);
    }
    if (paymentStatus === 'unpaid') {
        // JOBS-HEADER-QUICKFILTERS-001: only jobs whose outstanding Due (>0) — the finance
        // rollup folded into the paginated WHERE (companyId is always $1).
        conditions.push(`${jobFinanceQueries.outstandingDueExpr('j', '$1')} > 0`);
    }
    if (dateBounds.fromInclusive) {
        idx++; conditions.push(`j.start_date >= $${idx}::timestamptz`); params.push(dateBounds.fromInclusive);
    }
    if (dateBounds.toExclusive) {
        idx++; conditions.push(`j.start_date < $${idx}::timestamptz`); params.push(dateBounds.toExclusive);
    }
    if (serviceNames.length > 0) {
        idx++; conditions.push(`j.service_name = ANY($${idx}::text[])`); params.push(serviceNames);
    }
    if (jobSources.length > 0) {
        idx++; conditions.push(`j.job_source = ANY($${idx}::text[])`); params.push(jobSources);
    }
    if (normalizedTagIds.length > 0) {
        idx++; const tagsParam = `$${idx}::int[]`; params.push(normalizedTagIds);
        if (tagMatch === 'all' && normalizedTagIds.length > 1) {
            idx++; params.push(normalizedTagIds.length);
            conditions.push(`(
                SELECT COUNT(DISTINCT jta3.tag_id) FROM job_tag_assignments jta3
                WHERE jta3.job_id = j.id AND jta3.tag_id = ANY(${tagsParam})
            ) = $${idx}::int`);
        } else {
            conditions.push(`EXISTS (
                SELECT 1 FROM job_tag_assignments jta3
                WHERE jta3.job_id = j.id AND jta3.tag_id = ANY(${tagsParam})
            )`);
        }
    }

    const facetConditions = conditions.slice();
    if (providers.length > 0) {
        idx++; params.push(providers);
        conditions.push(`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(j.assigned_techs, '[]'::jsonb)) AS tech(value)
            WHERE BTRIM(tech.value ->> 'name') = ANY($${idx}::text[])
        )`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const facetWhereClause = `WHERE ${facetConditions.join(' AND ')}`;

    let total = null;
    let facets = null;
    if (!decodedCursor) {
        const includeProviderFacet = mode === 'cursor' || Number(offset) === 0;
        const providersSql = includeProviderFacet
            ? `(SELECT COALESCE(json_agg(provider_rows.provider ORDER BY provider_rows.provider), '[]'::json)
                FROM (
                    SELECT DISTINCT BTRIM(tech.value ->> 'name') AS provider
                    FROM jobs j
                    LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.assigned_techs, '[]'::jsonb)) AS tech(value)
                    ${facetWhereClause}
                      AND BTRIM(COALESCE(tech.value ->> 'name', '')) <> ''
                ) provider_rows)`
            : 'NULL::json';
        const metadataResult = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM jobs j
                 LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
                 ${whereClause}) AS total,
                ${providersSql} AS providers`,
            params,
        );
        total = Number(metadataResult.rows[0]?.total || 0);
        facets = includeProviderFacet
            ? { providers: metadataResult.rows[0]?.providers || [] }
            : null;
    }

    const dataParams = params.slice();
    const sort = metaKey
        ? {
            expression: `LOWER(COALESCE(j.metadata ->> $${dataParams.push(metaKey)}, '')) COLLATE "C"`,
            type: 'text',
            nullable: false,
        }
        : sortTemplate;
    const cursorKeys = [];
    const cursorProjections = [];
    const orderParts = [];
    if (sort.nullable) {
        cursorKeys.push({ expression: `(${sort.expression} IS NULL)`, direction: 'asc', type: 'boolean' });
        cursorProjections.push(`(${sort.expression} IS NULL) AS __cursor_null`);
        orderParts.push(`(${sort.expression} IS NULL) ASC`);
    }
    cursorKeys.push({
        expression: sort.expression,
        direction: sortOrder,
        type: sort.type,
        nullable: sort.nullable === true,
    });
    cursorKeys.push({ expression: 'j.id', direction: sortOrder, type: 'bigint' });
    if (sort.type === 'timestamp') {
        cursorProjections.push(`${timestampCursorExpression(sort.expression)} AS __cursor_value`);
    } else if (sort.type === 'numeric') {
        cursorProjections.push(`(${sort.expression})::text AS __cursor_value`);
    } else {
        cursorProjections.push(`${sort.expression} AS __cursor_value`);
    }
    cursorProjections.push(`${bigintCursorExpression('j.id')} AS __cursor_id`);
    orderParts.push(`${sort.expression} ${sortOrder.toUpperCase()}`, `j.id ${sortOrder.toUpperCase()}`);

    let cursorPredicate = '';
    if (decodedCursor) {
        const keyset = buildKeysetPredicate(cursorKeys, decodedCursor.values, dataParams.length + 1);
        cursorPredicate = ` AND ${keyset.sql}`;
        dataParams.push(...keyset.params);
    }
    const limitParam = dataParams.length + 1;
    dataParams.push(pageLimit + 1);
    let offsetSql = '';
    if (mode === 'offset') {
        const offsetParam = dataParams.length + 1;
        dataParams.push(Number(offset));
        offsetSql = ` OFFSET $${offsetParam}`;
    }

    const { rows: probedRows } = await db.query(`
        SELECT j.*, COALESCE(c.full_name, j.customer_name) AS customer_name,
               COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone,
               COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email,
               ${cursorProjections.join(', ')}
        FROM jobs j
        LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
        ${whereClause}${cursorPredicate}
        ORDER BY ${orderParts.join(', ')}
        LIMIT $${limitParam}${offsetSql}
    `, dataParams);
    const rows = probedRows.slice(0, pageLimit);
    const hasMore = probedRows.length > pageLimit;

    // Fetch tags for all jobs in batch
    const jobIds = rows.map(r => r.id);
    let tagsMap = {};
    if (jobIds.length > 0) {
        const { rows: tagRows } = await db.query(`
            SELECT jta.job_id, t.id, t.name, t.color, t.is_active
            FROM job_tag_assignments jta
            JOIN job_tags t ON t.id = jta.tag_id
            JOIN jobs scoped_job ON scoped_job.id = jta.job_id AND scoped_job.company_id = $2
            WHERE jta.job_id = ANY($1)
            ORDER BY t.sort_order, t.id
        `, [jobIds, companyId]);
        for (const tr of tagRows) {
            if (!tagsMap[tr.job_id]) tagsMap[tr.job_id] = [];
            tagsMap[tr.job_id].push({ id: tr.id, name: tr.name, color: tr.color, is_active: tr.is_active });
        }
    }

    // Fetch actual paid + signed outstanding amounts from invoices and the live
    // Job payment pool. An invoice_id on a ledger row is receipt metadata only.
    const paymentsMap = {};
    if (jobIds.length > 0 && companyId) {
        const paidRows = await jobFinanceQueries.listJobPaymentRollups(companyId, jobIds);
        for (const pr of paidRows) {
            paymentsMap[pr.job_id] = { total_paid: pr.total_paid, total_due: pr.total_due };
        }
    }

    const results = rows.map(r => {
        const job = rowToJob(r);
        job.tags = tagsMap[r.id] || [];
        const pay = paymentsMap[r.id];
        // No local invoice or Job-pool money → retain the Zenbooker fallback.
        job.amount_paid = pay ? pay.total_paid : null;
        job.balance_due = pay ? pay.total_due : null;
        return job;
    });

    const lastRow = rows.at(-1);
    const cursorValues = lastRow
        ? [
            ...(sort.nullable ? [Boolean(lastRow.__cursor_null)] : []),
            lastRow.__cursor_value == null ? null : String(lastRow.__cursor_value),
            String(lastRow.__cursor_id),
        ]
        : [];
    const nextCursor = mode === 'cursor' && hasMore && lastRow
        ? encodeCursor({
            endpoint: 'jobs',
            sort: sortBy,
            direction: sortOrder,
            fingerprint,
            values: cursorValues,
        }, cursorExpectation)
        : null;

    return {
        results,
        total,
        offset: mode === 'offset' ? Number(offset) : 0,
        limit: pageLimit,
        has_more: hasMore,
        facets,
        pagination: {
            mode,
            limit: pageLimit,
            returned: results.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
        },
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
            SUM(CASE WHEN i.status NOT IN ('void','voided','refunded')
                THEN COALESCE(i.total, 0) - COALESCE(i.amount_paid, 0)
                ELSE 0
            END) AS balance_due
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
 * caller's failure path) after ANY committed local write that takes a job OUT of
 * 'Part arrived': updateBlancStatus or cancelJob.
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

function emitJobDomainEvent(companyId, eventType, jobId, payload, activityActor = null, client = null) {
    const statusPayload = eventType === 'job.status_changed'
        ? {
            job_number: payload.job_number || null,
            old_status: payload.old_status ?? payload.from ?? null,
            new_status: payload.new_status ?? payload.to ?? null,
        }
        : {};
    return eventBus.emit(companyId, eventType, {
        job_id: jobId,
        record_refs: [{ type: 'job', id: jobId }],
        ...payload,
        ...statusPayload,
    }, {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'job',
        aggregateId: jobId,
        ...(client ? { client } : {}),
    }).catch(() => {});
}

async function updateBlancStatus(jobId, newStatus, companyId, activityActor = null, options = {}) {
    if (!companyId) {
        const err = new Error('updateBlancStatus requires companyId');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const { client = null, job: suppliedJob = null, resolvedTransition = null } = options;
    const job = suppliedJob || await getJobById(jobId, companyId, null, { client, forUpdate: Boolean(client) });
    if (!job) {
        throw Object.assign(new Error(`Job #${jobId} not found`), { statusCode: 404 });
    }

    // Try FSM resolution first
    const result = resolvedTransition || await fsmService.resolveTransition(
        companyId,
        'job',
        job.blanc_status,
        newStatus,
        { queryable: client || db }
    );
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

    // $1 (blanc_status, varchar) must NOT be reused in the CASE comparison —
    // Postgres then deduces two types for it ("inconsistent types deduced for
    // parameter $1") and the whole UPDATE fails for every status change. Pass the
    // canceled flag as its own boolean param.
    await mutateWithActivity(
        activityActor,
        {
            companyId,
            action: 'job.status_changed',
            jobId,
            summary: { status: newStatus },
        },
        client => updateOwnedJob(
            client,
            `UPDATE jobs
             SET blanc_status = $1,
                 zb_canceled = CASE WHEN $2 THEN true ELSE zb_canceled END,
                 updated_at = NOW()
             WHERE id = $3 AND company_id = $4`,
            [newStatus, newStatus === 'Canceled', jobId, companyId],
            jobId
        ),
        { client }
    );

    await emitJobDomainEvent(companyId, 'job.status_changed', jobId, {
        job_number: job.job_number,
        from: job.blanc_status,
        to: newStatus,
    }, activityActor, client);

    // Fail-safe trigger seam (OUTBOUND-PARTS-CALL-001 §B.2 / S13): entering
    // 'Part arrived' fires the idempotent auto-task creation. Fire-and-forget —
    // NEVER awaited, NEVER rolls back or blocks the already-committed transition
    // (mirrors eventService.logEvent discipline). Lazy-require partsCallService to
    // avoid a circular dependency (partsCallService → tasksQueries).
    const fireAfterCommit = callback => {
        if (client?.afterCommit) client.afterCommit(callback);
        else callback();
    };
    if (newStatus === 'Part arrived' && job.blanc_status !== 'Part arrived') {
        fireAfterCommit(() => {
            try {
                require('./partsCallService')
                    .onPartArrived(jobId, companyId)
                    .catch(err => console.warn('[jobsService] onPartArrived hook failed (non-blocking):', err.message));
            } catch (err) {
                console.warn('[jobsService] onPartArrived hook failed (non-blocking):', err.message);
            }
        });
    }

    // CANCEL-001 leave-hook (CC-02 S1/S2): the job just left 'Part arrived' — any
    // queued robot call must not survive the exit. companyId can be null on the
    // legacy no-company path → fall back to the job row's own tenant.
    if (job.blanc_status === 'Part arrived' && newStatus !== 'Part arrived') {
        fireAfterCommit(() => fireRobotCallLeaveHook(jobId, companyId || job.company_id, newStatus));
    }

    return { ...job, blanc_status: newStatus, _prev_status: job.blanc_status };
}

// =============================================================================
// Historical Zenbooker note helpers
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
    const deduplicatedLocalNotes = deduplicateNotesByIdentity(localNotes);
    const deduplicatedZbNotes = deduplicateNotesByIdentity(zbNotes);
    const byZbId = new Map();          // zb id → local note
    const unmatchedLocalByText = [];   // [{ note, used }]
    const matched = new Set();         // local notes folded into a ZB note (by ref)
    for (const ln of deduplicatedLocalNotes) {
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

    const merged = deduplicatedZbNotes.map(zn => {
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
    const unechoed = deduplicatedLocalNotes.filter(ln =>
        ln && ln.id && ln.created_by && !ln.deleted_at && !ln.zb_note_id && !matched.has(ln)
    );
    return [...merged, ...unechoed];
}

// =============================================================================
// Notes
// =============================================================================

async function addNote(jobId, text, attachments = [], author = null, createdBy = null, noteId = null, companyId) {
    if (!companyId) {
        const err = new Error('addNote requires companyId');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const job = await getJobById(jobId, companyId);
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

    const notes = [...(job.notes || []), note];
    const updateSql = 'UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3';
    const updateParams = [JSON.stringify(notes), jobId, companyId];
    await db.query(updateSql, updateParams);

    return { notes };
}

// =============================================================================
// Local job actions
// =============================================================================

async function cancelJob(jobId, companyId, activityActor = null) {
    if (!companyId) {
        const err = new Error('cancelJob requires companyId');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const job = await getJobById(jobId, companyId);
    if (!job) {
        throw Object.assign(new Error(`Job #${jobId} not found`), { statusCode: 404 });
    }

    await mutateWithActivity(
        activityActor,
        {
            companyId,
            action: 'job.status_changed',
            jobId,
            summary: { status: 'Canceled' },
        },
        client => updateOwnedJob(
            client,
            `UPDATE jobs
             SET zb_canceled = true, blanc_status = $1, updated_at = NOW()
             WHERE id = $2 AND company_id = $3`,
            ['Canceled', jobId, companyId],
            jobId
        )
    );
    await emitJobDomainEvent(companyId, 'job.status_changed', jobId, {
        job_number: job.job_number,
        from: job.blanc_status,
        to: 'Canceled',
    }, activityActor);
    // CANCEL-001 leave-hook (CC-02 S2): this writer sets blanc_status DIRECTLY
    // (bypasses updateBlancStatus — fsm.js /apply + the jobs.js cancel route), so
    // it needs its own exit hook. Pre-state from the job loaded above.
    if (job.blanc_status === 'Part arrived') {
        fireRobotCallLeaveHook(jobId, job.company_id, 'Canceled');
    }
    return { ...job, blanc_status: 'Canceled', zb_canceled: true };
}

// =============================================================================
// Job Tags
// =============================================================================

/**
 * Update tags assigned to a job.
 * Only active tags can be newly assigned; existing inactive tags are preserved if re-sent.
 */
async function updateJobTags(jobId, tagIds, companyId, activityActor = null) {
    if (!companyId) throw new Error('updateJobTags requires companyId');
    const job = await getJobById(jobId, companyId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    const replaceTags = async (client) => {
        // Get currently assigned tag IDs
        const { rows: currentRows } = await client.query(
            `SELECT jta.tag_id
             FROM job_tag_assignments jta
             JOIN jobs j ON j.id = jta.job_id AND j.company_id = $2
             WHERE jta.job_id = $1 AND j.company_id = $2`,
            [jobId, companyId]
        );
        const currentTagIds = new Set(currentRows.map(r => r.tag_id));

        // Validate: new tags must be active
        if (tagIds && tagIds.length > 0) {
            const newTagIds = tagIds.filter(id => !currentTagIds.has(id));
            if (newTagIds.length > 0) {
                const { rows: tagRows } = await client.query(
                    'SELECT id, is_active FROM job_tags WHERE id = ANY($1)',
                    [newTagIds]
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
        await client.query(
            `DELETE FROM job_tag_assignments jta
             USING jobs j
             WHERE jta.job_id = j.id AND jta.job_id = $1 AND j.company_id = $2`,
            [jobId, companyId]
        );

        // Insert new assignments
        if (tagIds && tagIds.length > 0) {
            for (const tagId of tagIds) {
                await client.query(
                    `INSERT INTO job_tag_assignments (job_id, tag_id)
                     SELECT j.id, $2 FROM jobs j
                     WHERE j.id = $1 AND j.company_id = $3
                     ON CONFLICT DO NOTHING`,
                    [jobId, tagId, companyId]
                );
            }
        }
        return true;
    };

    if (activityActor) {
        await mutateWithActivity(
            activityActor,
            {
                companyId,
                action: 'job.updated',
                jobId,
            },
            replaceTags
        );
    } else {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await replaceTags(client);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    const tags = await getTagsForJob(jobId, companyId);
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
    return getFallbackJobActions(currentState);
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
async function updateJobLocation(
    companyId,
    jobId,
    { address, lat, lng, normalized_address, place_id } = {},
    activityActor = null
) {
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
    const job = await mutateWithActivity(
        activityActor,
        updated => updated ? {
            companyId, action: 'job.updated', jobId,
        } : null,
        async (client) => {
            const { rows } = await client.query(
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
            return rows[0] || null;
        }
    );
    if (!job) return null;

    // No coords but an address present → geocode async (FR-004).
    if (!hasCoords && job.address && String(job.address).trim()) {
        await routeSeg.enqueueGeocode(companyId, jobId).catch(() => {});
    }
    // Recalc affected route segments (coords changed → force surviving pairs).
    await routeSeg.recalcForJob(companyId, jobId, { beforeTechDays, coordsChanged: true })
        .catch(e => console.error('[JobsService] recalc after location edit failed (non-fatal):', e.message));

    return job;
}

/**
 * Update a job's free-text description (inline edit on the job panel). Tenant-scoped;
 * the updated_at trigger stamps the change. Returns the reshaped job.
 */
async function updateJobDescription(jobId, description, companyId, activityActor = null) {
    if (!companyId) throw new Error('updateJobDescription requires companyId');
    const text = typeof description === 'string' ? description : '';
    const updated = await mutateWithActivity(
        activityActor,
        row => row ? {
            companyId, action: 'job.updated', jobId,
        } : null,
        async (client) => {
            const { rows } = await client.query(
                `UPDATE jobs SET description = $1
                 WHERE id = $2 AND company_id = $3
                 RETURNING id`,
                [text, jobId, companyId]
            );
            return rows[0] || null;
        }
    );
    if (!updated) {
        throw Object.assign(new Error(`Job #${jobId} not found`), { statusCode: 404 });
    }
    return getJobById(jobId, companyId);
}

module.exports = {
    createJob,
    createManualJob,
    createDirectJob,
    getJobById,
    getJobBySeq,
    getJobByCode,
    getJobByZbId,
    listJobs,
    searchJobsForPicker,
    getJobBalanceDue,
    updateBlancStatus,
    mergeNotes,
    addNote,
    cancelJob,
    BLANC_STATUSES,
    ALLOWED_TRANSITIONS,
    zbJobToColumns,
    computeBlancStatusFromZb,
    updateJobTags,
    updateJobDescription,
    getTagsForJob,
    updateCoords,
    updateJobLocation,
    getJobTransitions,
    resolveAssignedProviderUserIds,
    refreshCompanyProviderMirror,
};
