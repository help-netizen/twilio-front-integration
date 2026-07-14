'use strict';

const marketplaceQueries = require('../../db/marketplaceQueries');
const slotEngineSettingsQueries = require('../../db/slotEngineSettingsQueries');

const SLOT_KEYS = Object.freeze([
    'horizon_days',
    'max_distance_miles',
    'recommendations_shown',
    'overlap_minutes',
    'min_buffer_minutes',
]);

const SETTINGS_ALLOWLIST = Object.freeze({
    'rely-leads': Object.freeze(['zone_mode', 'zip_count', 'unit_types', 'brands']),
    'smart-slot-engine': SLOT_KEYS,
    'slot-engine': SLOT_KEYS,
    'mail-secretary': Object.freeze(['provider', 'enabled']),
    'vapi-ai': Object.freeze(['assistant_configured']),
});

// v1: live_mode/autonomous_mode deferred — sourced outside marketplace tables (ASSISTANT-BOT-001 §5.2)

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(installationStatus) {
    if (installationStatus === 'connected') return 'connected';
    if (installationStatus === 'provisioning') return 'provisioning';
    if (installationStatus === 'provisioning_failed' || installationStatus === 'error') {
        return 'error';
    }
    return 'not_connected';
}

function projectRelySettings(settings) {
    if (!isPlainObject(settings)) return {};

    const projected = {};
    const zone = isPlainObject(settings.zone) ? settings.zone : {};
    if (typeof zone.mode === 'string') projected.zone_mode = zone.mode;
    if (Array.isArray(zone.custom_zips)) projected.zip_count = zone.custom_zips.length;
    if (Array.isArray(settings.unit_types)) {
        projected.unit_types = settings.unit_types.filter(value => typeof value === 'string');
    }
    if (Array.isArray(settings.brands)) {
        projected.brands = settings.brands.filter(value => typeof value === 'string');
    }
    return projected;
}

function projectAllowlistedSettings(appKey, settings) {
    if (!isPlainObject(settings)) return {};
    if (appKey === 'rely-leads') return projectRelySettings(settings);

    const projected = {};
    for (const key of SETTINGS_ALLOWLIST[appKey] || []) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
        const value = settings[key];
        if (SLOT_KEYS.includes(key) && typeof value === 'number' && Number.isFinite(value)) {
            projected[key] = value;
        } else if (key === 'provider' && typeof value === 'string') {
            projected[key] = value;
        } else if ((key === 'enabled' || key === 'assistant_configured')
            && typeof value === 'boolean') {
            projected[key] = value;
        }
    }
    return projected;
}

function isSlotEngine(appKey) {
    return appKey === 'smart-slot-engine' || appKey === 'slot-engine';
}

async function getServiceConfig(companyId) {
    const rows = await marketplaceQueries.getAppConnectionSnapshot(companyId);
    const needsSlotSettings = rows.some(row => (
        isSlotEngine(row.app_key) && normalizeStatus(row.installation_status) === 'connected'
    ));
    const slotSettings = needsSlotSettings
        ? await slotEngineSettingsQueries.getByCompany(companyId)
        : null;

    return rows.map((row) => {
        const status = normalizeStatus(row.installation_status);
        const configured = status === 'connected';
        let settings = {};
        if (configured) {
            settings = projectAllowlistedSettings(
                row.app_key,
                isSlotEngine(row.app_key) ? slotSettings : row.installation_settings
            );
        }
        return {
            app_key: row.app_key,
            name: row.name,
            category: row.category,
            status,
            configured,
            settings,
        };
    });
}

module.exports = { getServiceConfig };
