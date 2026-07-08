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
const groupRouting = require('./groupRouting');

const DEFAULT_INTERVAL_MS = 60_000; // 60s tick, matching snoozeScheduler.

// How many due rows to claim per tick. Small: dialing is I/O-bound (each does a
// VAPI POST) and we don't want one tick to hold a large claim across a slow API.
const BATCH = 10;

let intervalHandle = null;

// =============================================================================
// Retry / business-hours scheduling helpers
// =============================================================================

/**
 * Resolve the group object `groupRouting.isBusinessHours(group, now)` expects
 * ({ id, timezone }) for a company. We use the company's first user_group for the
 * `user_group_hours` lookup and the company's own timezone for local-time
 * formatting. If the company has no group, `isBusinessHours` treats "no hours"
 * as open (returns true) — the safe default is to allow the dial. Safe-fail:
 * never throws; on any DB error returns a permissive group (open).
 */
async function resolveBusinessHoursGroup(companyId) {
    try {
        const { rows } = await db.query(
            `SELECT ug.id AS group_id,
                    COALESCE(c.timezone, 'America/New_York') AS timezone
             FROM companies c
             LEFT JOIN user_groups ug ON ug.company_id = c.id::text
             WHERE c.id = $1
             ORDER BY ug.created_at ASC
             LIMIT 1`,
            [companyId]
        );
        const row = rows[0];
        // group_id may be null (company has no groups) — isBusinessHours then
        // finds no hours rows and returns true (open). timezone always present.
        return {
            id: row ? row.group_id : null,
            timezone: (row && row.timezone) || 'America/New_York',
        };
    } catch (err) {
        console.warn('[outboundCallWorker] resolveBusinessHoursGroup failed, treating as open:', err.message);
        return { id: null, timezone: 'America/New_York' };
    }
}

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
 * Offset (ms) of `timezone` from UTC at the given local wall-clock moment, i.e.
 * localWallTime - UTC. Derived by formatting a probe UTC instant in the tz and
 * diffing — handles DST without any external library.
 */
function getTimezoneOffsetMs(timezone, year, month, day, hour) {
    const probe = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(probe).map(p => [p.type, p.value])
    );
    const asUTC = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        // Intl may emit '24' for midnight — normalize to 0.
        Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return asUTC - probe.getTime();
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
            // Unknown token → conservative immediate (worker's biz-hours clamp
            // at dial time still prevents an off-hours call).
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
    const job = await jobsService.getJobById(jobId, companyId);
    if (!job || job.zb_canceled || job.blanc_status === 'Canceled' || job.blanc_status !== 'Part arrived') {
        const reason = !job
            ? 'job_not_found'
            : (job.zb_canceled || job.blanc_status === 'Canceled' ? 'job_canceled' : `job_status_${job.blanc_status}`);
        await terminate(attempt.id, 'failed', reason);
        return;
    }

    // --- Retry-config for backoff / max_attempts (safe-fail → DEFAULTS). ---
    const settings = await outboundCallSettingsService.resolve(companyId);
    const group = await resolveBusinessHoursGroup(companyId);

    // --- Business-hours clamp: don't dial outside the company's open hours. ---
    // Push the row back to 'pending' at the next open time; do NOT dial now.
    const now = new Date();
    let open = true;
    try {
        open = await groupRouting.isBusinessHours(group, now);
    } catch (err) {
        // If we can't determine hours, err on the side of dialing (open).
        console.warn('[outboundCallWorker] isBusinessHours failed, proceeding as open:', err.message);
        open = true;
    }
    if (!open) {
        const nextOpen = nextBusinessMorning(now, group.timezone, settings.next_morning_hour);
        await db.query(
            `UPDATE outbound_call_attempts
             SET status = 'pending', scheduled_at = $2, updated_at = now()
             WHERE id = $1`,
            [attempt.id, nextOpen]
        );
        return;
    }

    // --- Place the call (safe-fail: placeCall resolves, never rejects). ---
    const result = await outboundCallService.placeCall({
        companyId,
        jobId,
        contactId: attempt.contact_id,
        customerName: job.customer_name,
        customerNumber: attempt.phone || job.customer_phone,
        slot: attempt.slot_json || undefined,
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
        return;
    }

    // --- Failed to PLACE the call → treat as a failed attempt, feed retry. ---
    const failReason = (result && result.error) || 'place_call_failed';
    await scheduleRetryOrExhaust(attempt, job, settings, group, failReason, now);
}

/**
 * On a failed placement: mark THIS attempt failed, then either enqueue the next
 * attempt (if attempt_no < max_attempts) or terminate as exhausted. Writes a job
 * note in both cases. The job stays 'Part arrived' and the task stays open with
 * the dispatcher regardless (no status flip here).
 */
async function scheduleRetryOrExhaust(attempt, job, settings, group, failReason, now) {
    const maxAttempts = settings.max_attempts || 3;

    // Mark the current attempt as failed (reason recorded for audit).
    await db.query(
        `UPDATE outbound_call_attempts
         SET status = 'failed', reason = $2, updated_at = now()
         WHERE id = $1`,
        [attempt.id, failReason]
    );

    if (attempt.attempt_no < maxAttempts) {
        const nextScheduledAt = computeNextScheduledAt(attempt.attempt_no, settings, group, now);
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
            await processAttempt(attempt);
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
};
