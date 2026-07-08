'use strict';

/**
 * partsCallService.js — OUTBOUND-PARTS-CALL-001.
 *
 * The outbound "part arrived → book the finish visit" orchestration. This module
 * grows in waves; wave 2 (T5) ships ONLY `onPartArrived` — the idempotent
 * auto-task creator fired (fire-and-forget) by the `updateBlancStatus` hook
 * (T16) when a job enters the `Part arrived` status. `startRobotCall` (the
 * slot pre-compute + attempt enqueue) is a LATER wave (T7) and is intentionally
 * absent here; the module is left extensible for it.
 *
 * Everything is company-scoped: every SQL statement filters on `company_id`, and
 * `companyId` always flows in from the caller (ultimately `job.company_id`),
 * never a blind hardcode. Functions are tx-aware — an optional `client` is used
 * when provided so the work can run inside the status transaction; otherwise the
 * shared pool is used.
 */

const db = require('../db/connection');
const { requireCompanyId, queryFor } = require('../db/crmUtils');
const tasksQueries = require('../db/tasksQueries');
const jobsService = require('./jobsService');
const recommendSlots = require('./agentSkills/skills/recommendSlots');
const outboundCallSettingsService = require('./outboundCallSettingsService');

// v1 dial seam is gated to Boston Masters (spec §Scope / C.1). All code stays
// parameterized on job.company_id; this constant only guards the dial seam.
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// Default finish-visit duration (mirrors recommendSlots' APPOINTMENT_DURATION_MIN).
const FINISH_VISIT_DURATION_MIN = 120;

// Dispatcher-facing reason copy (S6, FR-9) written to the task when we can't dial.
const NO_SLOTS_DISPATCHER_REASON =
    'No available slots — dispatcher, please call the customer manually and set a time.';
const ENGINE_ERROR_DISPATCHER_REASON =
    'Scheduling engine error — dispatcher, please call the customer manually and set a time.';

// The closed action set stamped onto the auto-task (rendered as typed buttons by
// TaskCard; executed by the closed backend action registry — T14). Labels are the
// dispatcher-facing copy from the spec (§B.3 / S1).
const PART_ARRIVED_CALL_KIND = 'part_arrived_call';
const PART_ARRIVED_ACTIONS = [
    { type: 'robot_call', label: '🤖 Let the robot call' },
    { type: 'manual_call', label: "📞 I'll call myself" },
];

/**
 * onPartArrived(jobId, companyId, client?) — idempotent auto-task creation.
 *
 * Called (fire-and-forget, its own try/catch in the hook) after a job commits
 * into `Part arrived`. Creates EXACTLY ONE open `part_arrived_call` task per job:
 *
 *   1. Dedup guard (S1, OQ-5): SELECT for an already-open `part_arrived_call`
 *      task on this (company, job). Found → no-op (re-entering the status or a
 *      duplicate event never spawns a second task). `createTask` has no built-in
 *      upsert, so this SELECT guard IS the app-upsert (Deviation 2).
 *   2. Else resolve the job's customer name (company-scoped) for the title, and
 *      `createTask` on the job parent with `kind='part_arrived_call'` and the
 *      typed `actions`.
 *
 * Returns the created task, the existing open task (when deduped), or null.
 * The task's `created_by` defaults to 'user' inside `createTask` (this is a
 * system/automation task; there is no acting CRM user — it surfaces as Action
 * Required via a job parent under AR-TASK-UNIFY-001, so 'user' is correct — the
 * 'agent'/'system' created_by values are Pulse-timeline concepts that would hide
 * an entity-parent task from the cross-entity list).
 *
 * @param {number|string} jobId
 * @param {string} companyId
 * @param {object} [client] optional pg client for tx-aware execution
 */
