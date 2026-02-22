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

        company_id: row.company_id,
        created_at: row.created_at ? row.created_at.toISOString() : null,
        updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
}

/** Map a Zenbooker API job object to flat columns for upsert */
function zbJobToColumns(zbJob) {
    return {
        job_number: zbJob.job_number || null,
        service_name: zbJob.service_name || null,
        start_date: zbJob.start_date || null,
        end_date: zbJob.end_date || null,
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
        notes: JSON.stringify(zbJob.notes || []),
        zb_status: zbJob.status || 'scheduled',
        zb_canceled: !!zbJob.canceled,
        zb_rescheduled: !!zbJob.rescheduled,
        zb_raw: JSON.stringify(zbJob),
    };
}

/**
 * Compute blanc_status from Zenbooker flags/status (§9 priority rules)
 *   1. canceled=true  → Canceled
 *   2. rescheduled=true → Rescheduled
 *   3. status=complete → Visit completed
 *   4. status=scheduled/en-route → Submitted
 */
function computeBlancStatusFromZb(zbStatus, zbCanceled, zbRescheduled) {
    if (zbCanceled) return 'Canceled';
    if (zbStatus === 'complete') return 'Visit completed';
    if (zbRescheduled) return 'Rescheduled';
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
    return rowToJob(rows[0]);
}

async function getJobByZbId(zbJobId) {
    const { rows } = await db.query('SELECT * FROM jobs WHERE zenbooker_job_id = $1', [zbJobId]);
    if (rows.length === 0) return null;
    return rowToJob(rows[0]);
}

async function listJobs({ blancStatus, zbCanceled, search, offset = 0, limit = 50, companyId, contactId, sortBy, sortOrder, onlyOpen, startDate, endDate } = {}) {
    const conditions = [];
    const params = [];
    let idx = 0;

    if (companyId) {
        idx++; conditions.push(`j.company_id = $${idx}`); params.push(companyId);
    }
    if (blancStatus) {
        idx++; conditions.push(`j.blanc_status = $${idx}`); params.push(blancStatus);
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
            j.address ILIKE $${idx}
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

    return {
        results: rows.map(rowToJob),
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
async function syncFromZenbooker(zbJobId, zbData) {
    const cols = zbJobToColumns(zbData);
    const newBlancStatus = computeBlancStatusFromZb(cols.zb_status, cols.zb_canceled, cols.zb_rescheduled);

    // Check if job exists
    const existing = await getJobByZbId(zbJobId);

    if (existing) {
        // Update existing — but don't override manual blanc_status if not a flag/status event
        // Only override if the computed status actually differs from what priority rules dictate
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
                updated_at = NOW()
            WHERE zenbooker_job_id = $19
        `, [
            cols.zb_status, cols.zb_canceled, cols.zb_rescheduled,
            newBlancStatus,
            cols.job_number, cols.service_name, cols.start_date, cols.end_date,
            cols.customer_name, cols.customer_phone, cols.customer_email, cols.address,
            cols.territory, cols.invoice_total, cols.invoice_status,
            cols.assigned_techs, cols.notes, cols.zb_raw,
            zbJobId,
        ]);

        console.log(`[JobsService] Synced job ${zbJobId}: blanc_status ${existing.blanc_status} → ${newBlancStatus}`);
        return { updated: true, job_id: existing.id, blanc_status: newBlancStatus };
    } else {
        // Create new (orphan — no lead linkage yet)
        const job = await createJob({ zenbookerJobId: zbJobId, zbData });
        console.log(`[JobsService] Created local job for zb_id=${zbJobId}, id=${job.id}`);
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

async function cancelJob(jobId) {
    const job = await getJobById(jobId);
    if (!job) throw new Error(`Job #${jobId} not found`);

    if (job.zenbooker_job_id) {
        await zenbookerClient.cancelJob(job.zenbooker_job_id);
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
        await zenbookerClient.markJobEnroute(job.zenbooker_job_id);
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
        await zenbookerClient.markJobInProgress(job.zenbooker_job_id);
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
        await zenbookerClient.markJobComplete(job.zenbooker_job_id);
    }
    await db.query(
        "UPDATE jobs SET zb_status = 'complete', blanc_status = 'Visit completed', updated_at = NOW() WHERE id = $1",
        [jobId]
    );
    return { ...job, zb_status: 'complete', blanc_status: 'Visit completed' };
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
};
