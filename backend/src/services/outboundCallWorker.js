/**
 * outboundCallWorker.js — OUTBOUND-PARTS-CALL-001, OPC1-T10 (Decision F, spec §C.4).
 *
 * The claim-loop worker that drains `outbound_call_attempts`. It is the *dialer*
 * side of the outbound "part arrived → book the finish visit" flow: it picks up
 * due `pending` rows, places the VAPI call, and — when a dial can't even be
 * placed — records a per-attempt job note and schedules the next retry per the
 * per-company backoff. The RESULT of a *placed* call (booked / no-answer /
 * voicemail / declined) is classified by the VAPI end-of-call webhook (OPC1-T14),
 * which transitions the `dialing` row from there; this worker only owns
 * placement + the failed-to-place retry path.
 *
 * Pattern mirrors `agentWorker` (FOR UPDATE SKIP LOCKED atomic claim) and the
 * `snoozeScheduler` start/stop/tick shape (60s setInterval). Everything is
 * company-scoped: companyId always comes from the attempt row, never a constant.
 *
 * SAFE-FAIL: every attempt is processed inside its own try/catch, so one bad row
 * (missing job, VAPI fault, note hiccup) can never abort the tick or corrupt
 * another company's row. The tick itself is wrapped too, so the interval never
 * dies. Env-gated by FEATURE_OUTBOUND_CALL_WORKER; the actual start() call lives
 * in src/server.js (OPC1-T12) — this module only exports start/stop/tick.
 */

const db = require('../db/connection');
const jobsService = require('./jobsService');
const outboundCallService = require('./outboundCallService');
const outboundCallSettingsService = require('./outboundCallSettingsService');
const agentCallWindowService = require('./agentCallWindowService');
// OUTBOUND-PARTS-CALL-CANCEL-001 (CC-04): the CC-01 cancel helpers. Used by the
// honest Guard-1 (task stamp) and the shared no-resurrection retry guard
// (isChainCanceled). partsCallService never requires this module — no cycle.
const partsCallService = require('./partsCallService');
// OUTBOUND-CALL-TIMELINE-001 (CT-04): mirror a placed robot call into the
// customer's Pulse timeline. The service is NON-FATAL by contract, but we still
// wrap the call here (best-effort side-effect — never blocks/reclassifies a dial).
const vapiCallTimelineService = require('./vapiCallTimelineService');

const DEFAULT_INTERVAL_MS = 60_000; // 60s tick, matching snoozeScheduler.

// How many due rows to claim per tick. Small: dialing is I/O-bound (each does a
// VAPI POST) and we don't want one tick to hold a large claim across a slow API.
const BATCH = 10;

let intervalHandle = null;

// =============================================================================
// Retry / business-hours scheduling helpers
// =============================================================================

/**
 * Resolve only the company timezone used by the parts-specific
 * `next_business_morning` retry token. Outbound eligibility no longer reads
 * user_group_hours; those rows are inbound-routing-only.
 */
async function resolveCompanyTimezone(companyId) {
    try {
        const { rows } = await db.query(
            `SELECT COALESCE(c.timezone, 'America/New_York') AS timezone
             FROM companies c
             WHERE c.id = $1
             LIMIT 1`,
            [companyId]
        );
        const row = rows[0];
        return {
            id: null,
            timezone: (row && row.timezone) || 'America/New_York',
        };
    } catch {
        console.warn('[outboundCallWorker] resolveCompanyTimezone failed; using default timezone');
        return { id: null, timezone: 'America/New_York' };
    }
}

// Compatibility for the webhook/tests that used the former group-hours helper.
const resolveBusinessHoursGroup = resolveCompanyTimezone;
const getTimezoneOffsetMs = agentCallWindowService.getTimezoneOffsetMs;

/**
 * Compute the next business-morning timestamp (next_morning_hour company-local,
 * default 09:00) as a UTC Date. Anchors on `from`, advances to the NEXT calendar
 * day in the company timezone, and pins the wall-clock hour. tz-aware via
 * Intl.DateTimeFormat (consistent with commit 6d5975a — render in company tz).
 */
