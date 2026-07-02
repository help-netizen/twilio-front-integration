/**
 * Push Notification Delivery Service
 *
 * Two independent delivery channels live here:
 *
 *  1. Web Push (VAPID) — company-wide broadcast for the browser CRM.
 *     `sendPushToCompany(companyId, eventType, data)` fans a notification out to
 *     every active push_subscriptions row for a company (new_text_message,
 *     new_lead). Used by leads.js and conversationsService.js.
 *
 *  2. Native APNs (MOBILE-TECH-APP-001 / MTECH-T2, spec §3.7/§4.2/§8.T2/C9) —
 *     per-user delivery to the iOS tech app. `sendToUser(companyId, crmUserId,
 *     { type, job_id })` resolves that user's device_tokens rows and pushes an
 *     APNs alert. Called from the reassign hook (job_assigned, for each newly-
 *     added provider) and the reschedule hook (job_rescheduled, for currently-
 *     assigned providers) in scheduleService. Token-based (.p8 → ES256 JWT) over
 *     HTTP/2 using only Node built-ins + jsonwebtoken (no APNs dependency added).
 *     FAIL-SOFT: no-ops when APNS_* env is absent, never throws — a push failure
 *     must never break the reassign/reschedule caller. APNs 410 Unregistered →
 *     the stale device_tokens row is deleted (spec C9, token rotation).
 */

const webpush = require('web-push');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');

const SETTING_KEY = 'browser_push_config';

// Event type → company setting key mapping
const EVENT_SETTING_MAP = {
    new_text_message: 'browser_push_new_text_message_enabled',
    new_lead: 'browser_push_new_lead_enabled',
};

/**
 * Check if a notification event type is enabled for a company.
 */
async function isEventEnabled(companyId, eventType) {
    const settingKey = EVENT_SETTING_MAP[eventType];
    if (!settingKey) return false;

    const { rows } = await db.query(
        'SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2',
        [companyId, SETTING_KEY]
    );

    if (rows.length === 0) return false;
    return !!rows[0].setting_value?.[settingKey];
}

/**
 * Send push notification to all active subscriptions in a company.
 *
 * @param {string} companyId - Company UUID
 * @param {string} eventType - 'new_text_message' | 'new_lead'
 * @param {object} data - Notification payload data
 * @param {string} data.title - Notification title
 * @param {string} data.body - Notification body text
 * @param {string} data.url - Deep link URL (e.g. /pulse/timeline/xxx or /leads/xxx)
 * @param {string} [data.tag] - Deduplication tag to prevent duplicate notifications
 */
async function sendPushToCompany(companyId, eventType, data) {
    const logPrefix = `[PushService] [${eventType}] company=${companyId}`;

    try {
        // 1. Check company policy
        const enabled = await isEventEnabled(companyId, eventType);
        if (!enabled) {
            console.log(`${logPrefix} Event type disabled, skipping`);
            return { sent: 0, failed: 0, skipped: true };
        }

        // 2. Get all active subscriptions for this company
        const { rows: subscriptions } = await db.query(
            `SELECT id, endpoint, p256dh, auth, user_id
             FROM push_subscriptions
             WHERE company_id = $1 AND is_active = true`,
            [companyId]
        );

        if (subscriptions.length === 0) {
            console.log(`${logPrefix} No active subscriptions`);
            return { sent: 0, failed: 0, skipped: false };
        }

        // 3. Configure VAPID
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@blanc.app',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );

        // 4. Build payload
        const payload = JSON.stringify({
            title: data.title || 'New notification',
            body: data.body || '',
            url: data.url || '/',
            tag: data.tag || `${eventType}-${Date.now()}`,
        });

        // 5. Send to all subscriptions
        let sent = 0;
        let failed = 0;
        const staleEndpoints = [];

        const results = await Promise.allSettled(
            subscriptions.map(async (sub) => {
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        payload
                    );
                    return { status: 'sent', id: sub.id };
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        staleEndpoints.push(sub.endpoint);
                    }
                    throw err;
                }
            })
        );

        for (const r of results) {
            if (r.status === 'fulfilled') sent++;
            else failed++;
        }

        // 6. Deactivate stale subscriptions
        if (staleEndpoints.length > 0) {
            await db.query(
                `UPDATE push_subscriptions SET is_active = false WHERE endpoint = ANY($1)`,
                [staleEndpoints]
            );
            console.log(`${logPrefix} Deactivated ${staleEndpoints.length} stale subscriptions`);
        }

        console.log(`${logPrefix} Targeted=${subscriptions.length} Sent=${sent} Failed=${failed}`);
        return { sent, failed, skipped: false, targeted: subscriptions.length };
    } catch (err) {
        console.error(`${logPrefix} Error:`, err.message);
        return { sent: 0, failed: 0, error: err.message };
    }
}

// =============================================================================
// Native APNs (MOBILE-TECH-APP-001 / MTECH-T2)
// =============================================================================

// Apple APNs hosts. Production by default; the sandbox host is used only when
// APNS_ENV=sandbox (dev/TestFlight builds signed for the dev gateway).
const APNS_HOST_PROD = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

// The provider JWT is valid up to 1h; Apple rejects tokens older than that.
// Regenerate ~every 50 min so a long-lived process never sends a stale token.
const APNS_JWT_TTL_MS = 50 * 60 * 1000;

// Localized alert copy per push type. `content-available:1` is set alongside so
// the app also wakes to run an incremental sync (spec §3.7 silent-trigger).
const APNS_ALERTS = {
    job_assigned: { title: 'New job assigned', body: 'A job was assigned to you. Tap to view.' },
    job_rescheduled: { title: 'Job rescheduled', body: 'A job on your schedule was rescheduled. Tap to view.' },
};

