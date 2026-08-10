/**
 * Job FSM Sync Service
 *
 * Bi-directional sync between Albusto Job statuses and Zenbooker Job statuses.
 *
 * Data model:
 *   - A "Job" in Albusto = lead row with converted_to_job=true, status='Converted'
 *   - Albusto parent status → leads.sub_status
 *   - Zenbooker job ID   → leads.zenbooker_job_id
 *
 * ─── Inbound (Zenbooker → Albusto) ────────────────────────────────────────────
 *   Webhook events are mapped to Albusto sub_status using priority rules:
 *     1. canceled=true  → "Canceled"     (highest priority)
 *     2. rescheduled=true → "Rescheduled"
 *     3. status=complete  → "Visit completed"
 *     4. status=scheduled / en-route → "Submitted"
 *
 * ─── Outbound (Albusto → Zenbooker) ───────────────────────────────────────────
 *   When Albusto sub_status changes via PATCH /api/leads/:uuid:
 *     - "Submitted"         → no Zenbooker API call (already scheduled)
 *     - "Waiting for parts" → no Zenbooker API call (Albusto-only operational state)
 *     - "Visit completed"   → no Zenbooker API call (Albusto-only operational state)
 *     - "Job is Done"       → markJobComplete
 *     - "Canceled"          → cancelJob
 *     - others              → no automatic Zenbooker action
 */

const db = require('../db/connection');

// =============================================================================
// Constants
// =============================================================================

/** Valid Albusto (parent) Job statuses */
const BLANC_JOB_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
];

/**
 * Zenbooker webhook event → Albusto sub_status mapping.
 * Priority order: canceled > rescheduled > status-based.
 */
const EVENT_TO_STATUS = {
    'job.canceled': 'Canceled',
    'job.rescheduled': 'Rescheduled',
    'job.completed': 'Visit completed',
    'job.enroute': 'Submitted',
    'job.started': 'Submitted',
    'job.created': 'Submitted',
};

// =============================================================================
// Inbound: Zenbooker → Albusto
// =============================================================================

/**
 * Handle an inbound job webhook event from Zenbooker.
 * Finds the matching Albusto lead by zenbooker_job_id and updates sub_status.
 *
 * @param {Object} payload - Webhook payload { event, data, ... }
 * @returns {{ updated: boolean, lead_uuid?: string, sub_status?: string }}
 */
async function handleJobWebhook(payload, companyId) {
    if (!companyId) throw new Error('handleJobWebhook requires companyId');
    const event = payload.event;
    const jobId = payload.data?.id ? String(payload.data.id) : null;

    if (!jobId) {
        console.warn(`[JobSync] Missing data.id in webhook event=${event}`);
        return { updated: false, reason: 'missing_job_id' };
    }

    // 1. Find matching Albusto lead
    const { rows } = await db.query(
        `SELECT uuid, sub_status FROM leads
         WHERE zenbooker_job_id = $1
           AND converted_to_job = true
           AND company_id = $2
         LIMIT 1`,
        [jobId, companyId]
    );

    if (rows.length === 0) {
        console.log(`[JobSync] No Albusto lead found for zenbooker_job_id=${jobId}, event=${event}`);
        return { updated: false, reason: 'lead_not_found' };
    }

    const lead = rows[0];

    // 2. Determine new sub_status using priority rules
    let newSubStatus;

    // For events that directly map, use the event map
    if (EVENT_TO_STATUS[event]) {
        newSubStatus = EVENT_TO_STATUS[event];
    } else if (event === 'job.service_providers.assigned' ||
        event === 'job.rated' ||
        event === 'job.auto_assign_failed') {
        // These events don't change the parent status, but provider assignment
        // must still refresh the internal assignee mirror (PF007-HARDENING-001).
        if (event === 'job.service_providers.assigned') {
            try {
                await refreshAssigneeMirrorFromAssignment(jobId, payload.data, companyId);
            } catch (mirrorErr) {
                console.error(`[JobSync] Assignee mirror update failed for job ${jobId}:`, mirrorErr.message);
            }
        }
        console.log(`[JobSync] Event ${event} for job ${jobId} — no status change needed`);
        return { updated: false, reason: 'no_status_change', event };
    } else {
        console.log(`[JobSync] Unknown job event=${event}, skipping`);
        return { updated: false, reason: 'unknown_event' };
    }

    // 3. Apply priority override: fetch full job data for flag-based priority
    //    Priority: canceled > rescheduled > status-based
    if (event !== 'job.canceled' && event !== 'job.rescheduled') {
        try {
            const jobData = payload.data;
            if (jobData.canceled === true) {
                newSubStatus = 'Canceled';
            } else if (jobData.rescheduled === true) {
                newSubStatus = 'Rescheduled';
            }
        } catch (fetchErr) {
            console.warn(`[JobSync] Could not check flags for job ${jobId}:`, fetchErr.message);
        }
    }

    // 4. Skip if no change
    if (lead.sub_status === newSubStatus) {
        console.log(`[JobSync] Job ${jobId} already in sub_status='${newSubStatus}', skipping`);
        return { updated: false, reason: 'already_current' };
    }

    // 5. Update Albusto sub_status
    await db.query(
        `UPDATE leads SET sub_status = $1, updated_at = NOW()
         WHERE uuid = $2 AND company_id = $3`,
        [newSubStatus, lead.uuid, companyId]
    );

    console.log(`[JobSync] Updated lead ${lead.uuid}: sub_status '${lead.sub_status}' → '${newSubStatus}' (event=${event})`);

    return { updated: true, lead_uuid: lead.uuid, sub_status: newSubStatus };
}

/**
 * Refresh jobs.assigned_techs + the internal assignee mirror when Zenbooker
 * reports a provider assignment change (PF007-HARDENING-001 / TASK-RBAC-003).
 *
 * External provider ids are resolved to crm_users.id strictly inside the
 * job's own company; unmapped ids resolve to nothing. Idempotent.
 */
async function refreshAssigneeMirrorFromAssignment(zbJobId, eventData, companyId) {
    if (!companyId) throw new Error('refreshAssigneeMirrorFromAssignment requires companyId');
    const assignedProviders = eventData?.assigned_providers;
    if (!Array.isArray(assignedProviders)) {
        // Partial webhook payload — the full job sync path (syncFromZenbooker,
        // fed by the fetched full ZB job) covers the mirror in this case.
        return { updated: false, reason: 'no_assignment_payload' };
    }

    const { rows } = await db.query(
        `SELECT id, company_id
         FROM jobs
         WHERE zenbooker_job_id = $1 AND company_id = $2
         LIMIT 1`,
        [String(zbJobId), companyId]
    );
    if (rows.length === 0) return { updated: false, reason: 'job_not_found' };

    const job = rows[0];
    const jobsService = require('./jobsService');
    const mirror = await jobsService.resolveAssignedProviderUserIds(job.company_id, assignedProviders);

    await db.query(
        `UPDATE jobs
         SET assigned_techs = $1::jsonb,
             assigned_provider_user_ids = $2::jsonb,
             updated_at = NOW()
         WHERE id = $3 AND company_id = $4`,
        [JSON.stringify(assignedProviders), mirror, job.id, companyId]
    );

    console.log(`[JobSync] Assignee mirror updated for job ${job.id} (zb=${zbJobId}): ${mirror}`);
    return { updated: true, job_id: job.id };
}

// =============================================================================
// Outbound: Albusto → Zenbooker
// =============================================================================

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    handleJobWebhook,
    refreshAssigneeMirrorFromAssignment,
    BLANC_JOB_STATUSES,
    EVENT_TO_STATUS,
};
