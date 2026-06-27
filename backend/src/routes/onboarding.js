/**
 * Onboarding — ALB-101.
 * Authenticated (Keycloak token), but NO requireCompanyAccess: the whole point
 * is that the user has no company yet.
 */

const express = require('express');
const router = express.Router();
const otpService = require('../services/otpService');
const googlePlacesService = require('../services/googlePlacesService');
const platformCompanyService = require('../services/platformCompanyService');
const membershipQueries = require('../db/membershipQueries');

// POST /api/onboarding — create the company + first tenant_admin
router.post('/', async (req, res) => {
    try {
        if (process.env.FEATURE_SELF_SIGNUP !== 'true') {
            return res.status(503).json({ code: 'SIGNUP_DISABLED', message: 'Self-signup is not available' });
        }
        const userId = req.user?.crmUser?.id;
        if (!userId) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Authentication required' });

        const { company_name, place, manual, otp_token } = req.body || {};
        if (!company_name || String(company_name).trim().length < 2) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'company_name is required' });
        }

        // Already onboarded?
        const membership = await membershipQueries.getActiveMembership(userId);
        if (membership) {
            return res.status(409).json({ code: 'ALREADY_ONBOARDED', message: 'You already belong to a company' });
        }

        // Phone possession proof from the OTP step
        const otp = otpService.validateOtpToken(otp_token, 'signup');
        if (!otp) {
            return res.status(401).json({ code: 'OTP_REQUIRED', message: 'Verify your phone number first' });
        }

        // Resolve location → geo + timezone
        let geo = {};
        if (place?.place_id) {
            geo = (await googlePlacesService.resolve(place.place_id)) || {};
        } else if (manual?.city || manual?.zip) {
            geo = {
                city: manual.city || null,
                state: manual.state || null,
                zip: manual.zip || null,
                timezone: manual.timezone || 'America/New_York',
            };
        }

        const { company } = await platformCompanyService.bootstrapCompany({
            userId,
            name: String(company_name).trim(),
            geo,
            phone: otp.phone,
            email: req.user?.email || null,
        });

        // AUTH-FLOW-FIX-001 (R4): trust the just-onboarded device so the 2FA gate
        // does not fire (and re-send an SMS) immediately after signup. Mirrors the
        // albusto_td cookie set by routes/authDevice.js trust-device.
        const { deviceId, maxAgeSec } = await otpService.trustDevice(userId, {
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

        res.status(201).json({
            ok: true,
            company: { id: company.id, name: company.name, timezone: company.timezone },
            redirect: '/pulse',
        });
    } catch (err) {
        console.error('[Onboarding] error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Onboarding failed' });
    }
});

// GET /api/onboarding/status — has the user finished onboarding?
router.get('/status', async (req, res) => {
    try {
        const userId = req.user?.crmUser?.id;
        if (!userId) return res.status(401).json({ code: 'AUTH_REQUIRED' });
        const membership = await membershipQueries.getActiveMembership(userId);
        res.json({ ok: true, onboarded: !!membership });
    } catch (err) {
        res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
});

module.exports = router;
