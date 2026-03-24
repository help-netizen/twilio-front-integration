/**
 * Push Notification Delivery Service
 *
 * Sends Web Push notifications to all eligible users in a company
 * for a given event type (new_text_message, new_lead).
 */

const webpush = require('web-push');
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

module.exports = { sendPushToCompany, isEventEnabled };
