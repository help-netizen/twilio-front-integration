/**
 * rulesSeed.js — AUTO-001 / ARM-001. AR-equivalent system rules.
 *
 * Translates the legacy arConfigHelper triggers (inbound_sms, missed_call) into
 * editable automation rules. Two entry points share one builder:
 *   - seedDefaultRules: static defaults for a fresh company (bootstrap).
 *   - migrateCompanyARConfig: faithful per-company cutover — reads the company's
 *     real action_required_config (priority/SLA/enabled) so flipping
 *     FEATURE_RULES_ENGINE_AR doesn't silently reset customised behaviour.
 * Idempotent via the (company_id, name) WHERE is_system unique index (mig 102).
 *
 * Note: the legacy `voicemail` trigger has no domain event source yet, so it is
 * intentionally not migrated — there is nothing to react to. Tracked as debt.
 */

const db = require('../db/connection');
const { DEFAULT_CONFIG, getARConfig } = require('./arConfigHelper');

const SMS_RULE = 'Inbound SMS → Action Required';
const CALL_RULE = 'Missed call → Task';

/** Build the system-rule rows that correspond to an AR config object. */
function buildRulesFromConfig(config = DEFAULT_CONFIG) {
    const triggers = config?.triggers || {};
    const sms = triggers.inbound_sms || {};
    const call = triggers.missed_call || {};
    const arEnabled = config?.enabled !== false;

    return [
        {
            name: SMS_RULE,
            description: 'When a customer texts in, flag the thread and create a task (migrated from AR config).',
            trigger_kind: 'event',
            event_type: 'sms.inbound',
            conditions: {},
            actions: [
                { type: 'set_action_required', params: { reason: 'new_message' } },
                { type: 'create_task', params: {
                    title: 'New message from {{contact_id}}',
                    priority: sms.task_priority || 'p1',
                    sla_minutes: sms.task_sla_minutes ?? 10,
                } },
            ],
            enabled: arEnabled && sms.enabled !== false && sms.create_task !== false,
        },
        {
            name: CALL_RULE,
            description: 'When an inbound call is missed, create a follow-up task (migrated from AR config).',
            trigger_kind: 'event',
            event_type: 'call.missed',
            conditions: {},
            actions: [
                { type: 'create_task', params: {
                    title: 'Missed call from {{from}}',
                    priority: call.task_priority || 'p2',
                    sla_minutes: call.task_sla_minutes ?? 30,
                } },
            ],
            enabled: arEnabled && call.enabled === true && call.create_task !== false,
        },
    ];
}

async function upsertRules(companyId, rules, { overwrite }) {
    let n = 0;
    for (const r of rules) {
        const conflict = overwrite
            ? `DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled,
                            conditions = EXCLUDED.conditions, actions = EXCLUDED.actions, updated_at = now()`
            : 'DO NOTHING';
        const { rowCount } = await db.query(
            `INSERT INTO automation_rules
                (company_id, name, description, enabled, trigger_kind, event_type, conditions, actions, is_system)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,true)
             ON CONFLICT (company_id, name) WHERE is_system = true ${conflict}`,
            [companyId, r.name, r.description, r.enabled, r.trigger_kind, r.event_type,
             JSON.stringify(r.conditions), JSON.stringify(r.actions)]
        );
        n += rowCount;
    }
    return n;
}

/** Seed static default system rules for a fresh company. Never clobbers edits. */
async function seedDefaultRules(companyId) {
    return upsertRules(companyId, buildRulesFromConfig(DEFAULT_CONFIG), { overwrite: false });
}

/**
 * Faithful cutover: read the company's real AR config and upsert system rules
 * that reflect it (priority/SLA/enabled). Authoritative — overwrites the
 * system rules so the migrated behaviour matches the legacy path exactly.
 */
async function migrateCompanyARConfig(companyId) {
    const config = await getARConfig(companyId);
    const affected = await upsertRules(companyId, buildRulesFromConfig(config), { overwrite: true });
    return { affected, config_enabled: config?.enabled !== false };
}

module.exports = { seedDefaultRules, migrateCompanyARConfig, buildRulesFromConfig, SMS_RULE, CALL_RULE };
