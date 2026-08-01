'use strict';

const db = require('../db/connection');
const pushService = require('./pushService');
const { resolveNotificationRecipients } = require('./notificationRecipientResolver');
const {
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
} = require('./notificationEventCatalog');
const { buildNotificationPayload } = require('./notificationPayloadBuilder');

const DISPATCHER_EVENT_TYPES = Object.freeze(
    NOTIFICATION_EVENT_CATALOG
        .filter(entry => entry.producer_available)
        .map(entry => entry.event_type)
);

const CHANNEL_SENDERS = Object.freeze({
    browser_push: 'sendWebPushToUser',
    native_push: 'sendNativePushToUser',
});

function queryFor(client, database) {
    return client?.query ? client.query.bind(client) : database.query.bind(database);
}

function safeErrorCode(result) {
    const value = result?.error_code;
    return typeof value === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(value)
        ? value
        : 'PROVIDER_SEND_FAILED';
}

function createNotificationDispatcher({
    database = db,
    resolver = resolveNotificationRecipients,
    transports = pushService,
    logger = console,
} = {}) {
    async function beginDelivery(query, companyId, userId, channel, deliveryId) {
        const { rows } = await query(
            `UPDATE notification_deliveries
             SET status = 'sending',
                 attempt_count = attempt_count + 1,
                 last_error_code = NULL,
                 last_error_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
               AND company_id = $2
               AND user_id = $3
               AND channel = $4
               AND status = 'pending'
             RETURNING id, event_type, record_type, record_id, is_pre_change_recipient`,
            [deliveryId, companyId, userId, channel]
        );
        return rows[0] || null;
    }

    async function finishDelivery(query, {
        deliveryId,
        companyId,
        userId,
        channel,
        status,
        errorCode = null,
        providerMessageId = null,
    }) {
        await query(
            `UPDATE notification_deliveries
             SET status = $5,
                 last_error_code = $6,
                 last_error_at = CASE WHEN $5 = 'failed' THEN NOW() ELSE NULL END,
                 provider_message_id = $7,
                 sent_at = CASE WHEN $5 = 'sent' THEN NOW() ELSE sent_at END,
                 updated_at = NOW()
             WHERE id = $1
               AND company_id = $2
               AND user_id = $3
               AND channel = $4
               AND status = 'sending'`,
            [deliveryId, companyId, userId, channel, status, errorCode, providerMessageId]
        );
    }

    async function deliverChannel(query, event, recipient, channel) {
        const deliveryId = recipient.delivery_ids?.[channel];
        if (!deliveryId) return;

        const claim = await beginDelivery(
            query,
            event.company_id,
            recipient.user_id,
            channel,
            deliveryId
        );
        if (!claim) return;

        const payload = buildNotificationPayload({
            eventType: claim.event_type,
            deliveryId: claim.id,
            recordType: claim.record_type,
            recordId: claim.record_id,
            isPreChangeRecipient: claim.is_pre_change_recipient === true,
        });
        if (!payload) {
            await finishDelivery(query, {
                deliveryId,
                companyId: event.company_id,
                userId: recipient.user_id,
                channel,
                status: 'failed',
                errorCode: 'PAYLOAD_REJECTED',
            });
            return;
        }

        const destinationIds = (recipient.destinations?.[channel] || []).map(row => row.id);
        const senderName = CHANNEL_SENDERS[channel];
        try {
            const result = await transports[senderName](
                event.company_id,
                recipient.user_id,
                payload,
                { destinationIds }
            );
            const targeted = Number(result?.targeted || 0);
            const sent = Number(result?.sent || 0);
            const failed = Number(result?.failed || 0);
            const status = result?.error_code
                ? 'failed'
                : targeted === 0
                    ? 'skipped'
                    : sent === targeted && failed === 0
                        ? 'sent'
                        : 'failed';
            await finishDelivery(query, {
                deliveryId,
                companyId: event.company_id,
                userId: recipient.user_id,
                channel,
                status,
                errorCode: status === 'failed' ? safeErrorCode(result) : null,
                providerMessageId: result?.provider_message_id || null,
            });
        } catch (error) {
            await finishDelivery(query, {
                deliveryId,
                companyId: event.company_id,
                userId: recipient.user_id,
                channel,
                status: 'failed',
                errorCode: 'PROVIDER_SEND_FAILED',
            }).catch(() => {});
            logger.error('[notificationDispatcher] provider send failed (non-fatal):', error.message);
        }
    }

    async function dispatch(event, { client = null } = {}) {
        if (!event?.company_id || !event?.id || !getNotificationCatalogEntry(event.event_type)?.producer_available) {
            return { recipients: 0, deliveries: 0 };
        }
        const query = queryFor(client, database);
        try {
            const recipients = await resolver(event.company_id, event, { client });
            let deliveries = 0;
            for (const recipient of recipients) {
                for (const channel of Object.keys(CHANNEL_SENDERS)) {
                    if (!recipient.delivery_ids?.[channel]) continue;
                    deliveries += 1;
                    await deliverChannel(query, event, recipient, channel);
                }
            }
            return { recipients: recipients.length, deliveries };
        } catch (error) {
            logger.error('[notificationDispatcher] dispatch failed (non-fatal):', error.message);
            return { recipients: 0, deliveries: 0, failed: true };
        }
    }

    function register(eventBus) {
        eventBus.subscribe('notification-dispatcher', DISPATCHER_EVENT_TYPES, dispatch);
    }

    return { dispatch, register };
}

const notificationDispatcher = createNotificationDispatcher();

module.exports = {
    DISPATCHER_EVENT_TYPES,
    createNotificationDispatcher,
    dispatch: notificationDispatcher.dispatch,
    register: notificationDispatcher.register,
};
