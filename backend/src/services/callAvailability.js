/**
 * Call Availability Service
 *
 * Centralized logic for determining operator/contact busy state.
 * Provides age-based stale filtering and Twilio API fallback verification.
 *
 * Used by:
 * - handleVoiceInbound (Client routing busy check)
 * - handleVoiceInbound (SIP routing busy check)
 * - GET /api/voice/check-busy (outbound pre-flight check)
 */

const db = require('../db/connection');

const FINAL_STATUSES = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];

// Age thresholds: calls older than these are considered stale
const RINGING_MAX_AGE_SECONDS = 90;
const IN_PROGRESS_MAX_AGE_HOURS = 4;

/**
 * SQL WHERE clause fragment for filtering out stale call records.
 * Assumes the table alias is not used (bare column names).
 */
const STALE_FILTER_SQL = `
    is_final = false
    AND (
        (status IN ('initiated', 'ringing', 'queued') AND started_at > NOW() - INTERVAL '${RINGING_MAX_AGE_SECONDS} seconds')
        OR
        (status IN ('in-progress', 'voicemail_recording') AND started_at > NOW() - INTERVAL '${IN_PROGRESS_MAX_AGE_HOURS} hours')
    )`;

/**
 * Verify stale call_sids via Twilio REST API and fix them in DB.
 * Returns the set of call_sids that were resolved (actually finished).
 *
 * @param {string[]} callSids - Call SIDs to verify
 * @param {string} traceId - For logging
 * @returns {Promise<Set<string>>} - Resolved (finished) call SIDs
 */
async function verifyAndFixStaleCalls(callSids, traceId) {
    const resolved = new Set();
    if (!callSids || callSids.length === 0) return resolved;

    try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        for (const sid of callSids) {
            try {
                const details = await client.calls(sid).fetch();
                const apiStatus = (details.status || '').toLowerCase();
                if (FINAL_STATUSES.includes(apiStatus)) {
                    resolved.add(sid);
                    await db.query(
                        `UPDATE calls SET status = $2, is_final = true, ended_at = COALESCE($3, ended_at)
                         WHERE call_sid = $1 AND is_final = false`,
                        [sid, apiStatus, details.endTime ? new Date(details.endTime) : null]
                    );
                    console.log(`[${traceId}] Twilio API: ${sid} actually ${apiStatus} — fixed`);
                }
            } catch (fetchErr) {
                console.warn(`[${traceId}] Twilio API fetch failed for ${sid}:`, fetchErr.message);
            }
        }
    } catch (twilioErr) {
        console.warn(`[${traceId}] Twilio API fallback failed:`, twilioErr.message);
    }

    return resolved;
}

/**
 * Get busy Client identities (WebRTC softphone users).
 * Returns { busyIdentities: Set<string>, callSids: string[] }
 *
 * @param {string} traceId
 * @returns {Promise<{busyIdentities: Set<string>, callSids: string[]}>}
 */
async function getBusyClientIdentities(traceId) {
    const result = await db.query(
        `SELECT DISTINCT
            CASE WHEN to_number LIKE 'client:%' THEN to_number
                 WHEN from_number LIKE 'client:%' THEN from_number
            END AS client_number,
            call_sid
         FROM calls
         WHERE status IN ('ringing', 'in-progress')
           AND ${STALE_FILTER_SQL}
           AND (to_number LIKE 'client:%' OR from_number LIKE 'client:%')`
    );

    const busyIdentities = new Set(
        result.rows
            .map(r => (r.client_number || '').replace('client:', ''))
            .filter(Boolean)
    );
    const callSids = result.rows.map(r => r.call_sid).filter(Boolean);

    return { busyIdentities, callSids };
}

/**
 * Get busy SIP operators.
 * Returns { busySipUsers: Set<string>, callSids: string[] }
 *
 * @param {string} traceId
 * @returns {Promise<{busySipUsers: Set<string>, callSids: string[]}>}
 */
async function getBusySipUsers(traceId) {
    const result = await db.query(
        `SELECT DISTINCT to_number, call_sid FROM calls
         WHERE status IN ('ringing', 'in-progress', 'voicemail_recording')
           AND ${STALE_FILTER_SQL}
           AND to_number LIKE 'sip:%'`
    );

    const busySipUsers = new Set();
    for (const row of result.rows) {
        const match = row.to_number.match(/^sip:([^@]+)@/);
        if (match) busySipUsers.add(match[1]);
    }
    const callSids = result.rows.map(r => r.call_sid).filter(Boolean);

    return { busySipUsers, callSids };
}

/**
 * Check if a phone number has an active call (for outbound pre-flight check).
 *
 * @param {string} phoneE164 - Phone number in E.164 format
 * @param {string} traceId
 * @returns {Promise<boolean>} - true if busy
 */
async function isContactBusy(phoneE164, traceId) {
    const result = await db.query(
        `SELECT call_sid FROM calls
         WHERE parent_call_sid IS NULL
           AND status IN ('initiated', 'ringing', 'in-progress', 'queued')
           AND ${STALE_FILTER_SQL}
           AND (from_number = $1 OR to_number = $1)
         LIMIT 1`,
        [phoneE164]
    );

    if (result.rows.length === 0) return false;

    // Verify via Twilio API before declaring busy
    const sid = result.rows[0].call_sid;
    const resolved = await verifyAndFixStaleCalls([sid], traceId || 'check-busy');
    return !resolved.has(sid);
}

module.exports = {
    STALE_FILTER_SQL,
    FINAL_STATUSES,
    verifyAndFixStaleCalls,
    getBusyClientIdentities,
    getBusySipUsers,
    isContactBusy,
};
