/**
 * ruleActions.js — action executors for the rules engine (ADR-001 §2.2).
 *
 * Each action type maps to a provider. Params support {{path}} template
 * interpolation against the rule context (event payload + entity fields).
 * Adding an action type = adding one entry to REGISTRY — no engine changes.
 */

const db = require('../db/connection');

// ── Template interpolation ───────────────────────────────────────────────────

function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function render(template, context) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
        const v = getPath(context, path);
        return v === undefined || v === null ? '' : String(v);
    });
}

function renderParams(params, context) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) {
        out[k] = typeof v === 'string' ? render(v, context) : v;
    }
    return out;
}

// ── Action registry ──────────────────────────────────────────────────────────

const REGISTRY = {
    // SMS to a phone resolved from params.to (template, e.g. {{contact.phone}})
    async send_sms({ params, companyId }) {
        const conversationsService = require('./conversationsService');
        const to = params.to;
        const proxy = params.from || process.env.SOFTPHONE_CALLER_ID;
        if (!to) throw new Error('send_sms requires "to"');
        const conv = await conversationsService.getOrCreateConversation(to, proxy, companyId);
        const msg = await conversationsService.sendMessage(conv.id, { body: params.body || '', author: 'automation' });
        return { conversation_id: conv.id, message_sid: msg?.twilio_message_sid || null };
    },

    async send_email({ params, companyId }) {
        const emailService = require('./emailService');
        if (!params.to || !params.subject) throw new Error('send_email requires "to" and "subject"');
        await emailService.sendEmail(companyId, {
            to: params.to, subject: params.subject, body: params.body || '',
            userId: null, userEmail: null,
        });
        return { to: params.to };
    },

    async create_task({ params, companyId, context }) {
        const queries = require('../db/queries');
        // sla_minutes → relative due date (carries the legacy AR task_sla_minutes
        // faithfully). An explicit due_at always wins.
        let dueAt = params.due_at || null;
        if (!dueAt && params.sla_minutes != null) {
            const mins = parseInt(params.sla_minutes, 10);
            if (Number.isFinite(mins) && mins > 0) dueAt = new Date(Date.now() + mins * 60000).toISOString();
        }
        const task = await queries.createTask({
            companyId,
            threadId: params.thread_id || context.timeline_id || null,
            subjectType: params.subject_type || 'contact',
            subjectId: params.subject_id || context.contact_id || null,
            title: params.title || 'Automated task',
            description: params.description || null,
            priority: params.priority || 'p2',
            dueAt,
            ownerUserId: params.owner_user_id || null,
            createdBy: 'automation',
        });
        return { task_id: task?.id };
    },

    async set_action_required({ context, companyId, params }) {
        const queries = require('../db/queries');
        const timelineId = params.timeline_id || context.timeline_id;
        if (!timelineId) throw new Error('set_action_required needs a timeline');
        await queries.setActionRequired(timelineId, params.reason || 'automation', 'automation');
        return { timeline_id: timelineId };
    },

    async fsm_transition({ params, companyId, context }) {
        const jobsService = require('./jobsService');
        const jobId = params.job_id || context.id;
        if (!jobId || !params.target_status) throw new Error('fsm_transition needs job_id + target_status');
        await jobsService.updateBlancStatus(parseInt(jobId, 10), params.target_status, companyId);
        return { job_id: jobId, status: params.target_status };
    },

    // Queue an agent task (ADR-001 §2.3) — executed by the agent worker
    async run_agent_task({ params, companyId, context, rule }) {
        const { rows } = await db.query(
            `INSERT INTO tasks (company_id, kind, agent_type, agent_input, agent_status,
                                title, status, created_by, source_rule_id, thread_id, subject_type)
             VALUES ($1, 'agent', $2, $3::jsonb, 'queued', $4, 'open', 'automation', $5, $6, 'contact')
             RETURNING id`,
            [companyId, params.agent_type || 'generic',
             JSON.stringify({ ...(params.input || {}), context }),
             params.title || `Agent: ${params.agent_type || 'task'}`,
             rule?.id || null, context.timeline_id || null]
        );
        return { agent_task_id: rows[0].id };
    },

    // Fire an outbound webhook to a tenant-configured URL (marketplace devs)
    async webhook({ params }) {
        if (!params.url) throw new Error('webhook requires "url"');
        const res = await fetch(params.url, {
            method: params.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(params.headers || {}) },
            body: JSON.stringify(params.body || {}),
        });
        return { status: res.status };
    },
};

const ACTION_TYPES = Object.keys(REGISTRY);

/**
 * Execute one action against the rule context.
 * @param {{type:string, params:object}} action
 */
async function execute(action, { rule, context, companyId }) {
    const fn = REGISTRY[action.type];
    if (!fn) throw new Error(`Unknown action type: ${action.type}`);
    const params = renderParams(action.params || {}, context);
    return fn({ params, rule, context, companyId });
}

module.exports = { execute, render, renderParams, ACTION_TYPES };
