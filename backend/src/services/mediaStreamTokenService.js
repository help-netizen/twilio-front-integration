const crypto = require('crypto');
const db = require('../db/connection');
const { encodeSignedClaims, decodeSignedClaims } = require('./twilioMediaTokenCodec');

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

function tokenTtlSeconds() {
    const configured = Number(process.env.TWILIO_MEDIA_STREAM_TOKEN_TTL_SECONDS);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_SECONDS;
    return Math.min(Math.floor(configured), MAX_TTL_SECONDS);
}

function mintStreamToken({ companyId, callSid, accountSid, direction = 'unknown' }) {
    if (!companyId || !callSid || !accountSid) {
        const err = new Error('Media stream token requires company, call, and account context');
        err.code = 'MEDIA_STREAM_TOKEN_CONTEXT_REQUIRED';
        throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = {
        v: 1,
        company_id: companyId,
        call_sid: callSid,
        account_sid: accountSid,
        direction,
        iat: now,
        exp: now + tokenTtlSeconds(),
        jti: crypto.randomBytes(12).toString('base64url'),
    };
    return encodeSignedClaims(claims);
}

function verifyStreamToken(token) {
    try {
        const claims = decodeSignedClaims(token);
        const now = Math.floor(Date.now() / 1000);
        if (!claims
            || claims.v !== 1
            || !claims.company_id
            || !claims.call_sid
            || !claims.account_sid
            || !claims.jti
            || !Number.isInteger(claims.iat)
            || !Number.isInteger(claims.exp)
            || claims.exp <= now
            || claims.iat > now + 30
            || claims.exp - claims.iat > MAX_TTL_SECONDS) {
            return null;
        }
        return claims;
    } catch (error) {
        if (error?.code === 'TWILIO_MEDIA_TOKEN_SECRET_MISSING') {
            error.code = 'MEDIA_STREAM_TOKEN_SECRET_MISSING';
            throw error;
        }
        return null;
    }
}

async function consumeStreamToken(token) {
    const claims = verifyStreamToken(token);
    if (!claims) return null;

    const claimed = await db.query(
        `INSERT INTO twilio_media_stream_token_claims (jti, expires_at)
         VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO NOTHING
         RETURNING jti`,
        [claims.jti, claims.exp]
    );
    if (claimed.rows.length === 0) return null;

    // Keep the replay ledger bounded. This is deliberately best-effort after
    // the atomic claim; cleanup failure must not make a claimed token reusable.
    db.query(
        `DELETE FROM twilio_media_stream_token_claims
         WHERE expires_at < NOW() - INTERVAL '5 minutes'`
    ).catch(() => {});
    return claims;
}

module.exports = {
    mintStreamToken,
    verifyStreamToken,
    consumeStreamToken,
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
};
