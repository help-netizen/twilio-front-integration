/**
 * Jobs Service
 *
 * Local Blanc storage for Jobs with Zenbooker sync.
 * A Job is created when a Lead is converted (status = 'Converted').
 *
 * FSM:
 *   blanc_status  — parent status in Blanc (Submitted, Waiting for parts, etc.)
 *   zb_status     — Zenbooker substatus (scheduled, en-route, complete)
 *   zb_rescheduled, zb_canceled — Zenbooker boolean flags
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');

// =============================================================================
// Constants
// =============================================================================

const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
];

/** Manual transitions allowed in Blanc UI (§7) */
const ALLOWED_TRANSITIONS = {
    'Submitted': ['Follow Up with Client', 'Waiting for parts', 'Canceled'],
    'Waiting for parts': ['Submitted', 'Follow Up with Client', 'Canceled'],
    'Follow Up with Client': ['Waiting for parts', 'Submitted', 'Canceled'],
    'Visit completed': ['Follow Up with Client', 'Job is Done', 'Canceled'],
    'Job is Done': ['Canceled'],
    'Rescheduled': ['Submitted', 'Canceled'],
    'Canceled': [],  // terminal
};

/** Blanc → Zenbooker outbound mapping (§6) */
const OUTBOUND_MAP = {
    'Submitted': 'scheduled',    // → set zb_status to scheduled
    'Waiting for parts': 'complete',     // → set zb_status to complete
    'Job is Done': 'complete',     // → set zb_status to complete
};

// =============================================================================
// Helpers
// =============================================================================

