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
const timelinesQueries = require('../db/timelinesQueries');
const jobsService = require('./jobsService');
const recommendSlots = require('./agentSkills/skills/recommendSlots');
const slotEngineService = require('./slotEngineService');
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
        `SELECT customer_name, contact_id FROM jobs WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [jobId, companyId]
    );
    const customer = (jobRow.rows[0]?.customer_name || '').trim() || 'the customer';
    const contactId = jobRow.rows[0]?.contact_id ?? null;

    const task = await tasksQueries.createTask(
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

    // BTN-06 (AR-TASK-UNIFY): also thread-link this job task to the customer's
    // Pulse timeline so it surfaces as Action Required in Pulse — the AR lateral
    // keys on `thread_id = timeline.id`, so a job-only task never shows there.
    // Best-effort + non-fatal + idempotent: no contact / no resolvable timeline →
    // the task stays job-only (the Job-card path is untouched) and a failure here
    // never breaks task creation. Company scope flows through both calls.
    if (contactId != null) {
        try {
            const timeline = await timelinesQueries.findOrCreateTimelineByContact(contactId, companyId, client || db);
            if (timeline && timeline.id) {
                const linked = await query(
                    `UPDATE tasks
                        SET thread_id = $3, contact_id = $4, subject_type = 'contact', subject_id = $4
                      WHERE company_id = $1 AND id = $2 AND thread_id IS NULL`,
                    [companyId, task.id, timeline.id, contactId]
                );
                if (linked.rowCount > 0) {
                    return tasksQueries.getTaskById(companyId, task.id, client);
                }
            }
        } catch (err) {
            console.error('[partsCallService] Pulse thread-link failed (non-fatal):', err.message);
        }
    }

    return task;
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
 * localPartsInTz(date, tz) — company-local 'YYYY-MM-DD' + 'HH:MM' (24h) for an
 * instant. Uses Intl.formatToParts so the result is locale-separator-independent
 * (never depends on the runtime's default locale for the field glue).
 */
function localPartsInTz(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
    };
}

/**
 * buildRobotCallSlot({ startIso, endIso, techName?, techId? }, companyId) —
 * SLOTPICK-001 (+ TECHSLOT-001).
 *
 * Convert a dispatcher-picked UTC arrival window (emitted by CustomTimeModal as
 * `Date.toISOString()` instants) into the CANONICAL `slot_json` the outbound
 * lifecycle offers on the call — the SAME shape recommendSlots produces
 * (`{ key, date, start, end, label, techName, confidence }`), plus the picked
 * technician (`techId`, TECHSLOT-001 §2) so the in-call recommendSlots can be
 * server-constrained to that tech. The client label is NEVER trusted; the
 * server re-derives everything in the company timezone. `techId` is an opaque
 * passthrough (it only ever narrows within the company's own roster downstream).
 *
 * Validation (server authority — any failure → `{ ok:false, error:'invalid_slot' }`):
 *   1. `startIso`/`endIso` parse to valid Dates.
 *   2. instant `start < end`.
 *   3. company-local `date(start) === date(end)` (an arrival window is same-day).
 *   4. `date >= todayStr` (company-local today; same-day allowed = grace).
 *   5. `date <= todayStr + 60d` (HORIZON).
 *
 * @param {{ startIso?: string, endIso?: string, techName?: string, techId?: string }} picked
 * @param {string} companyId
 * @returns {Promise<{ ok:true, slot:object }|{ ok:false, error:'invalid_slot' }>}
 */
async function buildRobotCallSlot({ startIso, endIso, techName, techId } = {}, companyId) {
    requireCompanyId(companyId);

    // 1) Both instants must parse.
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return { ok: false, error: 'invalid_slot' };
    }

    // 2) Ordered instants.
    if (startDate.getTime() >= endDate.getTime()) {
        return { ok: false, error: 'invalid_slot' };
    }

    // 3) Derive company-local date/start/end.
    const tz = await slotEngineService.resolveTimezone(companyId);
    const s = localPartsInTz(startDate, tz);
    const e = localPartsInTz(endDate, tz);
    const date = s.date;
    const start = s.time;
    const end = e.time;

    // No crossing of company-local midnight — same day required.
    if (s.date !== e.date) {
        return { ok: false, error: 'invalid_slot' };
    }

    // 4/5) Horizon: date in [todayStr, todayStr + 60d] (company-local). ISO date
    //       strings sort lexicographically, so string comparison is exact here.
    const todayStr = localPartsInTz(new Date(), tz).date;
    const horizon = new Date(`${todayStr}T00:00:00Z`);
    horizon.setUTCDate(horizon.getUTCDate() + 60);
    const horizonStr = horizon.toISOString().slice(0, 10);
    if (date < todayStr || date > horizonStr) {
        return { ok: false, error: 'invalid_slot' };
    }

    const slot = {
        key: `${date}|${start}|${end}`,
        date,
        start,
        end,
        label: recommendSlots.formatSlotLabel(date, start, end),
        techName: techName || null,
        confidence: null,
        // TECHSLOT-001 (§2): the dispatcher's lane pick rides the slot into
        // slot_json → worker → placeCall variableValues → in-call recommendSlots.
        techId: techId || null,
    };
    return { ok: true, slot };
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
 *      chosen slot in slot_json. The partial-unique (job_id) WHERE status IN
 *      ('pending','dialing') guard makes a double-press (S14) a graceful no-op:
 *      the unique_violation is caught → return the existing active row
 *      { ok:true, already:true, attemptId }. Returns { ok:true, attemptId, slot }.
 *
 * SLOTPICK-001: when `dispatcherSlot` ({ startIso, endIso, techName?, techId? }) is
 * supplied the dispatcher already picked the window in the reschedule modal — we
 * convert + validate it server-side via `buildRobotCallSlot` and SKIP step 4
 * (recommendSlots). A window that fails validation is a client-correctable pick
 * (bad/expired/out-of-horizon), so we return { ok:false, reason:'invalid_slot' }
 * WITHOUT stamping the task failed (the route maps it to HTTP 400). No
 * `dispatcherSlot` → the pre-existing auto-compute path (step 4) runs
 * byte-identically (backward-compat).
 *
 * TECHSLOT-001:
 *   - req 1 (server-authoritative, non-bypassable): a job with 2+ assigned
 *     technicians is NEVER robot-called — { ok:false, reason:'multi_tech' } right
 *     after the dialable guard, BEFORE the v1/phone/slot steps. NO attempt row,
 *     NO task stamp (mirrors not_dialable; the modal self-blocks with its own
 *     message, a direct API caller gets the route's 200 envelope refusal).
 *   - §2/§5: whatever slot wins (dispatcher pick OR auto-compute) is enriched
 *     before the INSERT with the tech constraint + the job's location:
 *     `slot_json.techId` (dispatcher pick > single-assigned-tech default > null)
 *     and `slot_json.lat`/`lng` (from the already-loaded job; null when absent —
 *     non-fatal). The worker copies slot_json forward on retries, and placeCall
 *     lifts these into `variableValues` for the in-call recommendSlots.
 *
 * @param {number|string} jobId
 * @param {string} companyId
 * @param {number|string} taskId
 * @param {object} [client] optional pg client for tx-aware execution
 * @param {{ startIso:string, endIso:string, techName?:string, techId?:string }|null} [dispatcherSlot]
 */
async function startRobotCall(jobId, companyId, taskId, client = null, dispatcherSlot = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);

    try {
        // 1) Resolve the job (company-scoped) and confirm it is still dialable.
        const job = await jobsService.getJobById(jobId, companyId);
        if (!job || job.zb_canceled || job.blanc_status === 'Canceled'
            || job.blanc_status !== 'Part arrived') {
            return { ok: false, reason: 'not_dialable' };
        }

        // 1b) TECHSLOT-001 req-1 gate (server-authoritative, non-bypassable): a
        //     job with 2+ assigned technicians is never robot-called — the
        //     dispatcher calls manually. A domain refusal like not_dialable:
        //     NO attempt, NO markRobotCallFailed stamp (the task stays open and
        //     client-correctable), fired BEFORE the v1/phone/slot steps. The
        //     execute route maps it to a 200 envelope refusal (not a 400).
        if ((job.assigned_techs || []).length >= 2) {
            return { ok: false, reason: 'multi_tech' };
        }

        // 2) v1 dial-seam gate: Boston Masters + settings.enabled only.
        const settings = await outboundCallSettingsService.resolve(companyId);
        if (companyId !== DEFAULT_COMPANY_ID || settings.enabled === false) {
            return { ok: false, reason: 'disabled' };
        }

        // 3) Resolve the number to dial. Prefer the job's own customer_phone, but
        //    fall back to the linked contact's phone_e164 — many jobs (esp. manual /
        //    ZB-synced ones) carry the number ONLY on the contact record, so reading
        //    job.customer_phone alone wrongly reported no_phone. (PARTS-CALL-PHONE-FALLBACK-001)
        let phone = (job.customer_phone || '').trim() || null;
        if (!phone && job.contact_id != null) {
            try {
                const cRes = await query(
                    `SELECT phone_e164 FROM contacts WHERE id = $1 AND company_id = $2 LIMIT 1`,
                    [job.contact_id, companyId]
                );
                phone = (cRes.rows[0]?.phone_e164 || '').trim() || null;
            } catch (err) {
                console.error('[partsCallService] contact phone fallback lookup failed:', err.message);
            }
        }
        // No phone anywhere → can't dial (FR-9). Reason on task; job stays Part arrived.
        if (!phone) {
            await markRobotCallFailed(companyId, taskId, NO_SLOTS_DISPATCHER_REASON, client);
            return { ok: false, reason: 'no_phone' };
        }

        // 4) Resolve the slot to offer.
        //    (a) SLOTPICK-001 dispatcher pick: convert + validate the chosen window
        //        server-side and SKIP the engine. Invalid → NO INSERT, NO task-stamp
        //        (client-correctable); the route maps reason:'invalid_slot' → HTTP 400.
        //    (b) Auto-compute (backward-compat): recommendSlots internally gates on the
        //        smart-slot-engine app and safe-fails; every non-happy outcome
        //        (available:false / fallback:true / empty / throw) is "no slots → no call".
        let slot;
        if (dispatcherSlot) {
            const built = await buildRobotCallSlot(dispatcherSlot, companyId);
            if (!built.ok) {
                return { ok: false, reason: 'invalid_slot' };
            }
            slot = built.slot;
        } else {
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
            slot = topSlot;
        }

        // 4c) TECHSLOT-001 (§2/§5): both slot paths converge here — carry the
        //     technician constraint + the job's location on the attempt.
        //     techId: the dispatcher's lane pick wins; when absent and the job
        //     has exactly ONE assigned tech, default to it (spec edge 1) so the
        //     in-call recs still scope to the job's tech; no tech at all → null
        //     (legacy all-tech in the skill). Coords come from the already-loaded
        //     job; missing/invalid → null, non-fatal (the in-call skill falls
        //     back to address/zip resolution). slot_json is copied forward on
        //     retry, so the constraint + location persist across attempts. The
        //     multi_tech gate (1b) guarantees ≤1 assigned tech by this point.
        const assignedTechs = Array.isArray(job.assigned_techs) ? job.assigned_techs : [];
        const soleTechId =
            assignedTechs.length === 1 && assignedTechs[0] && assignedTechs[0].id != null
                ? assignedTechs[0].id
                : null;
        const jobLat = job.lat != null ? Number(job.lat) : NaN;
        const jobLng = job.lng != null ? Number(job.lng) : NaN;
        slot = {
            ...slot,
            techId: slot.techId || soleTechId,
            lat: Number.isFinite(jobLat) ? jobLat : null,
            lng: Number.isFinite(jobLng) ? jobLng : null,
        };

        // 5) Enqueue the first attempt (immediate). The partial-unique index makes a
        //    concurrent double-press (S14) a graceful no-op — we return the in-flight row.
        try {
            const { rows } = await query(
                `INSERT INTO outbound_call_attempts
                    (company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json)
                 VALUES ($1, $2, $3, $4, $5, 1, 'pending', now(), $6::jsonb)
                 RETURNING id`,
                [companyId, jobId, taskId, job.contact_id ?? null, phone, JSON.stringify(slot)]
            );
            return { ok: true, attemptId: rows[0].id, slot };
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
    // SLOTPICK-001: ISO→canonical slot_json conversion + validation (route/tests).
    buildRobotCallSlot,
    // Exported for T7 / tests to reference the canonical constants.
    PART_ARRIVED_CALL_KIND,
    PART_ARRIVED_ACTIONS,
};
