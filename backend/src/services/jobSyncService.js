/**
 * Job FSM Sync Service
 *
 * Bi-directional sync between Blanc Job statuses and Zenbooker Job statuses.
 *
 * Data model:
 *   - A "Job" in Blanc = lead row with converted_to_job=true, status='Converted'
 *   - Blanc parent status → leads.sub_status
 *   - Zenbooker job ID   → leads.zenbooker_job_id
 *
 * ─── Inbound (Zenbooker → Blanc) ────────────────────────────────────────────
 *   Webhook events are mapped to Blanc sub_status using priority rules:
 *     1. canceled=true  → "Canceled"     (highest priority)
 *     2. rescheduled=true → "Rescheduled"
 *     3. status=complete  → "Visit completed"
 *     4. status=scheduled / en-route → "Submitted"
 *
 * ─── Outbound (Blanc → Zenbooker) ───────────────────────────────────────────
 *   When Blanc sub_status changes via PATCH /api/leads/:uuid:
 *     - "Submitted"         → no Zenbooker API call (already scheduled)
 *     - "Waiting for parts" → markJobComplete
 *     - "Job is Done"       → markJobComplete
 *     - "Canceled"          → cancelJob
 *     - others              → no automatic Zenbooker action
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');

// =============================================================================
// Constants
// =============================================================================

/** Valid Blanc (parent) Job statuses */
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
 * Zenbooker webhook event → Blanc sub_status mapping.
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
// Inbound: Zenbooker → Blanc
// =============================================================================

/**
 * Handle an inbound job webhook event from Zenbooker.
 * Finds the matching Blanc lead by zenbooker_job_id and updates sub_status.
 *
 * @param {Object} payload - Webhook payload { event, data, ... }
 * @returns {{ updated: boolean, lead_uuid?: string, sub_status?: string }}
 */
async function handleJobWebhook(payload) {
    const event = payload.event;
    const jobId = payload.data?.id ? String(payload.data.id) : null;

    if (!jobId) {
        console.warn(`[JobSync] Missing data.id in webhook event=${event}`);
        return { updated: false, reason: 'missing_job_id' };
    }

    // 1. Find matching Blanc lead
    const { rows } = await db.query(
        `SELECT uuid, sub_status FROM leads
         WHERE zenbooker_job_id = $1 AND converted_to_job = true
         LIMIT 1`,
        [jobId]
    );

    if (rows.length === 0) {
        console.log(`[JobSync] No Blanc lead found for zenbooker_job_id=${jobId}, event=${event}`);
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
        // These events don't change the parent status
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

    // 5. Update Blanc sub_status
    await db.query(
        `UPDATE leads SET sub_status = $1, updated_at = NOW()
         WHERE uuid = $2`,
        [newSubStatus, lead.uuid]
    );

    console.log(`[JobSync] Updated lead ${lead.uuid}: sub_status '${lead.sub_status}' → '${newSubStatus}' (event=${event})`);

    return { updated: true, lead_uuid: lead.uuid, sub_status: newSubStatus };
}

// =============================================================================
// Outbound: Blanc → Zenbooker
// =============================================================================

/**
 * Sync a Blanc sub_status change to Zenbooker.
 * Called after PATCH /api/leads/:uuid when SubStatus changed on a converted lead.
 *
 * @param {string} leadUuid - Lead UUID
 * @param {string} newSubStatus - New Blanc sub_status value
 * @returns {{ synced: boolean, action?: string }}
 */
async function syncBlancStatusToZenbooker(leadUuid, newSubStatus) {
    // 1. Fetch lead to get zenbooker_job_id
    const { rows } = await db.query(
        `SELECT zenbooker_job_id FROM leads
         WHERE uuid = $1 AND converted_to_job = true`,
        [leadUuid]
    );

    if (rows.length === 0 || !rows[0].zenbooker_job_id) {
        console.log(`[JobSync] Lead ${leadUuid} has no zenbooker_job_id, skipping outbound sync`);
        return { synced: false, reason: 'no_job_id' };
    }

    const jobId = rows[0].zenbooker_job_id;

    // 2. Map Blanc sub_status → Zenbooker API call
    try {
        switch (newSubStatus) {
            case 'Waiting for parts':
            case 'Job is Done':
                // §6: Both map to Zenbooker "complete"
                await zenbookerClient.markJobComplete(jobId);
                console.log(`[JobSync] Outbound: lead ${leadUuid} → markJobComplete (job=${jobId})`);
                return { synced: true, action: 'mark_complete' };

            case 'Submitted':
                // §6: Map to Zenbooker "scheduled" — no direct API to set scheduled,
                // but we don't need to call anything since this is the default state
                console.log(`[JobSync] Outbound: lead ${leadUuid} → Submitted (no Zenbooker API needed)`);
                return { synced: false, reason: 'no_api_for_scheduled' };

            case 'Canceled':
                await zenbookerClient.cancelJob(jobId);
                console.log(`[JobSync] Outbound: lead ${leadUuid} → cancelJob (job=${jobId})`);
                return { synced: true, action: 'cancel' };

            default:
                // Follow Up with Client, Visit completed, Rescheduled — no automatic Zenbooker action
                console.log(`[JobSync] Outbound: sub_status='${newSubStatus}' has no Zenbooker mapping`);
                return { synced: false, reason: 'no_mapping' };
        }
    } catch (err) {
        console.error(`[JobSync] Outbound sync error for lead ${leadUuid}, job ${jobId}:`,
            err.response?.data || err.message);
        throw err;
    }
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    handleJobWebhook,
    syncBlancStatusToZenbooker,
    BLANC_JOB_STATUSES,
    EVENT_TO_STATUS,
};
