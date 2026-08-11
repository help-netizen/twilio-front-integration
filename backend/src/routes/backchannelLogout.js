const express = require('express');
const jwt = require('jsonwebtoken');
const { getKey, KEYCLOAK_REALM_URL } = require('../middleware/keycloakAuth');
const sessionRevocationService = require('../services/sessionRevocationService');

const router = express.Router();

const BACKCHANNEL_CLIENT_ID = 'crm-web';
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const MAX_LOGOUT_TOKEN_BYTES = 12 * 1024;

function readPositiveInteger(name, fallback, maximum) {
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) return fallback;
    return value;
}

const MAX_TOKEN_AGE_SECONDS = readPositiveInteger(
    'AUTH_BACKCHANNEL_MAX_TOKEN_AGE_SECONDS',
    120,
    3600
);
const CLOCK_SKEW_SECONDS = readPositiveInteger(
    'AUTH_BACKCHANNEL_CLOCK_SKEW_SECONDS',
    60,
    600
);

class LogoutTokenValidationError extends Error { }

function invalidToken() {
    return new LogoutTokenValidationError('Invalid logout token');
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function verifyJws(token) {
    return new Promise((resolve, reject) => {
        jwt.verify(
            token,
            getKey,
            {
                algorithms: ['RS256'],
                issuer: KEYCLOAK_REALM_URL,
                audience: BACKCHANNEL_CLIENT_ID,
                clockTolerance: CLOCK_SKEW_SECONDS,
                complete: true,
            },
            (err, verified) => {
                if (err || !verified) return reject(invalidToken());
                resolve(verified);
            }
        );
    });
}

async function validateLogoutToken(token) {
    if (!nonEmptyString(token) || Buffer.byteLength(token, 'utf8') > MAX_LOGOUT_TOKEN_BYTES) {
        throw invalidToken();
    }

    // Compact JWS has exactly three segments; this rejects unsecured/non-JWS
    // encodings (including five-segment JWE) before any key lookup.
    if (token.split('.').length !== 3) throw invalidToken();

    const unverified = jwt.decode(token, { complete: true });
    if (!unverified || unverified.header?.alg !== 'RS256' || !nonEmptyString(unverified.header?.kid)) {
        throw invalidToken();
    }
    if (unverified.header.typ !== undefined && unverified.header.typ !== 'logout+jwt') {
        throw invalidToken();
    }

    const verified = await verifyJws(token);
    const { header, payload } = verified;

    if (header.alg !== 'RS256') throw invalidToken();
    if (header.typ !== undefined && header.typ !== 'logout+jwt') throw invalidToken();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidToken();

    const audience = payload.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (!audiences.length || audiences.some(value => !nonEmptyString(value))
        || !audiences.includes(BACKCHANNEL_CLIENT_ID)) {
        throw invalidToken();
    }
    if (audiences.length > 1 && payload.azp !== BACKCHANNEL_CLIENT_ID) {
        throw invalidToken();
    }

    if (!Number.isSafeInteger(payload.iat)) throw invalidToken();
    const now = Math.floor(Date.now() / 1000);
    if (payload.iat > now + CLOCK_SKEW_SECONDS
        || now - payload.iat > MAX_TOKEN_AGE_SECONDS + CLOCK_SKEW_SECONDS) {
        throw invalidToken();
    }

    if (!nonEmptyString(payload.jti)) throw invalidToken();
    if (Object.prototype.hasOwnProperty.call(payload, 'nonce')) throw invalidToken();

    const events = payload.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)
        || !Object.prototype.hasOwnProperty.call(events, BACKCHANNEL_LOGOUT_EVENT)) {
        throw invalidToken();
    }
    const logoutEvent = events[BACKCHANNEL_LOGOUT_EVENT];
    if (!logoutEvent || typeof logoutEvent !== 'object' || Array.isArray(logoutEvent)) {
        throw invalidToken();
    }

    const sid = nonEmptyString(payload.sid) ? payload.sid.trim() : null;
    const sub = nonEmptyString(payload.sub) ? payload.sub.trim() : null;
    if (!sid && !sub) throw invalidToken();

    return {
        issuer: payload.iss,
        sid,
        sub,
        issuedAt: payload.iat,
        jti: payload.jti.trim(),
    };
}

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.use(express.urlencoded({
    extended: false,
    limit: '16kb',
    parameterLimit: 5,
}));

router.post('/', async (req, res) => {
    let revocation;
    try {
        revocation = await validateLogoutToken(req.body?.logout_token);
    } catch (err) {
        return res.status(400).json({ error: 'invalid_request' });
    }

    try {
        // A session-specific logout stores only sid even when sub is also present.
        // Phase 1 intentionally leaves crm-mobile and active-SSE teardown as future seams.
        await sessionRevocationService.recordRevocation(revocation);
        return res.status(200).end();
    } catch (err) {
        // Never log the signed token or its session/subject identifiers.
        console.error('[BackchannelLogout] Failed to persist revocation');
        return res.status(503).json({ error: 'temporarily_unavailable' });
    }
});

router.use((err, req, res, next) => {
    if (!err) return next();
    return res.status(400).json({ error: 'invalid_request' });
});

module.exports = router;
