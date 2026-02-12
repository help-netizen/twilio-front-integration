const db = require('../db/connection');
const queries = require('../db/queries');
const { isFinalStatus } = require('./stateMachine');

/**
 * Reconcile stale calls — safety net for calls stuck in transient statuses.
 * 
 * Runs periodically from the inbox worker. Finds non-final calls older than
 * STALE_THRESHOLD_MINUTES and resolves them via Twilio API or child-leg logic.
 */

const STALE_THRESHOLD_MINUTES = 10;

async function reconcileStaleCalls() {
    const traceId = `reconcile_${Date.now()}`;

    try {
        // Find all non-final calls older than threshold
        const result = await db.query(
            `SELECT call_sid, parent_call_sid, status, direction, started_at
             FROM calls
             WHERE is_final = false
               AND started_at < NOW() - INTERVAL '${STALE_THRESHOLD_MINUTES} minutes'
             ORDER BY started_at ASC`
        );

        const staleCalls = result.rows;
        if (staleCalls.length === 0) return { reconciled: 0 };

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

        return { reconciled };
    } catch (error) {
        console.error(`[${traceId}] Stale reconciliation error:`, error.message);
        return { reconciled: 0, error: error.message };
    }
}

async function reconcileOneCall(call, traceId) {
    const { call_sid, parent_call_sid } = call;

    // Strategy 1: Parent call with children — re-run reconcileInboundParent
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
            const { reconcileInboundParent } = require('./inboxWorker');
            await reconcileInboundParent(call_sid, traceId);

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
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const details = await client.calls(callSid).fetch();

        const apiStatus = details.status?.toLowerCase();
        if (!apiStatus) return false;

        const isFinal = isFinalStatus(apiStatus);

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

module.exports = { reconcileStaleCalls };
