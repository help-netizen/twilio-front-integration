const db = require('../db/connection');

function readPositiveInteger(name, fallback, maximum) {
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) return fallback;
    return value;
}

// Must cover the maximum Keycloak access-token lifetime plus accepted clock skew.
// The staging token-shape gate owns confirming/tuning this value.
const REVOCATION_TTL_SECONDS = readPositiveInteger(
    'AUTH_BACKCHANNEL_REVOCATION_TTL_SECONDS',
    360,
    86400
);

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

async function recordRevocation({ issuer, sid, sub, issuedAt, jti }) {
    const keyType = nonEmptyString(sid) ? 'sid' : 'sub';
    const keyValue = keyType === 'sid' ? sid.trim() : sub.trim();

    const { rows } = await db.query(
        `WITH expired AS (
             DELETE FROM revoked_sessions
              WHERE issuer = $1
                AND expires_at <= NOW()
         )
         INSERT INTO revoked_sessions (
             issuer,
             key_type,
             key_value,
             revoked_at,
             received_at,
             expires_at,
             logout_token_jti
         )
         VALUES ($1, $2, $3, TO_TIMESTAMP($4), NOW(), NOW() + make_interval(secs => $5), $6)
         ON CONFLICT (issuer, key_type, key_value) DO UPDATE
         SET revoked_at = CASE
                 WHEN revoked_sessions.logout_token_jti = EXCLUDED.logout_token_jti
                     THEN revoked_sessions.revoked_at
                 ELSE GREATEST(revoked_sessions.revoked_at, EXCLUDED.revoked_at)
             END,
             received_at = CASE
                 WHEN revoked_sessions.logout_token_jti = EXCLUDED.logout_token_jti
                     THEN revoked_sessions.received_at
                 ELSE GREATEST(revoked_sessions.received_at, EXCLUDED.received_at)
             END,
             expires_at = CASE
                 WHEN revoked_sessions.logout_token_jti = EXCLUDED.logout_token_jti
                     THEN revoked_sessions.expires_at
                 ELSE GREATEST(revoked_sessions.expires_at, EXCLUDED.expires_at)
             END,
             logout_token_jti = CASE
                 WHEN revoked_sessions.logout_token_jti = EXCLUDED.logout_token_jti
                     THEN revoked_sessions.logout_token_jti
                 WHEN EXCLUDED.revoked_at >= revoked_sessions.revoked_at
                     THEN EXCLUDED.logout_token_jti
                 ELSE revoked_sessions.logout_token_jti
             END
         RETURNING issuer, key_type, key_value, revoked_at, received_at, expires_at, logout_token_jti`,
        [issuer, keyType, keyValue, issuedAt, REVOCATION_TTL_SECONDS, jti]
    );

    return rows[0];
}

async function isAccessTokenRevoked({ issuer, sid, sub, issuedAt }) {
    const sidValue = nonEmptyString(sid) ? sid.trim() : null;
    const subValue = nonEmptyString(sub) ? sub.trim() : null;

    const { rowCount } = await db.query(
        `SELECT 1
           FROM revoked_sessions
          WHERE issuer = $1
            AND expires_at > NOW()
            AND revoked_at >= TO_TIMESTAMP($4)
            AND (
                (key_type = 'sid' AND key_value = $2)
                OR (key_type = 'sub' AND key_value = $3)
            )
          LIMIT 1`,
        [issuer, sidValue, subValue, issuedAt]
    );

    return rowCount > 0;
}

module.exports = {
    recordRevocation,
    isAccessTokenRevoked,
    REVOCATION_TTL_SECONDS,
};
