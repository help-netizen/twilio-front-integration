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
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const jobsService = require('../services/jobsService');
const eventService = require('../services/eventService');
const outboundCallSettingsService = require('../services/outboundCallSettingsService');
// REUSE the worker's exported scheduling primitives — do NOT duplicate the
// backoff math or re-implement business-hours resolution (arch §6 / task constraint).
const {
    computeNextScheduledAt,
    resolveBusinessHoursGroup,
} = require('../services/outboundCallWorker');

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

// ─── Handler ─────────────────────────────────────────────────────────────────

router.post('/', webhookSecretAuth, async (req, res) => {
    try {
        const message = req.body && req.body.message;
        // Only end-of-call reports classify an attempt. Other server messages
        // (status-update, conversation-update, tool-calls…) can reach this same
        // server.url and carry the same call.id while the call is still LIVE —
        // acting on them would prematurely terminate the dialing attempt and
        // schedule a spurious retry mid-call. Ignore anything else → 200 no-op.
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
        const { rows } = await db.query(
            `SELECT id, company_id, job_id, task_id, attempt_no, status, phone, contact_id, slot_json
             FROM outbound_call_attempts
             WHERE vapi_call_id = $1
             LIMIT 1`,
            [vapiCallId]
        );
        const attempt = rows[0];
        if (!attempt) {
            // Unknown call.id → 200 no-op, no leak (foreign/duplicate/late webhook).
            return res.json({ ok: true });
        }

        const companyId = attempt.company_id;
        const jobId = attempt.job_id;

        // Idempotence (S9 / edge-6): a non-`dialing` attempt is terminal → no-op.
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

        if (attempt.attempt_no < maxAttempts) {
            // Reuse the worker's backoff math (no duplication): immediate / +2h /
            // next-business-morning. The worker's business-hours clamp still applies
            // at dial time, so we don't need to clamp here.
            const group = await resolveBusinessHoursGroup(companyId);
            const nextScheduledAt = computeNextScheduledAt(attempt.attempt_no, settings, group, now);

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
