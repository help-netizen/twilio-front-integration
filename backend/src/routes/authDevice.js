/**
 * Trusted device 2FA endpoints — ALB-101 (FEATURE_SMS_2FA).
 * Authenticated; no tenant context required.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const otpService = require('../services/otpService');

// POST /api/auth/otp/send — send a login code to the user's own verified phone
router.post('/otp/send', async (req, res) => {
    try {
        const crmUser = req.user?.crmUser;
        if (!crmUser?.id) return res.status(401).json({ code: 'AUTH_REQUIRED' });
        const { rows } = await db.query('SELECT phone_e164 FROM crm_users WHERE id = $1', [crmUser.id]);
        const phone = rows[0]?.phone_e164;
        if (!phone) return res.status(409).json({ code: 'NO_PHONE', message: 'No verified phone on this account' });
        const out = await otpService.sendCode({ phone, purpose: 'login', ip: req.ip });
        res.json({ ok: true, resend_after_sec: out.resend_after_sec, phone_hint: phone.replace(/(\+1)\d{6}(\d{4})/, '$1••••••$2') });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ code: err.code, message: err.message, ...err.extra });
        console.error('[AuthDevice] otp/send error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
});

// POST /api/auth/otp/verify — verify the login code
router.post('/otp/verify', async (req, res) => {
    try {
        const crmUser = req.user?.crmUser;
        if (!crmUser?.id) return res.status(401).json({ code: 'AUTH_REQUIRED' });
        const { rows } = await db.query('SELECT phone_e164 FROM crm_users WHERE id = $1', [crmUser.id]);
        const phone = rows[0]?.phone_e164;
        if (!phone) return res.status(409).json({ code: 'NO_PHONE' });
        const out = await otpService.verifyCode({ phone, purpose: 'login', code: req.body?.code });
        res.json({ ok: true, otp_token: out.otp_token });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ code: err.code, message: err.message, ...err.extra });
        console.error('[AuthDevice] otp/verify error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
});

// POST /api/auth/trust-device — exchange a login otp_token for a 30-day cookie
router.post('/trust-device', async (req, res) => {
    try {
        const crmUser = req.user?.crmUser;
        if (!crmUser?.id) return res.status(401).json({ code: 'AUTH_REQUIRED' });
        const otp = otpService.validateOtpToken(req.body?.otp_token, 'login');
        if (!otp) return res.status(401).json({ code: 'OTP_REQUIRED', message: 'Verify the code first' });

        const { deviceId, maxAgeSec } = await otpService.trustDevice(crmUser.id, {
            ip: req.ip,
            label: req.headers['user-agent']?.slice(0, 120) || null,
        });
        res.cookie('albusto_td', deviceId, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: maxAgeSec * 1000,
            path: '/',
        });
        res.json({ ok: true, trusted_days: Math.round(maxAgeSec / 86400) });
    } catch (err) {
        console.error('[AuthDevice] trust-device error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
});

module.exports = router;
