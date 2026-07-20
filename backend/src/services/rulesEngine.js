/**
 * rulesEngine.js — declarative automation (ADR-001 §2.2).
 *
 * Rules are stored in `automation_rules` and edited in the UI. On each domain
 * event the engine finds matching enabled rules, evaluates conditions, and
 * runs the ordered actions. Scheduled (timer) rules enqueue into
 * `automation_scheduled_jobs`, fired by the scheduler tick.
 *
 * Idempotency: one run per (event, rule) via dedupe_key.
 */

const db = require('../db/connection');
const actions = require('./ruleActions');
const schedulerRegistry = require('./schedulerRegistry');
require('./inspectorScheduler').registerScheduler(schedulerRegistry);

// ── Condition evaluation: {all|any: [{field, op, value}]} over a context ─────

function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const OPS = {
    eq: (a, b) => a === b,
    ne: (a, b) => a !== b,
    in: (a, b) => Array.isArray(b) && b.includes(a),
    nin: (a, b) => Array.isArray(b) && !b.includes(a),
    contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
    gt: (a, b) => Number(a) > Number(b),
    lt: (a, b) => Number(a) < Number(b),
    exists: (a) => a !== undefined && a !== null && a !== '',
    truthy: (a) => !!a,
};

function evaluateConditions(conditions, context) {
    if (!conditions || Object.keys(conditions).length === 0) return true;
    const clauses = conditions.all || conditions.any || [];
    if (clauses.length === 0) return true;
    const test = (c) => {
        const fn = OPS[c.op];
        if (!fn) return false;
        return fn(getPath(context, c.field), c.value);
    };
    return conditions.any ? clauses.some(test) : clauses.every(test);
}

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * Handle a domain event: run matching event-triggered rules; enqueue delayed
 * (schedule-after-event) rules.
 */
async function onEvent(event) {
    const { rows: rules } = await db.query(
        `SELECT * FROM automation_rules
         WHERE company_id = $1 AND enabled = true
           AND ((trigger_kind = 'event' AND event_type = $2)
             OR (trigger_kind = 'schedule' AND delay_after_event_type = $2))`,
        [event.company_id, event.event_type]
    );
    for (const rule of rules) {
        const context = buildContext(event);
        if (!evaluateConditions(rule.conditions, context)) continue;

        if (rule.trigger_kind === 'schedule' && rule.delay_after_event_type) {
            await enqueueDelayed(rule, event, context);
        } else {
            await runRule(rule, event, context);
        }
    }
}

function buildContext(event) {
    return {
        event: { type: event.event_type, at: event.created_at },
        company_id: event.company_id,
        actor: { type: event.actor_type, id: event.actor_id },
        ...event.payload, // job / lead / contact / call … fields at top level
    };
}

async function enqueueDelayed(rule, event, context) {
    const dedupe = `sched:${rule.id}:${event.id ?? JSON.stringify(context).length}`;
    const fireAt = new Date(Date.now() + (rule.delay_seconds || 0) * 1000);
    await db.query(
        `INSERT INTO automation_scheduled_jobs (rule_id, company_id, fire_at, context, dedupe_key)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [rule.id, rule.company_id, fireAt, JSON.stringify(context), dedupe]
    );
}

/** Execute a rule's actions, recording an automation_rule_runs row. */
async function runRule(rule, event, context, { dedupeKey } = {}) {
    const dedupe = dedupeKey || (event?.id ? `run:${rule.id}:${event.id}` : null);
    const { rows: runRows } = await db.query(
        `INSERT INTO automation_rule_runs (rule_id, company_id, event_id, dedupe_key, status, started_at)
         VALUES ($1,$2,$3,$4,'pending',now())
         ${dedupe ? 'ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING' : ''}
         RETURNING id`,
        [rule.id, rule.company_id, event?.id || null, dedupe]
    );
    if (!runRows[0]) return { skipped: true }; // already ran (dedupe)
    const runId = runRows[0].id;

    const results = [];
    let failed = false;
    for (const action of (rule.actions || [])) {
        try {
            const out = await actions.execute(action, { rule, context, companyId: rule.company_id });
            results.push({ type: action.type, ok: true, ...out });
        } catch (err) {
            failed = true;
            results.push({ type: action.type, ok: false, error: err.message?.slice(0, 300) });
            break; // stop on first failure (rule actions are an ordered pipeline)
        }
    }

    await db.query(
        `UPDATE automation_rule_runs
         SET status = $2, actions_result = $3::jsonb, error_text = $4, finished_at = now()
         WHERE id = $1`,
        [runId, failed ? 'failed' : 'succeeded', JSON.stringify(results),
         failed ? results.find(r => !r.ok)?.error || 'action failed' : null]
    );
    return { runId, failed, results };
}

/** Scheduler tick: fire due delayed jobs + cron rules. Call from a timer. */
async function tickScheduler(now = new Date()) {
    // 1. Delayed (after-event) jobs that are due
    const { rows: due } = await db.query(
        `UPDATE automation_scheduled_jobs SET status = 'fired'
         WHERE id IN (
            SELECT id FROM automation_scheduled_jobs
            WHERE status = 'pending' AND fire_at <= $1
            ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [now]
    );
    let fired = 0;
    for (const job of due) {
        const { rows: ruleRows } = await db.query(
            'SELECT * FROM automation_rules WHERE id = $1 AND enabled = true', [job.rule_id]
        );
        if (!ruleRows[0]) continue;
        await runRule(ruleRows[0], null, job.context, { dedupeKey: `schedrun:${job.id}` });
        fired++;
    }
    const schedulers = await schedulerRegistry.tick(now);
    return { fired, schedulers };
}

module.exports = { onEvent, runRule, tickScheduler, evaluateConditions, buildContext, _OPS: OPS };
