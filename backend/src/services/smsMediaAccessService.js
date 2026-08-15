'use strict';

const crypto = require('crypto');
const convQueries = require('../db/conversationsQueries');
const { encodeSignedClaims, decodeSignedClaims } = require('./twilioMediaTokenCodec');

const TOKEN_PURPOSE = 'sms_media_access';
const TOKEN_TTL_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;
const CLAIM_KEYS = Object.freeze([
    'company_id',
    'exp',
    'iat',
    'jti',
    'media_id',
    'purpose',
    'v',
]);

function requireContext(mediaId, companyId) {
    if (!mediaId || !companyId) {
        const err = new Error('Media access requires media and company context');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
    }
}

function mintMediaAccessToken(mediaId, companyId) {
    requireContext(mediaId, companyId);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        v: 1,
        purpose: TOKEN_PURPOSE,
        media_id: String(mediaId),
        company_id: String(companyId),
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
        jti: crypto.randomBytes(12).toString('base64url'),
    };
    return {
        token: encodeSignedClaims(claims),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
}

function verifyMediaAccessToken(token, expectedMediaId) {
    const claims = decodeSignedClaims(token);
    if (!claims) return null;

    const keys = Object.keys(claims).sort();
    const now = Math.floor(Date.now() / 1000);
    if (keys.length !== CLAIM_KEYS.length
        || keys.some((key, index) => key !== CLAIM_KEYS[index])
        || claims.v !== 1
        || claims.purpose !== TOKEN_PURPOSE
        || typeof claims.media_id !== 'string'
        || claims.media_id !== String(expectedMediaId || '')
        || typeof claims.company_id !== 'string'
        || !claims.company_id
        || typeof claims.jti !== 'string'
        || !claims.jti
        || !Number.isInteger(claims.iat)
        || !Number.isInteger(claims.exp)
        || claims.exp <= now
        || claims.iat > now + CLOCK_SKEW_SECONDS
        || claims.exp - claims.iat !== TOKEN_TTL_SECONDS) {
        return null;
    }
    return claims;
}

async function issueMediaAccess(mediaId, companyId) {
    requireContext(mediaId, companyId);
    const media = await convQueries.getMediaById(mediaId, companyId);
    if (!media) return null;

    const signed = mintMediaAccessToken(mediaId, companyId);
    return {
        url: `/api/messaging/media/${encodeURIComponent(mediaId)}/temporary-url?cap=${encodeURIComponent(signed.token)}`,
        expiresAt: signed.expiresAt,
    };
}

module.exports = {
    issueMediaAccess,
    mintMediaAccessToken,
    verifyMediaAccessToken,
    TOKEN_TTL_SECONDS,
};