async function onPartArrived(jobId, companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);

    // 1) Idempotency / dedup guard — one open part_arrived_call task per job.
    const existing = await query(
        `SELECT id FROM tasks
         WHERE company_id = $1 AND job_id = $2 AND kind = $3 AND status = 'open'
         LIMIT 1`,
        [companyId, jobId, PART_ARRIVED_CALL_KIND]
    );
    if (existing.rows.length > 0) {
        // Already have an open call task on this job — no-op (return it hydrated).
        return tasksQueries.getTaskById(companyId, existing.rows[0].id, client);
    }

    // 2) Resolve the customer name for a human-readable title (company-scoped).
    const jobRow = await query(
        `SELECT customer_name FROM jobs WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [jobId, companyId]
    );
    const customer = (jobRow.rows[0]?.customer_name || '').trim() || 'the customer';

    return tasksQueries.createTask(
        companyId,
        {
            parentType: 'job',
            parentId: jobId,
            description: `Part arrived — schedule completion visit for ${customer}`,
            kind: PART_ARRIVED_CALL_KIND,
            actions: PART_ARRIVED_ACTIONS,
        },
        client
    );
}

/**
 * Stamp the task's `robot_call` action with `state:'failed'` + a dispatcher-facing
 * `reason`, company-scoped, so the button reflects the pre-call failure (S6, FR-9).
 * Best-effort: a write failure here never turns a safe-fail into a throw — the task
 * simply stays open with the dispatcher. Preserves every other action verbatim.
 */
async function markRobotCallFailed(companyId, taskId, reason, client) {
    const query = queryFor(client, db);
    try {
        const { rows } = await query(
            `SELECT actions FROM tasks WHERE company_id = $1 AND id = $2 LIMIT 1`,
            [companyId, taskId]
        );
        if (rows.length === 0) return;
        const actions = Array.isArray(rows[0].actions) ? rows[0].actions : PART_ARRIVED_ACTIONS;
        const next = actions.map((a) =>
            a && a.type === 'robot_call' ? { ...a, state: 'failed', reason } : a
        );
        await query(
            `UPDATE tasks SET actions = $3::jsonb WHERE company_id = $1 AND id = $2`,
            [companyId, taskId, JSON.stringify(next)]
        );
    } catch (err) {
        console.error('[partsCallService] markRobotCallFailed failed (non-fatal):', err.message);
    }
}

/**
 * startRobotCall(jobId, companyId, taskId, client?) — pre-compute a slot, then
 * enqueue the FIRST outbound attempt (FR-5, FR-9; spec §C.1 / S2-start / S6 / S14).
 *
 * Invoked by the `robot_call` task-action handler (T14). It NEVER dials — it only
 * pre-computes the top slot and drops a single `pending` row into
 * `outbound_call_attempts`; the outboundCallWorker (T10) claims it and places the
 * call. Everything is company-scoped and safe-fail: any pre-call fault leaves the
 * job `Part arrived` and the task open with the dispatcher, and returns a shape
 * (never throws).
 *
 * Flow:
 *   1. Resolve the job (company-scoped via getJobById). Missing / not `Part arrived`
 *      / canceled → don't dial, { ok:false, reason:'not_dialable' }.
 *   2. v1 gate: unless companyId === DEFAULT_COMPANY_ID AND settings.enabled →
 *      short-circuit { ok:false, reason:'disabled' } (no attempt, no call).
 *   3. No customer phone (FR-9) → reason on task, { ok:false, reason:'no_phone' }.
 *   4. Pre-compute the top slot via recommendSlots (which itself gates on the
 *      smart-slot-engine app + safe-fails to fallback). available:false /
 *      fallback:true / empty / throw → NO call, NO attempt; write a dispatcher
 *      reason to the task, mark the robot_call action failed, leave the job
 *      `Part arrived`. Returns { ok:false, reason:'no_slots'|'engine_error' }.
 *   5. Else INSERT one `pending` attempt (immediate scheduled_at) carrying the
 *      top-1 slot in slot_json. The partial-unique (job_id) WHERE status IN
 *      ('pending','dialing') guard makes a double-press (S14) a graceful no-op:
 *      the unique_violation is caught → return the existing active row
 *      { ok:true, already:true, attemptId }. Returns { ok:true, attemptId, slot }.
 *
 * @param {number|string} jobId
 * @param {string} companyId
 * @param {number|string} taskId
 * @param {object} [client] optional pg client for tx-aware execution
 */
async function startRobotCall(jobId, companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);

    try {
        // 1) Resolve the job (company-scoped) and confirm it is still dialable.
        const job = await jobsService.getJobById(jobId, companyId);
        if (!job || job.zb_canceled || job.blanc_status === 'Canceled'
            || job.blanc_status !== 'Part arrived') {
            return { ok: false, reason: 'not_dialable' };
        }

        // 2) v1 dial-seam gate: Boston Masters + settings.enabled only.
        const settings = await outboundCallSettingsService.resolve(companyId);
        if (companyId !== DEFAULT_COMPANY_ID || settings.enabled === false) {
            return { ok: false, reason: 'disabled' };
        }

        // 3) No phone → can't dial (FR-9). Reason on task; job stays Part arrived.
        const phone = (job.customer_phone || '').trim() || null;
        if (!phone) {
            await markRobotCallFailed(companyId, taskId, NO_SLOTS_DISPATCHER_REASON, client);
            return { ok: false, reason: 'no_phone' };
        }

        // 4) Pre-compute the top slot. recommendSlots internally gates on the
        //    smart-slot-engine app and safe-fails; we treat every non-happy outcome
        //    (available:false / fallback:true / empty / throw) as "no slots → no call".
        let recs;
        try {
            recs = await recommendSlots.run(companyId, {}, {
                address: (job.address && String(job.address).trim()) || undefined,
                lat: job.lat != null ? Number(job.lat) : undefined,
                lng: job.lng != null ? Number(job.lng) : undefined,
                durationMinutes: FINISH_VISIT_DURATION_MIN,
            });
        } catch (err) {
            console.error('[partsCallService] recommendSlots threw:', err.message);
            await markRobotCallFailed(companyId, taskId, ENGINE_ERROR_DISPATCHER_REASON, client);
            return { ok: false, reason: 'engine_error' };
        }

        const topSlot = recs && recs.available && Array.isArray(recs.slots) ? recs.slots[0] : null;
        if (!recs || recs.fallback || !topSlot) {
            await markRobotCallFailed(companyId, taskId, NO_SLOTS_DISPATCHER_REASON, client);
            return { ok: false, reason: 'no_slots' };
        }

        // 5) Enqueue the first attempt (immediate). The partial-unique index makes a
        //    concurrent double-press (S14) a graceful no-op — we return the in-flight row.
        try {
            const { rows } = await query(
                `INSERT INTO outbound_call_attempts
                    (company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json)
                 VALUES ($1, $2, $3, $4, $5, 1, 'pending', now(), $6::jsonb)
                 RETURNING id`,
                [companyId, jobId, taskId, job.contact_id ?? null, phone, JSON.stringify(topSlot)]
            );
            return { ok: true, attemptId: rows[0].id, slot: topSlot };
        } catch (err) {
            if (err.code === '23505') {
                // In-flight active attempt already exists — return it (no 2nd call).
                const existing = await query(
                    `SELECT id FROM outbound_call_attempts
                     WHERE company_id = $1 AND job_id = $2 AND status IN ('pending','dialing')
                     ORDER BY id DESC LIMIT 1`,
                    [companyId, jobId]
                );
                return { ok: true, already: true, attemptId: existing.rows[0]?.id ?? null };
            }
            throw err;
        }
    } catch (err) {
        // Safe-fail: never turn a robot_call press into a 500. Task stays open.
        console.error('[partsCallService] startRobotCall failed (safe-fail):', err.message);
        return { ok: false, reason: 'engine_error' };
    }
}

module.exports = {
    onPartArrived,
    startRobotCall,
    // Exported for T7 / tests to reference the canonical constants.
    PART_ARRIVED_CALL_KIND,
    PART_ARRIVED_ACTIONS,
};
