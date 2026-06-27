/**
 * emailPush.js — Gmail → Google Pub/Sub inbound push endpoint (EMAIL-TIMELINE-001,
 * TASK-ET-5). Mounted in src/server.js BEFORE express.json with a RAW body parser,
 * exactly like the Stripe webhook:
 *   app.use('/api/email/push',
 *           express.raw({ type: '*\/*', limit: '1mb' }), emailPushRouter)
 * so this handler's `POST /google` resolves to `POST /api/email/push/google`.
 *
 * UNAUTHENTICATED by user (Pub/Sub cannot carry our JWT). The credential is the
 * subscription-configured verification: a shared `?token=` (primary) and/or a
 * Google OIDC `Authorization: Bearer` JWT (optional). Verification runs BEFORE
 * any work; only verification failures return 4xx (401 token / 403 OIDC).
 *
 * Everything else FAST-ACKS 200 (even malformed bodies / downstream errors) so
 * Pub/Sub's at-least-once delivery never retry-storms us. The actual ingest is
 * detached via setImmediate AFTER the 200; idempotency + reconciliation live
 * downstream (emailTimelineService + the 5-min poll).
 */
const express = require('express');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const router = express.Router();
const emailTimelineService = require('../services/email/emailTimelineService');

// Reused OAuth2Client for OIDC verification. verifyIdToken fetches + caches
// Google's signing certs internally, so a single shared instance is fine.
const oauth2Client = new OAuth2Client();

/**
 * Constant-time string compare that never throws and never short-circuits on
 * length (timingSafeEqual requires equal-length buffers — we hash both sides to
 * a fixed width so a length mismatch still costs the same and can't leak length).
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cryptographically verify a Google OIDC push JWT. verifyIdToken checks the RS256
 * signature against Google's published certs, plus `exp` and the `aud` claim. We
 * then additionally assert `email_verified` and (when GMAIL_PUBSUB_SA_EMAIL is set)
 * that `email` is the configured Pub/Sub push service account.
 *
 * Returns null when the token is valid, or { status, reason } to reject (403).
 */
async function verifyOidcBearer(req, oidcAudience) {
    const authz = req.headers && req.headers.authorization;
    const bearer = typeof authz === 'string' && authz.startsWith('Bearer ')
        ? authz.slice('Bearer '.length).trim()
        : null;
    if (!bearer) {
        return { status: 403, reason: 'oidc missing bearer token' };
    }

    let payload;
    try {
        // verifyIdToken verifies the signature against Google's certs + exp + audience.
        const ticket = await oauth2Client.verifyIdToken({ idToken: bearer, audience: oidcAudience });
        payload = ticket && ticket.getPayload ? ticket.getPayload() : null;
    } catch (e) {
        // Bad signature / expired / audience mismatch all land here.
        return { status: 403, reason: `oidc verify failed: ${e && e.message}` };
    }
    if (!payload) {
        return { status: 403, reason: 'oidc empty payload' };
    }
    // Defense-in-depth: verifyIdToken already enforced `aud`, but assert again.
    if (payload.aud !== oidcAudience) {
        return { status: 403, reason: 'oidc audience mismatch' };
    }
    if (payload.email_verified !== true) {
        return { status: 403, reason: 'oidc email not verified' };
    }
    const saEmail = process.env.GMAIL_PUBSUB_SA_EMAIL;
    if (saEmail && payload.email !== saEmail) {
        return { status: 403, reason: 'oidc email mismatch' };
    }
    return null; // signature + aud + email_verified (+ optional SA email) all valid.
}

/**
 * Verify the push request BEFORE any work. Returns null when allowed, or
 * { status, reason } to reject. Token mode is primary; OIDC is optional/secondary.
 * If NEITHER env is configured we log a warning and allow (dev only).
 */
async function verifyPush(req) {
    const expectedToken = process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
    const oidcAudience = process.env.GMAIL_PUSH_OIDC_AUDIENCE;

    // (1) Shared-token mode (primary): constant-time compare of ?token=.
    if (expectedToken) {
        const provided = req.query && req.query.token;
        if (!provided || !safeEqual(String(provided), expectedToken)) {
            return { status: 401, reason: 'token mismatch' };
        }
        return null; // token valid — accept (OIDC, if set, is additive not required)
    }

    // (2) OIDC bearer mode (optional/secondary): cryptographically verify the JWT.
    if (oidcAudience) {
        return verifyOidcBearer(req, oidcAudience);
    }

    // (3) Neither configured — dev fallback: warn and process.
    console.warn('[EmailPush] No GMAIL_PUSH_VERIFICATION_TOKEN or GMAIL_PUSH_OIDC_AUDIENCE set — processing push UNVERIFIED (dev only).');
    return null;
}

/**
 * POST /google  (→ /api/email/push/google)
 * Receives the Pub/Sub push envelope as a RAW Buffer body.
 */
router.post('/google', async (req, res) => {
    // ── Verify FIRST (reject early, no work, no DB). OIDC mode awaits Google's
    //    cert-backed signature check; a bad signature/aud/email → 403, no ingest. ─
    let rejection;
    try {
        rejection = await verifyPush(req);
    } catch (e) {
        // verifyPush is written to never throw, but fail closed if it ever does.
        console.warn('[EmailPush] verification error (rejected 403):', e && e.message);
        return res.status(403).json({ error: 'verification error' });
    }
    if (rejection) {
        console.warn(`[EmailPush] rejected (${rejection.status}): ${rejection.reason}`);
        return res.status(rejection.status).json({ error: rejection.reason });
    }

    // ── Parse the raw body. Malformed → ACK 200 (NEVER 4xx, or Pub/Sub
    //    retries forever); just log and drop. ───────────────────────────────
    let parsed = null;
    try {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
        parsed = raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.warn('[EmailPush] malformed body (acked, dropped):', e.message);
        return res.status(200).end();
    }

    if (!parsed || !parsed.message) {
        console.warn('[EmailPush] push envelope missing `message` (acked, dropped).');
        return res.status(200).end();
    }

    // ── FAST-ACK: 200 immediately so Pub/Sub does not retry-storm, THEN run
    //    the (safe-fail) ingest detached. Any downstream error is logged; the
    //    5-min poll reconciles. ──────────────────────────────────────────────
    res.status(200).end();
    setImmediate(() => {
        emailTimelineService.ingestPushNotification(parsed)
            .catch(err => console.error('[EmailPush] async ingest error:', err && err.message));
    });
});

module.exports = router;
