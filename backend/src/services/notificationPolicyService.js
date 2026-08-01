'use strict';

const db = require('../db/connection');
const { withTransaction } = require('./transactionService');
const {
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
    getPublicNotificationEventCatalog,
} = require('./notificationEventCatalog');

const LEGACY_EVENT_MAP = Object.freeze({
    browser_push_new_text_message_enabled: 'sms.inbound',
    browser_push_new_lead_enabled: 'lead.created',
});
const PREFERENCE_VALUES = new Set(['inherit', 'enabled', 'disabled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function inTransaction(client, work) {
    if (client) return work(client);
    return withTransaction(work);
}

function requireContext(companyId, userId = null) {
    if (!companyId) {
        throw new NotificationPolicyError(403, 'TENANT_CONTEXT_REQUIRED', 'Company context is required.');
    }
    if (userId === null) return;
    if (!userId) {
        throw new NotificationPolicyError(409, 'NO_CRM_USER', 'CRM user context is required.');
    }
}

function requireCatalogEntry(eventType) {
    const entry = getNotificationCatalogEntry(eventType);
    if (!entry) {
        throw new NotificationPolicyError(400, 'UNKNOWN_EVENT_TYPE', 'Unknown notification event type.');
    }
    return entry;
}

function rejectUnknownKeys(value, allowedKeys, label) {
    const unknown = Object.keys(value).filter(key => !allowedKeys.includes(key));
    if (unknown.length > 0) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', `${label} contains unsupported fields.`);
    }
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', `${label} must be an object.`);
    }
}

function validateChannelMap(entry, channels, { preference = false } = {}) {
    assertObject(channels, 'channels');
    const pairs = Object.entries(channels);
    if (pairs.length === 0) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', 'channels must not be empty.');
    }
    for (const [channel, value] of pairs) {
        if (!entry.supported_channels.includes(channel)) {
            throw new NotificationPolicyError(400, 'UNSUPPORTED_CHANNEL', `Channel ${channel} is not supported for ${entry.event_type}.`);
        }
        if (preference ? !PREFERENCE_VALUES.has(value) : typeof value !== 'boolean') {
            throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', `Invalid value for channel ${channel}.`);
        }
        if (!entry.producer_available && (value === true || value === 'enabled')) {
            throw new NotificationPolicyError(409, 'PRODUCER_UNAVAILABLE', `Producer for ${entry.event_type} is not available.`);
        }
    }
    return pairs;
}

function roleDeliveryShape(role, entry, channelRows = []) {
    const enabledByChannel = new Map(channelRows.map(row => [row.channel, row.enabled === true]));
    return {
        role_config_id: role.id,
        role_key: role.role_key,
        role_label: role.display_name,
        events: [{
            event_type: entry.event_type,
            channels: Object.fromEntries(
                entry.supported_channels.map(channel => [channel, enabledByChannel.get(channel) === true])
            ),
        }],
    };
}

function preferenceShape(entry, preferenceRows = []) {
    const preferenceByChannel = new Map(preferenceRows.map(row => [row.channel, row.preference]));
    return {
        event_type: entry.event_type,
        channels: Object.fromEntries(
            entry.supported_channels.map(channel => [channel, preferenceByChannel.get(channel) || 'inherit'])
        ),
    };
}

function computeEffectivePolicyEntry(entry, {
    companyEnabled = false,
    roleChannels = {},
    preferences = {},
    permissions = [],
    destinations = {},
} = {}) {
    const permissionSet = permissions instanceof Set ? permissions : new Set(permissions);
    const channels = {};

    for (const channel of entry.supported_channels) {
        const reasons = [];
        const preference = preferences[channel] || 'inherit';
        if (!entry.producer_available) reasons.push('PRODUCER_UNAVAILABLE');
        if (!companyEnabled) reasons.push('COMPANY_EVENT_DISABLED');
        if (roleChannels[channel] !== true) reasons.push('ROLE_CHANNEL_DISABLED');
        if (!permissionSet.has(entry.required_permission)) reasons.push('MISSING_PERMISSION');
        if (preference === 'disabled') reasons.push('USER_DISABLED');
        if ((channel === 'email' || channel === 'sms') && preference !== 'enabled') {
            reasons.push('USER_DISABLED');
        }
        if (destinations[channel] !== true) reasons.push('NO_ACTIVE_DESTINATION');
        channels[channel] = { enabled: reasons.length === 0, reason_codes: [...new Set(reasons)] };
    }

    return { event_type: entry.event_type, channels };
}

