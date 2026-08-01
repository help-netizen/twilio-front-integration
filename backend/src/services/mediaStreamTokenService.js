const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

function getSecret() {
    const secret = process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
        const err = new Error('Media stream token secret is not configured');
        err.code = 'MEDIA_STREAM_TOKEN_SECRET_MISSING';
        throw err;
    }
    return secret;
}

function tokenTtlSeconds() {
    const configured = Number(process.env.TWILIO_MEDIA_STREAM_TOKEN_TTL_SECONDS);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_SECONDS;
    return Math.min(Math.floor(configured), MAX_TTL_SECONDS);
}

function sign(encodedPayload, secret) {
    return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
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
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encodedPayload}.${sign(encodedPayload, getSecret())}`;
}

function verifyStreamToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [encodedPayload, suppliedSignature] = parts;
    const expectedSignature = sign(encodedPayload, getSecret());
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return null;
    }

    try {
        const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (claims.v !== 1
            || !claims.company_id
            || !claims.call_sid
            || !claims.account_sid
            || !Number.isInteger(claims.iat)
            || !Number.isInteger(claims.exp)
            || claims.exp <= now
            || claims.iat > now + 30
            || claims.exp - claims.iat > MAX_TTL_SECONDS) {
            return null;
        }
        return claims;
    } catch {
        return null;
    }
}

module.exports = {
    mintStreamToken,
    verifyStreamToken,
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
};
