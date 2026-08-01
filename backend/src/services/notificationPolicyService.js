'use strict';

const db = require('../db/connection');
const { NOTIFICATION_CATEGORIES } = require('./notificationEventCatalog');

const USER_NOTIFICATION_CATEGORIES = Object.freeze(
    NOTIFICATION_CATEGORIES.filter(category => category.user_configurable)
);
const CATEGORY_BY_KEY = new Map(USER_NOTIFICATION_CATEGORIES.map(category => [category.key, category]));

class NotificationPolicyError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'NotificationPolicyError';
        this.status = status;
        this.code = code;
    }
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function requireContext(companyId, userId) {
    if (!companyId) {
        throw new NotificationPolicyError(403, 'TENANT_CONTEXT_REQUIRED', 'Company context is required.');
    }
    if (!userId) {
        throw new NotificationPolicyError(409, 'NO_CRM_USER', 'CRM user context is required.');
    }
}

function requireUserCategory(categoryKey) {
    const category = CATEGORY_BY_KEY.get(categoryKey);
    if (!category) {
        throw new NotificationPolicyError(404, 'NOTIFICATION_CATEGORY_NOT_FOUND', 'Notification category not found.');
    }
    return category;
}

function validatePreferenceBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_PREFERENCE', 'body must be an object.');
    }
    if (Object.keys(body).some(key => key !== 'enabled') || typeof body.enabled !== 'boolean') {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_PREFERENCE', 'enabled must be a boolean.');
    }
}

async function getNotificationSettings(companyId, userId, { client = null } = {}) {
    requireContext(companyId, userId);
    const { rows } = await queryFor(client)(
        `SELECT
             COALESCE(
                 jsonb_object_agg(p.category, p.enabled)
                     FILTER (WHERE p.category IS NOT NULL),
                 '{}'::jsonb
             ) AS preferences,
             EXISTS (
                 SELECT 1
                 FROM push_subscriptions s
                 WHERE s.company_id = $1
                   AND s.user_id = $2
                   AND s.is_active = true
             ) AS browser_push_subscribed
         FROM user_notification_preferences p
         WHERE p.company_id = $1
           AND p.user_id = $2`,
        [companyId, userId]
    );
    const preferences = rows[0]?.preferences || {};

    return {
        categories: USER_NOTIFICATION_CATEGORIES.map(category => ({
            key: category.key,
            label: category.label,
            description: category.description,
            enabled: preferences[category.key] !== false,
        })),
        device: {
            browser_push: {
                supported: Boolean(process.env.VAPID_PUBLIC_KEY),
                // Browser permission is client-local and cannot be observed by
                // the API. The UI replaces this sentinel with Notification.permission.
                permission: 'unknown',
                subscribed: rows[0]?.browser_push_subscribed === true,
            },
        },
    };
}

async function updateCurrentUserCategory(companyId, userId, categoryKey, body, { client = null } = {}) {
    requireContext(companyId, userId);
    const category = requireUserCategory(categoryKey);
    validatePreferenceBody(body);

    const { rows } = await queryFor(client)(
        `INSERT INTO user_notification_preferences
            (company_id, user_id, category, enabled, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id, user_id, category)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
         RETURNING enabled`,
        [companyId, userId, category.key, body.enabled]
    );

    return {
        key: category.key,
        label: category.label,
        description: category.description,
        enabled: rows[0].enabled === true,
    };
}

module.exports = {
    USER_NOTIFICATION_CATEGORIES,
    NotificationPolicyError,
    getNotificationSettings,
    updateCurrentUserCategory,
};
