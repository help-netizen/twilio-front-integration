/**
 * Action Required Config Helper
 *
 * Loads per-company AR trigger config from company_settings.
 * Used by conversationsService (SMS) and inboxWorker (calls) to decide
 * whether to auto-trigger AR and what priority/SLA to use.
 */
const db = require('../db/connection');

const SETTING_KEY = 'action_required_config';

const DEFAULT_CONFIG = {
    enabled: true,
    triggers: {
        inbound_sms: { enabled: true, create_task: true, task_priority: 'p1', task_sla_minutes: 10 },
        missed_call: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 30 },
        voicemail: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 60 },
    },
};

/**
 * Load AR config for a company, merged with defaults.
 * @param {number|null} companyId
 * @returns {Promise<object>} merged config
 */
async function getARConfig(companyId) {
    if (!companyId) return DEFAULT_CONFIG;
    try {
        const { rows } = await db.query(
            'SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2',
            [companyId, SETTING_KEY]
        );
        const saved = rows.length > 0 ? rows[0].setting_value : {};
        return {
            ...DEFAULT_CONFIG,
            ...saved,
            triggers: {
                ...DEFAULT_CONFIG.triggers,
                ...(saved.triggers || {}),
            },
        };
    } catch (e) {
        console.warn('[ARConfig] Failed to load config, using defaults:', e.message);
        return DEFAULT_CONFIG;
    }
}

/**
 * Check if a specific trigger is enabled.
 * @param {number|null} companyId
 * @param {'inbound_sms'|'missed_call'|'voicemail'} triggerKey
 * @returns {Promise<{enabled: boolean, create_task: boolean, task_priority: string, task_sla_minutes: number}>}
 */
async function getTriggerConfig(companyId, triggerKey) {
    const config = await getARConfig(companyId);
    if (!config.enabled) return { enabled: false, create_task: false, task_priority: 'p2', task_sla_minutes: 30 };
    const trigger = config.triggers?.[triggerKey] || DEFAULT_CONFIG.triggers[triggerKey];
    return trigger || { enabled: false, create_task: false, task_priority: 'p2', task_sla_minutes: 30 };
}

module.exports = { getARConfig, getTriggerConfig, DEFAULT_CONFIG };