/**
 * Read + validate APNs config from env. Returns null (→ APNs path no-ops) when
 * any required value is missing. The .p8 private key may be a raw PEM (with real
 * newlines) or carry literal "\n" escapes (common in single-line env).
 */
function getApnsConfig() {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const bundleId = process.env.APNS_BUNDLE_ID;
    let privateKey = process.env.APNS_PRIVATE_KEY;

    if (!keyId || !teamId || !bundleId || !privateKey) return null;

    if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

    const host = process.env.APNS_ENV === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
    return { keyId, teamId, bundleId, privateKey, host };
}

// Cached provider JWT (bearer). Rebuilt when older than APNS_JWT_TTL_MS.
let cachedApnsToken = null;
let cachedApnsTokenAt = 0;

function getApnsProviderToken(cfg) {
    const now = Date.now();
    if (cachedApnsToken && now - cachedApnsTokenAt < APNS_JWT_TTL_MS) return cachedApnsToken;
    cachedApnsToken = jwt.sign(
        { iss: cfg.teamId, iat: Math.floor(now / 1000) },
        cfg.privateKey,
        { algorithm: 'ES256', header: { alg: 'ES256', kid: cfg.keyId } }
    );
    cachedApnsTokenAt = now;
    return cachedApnsToken;
}

/**
 * Build the APNs payload for a push type. `data` carries the deep-link routing
 * used by the client (albusto://job/{job_id}); `content-available:1` triggers a
 * background incremental sync on receipt (spec §3.7).
 */
function buildApnsPayload(type, jobId) {
    const alert = APNS_ALERTS[type] || { title: 'Albusto', body: 'You have an update.' };
    return {
        aps: {
            alert,
            sound: 'default',
            'content-available': 1,
        },
        data: { type, job_id: jobId },
    };
}

/**
 * Send one notification over an already-open HTTP/2 session. Resolves with the
 * APNs `:status` (number) or null on a transport-level failure. Never throws.
 */
function sendOneApns(session, cfg, providerToken, apnsToken, body) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (status) => { if (!settled) { settled = true; resolve(status); } };
        try {
            const req = session.request({
                ':method': 'POST',
                ':path': `/3/device/${apnsToken}`,
                'authorization': `bearer ${providerToken}`,
                'apns-topic': cfg.bundleId,
                'apns-push-type': 'alert',
                'content-type': 'application/json',
            });
            let status = null;
            req.on('response', (headers) => { status = headers[':status']; });
            req.setEncoding('utf8');
            req.on('data', () => {}); // drain (body carries an APNs `reason` we don't need)
            req.on('end', () => done(status));
            req.on('error', (err) => {
                console.error('[pushService] APNs request error (non-fatal):', err.message);
                done(null);
            });
            req.write(body);
            req.end();
        } catch (err) {
            console.error('[pushService] APNs request setup error (non-fatal):', err.message);
            done(null);
        }
    });
}

/**
 * Deliver a native APNs push to every device registered to (companyId, crmUserId).
 * Best-effort and self-contained: no-ops when unconfigured, never throws.
 *
 * @param {string} companyId  tenant (req.authz.company.id)
 * @param {string} crmUserId  target provider (crm_users.id)
 * @param {{type:string, job_id:(number|string)}} payload
 * @returns {Promise<void>}
 */
async function sendToUser(companyId, crmUserId, { type, job_id } = {}) {
    try {
        if (!companyId || !crmUserId) return;

        const cfg = getApnsConfig();
        if (!cfg) {
            // Not configured → silent no-op (owner supplies APNS_* in prod env).
            console.log('[pushService] APNS_* not configured — skipping push (fail-soft)');
            return;
        }

        // Resolve device tokens for this user, scoped to the company (isolation).
        const { rows } = await db.query(
            `SELECT apns_token FROM device_tokens
             WHERE company_id = $1 AND crm_user_id = $2`,
            [companyId, crmUserId]
        );
        if (!rows.length) return;

        const providerToken = getApnsProviderToken(cfg);
        const body = JSON.stringify(buildApnsPayload(type, job_id));

        const session = http2.connect(cfg.host);
        const staleTokens = [];
        let sessionError = false;
        session.on('error', (err) => {
            sessionError = true;
            console.error('[pushService] APNs session error (non-fatal):', err.message);
        });

        try {
            for (const { apns_token } of rows) {
                if (sessionError) break;
                const status = await sendOneApns(session, cfg, providerToken, apns_token, body);
                // 410 Unregistered → device unenrolled/reinstalled; prune the row (C9).
                if (status === 410) staleTokens.push(apns_token);
                else if (status && status >= 400) {
                    console.warn(`[pushService] APNs ${status} for user=${crmUserId} type=${type}`);
                }
            }
        } finally {
            try { session.close(); } catch { /* already closed */ }
        }

        if (staleTokens.length) {
            try {
                await db.query(
                    `DELETE FROM device_tokens
                     WHERE company_id = $1 AND crm_user_id = $2 AND apns_token = ANY($3::text[])`,
                    [companyId, crmUserId, staleTokens]
                );
                console.log(`[pushService] Pruned ${staleTokens.length} unregistered device token(s) for user=${crmUserId}`);
            } catch (err) {
                console.error('[pushService] Failed to prune stale tokens (non-fatal):', err.message);
            }
        }
    } catch (err) {
        // Absolute fail-soft boundary: never propagate to the caller.
        console.error('[pushService] sendToUser failed (non-fatal):', err.message);
    }
}

module.exports = { sendPushToCompany, isEventEnabled, sendToUser };
