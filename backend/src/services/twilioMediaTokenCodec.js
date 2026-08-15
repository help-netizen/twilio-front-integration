'use strict';

const crypto = require('crypto');

function getSecret() {
    const secret = process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
        const err = new Error('Twilio media token secret is not configured');
        err.code = 'TWILIO_MEDIA_TOKEN_SECRET_MISSING';
        throw err;
    }
    return secret;
}

function sign(encodedPayload) {
    return crypto.createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');
}

function encodeSignedClaims(claims) {
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encodedPayload}.${sign(encodedPayload)}`;
}

function decodeSignedClaims(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [encodedPayload, suppliedSignature] = parts;
    const expectedSignature = sign(encodedPayload);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return null;
    }

    try {
        const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
    } catch {
        return null;
    }
}

module.exports = { encodeSignedClaims, decodeSignedClaims };
