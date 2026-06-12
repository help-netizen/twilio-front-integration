/**
 * Public Auth API — ALB-101 (self-registration)
 *
 * Mounted WITHOUT authenticate at /api/public. Strict per-IP rate limits,
 * anti-enumeration responses, no tenant data. Keycloak stays the identity
 * plane — this router only orchestrates it.
 *
 * Kill switch: FEATURE_SELF_SIGNUP !== 'true' → 503 on signup surface.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const otpService = require('../services/otpService');
const googlePlacesService = require('../services/googlePlacesService');

const SIGNUP_ENABLED = () => process.env.FEATURE_SELF_SIGNUP === 'true';

const limiter = (max) => rateLimit({
    windowMs: 60 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: 'Too many requests' },
});

function requireSignupEnabled(req, res, next) {
    if (!SIGNUP_ENABLED()) {
        return res.status(503).json({ code: 'SIGNUP_DISABLED', message: 'Self-signup is not available' });
    }
    next();
}

// ── Keycloak helpers (env-based admin credentials) ───────────────────────────

function kcBase() {
    return process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '') || null;
}
const REALM = process.env.KEYCLOAK_REALM || 'crm-prod';

async function kcAdminToken() {
    const res = await fetch(`${kcBase()}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            username: process.env.KEYCLOAK_ADMIN_USER || 'admin',
            password: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
        }),
    });
    if (!res.ok) throw new Error(`KC admin auth failed: ${res.status}`);
    return (await res.json()).access_token;
}

// ── POST /api/public/signup ──────────────────────────────────────────────────

router.post('/signup', requireSignupEnabled, limiter(20), async (req, res) => {
    try {
        const { email, password, full_name } = req.body || {};
        const emailOk = typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
        if (!emailOk || !password || String(password).length < 8 || !full_name) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'email, full_name and a password of at least 8 characters are required',
            });
        }

        const token = await kcAdminToken();
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

        // Anti-enumeration: identical response whether or not the email exists
        const existsRes = await fetch(
            `${kcBase()}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
            { headers: auth }
        );
        const existing = await existsRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
            console.log(`[PublicAuth] signup for existing email (masked)`);
            return res.json({ ok: true });
        }

        const createRes = await fetch(`${kcBase()}/admin/realms/${REALM}/users`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
                username: email,
                email,
                firstName: full_name.split(' ')[0] || full_name,
                lastName: full_name.split(' ').slice(1).join(' ') || '',
                enabled: true,
                emailVerified: false,
                credentials: [{ type: 'password', value: password, temporary: false }],
                requiredActions: ['VERIFY_EMAIL'],
            }),
        });
        if (!createRes.ok) {
            console.error('[PublicAuth] KC create failed:', createRes.status, await createRes.text());
            return res.status(502).json({ code: 'SIGNUP_FAILED', message: 'Could not create the account' });
        }

        // Trigger the verification email (best-effort)
        try {
            const found = await (await fetch(
                `${kcBase()}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
                { headers: auth }
            )).json();
            if (found[0]?.id) {
                await fetch(
                    `${kcBase()}/admin/realms/${REALM}/users/${found[0].id}/send-verify-email`,
                    { method: 'PUT', headers: auth }
                );
            }
        } catch (mailErr) {
            console.warn('[PublicAuth] verify-email send failed:', mailErr.message);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[PublicAuth] signup error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Signup failed' });
    }
});

// ── OTP ──────────────────────────────────────────────────────────────────────

router.post('/otp/send', requireSignupEnabled, limiter(30), async (req, res) => {
    try {
        const { phone, purpose } = req.body || {};
        if (!['signup', 'login'].includes(purpose)) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Invalid purpose' });
        }
        const out = await otpService.sendCode({ phone, purpose, ip: req.ip });
        res.json({ ok: true, resend_after_sec: out.resend_after_sec });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ code: err.code, message: err.message, ...err.extra });
        console.error('[PublicAuth] otp/send error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Could not send the code' });
    }
});

router.post('/otp/verify', requireSignupEnabled, limiter(60), async (req, res) => {
    try {
        const { phone, purpose, code } = req.body || {};
        const out = await otpService.verifyCode({ phone, purpose, code });
        res.json({ ok: true, otp_token: out.otp_token });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ code: err.code, message: err.message, ...err.extra });
        console.error('[PublicAuth] otp/verify error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Verification failed' });
    }
});

// ── Places proxy (onboarding) ────────────────────────────────────────────────

router.get('/places/suggest', limiter(120), async (req, res) => {
    try {
        const suggestions = await googlePlacesService.suggest(String(req.query.q || ''));
        res.json({ suggestions });
    } catch (err) {
        console.warn('[PublicAuth] places/suggest error:', err.message);
        res.json({ suggestions: [] });
    }
});

router.get('/places/resolve', limiter(60), async (req, res) => {
    try {
        const geo = await googlePlacesService.resolve(String(req.query.place_id || ''));
        if (!geo) return res.status(404).json({ code: 'NOT_FOUND', message: 'Place not found' });
        res.json({ ok: true, geo });
    } catch (err) {
        console.warn('[PublicAuth] places/resolve error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Could not resolve the place' });
    }
});

module.exports = router;