function rowToJob(row) {
    return {
        id: row.id,
        lead_id: row.lead_id,
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
        territory: row.territory,
        invoice_total: row.invoice_total,
        invoice_status: row.invoice_status,
        assigned_techs: row.assigned_techs || [],
        notes: row.notes || [],
        tags: row.tags || [],

        company_id: row.company_id,
        created_at: row.created_at ? row.created_at.toISOString() : null,
        updated_at: row.updated_at ? row.updated_at.toISOString() : null,
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
        // Use time_slot to compute the correct end time matching ZB display.
        end_date: (() => {
            if (zbJob.time_slot?.end_time && zbJob.start_date) {
                // time_slot has local times (e.g. "12:00"), start_date has the date in UTC
                // Compute offset from start_time to end_time and apply to start_date
                const startMinutes = zbJob.time_slot.start_time
                    ? parseInt(zbJob.time_slot.start_time.split(':')[0]) * 60 + parseInt(zbJob.time_slot.start_time.split(':')[1])
                    : null;
                const endMinutes = parseInt(zbJob.time_slot.end_time.split(':')[0]) * 60 + parseInt(zbJob.time_slot.end_time.split(':')[1]);
                if (startMinutes !== null) {
                    const diffMs = (endMinutes - startMinutes) * 60 * 1000;
                    return new Date(new Date(zbJob.start_date).getTime() + diffMs).toISOString();
                }
            }
            return zbJob.end_date || null;
        })(),
        customer_name: zbJob.customer?.name || null,
        customer_phone: zbJob.customer?.phone || null,
        customer_email: zbJob.customer?.email || null,
        address: zbJob.service_address?.formatted ||
            [zbJob.service_address?.street, zbJob.service_address?.city,
            zbJob.service_address?.state, zbJob.service_address?.zip].filter(Boolean).join(', ') || null,
        territory: zbJob.territory?.name || null,
        invoice_total: zbJob.invoice?.total || null,
        invoice_status: zbJob.invoice?.status || null,
        assigned_techs: JSON.stringify(zbJob.assigned_providers || []),
        notes: JSON.stringify(zbJob.job_notes || zbJob.notes || []),
        zb_status: zbJob.status || 'scheduled',
        zb_canceled: !!zbJob.canceled,
        zb_rescheduled: !!zbJob.rescheduled,
        zb_raw: JSON.stringify(zbJob),
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
// CRUD
// =============================================================================

async function createJob({ leadId, contactId, zenbookerJobId, zbData, companyId }) {
    const cols = zbData ? zbJobToColumns(zbData) : {};
    const blancStatus = zbData
        ? computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled)
        : 'Submitted';

    const { rows } = await db.query(`
        INSERT INTO jobs (lead_id, contact_id, zenbooker_job_id, blanc_status,
            zb_status, zb_canceled, zb_rescheduled,
            job_number, service_name, start_date, end_date,
            customer_name, customer_phone, customer_email, address,
            territory, invoice_total, invoice_status, assigned_techs, notes,
            zb_raw, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
            territory = EXCLUDED.territory,
            invoice_total = EXCLUDED.invoice_total,
            invoice_status = EXCLUDED.invoice_status,
            assigned_techs = EXCLUDED.assigned_techs,
            notes = EXCLUDED.notes,
            zb_raw = EXCLUDED.zb_raw,
            updated_at = NOW()
        RETURNING *
    `, [
        leadId || null, contactId || null, zenbookerJobId, blancStatus,
        cols.zb_status || 'scheduled', cols.zb_canceled || false, cols.zb_rescheduled || false,
        cols.job_number || null, cols.service_name || null, cols.start_date || null, cols.end_date || null,
        cols.customer_name || null, cols.customer_phone || null, cols.customer_email || null, cols.address || null,
        cols.territory || null, cols.invoice_total || null, cols.invoice_status || null,
        cols.assigned_techs || '[]', cols.notes || '[]',
        cols.zb_raw || '{}', companyId || null,
    ]);

    return rowToJob(rows[0]);
}

async function getJobById(id) {
    const { rows } = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);
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

async function listJobs({ blancStatus, zbCanceled, search, offset = 0, limit = 50, companyId, contactId, sortBy, sortOrder, onlyOpen, startDate, endDate, serviceName, provider, tagIds, tagMatch } = {}) {
    const conditions = [];
    const params = [];
    let idx = 0;

    if (companyId) {
        idx++; conditions.push(`j.company_id = $${idx}`); params.push(companyId);
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
        conditions.push(`(
            j.job_number ILIKE $${idx} OR
            j.service_name ILIKE $${idx} OR
            j.customer_name ILIKE $${idx} OR
            j.customer_phone ILIKE $${idx} OR
            j.address ILIKE $${idx} OR
            EXISTS (
                SELECT 1 FROM job_tag_assignments jta2
                JOIN job_tags t2 ON t2.id = jta2.tag_id
                WHERE jta2.job_id = j.id AND t2.name ILIKE $${idx}
            )
        )`);
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
        service_name: 'j.service_name',
        start_date: 'j.start_date',
        blanc_status: 'j.blanc_status',
        created_at: 'j.created_at',
    };
    const sortCol = SORTABLE_COLUMNS[sortBy] || 'j.created_at';
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

    const results = rows.map(r => {
        const job = rowToJob(r);
        job.tags = tagsMap[r.id] || [];
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

// =============================================================================
// FSM — Manual status transitions
// =============================================================================

async function updateBlancStatus(jobId, newStatus) {
    if (!BLANC_STATUSES.includes(newStatus)) {
        throw new Error(`Invalid blanc_status: ${newStatus}`);
    }

    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    const allowed = ALLOWED_TRANSITIONS[job.blanc_status] || [];
    if (!allowed.includes(newStatus)) {
        throw new Error(`Transition ${job.blanc_status} → ${newStatus} is not allowed`);
    }

    await db.query(
        'UPDATE jobs SET blanc_status = $1, updated_at = NOW() WHERE id = $2',
        [newStatus, jobId]
    );

    // Outbound sync to Zenbooker (§6)
    if (job.zenbooker_job_id && OUTBOUND_MAP[newStatus]) {
        try {
            const targetZbStatus = OUTBOUND_MAP[newStatus];
            if (targetZbStatus === 'complete') {
                await zenbookerClient.markJobComplete(job.zenbooker_job_id);
            } else if (targetZbStatus === 'scheduled') {
                // No API to set back to scheduled — skip
            }
            // Also sync canceled
            if (newStatus === 'Canceled') {
                await zenbookerClient.cancelJob(job.zenbooker_job_id);
            }
            console.log(`[JobsService] Outbound sync: job ${jobId} → ${newStatus} (zb: ${targetZbStatus})`);
        } catch (err) {
            console.error(`[JobsService] Outbound sync error:`, err.response?.data || err.message);
        }
    }

    // Handle Cancel separately (not in OUTBOUND_MAP but still needs API call)
    if (newStatus === 'Canceled' && job.zenbooker_job_id && !OUTBOUND_MAP['Canceled']) {
        try {
            await zenbookerClient.cancelJob(job.zenbooker_job_id);
        } catch (err) {
            console.error(`[JobsService] Cancel sync error:`, err.response?.data || err.message);
        }
    }

    return { ...job, blanc_status: newStatus };
}

// =============================================================================
// Sync — Inbound from Zenbooker webhook
// =============================================================================

/**
 * Sync a Zenbooker job event into the local jobs table.
 * Creates or updates the local job, recalculates blanc_status.
 */
async function syncFromZenbooker(zbJobId, zbData, companyId = null, eventType = '') {
    const cols = zbJobToColumns(zbData);
    const newBlancStatus = computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled, eventType);

    // Try to match ZB customer → Blanc contact
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

    if (existing) {
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
                territory = COALESCE($13, territory),
                invoice_total = COALESCE($14, invoice_total),
                invoice_status = COALESCE($15, invoice_status),
                assigned_techs = $16::jsonb,
                notes = $17::jsonb,
                zb_raw = $18::jsonb,
                contact_id = COALESCE($20, contact_id),
                updated_at = NOW()
            WHERE zenbooker_job_id = $19
        `, [
            cols.zb_status, cols.zb_canceled, cols.zb_rescheduled,
            newBlancStatus,
            cols.job_number, cols.service_name, cols.start_date, cols.end_date,
            cols.customer_name, cols.customer_phone, cols.customer_email, cols.address,
            cols.territory, cols.invoice_total, cols.invoice_status,
            cols.assigned_techs, cols.notes, cols.zb_raw,
            zbJobId, contactId,
        ]);

        console.log(`[JobsService] Synced job ${zbJobId}: blanc_status ${existing.blanc_status} → ${newBlancStatus}`);
        return { updated: true, job_id: existing.id, blanc_status: newBlancStatus };
    } else {
        // Create new job linked to contact
        const job = await createJob({ zenbookerJobId: zbJobId, zbData, companyId, contactId });
        console.log(`[JobsService] Created local job for zb_id=${zbJobId}, id=${job.id}, contact=${contactId}`);
        return { updated: true, job_id: job.id, blanc_status: job.blanc_status, created: true };
    }
}

// =============================================================================
// Notes
// =============================================================================

async function addNote(jobId, text) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    const notes = [...(job.notes || []), { text, created: new Date().toISOString() }];
    await db.query('UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(notes), jobId]);

    // Also push to Zenbooker if linked
    if (job.zenbooker_job_id) {
        try {
            await zenbookerClient.addJobNote(job.zenbooker_job_id, { text });
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

    if (job.zenbooker_job_id) {
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
    return { ...job, blanc_status: 'Canceled', zb_canceled: true };
}

async function markEnroute(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    if (job.zenbooker_job_id) {
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

    if (job.zenbooker_job_id) {
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

    if (job.zenbooker_job_id) {
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
// Exports
// =============================================================================
module.exports = {
    createJob,
    getJobById,
    getJobByZbId,
    listJobs,
    updateBlancStatus,
    syncFromZenbooker,
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
};