function nextBusinessMorning(from, timezone, morningHour) {
    const tz = timezone || 'America/New_York';
    const hour = Number.isInteger(morningHour) ? morningHour : 9;

    // Local Y-M-D of `from` in the company tz.
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(from).map(p => [p.type, p.value])
    );
    const y = Number(parts.year);
    const m = Number(parts.month);
    const d = Number(parts.day);

    // Tomorrow's local date (UTC midday math avoids DST edge/rollover glitches).
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    const ty = tomorrow.getUTCFullYear();
    const tm = tomorrow.getUTCMonth() + 1;
    const td = tomorrow.getUTCDate();

    // Convert "tomorrow HH:00 in tz" → the correct UTC instant by measuring the
    // tz offset at that wall time (getTimezoneOffsetMs handles DST).
    const offsetMs = getTimezoneOffsetMs(tz, ty, tm, td, hour);
    return new Date(Date.UTC(ty, tm - 1, td, hour, 0, 0) - offsetMs);
}

/**
 * Compute the scheduled_at for the NEXT attempt given the just-failed attempt.
 * backoff_schedule[0] = attempt 1 (immediate), [1] = attempt 2 (+2h), [2] =
 * attempt 3 (next business morning). `justFailedNo` is the attempt_no that just
 * failed; the next attempt is `justFailedNo + 1`, whose backoff token is at index
 * `justFailedNo` (0-based). Unknown/absent token falls back to immediate.
 * @returns {Date}
 */
function computeNextScheduledAt(justFailedNo, settings, group, now = new Date()) {
    const schedule = Array.isArray(settings.backoff_schedule) ? settings.backoff_schedule : [];
    const token = schedule[justFailedNo]; // next attempt's backoff token
    switch (token) {
        case 'immediate':
            return new Date(now.getTime());
        case '+2h':
            return new Date(now.getTime() + 2 * 60 * 60 * 1000);
        case 'next_business_morning':
            return nextBusinessMorning(now, group.timezone, settings.next_morning_hour);
        default:
            // Unknown token → conservative immediate; every caller/claim then
            // passes this instant through agentCallWindowService.
            return new Date(now.getTime());
    }
}

// =============================================================================
// Note path — a human-readable note on the job for every UNsuccessful attempt
// =============================================================================

/**
 * Append an "AI Phone" note to the job describing the failed attempt + next-try
 * time. Uses the SAME note path as the in-call skill (jobsService.addNote with
 * author='AI Phone', createdBy='AI Phone', per rescheduleAppointment). Guarded —
 * a note hiccup must not fail the retry scheduling.
 */
async function addFailedAttemptNote(jobId, customerName, nextScheduledAt, exhausted) {
    try {
        const who = customerName || 'the customer';
        const text = exhausted
            ? `AI: tried to reach ${who} but could not place the call — automated attempts exhausted, please follow up.`
            : `AI: tried to reach ${who} but could not place the call — next attempt at ${nextScheduledAt.toISOString()}.`;
        await jobsService.addNote(jobId, text, [], 'AI Phone', 'AI Phone');
    } catch (err) {
        console.warn('[outboundCallWorker] addFailedAttemptNote failed (non-fatal):', err.message);
    }
}

// =============================================================================
// OUTBOUND-PARTS-CALL-CANCEL-001 (CC-04) — the shared no-resurrection guard
// =============================================================================

/**
 * retryBlockReason(attempt) — may this failing attempt's chain schedule its NEXT
 * attempt? Shared by BOTH retry-insertion sites (this worker's
 * `scheduleRetryOrExhaust` and the webhook's transient branch in
 * `routes/vapiCallStatus.js`) so the compound predicate lives in exactly one
 * place (spec S10). Company scope comes from the attempt ROW (anti-spoof).
 *
 * Two independent belts:
 *   1. Company-scoped job re-read — the job must still exist, be non-canceled
 *      and sit in 'Part arrived' (belt #2 of S10: works even when the cancel
 *      hook's marker write failed).
 *   2. `partsCallService.isChainCanceled` — a `canceled` row NEWER than the
 *      failing attempt (leave-hook flip or mid-flight marker, S9) kills the
 *      chain even if the job happens to sit in 'Part arrived' again. Old
 *      canceled rows (id <= attempt.id) never block a fresh re-queue (S12).
 *
 * @returns {Promise<string|null>} a short block reason ('job_not_found' |
 *   'job_canceled' | 'job_status_<X>' | 'chain_canceled') when the retry INSERT
 *   must be skipped, or null when the chain may continue. FAIL-OPEN: any read
 *   fault → null (happy-path retries behave exactly as today) — never throws.
 */
