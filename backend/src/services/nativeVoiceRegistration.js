/**
 * SOFTPHONE-NATIVE-001 Stage 2 — durable native Voice registration signal.
 *
 * The mobile app writes this only after voice.register() succeeds and deletes it
 * after unregister/toggle-off. There is no separate server-side softphone flag:
 * an unexpired row is the explicit native "connected" signal. Every operation is
 * keyed by the authenticated CRM user and selected company.
 */

const db = require('../db/connection');

const NATIVE_REGISTRATION_TTL_DAYS = 30;

function requireIdentity(userId, companyId) {
    if (!userId || !companyId) {
        const err = new Error('Native Voice registration requires user and company context');
        err.code = 'NATIVE_VOICE_CONTEXT_REQUIRED';
        err.httpStatus = 401;
        throw err;
    }
}

async function upsertNativeRegistration(userId, companyId) {
    requireIdentity(userId, companyId);
    const result = await db.query(
        `INSERT INTO native_voice_registrations
            (company_id, user_id, created_at, updated_at, expires_at)
         VALUES ($1, $2, NOW(), NOW(), NOW() + ($3::int * INTERVAL '1 day'))
         ON CONFLICT (company_id, user_id) DO UPDATE SET
            updated_at = NOW(),
            expires_at = NOW() + ($3::int * INTERVAL '1 day')
         RETURNING (xmax = 0) AS inserted, expires_at`,
        [String(companyId), String(userId), NATIVE_REGISTRATION_TTL_DAYS]
    );
    const row = result.rows[0];
    return {
        inserted: row?.inserted === true,
        expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
}

async function deleteNativeRegistration(userId, companyId) {
    requireIdentity(userId, companyId);
    const result = await db.query(
        `DELETE FROM native_voice_registrations
         WHERE company_id = $1 AND user_id = $2`,
        [String(companyId), String(userId)]
    );
    return result.rowCount > 0;
}

async function getActiveNativeUserIds(userIds, companyId) {
    const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
    if (!companyId || ids.length === 0) return new Set();
    const result = await db.query(
        `SELECT user_id
         FROM native_voice_registrations
         WHERE company_id = $1
           AND user_id::text = ANY($2::text[])
           AND expires_at > NOW()`,
        [String(companyId), ids]
    );
    return new Set(result.rows.map(row => String(row.user_id)));
}

module.exports = {
    upsertNativeRegistration,
    deleteNativeRegistration,
    getActiveNativeUserIds,
    NATIVE_REGISTRATION_TTL_DAYS,
};
