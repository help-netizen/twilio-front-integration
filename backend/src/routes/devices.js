/**
 * Devices Routes — native APNs device-token registry.
 * MOBILE-TECH-APP-001 / MTECH-T2 (spec §4.2, C9/C13).
 *
 * Mounted at `/api/devices` with `authenticate, requireCompanyAccess`
 * (src/server.js). Named `devices.js` (NOT authDevice.js — that owns the
 * `/api/auth/*` SMS-OTP 2FA flow, unrelated to APNs).
 *
 *   POST /api/devices          register / re-register the caller's iOS device
 *                              token under its full tenant/user identity.
 *   DELETE /api/devices/:token deregister the caller's own device token
 *                              (idempotent — a missing row is still 200).
 *
 * Isolation: company_id ONLY from req.companyFilter.company_id, set by
 * requireCompanyAccess; the owning user is
 * req.user.crmUser.id — a request with no crm_user gets 409 NO_CRM_USER (a push
 * with no user scope is meaningless). DELETE is own-token only (scoped by
 * crm_user_id) so one user can never remove another user's device.
 *
 * Response envelope: { ok, data } / { ok:false, error }.
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// company_id ONLY from requireCompanyAccess — no crm_users.company_id, authz
// fallback, body identity, or "first company" guess.
function getCompanyId(req) {
    return req.companyFilter?.company_id || null;
}

// ─── POST /api/devices ───────────────────────────────────────────────────────
// Register or re-register a device token. Physical possession is the ownership
// proof: the most recent registration atomically replaces any previous owner.
router.post('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) {
            // requireCompanyAccess should have set this; belt-and-suspenders.
            return res.status(403).json({ ok: false, error: 'Tenant context required' });
        }

        const crmUserId = req.user?.crmUser?.id;
        if (!crmUserId) {
            // No provider identity → a per-user push has no target (spec §4.2).
            return res.status(409).json({ ok: false, code: 'NO_CRM_USER', error: 'No crm_user for this account' });
        }

        const { apns_token, platform, app_version, device_model } = req.body || {};
        if (!apns_token || typeof apns_token !== 'string' || apns_token.trim() === '') {
            return res.status(400).json({ ok: false, error: 'apns_token is required' });
        }
        const token = apns_token.trim();
        const plat = (typeof platform === 'string' && platform.trim()) ? platform.trim() : 'ios';

        const client = await db.getClient();
        let rows;
        try {
            await client.query('BEGIN');
            // Serialize handoffs for this physical token. Without the lock, two
            // first-time registrations could both pass DELETE before either INSERT.
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                [token]
            );
            // Deliberately token-global: current device possession supersedes a
            // stale owner in any tenant. Request identity still comes only from
            // companyFilter + crmUser, never from the body.
            await client.query(
                `DELETE FROM device_tokens
                 WHERE apns_token = $1
                   AND (company_id <> $2 OR crm_user_id <> $3)`,
                [token, companyId, crmUserId]
            );
            ({ rows } = await client.query(
                `INSERT INTO device_tokens
                    (company_id, crm_user_id, apns_token, platform, app_version, device_model, last_seen_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, now(), now())
                 ON CONFLICT (company_id, crm_user_id, apns_token) DO UPDATE SET
                    platform    = EXCLUDED.platform,
                    app_version = EXCLUDED.app_version,
                    device_model= EXCLUDED.device_model,
                    last_seen_at= now()
                 RETURNING (xmax = 0) AS inserted`,
                [companyId, crmUserId, token, plat, app_version || null, device_model || null]
            ));
            await client.query('COMMIT');
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
            throw error;
        } finally {
            client.release();
        }

        const inserted = rows[0]?.inserted === true;
        console.log(`[Devices] Registered device for user=${crmUserId} company=${companyId} (${inserted ? 'new' : 'updated'})`);
        return res.status(inserted ? 201 : 200).json({ ok: true, data: { registered: true } });
    } catch (err) {
        console.error('[Devices] POST error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/devices/:token ──────────────────────────────────────────────
// Deregister the caller's OWN device token (logout / account switch, C13). Scoped
// to (company_id, crm_user_id) so no user can delete another's row. Idempotent:
// a missing/foreign row deletes nothing but still returns 200 removed:true.
router.delete('/:token', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) {
            return res.status(403).json({ ok: false, error: 'Tenant context required' });
        }

        const crmUserId = req.user?.crmUser?.id;
        if (!crmUserId) {
            return res.status(409).json({ ok: false, code: 'NO_CRM_USER', error: 'No crm_user for this account' });
        }

        const token = req.params.token;
        if (!token || token.trim() === '') {
            return res.status(400).json({ ok: false, error: 'token is required' });
        }

        await db.query(
            `DELETE FROM device_tokens
             WHERE apns_token = $1 AND company_id = $2 AND crm_user_id = $3`,
            [token.trim(), companyId, crmUserId]
        );

        return res.json({ ok: true, data: { removed: true } });
    } catch (err) {
        console.error('[Devices] DELETE error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