async function retryBlockReason(attempt) {
    const companyId = attempt.company_id;
    const jobId = attempt.job_id;
    try {
        const job = await jobsService.getJobById(jobId, companyId);
        if (!job) return 'job_not_found';
        if (job.zb_canceled || job.blanc_status === 'Canceled') return 'job_canceled';
        if (job.blanc_status !== 'Part arrived') return `job_status_${job.blanc_status}`;
    } catch (err) {
        console.warn('[outboundCallWorker] retry-guard job re-read failed (fail-open):', err.message);
    }
    try {
        if (await partsCallService.isChainCanceled(companyId, jobId, attempt.id)) {
            return 'chain_canceled';
        }
    } catch (err) {
        // isChainCanceled is fail-open (false) by contract; belt-and-braces.
        console.warn('[outboundCallWorker] retry-guard chain read failed (fail-open):', err.message);
    }
    return null;
}

// =============================================================================
// Per-attempt processing
// =============================================================================

/**
 * Handle one CLAIMED attempt row (already flipped to 'dialing' by the claim
 * UPDATE). All work here is company-scoped from `attempt.company_id`. Safe-fail:
 * the caller wraps this in try/catch, but we also guard internally so a partial
 * failure leaves the row in a sane state.
 */
async function processAttempt(attempt) {
    const companyId = attempt.company_id;
    const jobId = attempt.job_id;

    // --- Guard 1: job must still be actionable (Part arrived, not Canceled). ---
    // A job moved on (rescheduled/canceled) since enqueue should not be dialed.
    // CANCEL-001 (CC-04, S11): Guard-1 is now the HONEST net — a claimed row on
    // a job that left 'Part arrived' terminates as 'canceled' (was a dishonest
    // 'failed' with no note) and gets the same FR-3 job note + task stamp a
    // leave-hook cancel writes, so a sync-path race (status changed without any
    // hook firing) is still visible to the dispatcher. `job_not_found` keeps
    // 'failed' and writes nothing — there is no job to note on.
    const job = await jobsService.getJobById(jobId, companyId);
    if (!job) {
        await terminate(attempt.id, 'failed', 'job_not_found');
        return;
    }
    if (job.zb_canceled || job.blanc_status !== 'Part arrived') {
        // Reason keeps Guard-1's historical vocabulary (TC-CC-15).
        const reason = job.zb_canceled || job.blanc_status === 'Canceled'
            ? 'job_canceled'
            : `job_status_${job.blanc_status}`;
        await terminate(attempt.id, 'canceled', reason);
        // FR-3 copy (mirrors partsCallService.buildCancelCopy status_change).
        // zb_canceled with blanc_status still 'Part arrived' uses the S3 label.
        const newStatus = job.blanc_status !== 'Part arrived'
            ? job.blanc_status
            : 'Canceled (Zenbooker)';
        try {
            await jobsService.addNote(
                jobId,
                `AI: robot call canceled — job left 'Part arrived' (status changed to '${newStatus}').`,
                [], 'AI Phone', 'AI Phone'
            );
        } catch (err) {
            console.warn('[outboundCallWorker] Guard-1 cancel note failed (non-fatal):', err.message);
        }
        try {
            if (attempt.task_id != null) {
                await partsCallService.markRobotCallCanceled(
                    companyId, attempt.task_id,
                    `Canceled — job status changed to '${newStatus}'.`
                );
            }
        } catch (err) {
            console.warn('[outboundCallWorker] Guard-1 task stamp failed (non-fatal):', err.message);
        }
        return;
    }

    // --- Retry-config for backoff / max_attempts (safe-fail → DEFAULTS). ---
    const settings = await outboundCallSettingsService.resolve(companyId);
    const timezoneContext = await resolveCompanyTimezone(companyId);

    // --- Shared outbound call-window guard: carry, never drop. ---
    // Push this SAME row back to pending; a deferral does not consume attempt_no.
    const now = new Date();
    const allowedAt = await agentCallWindowService.nextAllowedAt(
        companyId,
        agentCallWindowService.AGENT_KEYS.PARTS,
        now
    );
    if (allowedAt.getTime() > now.getTime()) {
        await db.query(
            `UPDATE outbound_call_attempts
             SET status = 'pending', scheduled_at = $2, updated_at = now()
             WHERE id = $1 AND company_id = $3`,
            [attempt.id, allowedAt, companyId]
        );
        return;
    }

    // --- Outstanding balance for the voice agent ("how much do I owe?"). ---
    // Company-scoped local-invoice rollup. NON-FATAL: a lookup fault must NEVER
    // break the dial, so on any error we simply omit the balance and place the
    // call anyway. Formats a speak-safe STRING for the assistant:
    //   >0   → "$X.XX"                 (mirrors getInvoiceSummary's currency fmt)
    //   ≤0   → "paid in full, nothing due"
    //   null → left undefined/omitted  (job has no local invoice; the prompt then
    //          says a teammate will confirm — we never invent a number).
    let balanceDue;
    try {
        const bal = await jobsService.getJobBalanceDue(jobId, companyId);
        if (bal && bal.balanceDue != null) {
            balanceDue = bal.balanceDue > 0
                ? `$${Number(bal.balanceDue).toFixed(2)}`
                : 'paid in full, nothing due';
        }
    } catch (err) {
        console.warn('[outboundCallWorker] getJobBalanceDue failed (non-fatal), omitting balance:', err.message);
    }

    // --- Place the call (safe-fail: placeCall resolves, never rejects). ---
    const result = await outboundCallService.placeCall({
        companyId,
        jobId,
        contactId: attempt.contact_id,
        customerName: job.customer_name,
        customerNumber: attempt.phone || job.customer_phone,
        slot: attempt.slot_json || undefined,
        balanceDue,
    });

    if (result && result.ok) {
        // Placed. Store the VAPI call id for webhook correlation; the row stays
        // 'dialing' until the end-of-call webhook (T14) classifies the outcome.
        await db.query(
            `UPDATE outbound_call_attempts
             SET vapi_call_id = $2, updated_at = now()
             WHERE id = $1`,
            [attempt.id, result.vapiCallId]
        );

        // OUTBOUND-CALL-TIMELINE-001 (CT-04, spec S1): mirror the placed call
        // into the customer's Pulse timeline as a live "Ringing" row (softphone
        // model). Ordered AFTER the vapi_call_id stamp above (the source of truth
        // for retry correlation). NON-FATAL: a timeline write must NEVER fail the
        // dial or re-classify the attempt — the call is already placed and this
        // row is only a best-effort mirror (finalize self-heals it if skipped).
        // dialedNumber mirrors the exact number handed to placeCall as
        // customerNumber; callerId is the transient Twilio business line.
        try {
            await vapiCallTimelineService.recordPlacement({
                attempt,
                vapiCallId: result.vapiCallId,
                dialedNumber: attempt.phone || job.customer_phone,
                callerId: process.env.VAPI_OUTBOUND_TWILIO_NUMBER
                    || process.env.OUTBOUND_CALLER_ID
                    || null,
            });
        } catch (err) {
            console.warn('[outboundCallWorker] recordPlacement failed (non-fatal):', err.message);
        }
        return;
    }

    // --- Failed to PLACE the call → treat as a failed attempt, feed retry. ---
    const failReason = (result && result.error) || 'place_call_failed';
    await scheduleRetryOrExhaust(attempt, job, settings, timezoneContext, failReason, now);
}

