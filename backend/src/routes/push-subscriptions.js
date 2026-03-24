/**
 * Push Subscriptions Routes
 *
 * /api/push-subscriptions — user/browser-level Web Push subscription management
 *
 * Any authenticated user can manage their own subscriptions.
 */

const express = require('express');
const db = require('../db/connection');
const webpush = require('web-push');

const router = express.Router();

// Resolve company_id
async function resolveCompanyId(req) {
    const cid = req.companyFilter?.company_id;
    if (cid) return cid;
    const { rows } = await db.query('SELECT id FROM companies ORDER BY id LIMIT 1');
    return rows[0]?.id || null;
}

// ─── GET /api/push-subscriptions/status ─────────────────────────────────
// Returns current user's active subscription count for this company
router.get('/status', async (req, res) => {
    try {
        const companyId = await resolveCompanyId(req);
        const userId = req.user?.crmUser?.id;
        if (!companyId || !userId) {
            return res.json({ ok: true, hasActiveSubscription: false, count: 0 });
        }

        const { rows } = await db.query(
            `SELECT COUNT(*)::int as count FROM push_subscriptions
             WHERE company_id = $1 AND user_id = $2 AND is_active = true`,
            [companyId, userId]
        );

        res.json({
            ok: true,
            hasActiveSubscription: rows[0].count > 0,
            count: rows[0].count,
        });
    } catch (err) {
        console.error('[PushSubscriptions] GET status error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/push-subscriptions/vapid-public-key ───────────────────────
// Returns the VAPID public key so the frontend can subscribe
router.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) {
        return res.status(500).json({ ok: false, error: 'VAPID not configured' });
    }
    res.json({ ok: true, publicKey: key });
});

// ─── POST /api/push-subscriptions ───────────────────────────────────────
// Register or re-activate a push subscription
router.post('/', async (req, res) => {
    try {
        const companyId = await resolveCompanyId(req);
        const userId = req.user?.crmUser?.id;
        if (!companyId || !userId) {
            return res.status(400).json({ ok: false, error: 'Missing user/company context' });
        }

        const { endpoint, keys, browserName, userAgent } = req.body;
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ ok: false, error: 'Missing subscription data (endpoint, keys.p256dh, keys.auth)' });
        }

        // Upsert: if endpoint already exists, reactivate it
        await db.query(
            `INSERT INTO push_subscriptions (company_id, user_id, endpoint, p256dh, auth, browser_name, user_agent, is_active, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
             ON CONFLICT (endpoint)
             DO UPDATE SET
               company_id = $1,
               user_id = $2,
               p256dh = $4,
               auth = $5,
               browser_name = $6,
               user_agent = $7,
               is_active = true,
               last_seen_at = NOW()`,
            [companyId, userId, endpoint, keys.p256dh, keys.auth, browserName || null, userAgent || null]
        );

        console.log(`[PushSubscriptions] Registered subscription for user=${userId} company=${companyId}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[PushSubscriptions] POST error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/push-subscriptions ─────────────────────────────────────
// Deactivate a subscription by endpoint
router.delete('/', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) {
            return res.status(400).json({ ok: false, error: 'Missing endpoint' });
        }

        await db.query(
            `UPDATE push_subscriptions SET is_active = false WHERE endpoint = $1 AND user_id = $2`,
            [endpoint, req.user?.crmUser?.id]
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('[PushSubscriptions] DELETE error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /api/push-subscriptions/test ──────────────────────────────────
// Send a test notification to the current user's latest active subscription
router.post('/test', async (req, res) => {
    try {
        const companyId = await resolveCompanyId(req);
        const userId = req.user?.crmUser?.id;
        if (!companyId || !userId) {
            return res.status(400).json({ ok: false, error: 'Missing user/company context' });
        }

        const { rows } = await db.query(
            `SELECT endpoint, p256dh, auth FROM push_subscriptions
             WHERE company_id = $1 AND user_id = $2 AND is_active = true
             ORDER BY last_seen_at DESC LIMIT 5`,
            [companyId, userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'No active subscriptions found' });
        }

        // Configure VAPID
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@blanc.app',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );

        const payload = JSON.stringify({
            title: '🔔 Test Notification',
            body: 'Browser notifications are working! You will receive alerts for new messages and leads.',
            url: '/settings/actions-notifications',
        });

        let sent = 0;
        let failed = 0;
        for (const sub of rows) {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    payload
                );
                sent++;
            } catch (pushErr) {
                failed++;
                if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
                    // Subscription expired — deactivate
                    await db.query(
                        'UPDATE push_subscriptions SET is_active = false WHERE endpoint = $1',
                        [sub.endpoint]
                    );
                }
                console.warn(`[PushSubscriptions] Test push failed for endpoint: ${pushErr.statusCode || pushErr.message}`);
            }
        }

        res.json({ ok: true, sent, failed });
    } catch (err) {
        console.error('[PushSubscriptions] test error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
