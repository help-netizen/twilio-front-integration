'use strict';

/**
 * vapiCallStatus.js — OUTBOUND-PARTS-CALL-001, OPC1-T14 (spec §C.6 / S9 · arch §6).
 *
 * The VAPI end-of-call-report WEBHOOK that classifies an OUTBOUND robot call's
 * outcome and drives the retry state machine. This is the RESULT-classification
 * seam: the outboundCallWorker only owns *placement* (it leaves a placed attempt
 * `dialing` + stamps `vapi_call_id`); THIS webhook transitions that `dialing` row
 * to a terminal or next-retry state.
 *
 *   POST /api/vapi/call-status
 *
 * ── AUTH — shared secret, NOT a user session ────────────────────────────────
 *   Mounted in server.js at `/api/vapi/call-status` BEFORE the session-authed
 *   `/api/vapi` router (which requires `tenant.integrations.manage`) — VAPI is a
 *   machine caller with no session. Fail-closed: no configured secret → 503;
 *   header mismatch → 401. Header `x-vapi-secret`; secret = `VAPI_WEBHOOK_SECRET`
 *   (falls back to `VAPI_TOOLS_SECRET` so a single-secret deploy keeps working).
 *
 * ── ANTI-SPOOF — company comes from the ROW, never the body (S10 / §Data isolation)
 *   The only trusted correlation key from the body is `message.call.id`
 *   (`vapi_call_id`). Everything else — companyId, jobId, taskId, attempt_no — is
 *   read from the correlated `outbound_call_attempts` row. An unknown call.id → a
 *   200 no-op (idempotent, non-leaking; a duplicate/foreign webhook is harmless).
 *
 * ── IDEMPOTENCE (S9 / edge-6) ────────────────────────────────────────────────
 *   A `booked` / `exhausted` (any non-`dialing`) attempt is TERMINAL: a repeat
 *   webhook for the same call.id is a 200 no-op.
 *
 * ── SAFE-FAIL ────────────────────────────────────────────────────────────────
 *   Any unexpected error is logged and answered 200 (never a 500-storm that VAPI
 *   would hammer-retry). We never swallow silently — every branch logs.
 *
 * ── PULSE TIMELINE — OUTBOUND-CALL-TIMELINE-001 (CT-05) ──────────────────────
 *   Two NON-FATAL hooks into `vapiCallTimelineService` (CT-01) put the robot call
 *   into the Pulse `calls` timeline like a softphone call. They ride ON TOP of the
 *   retry FSM and can never disturb it (each is separately try/wrapped, company
 *   scope from the correlated row):
 *     • `status-update`      → `applyStatusUpdate` (live ringing→in-progress pill +
 *                              early re-key to the real Twilio sid). NO attempt
 *                              writes. Inert until the assistant emits status-update
 *                              (ops step CT-07) — silent degradation, not a blocker.
 *     • `end-of-call-report` → `finalizeFromEndOfCallReport` (terminal row +
 *                              duration/summary/transcript/recording), run BEFORE
 *                              the state-machine writes so a state throw can't
 *                              starve it and a repeat webhook re-finalizes idempotently.
 *
 * ── NO-RESURRECTION GUARD — OUTBOUND-PARTS-CALL-CANCEL-001 (CC-04, S9/S10) ────
 *   The transient branch (retry / exhausted) is gated by the shared
 *   `outboundCallWorker.retryBlockReason` guard: the failing attempt keeps its
 *   honest terminal status, but when the job left 'Part arrived' / is canceled /
 *   the chain carries a newer `canceled` row, NO retry or exhausted row is
 *   inserted and NO note is written (the cancel event already noted the job) —
 *   only an `outbound_call_retry_skipped` event. Fail-open: a guard fault means
 *   "not blocked" (retries behave exactly as before this guard existed).
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const jobsService = require('../services/jobsService');
const eventService = require('../services/eventService');
const outboundCallSettingsService = require('../services/outboundCallSettingsService');
// REUSE the worker's exported scheduling primitives — do NOT duplicate the
// backoff math or re-implement business-hours resolution (arch §6 / task constraint).
// retryBlockReason is the CANCEL-001 (CC-04) no-resurrection guard SHARED with the
// worker's retry-insertion site (spec S10 — both sites run one helper): job re-read
// (must still be 'Part arrived', non-canceled) + partsCallService.isChainCanceled
// (a `canceled` row newer than the failing attempt). Fail-open, never throws.
const {
    computeNextScheduledAt,
    resolveBusinessHoursGroup,
    retryBlockReason,
} = require('../services/outboundCallWorker');
const agentCallWindowService = require('../services/agentCallWindowService');
// OUTBOUND-CALL-TIMELINE-001 (CT-05): the NON-FATAL timeline seam (CT-01). Puts
// the robot call into the Pulse `calls` timeline — mid-call live transitions
// (applyStatusUpdate) and the finalized row with duration/summary/transcript/
// recording (finalizeFromEndOfCallReport). Its entry points are internally
// guarded (never throw), but every call here is ALSO wrapped so a hard fault can
// never disturb the attempt/retry state machine or the webhook's 200.
const vapiCallTimelineService = require('../services/vapiCallTimelineService');

// ─── Auth ────────────────────────────────────────────────────────────────────

function webhookSecretAuth(req, res, next) {
    const secret = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_TOOLS_SECRET;
    if (!secret) {
        // Fail closed: a machine webhook must never run unauthenticated.
        console.error('[vapiCallStatus] no webhook secret configured — refusing (fail-closed)');
        return res.status(503).json({ ok: false, error: 'vapi call-status webhook not configured' });
    }
    const header = req.headers['x-vapi-secret'];
    if (header !== secret) {
        // Diagnostic (no secret leaked): a webhook we reject never reaches the
        // finalize/classify body, so a silently-stuck call timeline points here.
        // Logs only whether VAPI sent ANY x-vapi-secret header, not its value.
        console.warn(`[vapiCallStatus] 401 x-vapi-secret mismatch (header_present=${header != null})`);
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
}

// ─── endedReason → next-state classification (retry state-table, spec §C.6/§Retry)
//
// Returns one of:
//   'booked'    — the assistant already booked (confirmPartsVisit landed): terminal
//                 success. Detected out-of-band (job Rescheduled / task done), not
//                 purely from endedReason.
//   'no_answer' — customer-did-not-answer / customer-busy → transient → retry.
//   'voicemail' — voicemail-detected → transient → retry.
//   'declined'  — customer engaged and declined all offered windows → terminal,
//                 hand to dispatcher (a human said no; retrying is noise).
//   'failed'    — hang-up / assistant-forwarded / place-failure / anything else →
//                 transient → retry.
function classifyEndedReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (!r) return 'failed';
    if (r.includes('did-not-answer') || r.includes('no-answer') || r.includes('busy')) {
        return 'no_answer';
    }
    if (r.includes('voicemail')) {
        return 'voicemail';
    }
    if (r.includes('declined') || r.includes('customer-declined')) {
        return 'declined';
    }
    // customer-ended / assistant-ended / assistant-forwarded / hang-up /
    // pipeline errors → transient failure that a later attempt may recover.
    return 'failed';
}

// ─── Notes ───────────────────────────────────────────────────────────────────

async function addAttemptNote(jobId, text) {
    try {
        await jobsService.addNote(jobId, text, [], 'AI Phone', 'AI Phone');
    } catch (err) {
        console.warn('[vapiCallStatus] addNote failed (non-fatal):', err.message);
    }
}

// ─── Correlation (anti-spoof, S10) ────────────────────────────────────────────
//
// The body's `message.call.id` (vapi_call_id) is the ONLY value we trust from a
// machine webhook. Everything else — companyId, jobId, attempt_no — is read from
// the correlated `outbound_call_attempts` row. Shared by BOTH the end-of-call
// classifier and the CT-05 status-update timeline branch so the anti-spoof rule
// (company from the ROW, never the body) lives in exactly one place. An unknown /
// foreign id → null (the caller answers a 200 no-op).
async function correlateAttempt(vapiCallId) {
    const { rows } = await db.query(
        `SELECT id, company_id, job_id, task_id, attempt_no, status, phone, contact_id, slot_json,
                scenario, lead_uuid
         FROM outbound_call_attempts
         WHERE vapi_call_id = $1
         LIMIT 1`,
        [vapiCallId]
    );
    return rows[0] || null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

router.post('/', webhookSecretAuth, async (req, res) => {
    try {
        const message = req.body && req.body.message;
        // Diagnostic breadcrumb (auth already passed): which VAPI message types
        // actually arrive per call. A call whose timeline stays "Ringing" but has
        // no 'end-of-call-report' line here means VAPI only sent status-updates —
        // distinct from an auth-rejected (401-logged) delivery.
        if (message && message.type) {
            const dcid = message.call && message.call.id;
            console.log(`[vapiCallStatus] rx type=${message.type} callId=${dcid || '?'}`);
        }

        // ── OUTBOUND-CALL-TIMELINE-001 (CT-05a): mid-call status-update ───────
        // status-update / conversation-update / tool-calls all reach this same
        // server.url and share the dialing attempt's call.id while the call is
        // still LIVE. They must NEVER classify the attempt or schedule a retry
        // (that is end-of-call's job — S2.3). BUT a `status-update` is worth a
        // TIMELINE write: it carries the live pill transition (ringing →
        // in-progress) and is usually where the real Twilio sid first appears
        // (early re-key). Correlate it (same anti-spoof SELECT → company from the
        // ROW), hand it to the NON-FATAL timeline seam, and return 200 WITHOUT
        // touching outbound_call_attempts. These only ARRIVE once the assistant's
        // serverMessages includes 'status-update' (ops step CT-07); until then
        // this branch is inert — silent degradation, not a blocker.
        if (message && message.type === 'status-update') {
            const liveCallId = message.call && message.call.id;
            if (liveCallId) {
                const liveAttempt = await correlateAttempt(liveCallId);
                // Unknown/foreign call.id → drop (we didn't place it) — no timeline row.
                if (liveAttempt) {
                    try {
                        await vapiCallTimelineService.applyStatusUpdate({ attempt: liveAttempt, message });
                    } catch (tlErr) {
                        console.warn('[vapiCallStatus] applyStatusUpdate failed (non-fatal):', tlErr && tlErr.message);
                    }
                }
            }
            return res.json({ ok: true });
        }

        // Only end-of-call reports classify an attempt. Any OTHER message type
        // (conversation-update, tool-calls…) can reach this same server.url and
        // carry the same call.id while the call is still LIVE — acting on them
        // would prematurely terminate the dialing attempt and schedule a spurious
        // retry mid-call. Ignore anything else → 200 no-op.
        if (!message || message.type !== 'end-of-call-report') {
            return res.json({ ok: true });
        }
        // The correlation key — the ONLY value we trust from the body.
        const vapiCallId = message && message.call && message.call.id;
        const endedReason = message && (message.endedReason || (message.call && message.call.endedReason));

        if (!vapiCallId) {
            // Not an end-of-call report we can correlate → no-op (don't error).
            return res.json({ ok: true });
        }

        // Correlate → the row is the sole source of companyId (anti-spoof S10).
        const attempt = await correlateAttempt(vapiCallId);
        if (!attempt) {
            // Unknown call.id → 200 no-op, no leak (foreign/duplicate/late webhook).
            return res.json({ ok: true });
        }

        const companyId = attempt.company_id;
        const jobId = attempt.job_id;

        // ── OUTBOUND-CALL-TIMELINE-001 (CT-05b): finalize the Pulse timeline ──
        // Put the finished robot call into the `calls` timeline (terminal row +
        // duration/summary/transcript/recording, re-keyed to the real Twilio sid).
        // Placed AFTER correlation but BEFORE the attempt state-machine writes AND
        // the idempotence no-op (S3.1 / граничный-2): a state-machine throw can't
        // starve the timeline, and a REPEAT (already-terminal) webhook still re-
        // finalizes idempotently. NON-FATAL: the seam is internally guarded, but we
        // wrap it too so a hard fault can neither break the 200 nor disturb the
        // retry FSM below. Company scope flows from `attempt`, never the body. If
        // this is lost, the 15-min synthetic sweeper (CT-02) is the safety net.
        try {
            await vapiCallTimelineService.finalizeFromEndOfCallReport({ attempt, message });
        } catch (tlErr) {
            console.warn('[vapiCallStatus] finalize timeline failed (non-fatal):', tlErr && tlErr.message);
        }

        // ── OUTBOUND-LEAD-CALL-001 / OLC-POSTCALL-001: lead post-call ─────────
        // Runs for EVERY lead end-of-call, BEFORE the parts dialing-only
        // idempotence guard below. Rationale: an AI booking flips the attempt to
        // 'booked' MID-CALL (confirmLeadBooking), so by end-of-call it is already
        // terminal — gating it behind `status === 'dialing'` would starve the
        // review task, the summary, and the 'Review' flip. handleLeadEndOfCall is
        // internally idempotent (booked/declined writes are status-guarded, the
        // review task carries an exactly-once belt), so a repeat webhook is safe.
        // Timeline finalize (CT-05b, above) already ran for this row.
        if (attempt.scenario === 'lead_call') {
            const klass = classifyEndedReason(endedReason);
            try {
                await require('../services/outboundLeadCallService')
                    .handleLeadEndOfCall(attempt, klass, endedReason, message);
            } catch (leadErr) {
                console.warn('[vapiCallStatus] lead end-of-call failed (safe-fail):', leadErr && leadErr.message);
            }
            return res.json({ ok: true });
        }

        // Idempotence (S9 / edge-6): a non-`dialing` PARTS attempt is terminal → no-op.
        if (attempt.status !== 'dialing') {
            return res.json({ ok: true });
        }

        // Booked detection (spec §C.6 terminal-success): confirmPartsVisit runs
        // DURING the call — it flips the job to 'Rescheduled' and closes the
        // part_arrived_call task. Either signal means the visit landed; we prefer
        // the job status (authoritative for the booking) and also accept a done
        // task. This is more reliable than parsing endedReason for "booked".
        let booked = false;
        try {
            const job = await jobsService.getJobById(jobId, companyId);
            if (job && job.blanc_status === 'Rescheduled') {
                booked = true;
            } else if (attempt.task_id != null) {
                const t = await db.query(
                    `SELECT status FROM tasks WHERE company_id = $1 AND id = $2 LIMIT 1`,
                    [companyId, attempt.task_id]
                );
                if (t.rows[0] && t.rows[0].status === 'done') booked = true;
            }
        } catch (err) {
            console.warn('[vapiCallStatus] booked-detection read failed (treating as not booked):', err.message);
        }

        if (booked) {
            // Terminal success. confirmPartsVisit already did the reschedule + note
            // + task-close; we only mark the attempt `booked`.
            await db.query(
                `UPDATE outbound_call_attempts SET status = 'booked', updated_at = now() WHERE id = $1`,
                [attempt.id]
            );
            return res.json({ ok: true });
        }

        const klass = classifyEndedReason(endedReason);

        // A human declined every offered window → hand to the dispatcher, do NOT
        // retry (a person said no; another robocall is noise). Terminal 'declined'.
        if (klass === 'declined') {
            await db.query(
                `UPDATE outbound_call_attempts SET status = 'declined', reason = $2, updated_at = now() WHERE id = $1`,
                [attempt.id, String(endedReason || 'customer-declined').slice(0, 120)]
            );
            await addAttemptNote(
                jobId,
                'AI: reached the customer but they declined the offered times — please follow up to set a visit.'
            );
            try {
                eventService.logEvent(companyId, 'job', jobId, 'outbound_call_declined',
                    { attemptNo: attempt.attempt_no }, 'system');
            } catch (_e) { /* non-fatal */ }
            return res.json({ ok: true });
        }

        // ── Transient (no_answer / voicemail / failed) → retry-or-exhaust ──────
        const settings = await outboundCallSettingsService.resolve(companyId);
        const maxAttempts = settings.max_attempts || 3;
        const now = new Date();

        // Mark THIS attempt with its terminal transient status (no_answer/voicemail/
        // failed) so it no longer occupies the (job_id) active-attempt guard.
        await db.query(
            `UPDATE outbound_call_attempts SET status = $2, reason = $3, updated_at = now() WHERE id = $1`,
            [attempt.id, klass, String(endedReason || klass).slice(0, 120)]
        );

        // ── OUTBOUND-PARTS-CALL-CANCEL-001 (CC-04) — no-resurrection guard ─────
        // THIS attempt already carries its honest terminal status (above). But a
        // chain whose job left 'Part arrived' (or that a leave-hook/human-contact
        // cancel marked while this call was in flight — S9/S10) must NOT be
        // resurrected: skip the retry INSERT, the exhausted marker AND both notes
        // (the cancel event already wrote its own note — never double-note).
        // SHARED helper with the worker's insertion site (S10); it is fail-open
        // and never throws, and we belt-and-brace it locally too so a guard fault
        // behaves as "not blocked" and can never break the webhook's 200.
        let retryBlockedBy = null;
        try {
            retryBlockedBy = await retryBlockReason(attempt);
        } catch (guardErr) {
            console.warn('[vapiCallStatus] retry guard failed (fail-open):', guardErr && guardErr.message);
        }
        if (retryBlockedBy) {
            try {
                eventService.logEvent(companyId, 'job', jobId, 'outbound_call_retry_skipped',
                    { attemptNo: attempt.attempt_no, outcome: klass, blockedBy: retryBlockedBy }, 'system');
            } catch (_e) { /* non-fatal */ }
            return res.json({ ok: true });
        }

        if (attempt.attempt_no < maxAttempts) {
            // Preserve the parts robot's retry ladder, then pass the candidate
            // through the shared outbound-agent guard before persisting it. A
            // call-window deferral does not increment attempt_no; this INSERT is
            // still the retry consumed by the completed attempt above.
            const timezoneContext = await resolveBusinessHoursGroup(companyId);
            const retryAt = computeNextScheduledAt(
                attempt.attempt_no,
                settings,
                timezoneContext,
                now
            );
            const nextScheduledAt = await agentCallWindowService.nextAllowedAt(
                companyId,
                agentCallWindowService.AGENT_KEYS.PARTS,
                retryAt
            );

            await db.query(
                `INSERT INTO outbound_call_attempts
                    (company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
                [
                    companyId, jobId, attempt.task_id, attempt.contact_id, attempt.phone,
                    attempt.attempt_no + 1, nextScheduledAt,
                    attempt.slot_json ? JSON.stringify(attempt.slot_json) : null,
                ]
            );

            const reasonWord = klass === 'voicemail' ? 'reached voicemail' : 'could not reach the customer';
            await addAttemptNote(
                jobId,
                `AI: ${reasonWord} — next attempt at ${nextScheduledAt.toISOString()}.`
            );
            try {
                eventService.logEvent(companyId, 'job', jobId, 'outbound_call_retry',
                    { attemptNo: attempt.attempt_no, nextScheduledAt: nextScheduledAt.toISOString(), outcome: klass }, 'system');
            } catch (_e) { /* non-fatal */ }
        } else {
            // Exhausted: no more attempts. Task stays open with the dispatcher, job
            // stays 'Part arrived' (no status flip here). Mark a terminal
            // `exhausted` marker attempt so the audit trail is explicit.
            await db.query(
                `INSERT INTO outbound_call_attempts
                    (company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json, reason)
                 VALUES ($1, $2, $3, $4, $5, $6, 'exhausted', now(), $7, 'max_attempts_reached')`,
                [
                    companyId, jobId, attempt.task_id, attempt.contact_id, attempt.phone,
                    attempt.attempt_no, attempt.slot_json ? JSON.stringify(attempt.slot_json) : null,
                ]
            );
            await addAttemptNote(
                jobId,
                'AI: automated attempts exhausted — please follow up with the customer to schedule the visit.'
            );
            try {
                eventService.logEvent(companyId, 'job', jobId, 'outbound_call_exhausted',
                    { attempts: maxAttempts }, 'system');
            } catch (_e) { /* non-fatal */ }
        }

        return res.json({ ok: true });
    } catch (err) {
        // Safe-fail: never a 500-storm. Log, answer 200 (VAPI won't hammer-retry).
        console.error('[vapiCallStatus] handler error (safe-fail 200):', err && err.message);
        return res.json({ ok: true });
    }
});

module.exports = router;
