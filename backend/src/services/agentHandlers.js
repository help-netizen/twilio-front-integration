/**
 * agentHandlers.js — AUTO-001. Registry of agent_type → handler.
 *
 * Each handler receives the agent task row and returns an output object
 * (stored in tasks.agent_output). Adding an agent type = one REGISTRY entry.
 */

const db = require('../db/connection');

const HANDLERS = {
    // Echo input — used by templates/tests.
    async noop(task) {
        return { echo: task.agent_input || {} };
    },

    // Run a CRM MCP tool inside the task's tenant context.
    async mcp_tool(task) {
        const input = task.agent_input || {};
        if (!input.tool) throw new Error('mcp_tool requires input.tool');
        const executor = require('./crmMcpToolExecutor');
        // Synthetic request scoped to the task's company (no HTTP request).
        const syntheticReq = {
            companyFilter: { company_id: task.company_id },
            user: { crmUser: { id: null }, email: 'automation@albusto' },
            authz: { permissions: ['tenant.company.manage'], company: {} },
            ip: null,
            headers: {},
        };
        const result = await executor.execute(syntheticReq, input.tool, input.args || {}, input.confirmation || null);
        return { tool: input.tool, result };
    },

    // Summarize a conversation thread (heuristic; LLM provider optional).
    async summarize_thread(task) {
        const input = task.agent_input || {};
        const timelineId = input.timeline_id || task.thread_id;
        if (!timelineId) throw new Error('summarize_thread requires a timeline_id');
        const { rows } = await db.query(
            `SELECT m.author, m.direction, m.body, m.created_at
             FROM sms_messages m
             JOIN sms_conversations c ON c.id = m.conversation_id AND c.company_id = $2
             JOIN timelines t ON regexp_replace(t.phone_e164, '\\D', '', 'g') = regexp_replace(c.customer_e164, '\\D', '', 'g')
             WHERE t.id = $1
             ORDER BY m.created_at DESC LIMIT 20`,
            [timelineId, task.company_id]
        );
        const lines = rows.reverse().map(r => `${r.direction === 'inbound' ? 'Customer' : 'Us'}: ${(r.body || '').slice(0, 120)}`);
        const summary = lines.length
            ? `Last ${lines.length} messages. ${lines.slice(-3).join(' | ')}`
            : 'No messages in this thread.';
        return { timeline_id: timelineId, message_count: rows.length, summary };
    },
};

async function run(task) {
    const handler = HANDLERS[task.agent_type];
    if (!handler) throw new Error(`Unknown agent_type: ${task.agent_type}`);
    return handler(task);
}

module.exports = { run, HANDLERS };
