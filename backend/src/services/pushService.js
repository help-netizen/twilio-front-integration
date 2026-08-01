'use strict';

/**
 * Tenant-and-user scoped notification transports.
 *
 * Recipient eligibility is owned by notificationRecipientResolver. These
 * functions only re-load the resolver-selected device rows using the complete
 * (company, user, destination-id) key and deliver a pre-sanitized payload.
 */

const webpush = require('web-push');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');

const APNS_HOST_PROD = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
const APNS_JWT_TTL_MS = 50 * 60 * 1000;
const LEGACY_APNS_JOB_TYPES = Object.freeze({
    'job.assigned': 'job_assigned',
    'job.rescheduled': 'job_rescheduled',
});

function emptyResult(errorCode = null) {
    return {
        targeted: 0,
        sent: 0,
        failed: 0,
        ...(errorCode ? { error_code: errorCode } : {}),
    };
}

function selectedIds(options) {
    return [...new Set((options?.destinationIds || []).filter(Boolean).map(String))];
}

function buildWebPushPayload(payload) {
    return {
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        event_type: payload.event_type,
        category_key: payload.category_key,
        category_label: payload.category_label,
        deep_link_kind: payload.deep_link_kind,
        record_ref: payload.record_ref,
        url: payload.url,
    };
}

async function sendWebPushToUser(companyId, userId, payload, options = {}) {
    if (!companyId || !userId || !payload) return emptyResult('INVALID_DELIVERY_CONTEXT');
    const destinationIds = selectedIds(options);
    if (destinationIds.length === 0) return emptyResult();

    try {
        const { rows } = await db.query(
            `SELECT id, endpoint, p256dh, auth
             FROM push_subscriptions
             WHERE company_id = $1
               AND user_id = $2
               AND is_active = true
               AND id = ANY($3::uuid[])
             ORDER BY id`,
            [companyId, userId, destinationIds]
        );
        if (rows.length === 0) return emptyResult();

        if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
            return {
                targeted: rows.length,
                sent: 0,
                failed: rows.length,
                error_code: 'WEB_PUSH_NOT_CONFIGURED',
            };
        }
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:notifications@albusto.com',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );

        const body = JSON.stringify(buildWebPushPayload(payload));
        const staleIds = [];
        let sent = 0;
        let failed = 0;
        await Promise.all(rows.map(async row => {
            try {
                await webpush.sendNotification(
                    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                    body
                );
                sent += 1;
            } catch (error) {
                failed += 1;
                if (error?.statusCode === 404 || error?.statusCode === 410) staleIds.push(row.id);
            }
        }));

        if (staleIds.length > 0) {
            await db.query(
                `UPDATE push_subscriptions
                 SET is_active = false
                 WHERE company_id = $1
                   AND user_id = $2
                   AND id = ANY($3::uuid[])`,
                [companyId, userId, staleIds]
            );
        }
        return {
            targeted: rows.length,
            sent,
            failed,
            ...(failed ? { error_code: 'WEB_PUSH_SEND_FAILED' } : {}),
        };
    } catch (error) {
        console.error('[pushService] Web Push delivery failed (non-fatal):', error.message);
        return emptyResult('WEB_PUSH_SEND_FAILED');
    }
}

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

function buildApnsPayload(payload) {
    const legacyType = LEGACY_APNS_JOB_TYPES[payload.event_type];
    const legacyJobData = legacyType && payload.record_ref?.type === 'job'
        ? { type: legacyType, job_id: payload.record_ref.id }
        : {};
    return {
        aps: {
            alert: { title: payload.title, body: payload.body },
            sound: 'default',
            'content-available': 1,
        },
        data: {
            event_type: payload.event_type,
            category_key: payload.category_key,
            deep_link_kind: payload.deep_link_kind,
            record_ref: payload.record_ref,
            ...legacyJobData,
        },
    };
}

function sendOneApns(session, cfg, providerToken, apnsToken, body) {
    return new Promise((resolve) => {
        let settled = false;
        const done = status => {
            if (!settled) {
                settled = true;
                resolve(status);
            }
        };
        try {
            const req = session.request({
                ':method': 'POST',
                ':path': `/3/device/${apnsToken}`,
                authorization: `bearer ${providerToken}`,
                'apns-topic': cfg.bundleId,
                'apns-push-type': 'alert',
                'content-type': 'application/json',
            });
            let status = null;
            req.on('response', headers => { status = headers[':status']; });
            req.setEncoding('utf8');
            req.on('data', () => {});
            req.on('end', () => done(status));
            req.on('error', () => done(null));
            req.write(body);
            req.end();
        } catch {
            done(null);
        }
    });
}

async function sendNativePushToUser(companyId, crmUserId, payload, options = {}) {
    if (!companyId || !crmUserId || !payload) return emptyResult('INVALID_DELIVERY_CONTEXT');
    const destinationIds = selectedIds(options);
    if (destinationIds.length === 0) return emptyResult();

    try {
        const { rows } = await db.query(
            `SELECT id, apns_token
             FROM device_tokens
             WHERE company_id = $1
               AND crm_user_id = $2
               AND id = ANY($3::bigint[])
             ORDER BY id`,
            [companyId, crmUserId, destinationIds]
        );
        if (rows.length === 0) return emptyResult();

        const cfg = getApnsConfig();
        if (!cfg) {
            return {
                targeted: rows.length,
                sent: 0,
                failed: rows.length,
                error_code: 'APNS_NOT_CONFIGURED',
            };
        }

        const providerToken = getApnsProviderToken(cfg);
        const body = JSON.stringify(buildApnsPayload(payload));
        const session = http2.connect(cfg.host);
        let sessionFailed = false;
        session.on('error', () => { sessionFailed = true; });
        const staleIds = [];
        let sent = 0;
        let failed = 0;
        try {
            for (const row of rows) {
                const status = sessionFailed
                    ? null
                    : await sendOneApns(session, cfg, providerToken, row.apns_token, body);
                if (status && status >= 200 && status < 300) sent += 1;
                else {
                    failed += 1;
                    if (status === 410) staleIds.push(String(row.id));
                }
            }
        } finally {
            try { session.close(); } catch { /* already closed */ }
        }

        if (staleIds.length > 0) {
            await db.query(
                `DELETE FROM device_tokens
                 WHERE company_id = $1
                   AND crm_user_id = $2
                   AND id = ANY($3::bigint[])`,
                [companyId, crmUserId, staleIds]
            );
        }
        return {
            targeted: rows.length,
            sent,
            failed,
            ...(failed ? { error_code: 'APNS_SEND_FAILED' } : {}),
        };
    } catch (error) {
        console.error('[pushService] APNs delivery failed (non-fatal):', error.message);
        return emptyResult('APNS_SEND_FAILED');
    }
}

module.exports = {
    buildWebPushPayload,
    buildApnsPayload,
    sendWebPushToUser,
    sendNativePushToUser,
};
