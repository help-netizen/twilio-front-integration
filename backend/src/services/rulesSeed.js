/**
 * rulesSeed.js — AUTO-001. AR-equivalent system rules.
 *
 * Migrates the hardcoded arConfigHelper triggers (inbound_sms, missed_call)
 * into editable automation rules. Idempotent (is_system unique per name).
 */

const db = require('../db/connection');

const SYSTEM_RULES = [
    {
        name: 'Inbound SMS → Action Required',
        description: 'When a customer texts in, flag the thread and create a P1 task (migrated from AR config).',
        trigger_kind: 'event',
        event_type: 'sms.inbound',
        conditions: {},
        actions: [
            { type: 'set_action_required', params: { reason: 'new_message' } },
            { type: 'create_task', params: { title: 'New message from {{contact_id}}', priority: 'p1' } },
        ],
        enabled: true,
    },
    {
        name: 'Missed call → Task',
        description: 'When an inbound call is missed, create a follow-up task (migrated from AR config).',
        trigger_kind: 'event',
        event_type: 'call.missed',
        conditions: {},
        actions: [
            { type: 'create_task', params: { title: 'Missed call from {{from}}', priority: 'p2' } },
        ],
        enabled: false, // matches the legacy default (missed_call disabled)
    },
];

/** Insert the system rules for a company. Idempotent. Returns inserted count. */
async function seedDefaultRules(companyId) {
    let inserted = 0;
    for (const r of SYSTEM_RULES) {
        const { rowCount } = await db.query(
            `INSERT INTO automation_rules
                (company_id, name, description, enabled, trigger_kind, event_type, conditions, actions, is_system)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,true)
             ON CONFLICT (company_id, name) WHERE is_system = true DO NOTHING`,
            [companyId, r.name, r.description, r.enabled, r.trigger_kind, r.event_type,
             JSON.stringify(r.conditions), JSON.stringify(r.actions)]
        );
        inserted += rowCount;
    }
    return inserted;
}

module.exports = { seedDefaultRules, SYSTEM_RULES };