async function getPolicySnapshot(companyId, {
    userId,
    roleKey,
    permissions = [],
    includeAllRoles = false,
    client = null,
} = {}) {
    requireContext(companyId, userId);
    const query = queryFor(client);
    const eventTypes = NOTIFICATION_EVENT_CATALOG.map(entry => entry.event_type);

    const { rows: policyRows } = await query(
        `SELECT event_type, enabled
         FROM company_notification_policies
         WHERE company_id = $1
           AND event_type = ANY($2::text[])`,
        [companyId, eventTypes]
    );
    const { rows: roleRows } = await query(
        `SELECT rc.id, rc.role_key, rc.display_name, d.event_type, d.channel, d.enabled
         FROM company_role_configs rc
         LEFT JOIN role_notification_delivery d
           ON d.company_id = rc.company_id
          AND d.role_config_id = rc.id
          AND d.event_type = ANY($2::text[])
         WHERE rc.company_id = $1
           AND ($3::boolean OR rc.role_key = $4)
         ORDER BY CASE rc.role_key
             WHEN 'tenant_admin' THEN 1
             WHEN 'manager' THEN 2
             WHEN 'dispatcher' THEN 3
             WHEN 'provider' THEN 4
             ELSE 5
         END`,
        [companyId, eventTypes, includeAllRoles, roleKey || '']
    );
    const { rows: preferenceRows } = await query(
        `SELECT event_type, channel, preference
         FROM user_notification_preferences
         WHERE company_id = $1
           AND user_id = $2
           AND event_type = ANY($3::text[])`,
        [companyId, userId, eventTypes]
    );
    const { rows: destinationRows } = await query(
        `SELECT
             EXISTS (
                 SELECT 1 FROM push_subscriptions
                 WHERE company_id = $1 AND user_id = $2 AND is_active = true
             ) AS browser_push,
             EXISTS (
                 SELECT 1 FROM device_tokens
                 WHERE company_id = $1 AND crm_user_id = $2
             ) AS native_push`,
        [companyId, userId]
    );

    const companyByEvent = new Map(policyRows.map(row => [row.event_type, row.enabled === true]));
    const roles = new Map();
    for (const row of roleRows) {
        if (!roles.has(row.id)) {
            roles.set(row.id, {
                id: row.id,
                role_key: row.role_key,
                display_name: row.display_name,
                channelsByEvent: new Map(),
            });
        }
        if (!row.event_type || !row.channel) continue;
        const role = roles.get(row.id);
        if (!role.channelsByEvent.has(row.event_type)) role.channelsByEvent.set(row.event_type, []);
        role.channelsByEvent.get(row.event_type).push(row);
    }
    const preferencesByEvent = new Map();
    for (const row of preferenceRows) {
        if (!preferencesByEvent.has(row.event_type)) preferencesByEvent.set(row.event_type, []);
        preferencesByEvent.get(row.event_type).push(row);
    }

    const roleDelivery = [...roles.values()].map(role => ({
        role_config_id: role.id,
        role_key: role.role_key,
        role_label: role.display_name,
        events: NOTIFICATION_EVENT_CATALOG.map(entry => roleDeliveryShape(
            role,
            entry,
            role.channelsByEvent.get(entry.event_type) || []
        ).events[0]),
    }));
    const currentPreferences = NOTIFICATION_EVENT_CATALOG.map(entry => (
        preferenceShape(entry, preferencesByEvent.get(entry.event_type) || [])
    ));
    const currentRole = [...roles.values()].find(role => role.role_key === roleKey) || null;
    const destination = destinationRows[0] || {};
    const destinations = {
        browser_push: destination.browser_push === true,
        native_push: destination.native_push === true,
    };
    const preferenceByEvent = new Map(currentPreferences.map(row => [row.event_type, row.channels]));
    const effectivePolicy = NOTIFICATION_EVENT_CATALOG.map(entry => {
        const currentRoleRows = currentRole?.channelsByEvent.get(entry.event_type) || [];
        const roleChannels = Object.fromEntries(currentRoleRows.map(row => [row.channel, row.enabled === true]));
        return computeEffectivePolicyEntry(entry, {
            companyEnabled: companyByEvent.get(entry.event_type) === true,
            roleChannels,
            preferences: preferenceByEvent.get(entry.event_type),
            permissions,
            destinations,
        });
    });

    return {
        catalog: getPublicNotificationEventCatalog(),
        company_policy: NOTIFICATION_EVENT_CATALOG.map(entry => ({
            event_type: entry.event_type,
            enabled: companyByEvent.get(entry.event_type) === true,
        })),
        role_delivery: roleDelivery,
        current_user_preferences: currentPreferences,
        effective_policy: effectivePolicy,
    };
}

