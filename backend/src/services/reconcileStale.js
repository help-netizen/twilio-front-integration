const db = require('../db/connection');
const queries = require('../db/queries');
const { isFinalStatus } = require('./stateMachine');
const { getTwilioClient } = require('./twilioClient');

/**
 * Reconcile stale calls — safety net for calls stuck in transient statuses.
 * 
 * Runs periodically from the inbox worker. Finds non-final calls older than
 * STALE_THRESHOLD_MINUTES and resolves them via Twilio API or child-leg logic.
 */

const STALE_THRESHOLD_MINUTES = 3;
// Synthetic `vapi:<id>` sids (outbound robot calls) never exist in Twilio; the row
// keeps this sid until a status-update/end-of-call webhook re-keys it to a real
// CA… sid. If that webhook is lost the row would sit non-final forever, so sweep it
// to a terminal status after a window far longer than any parts call could run.
// (OUTBOUND-CALL-TIMELINE-001 S5.2)
const SYNTHETIC_STALE_THRESHOLD_MINUTES = 15;

async function reconcileStaleCalls() {
    const traceId = `reconcile_${Date.now()}`;

    // Safety net, on its own guard: finalize live-forever synthetic rows whose VAPI
    // webhook was lost. Runs every cycle regardless of the Twilio sweep below and can
    // never crash it (or the worker) — its own try/catch.
    let sweptSynthetic = 0;
    try {
        sweptSynthetic = await sweepStaleSyntheticCalls(traceId);
    } catch (err) {
        console.error(`[${traceId}] Synthetic sweep error:`, err.message);
    }

    try {
        // Find all non-final calls older than threshold.
        // Twilio-sid guard (S5): only real CallSids (CA…) are pollable via the Twilio
        // REST API. Synthetic `vapi:%` rows would 404 → be wrongly marked failed
        // mid-call, so they are excluded here and handled by the synthetic sweeper above.
        const result = await db.query(
            `SELECT call_sid, parent_call_sid, status, direction, started_at, company_id
             FROM calls
             WHERE is_final = false
               AND call_sid LIKE 'CA%'
               AND started_at < NOW() - INTERVAL '${STALE_THRESHOLD_MINUTES} minutes'
             ORDER BY started_at ASC`
        );

        const staleCalls = result.rows;
        if (staleCalls.length === 0) return { reconciled: 0, sweptSynthetic };

        console.log(`[${traceId}] Found ${staleCalls.length} stale call(s)`);

        let reconciled = 0;

        for (const call of staleCalls) {
            try {
                const fixed = await reconcileOneCall(call, traceId);
                if (fixed) reconciled++;
            } catch (err) {
                console.error(`[${traceId}] Failed to reconcile ${call.call_sid}:`, err.message);
            }
        }

        if (reconciled > 0) {
            console.log(`[${traceId}] Reconciled ${reconciled}/${staleCalls.length} stale calls`);
        }

        return { reconciled, sweptSynthetic };
    } catch (error) {
        console.error(`[${traceId}] Stale reconciliation error:`, error.message);
        return { reconciled: 0, sweptSynthetic, error: error.message };
    }
}

/**
 * Synthetic-sid safety net (OUTBOUND-CALL-TIMELINE-001 S5.2).
 *
 * Outbound VAPI robot calls are inserted with a synthetic `vapi:<vapiCallId>` sid
 * and re-keyed to the real Twilio CallSid once a status-update/end-of-call webhook
 * arrives. If that webhook is lost the row stays non-final forever and `hasActiveCall`
 * keeps the contact's Call button disabled. Such a row is never pollable via Twilio
 * (guarded out of the main sweep), so finalize it here once it is far older than any
 * real parts call. Monotonic (`is_final = false` guard → final never regressed) and
 * company-scoped (SSE re-read uses each row's own company_id). Non-fatal by contract:
 * the caller wraps this in its own try/catch.
 */
async function sweepStaleSyntheticCalls(traceId) {
    const result = await db.query(
        `UPDATE calls
            SET status   = 'failed',
                is_final = true,
                ended_at = COALESCE(ended_at, NOW())
          WHERE is_final = false
            AND call_sid LIKE 'vapi:%'
            AND started_at < NOW() - INTERVAL '${SYNTHETIC_STALE_THRESHOLD_MINUTES} minutes'
          RETURNING call_sid, company_id`
    );

    const swept = result.rows;
    if (swept.length === 0) return 0;

    console.log(`[${traceId}] Synthetic sweep: ${swept.length} stale vapi:% row(s) → failed`);

    // Publish per-row SSE, company-scoped re-read. Best-effort — never throws.
    for (const row of swept) {
        try {
            const realtimeService = require('./realtimeService');
            const updated = await queries.getCallByCallSid(row.call_sid, row.company_id);
            if (updated) {
                realtimeService.publishCallUpdate({ eventType: 'call.updated', ...updated });
            }
        } catch (e) { /* SSE publish is best-effort */ }
    }

    return swept.length;
}