/**
 * On a failed placement: mark THIS attempt failed, then either enqueue the next
 * attempt (if attempt_no < max_attempts) or terminate as exhausted. Writes a job
 * note in both cases. The job stays 'Part arrived' and the task stays open with
 * the dispatcher regardless (no status flip here).
 */
async function scheduleRetryOrExhaust(attempt, job, settings, timezoneContext, failReason, now) {
    const maxAttempts = settings.max_attempts || 3;

    // Mark the current attempt as failed (reason recorded for audit).
    await db.query(
        `UPDATE outbound_call_attempts
         SET status = 'failed', reason = $2, updated_at = now()
         WHERE id = $1`,
        [attempt.id, failReason]
    );

    // CANCEL-001 (CC-04, S10): no-resurrection guard — the SAME compound guard
    // as the webhook's retry site. THIS attempt already carries its honest
    // 'failed' above; when the job left 'Part arrived' (or the chain carries a
    // newer `canceled` row) we skip the next-attempt INSERT AND the notes — the
    // cancel event already wrote its own note (no double-noting). Fail-open +
    // never throws, so the worker loop is untouched.
    const blockedBy = await retryBlockReason(attempt);
    if (blockedBy) {
        console.log(`[outboundCallWorker] retry skipped for attempt ${attempt.id} (job ${attempt.job_id}): ${blockedBy}`);
        return;
    }

    if (attempt.attempt_no < maxAttempts) {
        const rawNextScheduledAt = computeNextScheduledAt(
            attempt.attempt_no,
            settings,
            timezoneContext,
            now
        );
        const nextScheduledAt = await agentCallWindowService.nextAllowedAt(
            attempt.company_id,
            agentCallWindowService.AGENT_KEYS.PARTS,
            rawNextScheduledAt
        );
        // Enqueue the next attempt. The partial-unique (job_id) WHERE
        // status IN ('pending','dialing') guard is satisfied because we just
        // flipped THIS row to 'failed' above (no active row remains).
        await db.query(
            `INSERT INTO outbound_call_attempts
                (company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
            [
                attempt.company_id, attempt.job_id, attempt.task_id, attempt.contact_id,
                attempt.phone, attempt.attempt_no + 1, nextScheduledAt,
                attempt.slot_json ? JSON.stringify(attempt.slot_json) : null,
            ]
        );
        await addFailedAttemptNote(attempt.job_id, job.customer_name, nextScheduledAt, false);
    } else {
        // Exhausted: no more attempts. Task stays with the dispatcher.
        await addFailedAttemptNote(attempt.job_id, job.customer_name, now, true);
    }
}

/** Terminate an attempt (no retry). Records a terminal status + reason. */
async function terminate(attemptId, status, reason) {
    await db.query(
        `UPDATE outbound_call_attempts
         SET status = $2, reason = $3, updated_at = now()
         WHERE id = $1`,
        [attemptId, status, reason]
    );
}

// =============================================================================
// Claim loop
// =============================================================================

/**
 * One tick: atomically claim up to BATCH due 'pending' rows (flip to 'dialing')
 * using FOR UPDATE SKIP LOCKED so multiple worker instances never grab the same
 * row, then process each in isolation. Returns the number of rows claimed.
 * Exported for direct unit-test invocation (OPC1-T11).
 */
async function tick() {
    let claimed = [];
    try {
        const res = await db.query(
            `UPDATE outbound_call_attempts
             SET status = 'dialing', updated_at = now()
             WHERE id IN (
                SELECT id FROM outbound_call_attempts
                WHERE status = 'pending' AND scheduled_at <= now()
                ORDER BY scheduled_at ASC
                LIMIT $1
                FOR UPDATE SKIP LOCKED
             )
             RETURNING *`,
            [BATCH]
        );
        claimed = res.rows;
    } catch (err) {
        console.error('[outboundCallWorker] claim query failed:', err.message);
        return 0;
    }

    for (const attempt of claimed) {
        // Per-attempt isolation: one bad row never aborts the tick nor touches
        // another company's row.
        try {
            // OUTBOUND-LEAD-CALL-001: per-row scenario dispatch. Lead chains are
            // processed by outboundLeadCallService (lazy require — no cycle);
            // every other row takes the parts path byte-identically.
            if (attempt.scenario === 'lead_call') {
                await require('./outboundLeadCallService').processLeadAttempt(attempt);
            } else {
                await processAttempt(attempt);
            }
        } catch (err) {
            console.error(`[outboundCallWorker] attempt ${attempt.id} (job ${attempt.job_id}) failed:`, err.message);
            // Best-effort: leave a reason on the row so it isn't silently stuck
            // in 'dialing'. Mark 'failed' so it doesn't block the (job_id) guard.
            try {
                await terminate(attempt.id, 'failed', `worker_error:${(err.message || '').slice(0, 120)}`);
            } catch (e2) {
                console.error('[outboundCallWorker] could not mark attempt failed:', e2.message);
            }
        }
    }
    return claimed.length;
}

// =============================================================================
// Lifecycle
// =============================================================================

function start() {
    if (intervalHandle) return;
    const interval = parseInt(process.env.OUTBOUND_CALL_WORKER_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
    intervalHandle = setInterval(() => {
        tick().catch(err => console.error('[outboundCallWorker] tick error:', err.message));
    }, interval);
    console.log(`📞 Outbound call worker started (${interval}ms tick)`);
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        console.log('📞 Outbound call worker stopped');
    }
}

module.exports = {
    start,
    stop,
    tick,
    // Exported for unit tests (OPC1-T11):
    processAttempt,
    computeNextScheduledAt,
    nextBusinessMorning,
    resolveBusinessHoursGroup,
    // CANCEL-001 (CC-04): shared with routes/vapiCallStatus.js — both retry-
    // insertion sites run ONE guard (spec S10).
    retryBlockReason,
    // Compatibility export; implementation lives in the shared call-window guard.
    getTimezoneOffsetMs,
};