function validateCompanyPolicyPatch(entry, body) {
    assertObject(body, 'body');
    rejectUnknownKeys(body, ['company_enabled', 'roles'], 'body');
    if (body.company_enabled === undefined && body.roles === undefined) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', 'No policy changes supplied.');
    }
    if (body.company_enabled !== undefined && typeof body.company_enabled !== 'boolean') {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', 'company_enabled must be a boolean.');
    }
    if (!entry.producer_available && body.company_enabled === true) {
        throw new NotificationPolicyError(409, 'PRODUCER_UNAVAILABLE', `Producer for ${entry.event_type} is not available.`);
    }
    if (body.roles !== undefined && !Array.isArray(body.roles)) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', 'roles must be an array.');
    }

    const roles = body.roles || [];
    for (const role of roles) {
        assertObject(role, 'role');
        rejectUnknownKeys(role, ['role_config_id', 'channels'], 'role');
        if (!UUID_PATTERN.test(role.role_config_id || '')) {
            throw new NotificationPolicyError(400, 'INVALID_ROLE_CONFIG_ID', 'role_config_id must be a UUID.');
        }
        validateChannelMap(entry, role.channels);
    }
    return roles;
}

async function updateCompanyPolicy(companyId, eventType, body, actorUserId, { client = null } = {}) {
    requireContext(companyId, actorUserId);
    const entry = requireCatalogEntry(eventType);
    const roles = validateCompanyPolicyPatch(entry, body);

    return inTransaction(client, async tx => {
        const roleIds = [...new Set(roles.map(role => role.role_config_id))];
        let ownedRoles = [];
        if (roleIds.length > 0) {
            const result = await tx.query(
                `SELECT id, role_key, display_name
                 FROM company_role_configs
                 WHERE company_id = $1 AND id = ANY($2::uuid[])`,
                [companyId, roleIds]
            );
            ownedRoles = result.rows;
            if (ownedRoles.length !== roleIds.length) {
                throw new NotificationPolicyError(404, 'ROLE_CONFIG_NOT_FOUND', 'Role config not found.');
            }
        }

        if (body.company_enabled !== undefined) {
            await tx.query(
                `INSERT INTO company_notification_policies
                    (company_id, event_type, enabled, updated_by_user_id, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (company_id, event_type)
                 DO UPDATE SET enabled = EXCLUDED.enabled,
                               updated_by_user_id = EXCLUDED.updated_by_user_id,
                               updated_at = NOW()`,
                [companyId, eventType, body.company_enabled, actorUserId]
            );
        }

        for (const role of roles) {
            for (const [channel, enabled] of Object.entries(role.channels)) {
                await tx.query(
                    `INSERT INTO role_notification_delivery
                        (company_id, role_config_id, event_type, channel, enabled, updated_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT (company_id, role_config_id, event_type, channel)
                     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
                    [companyId, role.role_config_id, eventType, channel, enabled]
                );
            }
        }

        const { rows: policyRows } = await tx.query(
            `SELECT event_type, enabled
             FROM company_notification_policies
             WHERE company_id = $1 AND event_type = $2`,
            [companyId, eventType]
        );
        let deliveryRows = [];
        if (roleIds.length > 0) {
            const result = await tx.query(
                `SELECT role_config_id, channel, enabled
                 FROM role_notification_delivery
                 WHERE company_id = $1
                   AND event_type = $2
                   AND role_config_id = ANY($3::uuid[])`,
                [companyId, eventType, roleIds]
            );
            deliveryRows = result.rows;
        }

        return {
            company_policy: {
                event_type: eventType,
                enabled: policyRows[0]?.enabled === true,
            },
            role_delivery: ownedRoles.map(role => roleDeliveryShape(
                role,
                entry,
                deliveryRows.filter(row => row.role_config_id === role.id)
            )),
        };
    });
}

function validatePreferencePatch(entry, body) {
    assertObject(body, 'body');
    rejectUnknownKeys(body, ['channels'], 'body');
    if (!body.channels) {
        throw new NotificationPolicyError(400, 'INVALID_NOTIFICATION_POLICY', 'channels is required.');
    }
    return validateChannelMap(entry, body.channels, { preference: true });
}

async function updateCurrentUserPreference(companyId, userId, roleKey, permissions, eventType, body, { client = null } = {}) {
    requireContext(companyId, userId);
    const entry = requireCatalogEntry(eventType);
    const channels = validatePreferencePatch(entry, body);

    await inTransaction(client, async tx => {
        for (const [channel, preference] of channels) {
            await tx.query(
                `INSERT INTO user_notification_preferences
                    (company_id, user_id, event_type, channel, preference, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (company_id, user_id, event_type, channel)
                 DO UPDATE SET preference = EXCLUDED.preference, updated_at = NOW()`,
                [companyId, userId, eventType, channel, preference]
            );
        }
    });

    const snapshot = await getPolicySnapshot(companyId, {
        userId,
        roleKey,
        permissions,
        includeAllRoles: false,
        client,
    });
    return {
        preference: snapshot.current_user_preferences.find(row => row.event_type === eventType),
        effective_policy: snapshot.effective_policy.find(row => row.event_type === eventType),
    };
}

async function getLegacyNotificationConfig(companyId, { client = null } = {}) {
    requireContext(companyId);
    const { rows } = await queryFor(client)(
        `SELECT event_type, enabled, updated_by_user_id, updated_at
         FROM company_notification_policies
         WHERE company_id = $1
           AND event_type = ANY($2::text[])`,
        [companyId, Object.values(LEGACY_EVENT_MAP)]
    );
    const byEvent = new Map(rows.map(row => [row.event_type, row]));
    const latest = [...rows].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
    return {
        browser_push_new_text_message_enabled: byEvent.get('sms.inbound')?.enabled === true,
        browser_push_new_lead_enabled: byEvent.get('lead.created')?.enabled === true,
        updated_by_user_id: latest?.updated_by_user_id || null,
        updated_at: latest?.updated_at ? new Date(latest.updated_at).toISOString() : null,
    };
}

async function updateLegacyNotificationConfig(companyId, config, actorUserId, { client = null } = {}) {
    requireContext(companyId, actorUserId);
    assertObject(config, 'config');
    const updatedAt = new Date().toISOString();
    const toSave = {
        browser_push_new_text_message_enabled: config.browser_push_new_text_message_enabled === true,
        browser_push_new_lead_enabled: config.browser_push_new_lead_enabled === true,
        updated_by_user_id: actorUserId,
        updated_at: updatedAt,
    };

    await inTransaction(client, async tx => {
        for (const [legacyKey, eventType] of Object.entries(LEGACY_EVENT_MAP)) {
            await tx.query(
                `INSERT INTO company_notification_policies
                    (company_id, event_type, enabled, updated_by_user_id, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (company_id, event_type)
                 DO UPDATE SET enabled = EXCLUDED.enabled,
                               updated_by_user_id = EXCLUDED.updated_by_user_id,
                               updated_at = NOW()`,
                [companyId, eventType, toSave[legacyKey], actorUserId]
            );
        }
        // Keep the old row current for rollback safety and for the legacy push
        // sender until M1.T5 removes company-broadcast delivery.
        await tx.query(
            `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_at)
             VALUES ($1, 'browser_push_config', $2::jsonb, NOW())
             ON CONFLICT (company_id, setting_key)
             DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
            [companyId, JSON.stringify(toSave)]
        );
    });
    return toSave;
}

function buildRoleDefaults() {
    const roleDefaults = [];
    for (const entry of NOTIFICATION_EVENT_CATALOG) {
        for (const channel of entry.supported_channels) {
            for (const roleKey of ['tenant_admin', 'manager', 'dispatcher', 'provider']) {
                roleDefaults.push({
                    event_type: entry.event_type,
                    channel,
                    role_key: roleKey,
                    enabled: entry.default_role_keys.includes(roleKey),
                });
            }
        }
    }
    return roleDefaults;
}

async function seedNotificationRoleDefaultsForCompany(companyId, { client = null } = {}) {
    requireContext(companyId);
    const query = queryFor(client);
    const roleDefaults = buildRoleDefaults();

    await query(
        `INSERT INTO role_notification_delivery
            (company_id, role_config_id, event_type, channel, enabled)
         SELECT $1, rc.id, seed.event_type, seed.channel, seed.enabled
         FROM jsonb_to_recordset($2::jsonb)
              AS seed(event_type text, channel text, role_key text, enabled boolean)
         JOIN company_role_configs rc
           ON rc.company_id = $1
          AND rc.role_key = seed.role_key
         ON CONFLICT (company_id, role_config_id, event_type, channel) DO NOTHING`,
        [companyId, JSON.stringify(roleDefaults)]
    );
}

async function seedNotificationDefaultsForCompany(companyId, { client = null } = {}) {
    requireContext(companyId);
    const query = queryFor(client);
    const companyDefaults = NOTIFICATION_EVENT_CATALOG.map(entry => ({
        event_type: entry.event_type,
        default_enabled: entry.default_enabled,
    }));

    await query(
        `INSERT INTO company_notification_policies (company_id, event_type, enabled)
         SELECT $1, seed.event_type, seed.default_enabled
         FROM jsonb_to_recordset($2::jsonb)
              AS seed(event_type text, default_enabled boolean)
         ON CONFLICT (company_id, event_type) DO NOTHING`,
        [companyId, JSON.stringify(companyDefaults)]
    );
    await seedNotificationRoleDefaultsForCompany(companyId, { client });
}

module.exports = {
    LEGACY_EVENT_MAP,
    NotificationPolicyError,
    computeEffectivePolicyEntry,
    getPolicySnapshot,
    updateCompanyPolicy,
    updateCurrentUserPreference,
    getLegacyNotificationConfig,
    updateLegacyNotificationConfig,
    seedNotificationDefaultsForCompany,
    seedNotificationRoleDefaultsForCompany,
};