async function reconcileOneCall(call, traceId) {
    const { call_sid, parent_call_sid, company_id } = call;

    // Stuck voicemail_recording: caller hung up before recording started,
    // so the recording callback never arrives. Transition to no-answer (final).
    if (call.status === 'voicemail_recording') {
        const recCheck = await db.query(
            `SELECT 1 FROM recordings WHERE call_sid = $1 LIMIT 1`, [call_sid]
        );
        if (recCheck.rows.length === 0) {
            await db.query(
                `UPDATE calls SET status = 'no-answer', is_final = true,
                 ended_at = COALESCE(ended_at, NOW()) WHERE call_sid = $1`, [call_sid]
            );
            console.log(`[${traceId}] voicemail_recording with no recording → no-answer: ${call_sid}`);
            // Publish SSE update
            try {
                const realtimeService = require('./realtimeService');
                const updated = await queries.getCallByCallSid(call_sid);
                if (updated) realtimeService.publishCallUpdate({ eventType: 'call.updated', ...updated });
            } catch (e) { /* best-effort */ }
            return true;
        }
    }

    // Strategy 1: Parent call with children — re-run reconcileParentCall
    if (!parent_call_sid) {
        const childResult = await db.query(
            `SELECT call_sid, status, is_final FROM calls WHERE parent_call_sid = $1`,
            [call_sid]
        );

        if (childResult.rows.length > 0) {
            // First, reconcile any stale children via Twilio API
            for (const child of childResult.rows) {
                if (!child.is_final) {
                    await fetchAndUpdateFromTwilio(child.call_sid, traceId);
                }
            }

            // Now reconcile the parent based on updated children
            const { reconcileParentCall } = require('./inboxWorker');
            await reconcileParentCall(call_sid, traceId, company_id);

            const updated = await queries.getCallByCallSid(call_sid);
            if (updated && updated.is_final) {
                console.log(`[${traceId}] Parent ${call_sid}: ${call.status} → ${updated.status}`);
                return true;
            }

            // If still not final after reconcile, force-fetch from Twilio
            return await fetchAndUpdateFromTwilio(call_sid, traceId);
        }
    }

    // Strategy 2: Standalone or child call — fetch from Twilio API directly
    return await fetchAndUpdateFromTwilio(call_sid, traceId);
}

async function fetchAndUpdateFromTwilio(callSid, traceId) {
    try {
        const client = getTwilioClient();
        const details = await client.calls(callSid).fetch();

        const apiStatus = details.status?.toLowerCase();
        if (!apiStatus) return false;

        const isFinal = isFinalStatus(apiStatus);

        // Guard: don't let Twilio's "completed" overwrite meaningful statuses.
        // Twilio reports "completed" for parent calls when TwiML finishes,
        // even if no agent answered — preserve no-answer/voicemail statuses.
        const existing = await queries.getCallByCallSid(callSid);
        const preserveStatuses = ['no-answer', 'voicemail_recording', 'voicemail_left', 'blocked'];
        if (existing && preserveStatuses.includes(existing.status) && apiStatus === 'completed') {
            await db.query(
                `UPDATE calls SET is_final = true,
                 ended_at   = COALESCE($2, ended_at),
                 duration_sec = COALESCE($3, duration_sec),
                 price      = COALESCE($4, price),
                 price_unit = COALESCE($5, price_unit)
                 WHERE call_sid = $1`,
                [
                    callSid,
                    details.endTime ? new Date(details.endTime) : null,
                    parseInt(details.duration) || null,
                    details.price ? parseFloat(details.price) : null,
                    details.priceUnit || null,
                ]
            );
            console.log(`[${traceId}] Preserving ${existing.status} (Twilio says ${apiStatus}): ${callSid}`);
            return true;
        }

        await db.query(
            `UPDATE calls SET
                status       = $2,
                is_final     = $3,
                started_at   = COALESCE($4, started_at),
                ended_at     = COALESCE($5, ended_at),
                duration_sec = COALESCE($6, duration_sec),
                price        = COALESCE($7, price),
                price_unit   = COALESCE($8, price_unit)
             WHERE call_sid = $1`,
            [
                callSid,
                apiStatus,
                isFinal,
                details.startTime ? new Date(details.startTime) : null,
                details.endTime ? new Date(details.endTime) : null,
                parseInt(details.duration) || null,
                details.price ? parseFloat(details.price) : null,
                details.priceUnit || null,
            ]
        );

        console.log(`[${traceId}] Twilio API: ${callSid} → ${apiStatus} (final=${isFinal})`);

        // Publish SSE update
        try {
            const realtimeService = require('./realtimeService');
            const updated = await queries.getCallByCallSid(callSid);
            if (updated) {
                realtimeService.publishCallUpdate({ eventType: 'call.updated', ...updated });
            }
        } catch (e) { /* SSE publish is best-effort */ }

        return isFinal;
    } catch (error) {
        // If Twilio returns 404, the call doesn't exist — mark as failed
        if (error.status === 404) {
            await db.query(
                `UPDATE calls SET status = 'failed', is_final = true WHERE call_sid = $1`,
                [callSid]
            );
            console.log(`[${traceId}] Twilio 404: ${callSid} → marked failed`);
            return true;
        }
        throw error;
    }
}

module.exports = { reconcileStaleCalls, sweepStaleSyntheticCalls };
