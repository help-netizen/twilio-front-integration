/**
 * Automation Rules API — ADR-001 §2.2. Tenant-scoped CRUD + run history.
 * Mounted with tenant.company.manage.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { ACTION_TYPES } = require('../services/ruleActions');
const { getCatalog, EVENT_TYPE_KEYS, AGENT_TYPE_KEYS } = require('../services/eventCatalog');
const rulesSeed = require('../services/rulesSeed');

function companyId(req) { return req.companyFilter?.company_id; }

const VALID_TRIGGER = ['event', 'schedule'];

function validate(body) {
    if (!body.name) return 'name is required';
    if (!VALID_TRIGGER.includes(body.trigger_kind)) return 'invalid trigger_kind';
    if (body.trigger_kind === 'event' && !body.event_type) return 'event_type required for event trigger';
    if (body.trigger_kind === 'schedule' && !body.schedule_cron && !body.delay_after_event_type)
        return 'schedule needs schedule_cron or delay_after_event_type';
    if (body.trigger_kind === 'event' && body.event_type && !EVENT_TYPE_KEYS.includes(body.event_type))
        return `unknown event_type: ${body.event_type}`;
    for (const a of (body.actions || [])) {
        if (!ACTION_TYPES.includes(a.type)) return `unknown action type: ${a.type}`;
        if (a.type === 'run_agent_task' && a.params?.agent_type && !AGENT_TYPE_KEYS.includes(a.params.agent_type))
            return `unknown agent_type: ${a.params.agent_type}`;
    }
    return null;
}

// GET /api/automation/rules — list + the action catalog for the editor
router.get('/rules', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT * FROM automation_rules WHERE company_id = $1 ORDER BY created_at DESC`,
            [companyId(req)]
        );
        res.json({ ok: true, rules: rows, action_types: ACTION_TYPES });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to list rules' });
    }
});

// POST /api/automation/rules
router.post('/rules', async (req, res) => {
    const err = validate(req.body || {});
    if (err) return res.status(422).json({ ok: false, code: 'VALIDATION_ERROR', error: err });
    try {
        const b = req.body;
        const { rows } = await db.query(
            `INSERT INTO automation_rules
                (company_id, name, description, enabled, trigger_kind, event_type, schedule_cron,
                 delay_after_event_type, delay_seconds, conditions, actions, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
             RETURNING *`,
            [companyId(req), b.name, b.description || null, b.enabled !== false, b.trigger_kind,
             b.event_type || null, b.schedule_cron || null, b.delay_after_event_type || null,
             b.delay_seconds || null, JSON.stringify(b.conditions || {}), JSON.stringify(b.actions || []),
             req.user?.crmUser?.id || null]
        );
        res.status(201).json({ ok: true, rule: rows[0] });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to create rule' });
    }
});

// PATCH /api/automation/rules/:id
router.patch('/rules/:id', async (req, res) => {
    try {
        const b = req.body || {};
        if (b.actions) {
            for (const a of b.actions) if (!ACTION_TYPES.includes(a.type))
                return res.status(422).json({ ok: false, error: `unknown action type: ${a.type}` });
        }
        const { rows } = await db.query(
            `UPDATE automation_rules SET
                name = COALESCE($3, name),
                description = COALESCE($4, description),
                enabled = COALESCE($5, enabled),
                conditions = COALESCE($6::jsonb, conditions),
                actions = COALESCE($7::jsonb, actions),
                event_type = COALESCE($8, event_type),
                schedule_cron = COALESCE($9, schedule_cron),
                delay_after_event_type = COALESCE($10, delay_after_event_type),
                delay_seconds = COALESCE($11, delay_seconds),
                updated_at = now()
             WHERE id = $1 AND company_id = $2 RETURNING *`,
            [req.params.id, companyId(req), b.name ?? null, b.description ?? null,
             typeof b.enabled === 'boolean' ? b.enabled : null,
             b.conditions ? JSON.stringify(b.conditions) : null,
             b.actions ? JSON.stringify(b.actions) : null,
             b.event_type ?? null, b.schedule_cron ?? null, b.delay_after_event_type ?? null, b.delay_seconds ?? null]
        );
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'Rule not found' });
        res.json({ ok: true, rule: rows[0] });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to update rule' });
    }
});

// DELETE /api/automation/rules/:id
router.delete('/rules/:id', async (req, res) => {
    const { rowCount } = await db.query(
        'DELETE FROM automation_rules WHERE id = $1 AND company_id = $2', [req.params.id, companyId(req)]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Rule not found' });
    res.json({ ok: true });
});

// GET /api/automation/rules/:id/runs — recent execution history
router.get('/rules/:id/runs', async (req, res) => {
    const { rows } = await db.query(
        `SELECT r.* FROM automation_rule_runs r
         JOIN automation_rules ar ON ar.id = r.rule_id AND ar.company_id = $2
         WHERE r.rule_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
        [req.params.id, companyId(req)]
    );
    res.json({ ok: true, runs: rows });
});

// GET /api/automation/catalog — event/action/agent types for the editor
router.get('/catalog', (req, res) => {
    res.json({ ok: true, ...getCatalog() });
});

// POST /api/automation/rules/seed-defaults — create AR-equivalent system rules
router.post('/rules/seed-defaults', async (req, res) => {
    try {
        const inserted = await rulesSeed.seedDefaultRules(companyId(req));
        res.json({ ok: true, inserted });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to seed rules' });
    }
});

// POST /api/automation/rules/migrate-ar — ARM-001 cutover: rebuild the system
// rules from this company's real action_required_config (faithful priority/SLA).
router.post('/rules/migrate-ar', async (req, res) => {
    try {
        const result = await rulesSeed.migrateCompanyARConfig(companyId(req));
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to migrate AR config' });
    }
});

// GET /api/automation/agent-tasks?status= — list agent tasks (company-scoped)
router.get('/agent-tasks', async (req, res) => {
    try {
        const conds = ["company_id = $1", "kind = 'agent'"];
        const params = [companyId(req)];
        if (req.query.status) { conds.push(`agent_status = $${params.length + 1}`); params.push(req.query.status); }
        const { rows } = await db.query(
            `SELECT id, agent_type, agent_status, agent_input, agent_output, source_rule_id, created_at, completed_at
             FROM tasks WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
            params
        );
        res.json({ ok: true, tasks: rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to list agent tasks' });
    }
});

// POST /api/automation/agent-tasks/:id/retry — re-queue a failed agent task
router.post('/agent-tasks/:id/retry', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT agent_status FROM tasks WHERE id = $1 AND company_id = $2 AND kind = 'agent'`,
            [req.params.id, companyId(req)]
        );
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'Agent task not found' });
        if (rows[0].agent_status === 'running')
            return res.status(409).json({ ok: false, error: 'Task is currently running' });
        await db.query(
            `UPDATE tasks SET agent_status = 'queued', status = 'open', agent_output = NULL, completed_at = NULL, updated_at = now()
             WHERE id = $1 AND company_id = $2`,
            [req.params.id, companyId(req)]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to retry' });
    }
});

module.exports = router;
