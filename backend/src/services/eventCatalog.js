/**
 * eventCatalog.js — AUTO-001.
 *
 * Stable catalog of domain event types, rule action types and agent types,
 * surfaced to the rules editor (GET /api/automation/catalog). Sample fields
 * drive template-autocomplete and the condition-builder field picker.
 */

const { ACTION_TYPES } = require('./ruleActions');

const EVENT_TYPES = [
    { key: 'job.status_changed', label: 'Job status changed', sample_fields: ['id', 'from', 'to', 'contact_id', 'customer_name', 'customer_phone', 'service_name'] },
    { key: 'job.created', label: 'Job created', sample_fields: ['id', 'contact_id', 'service_name', 'customer_phone'] },
    { key: 'lead.created', label: 'Lead created', sample_fields: ['id', 'first_name', 'last_name', 'phone', 'job_type'] },
    { key: 'lead.status_changed', label: 'Lead status changed', sample_fields: ['id', 'from', 'to', 'phone'] },
    { key: 'call.completed', label: 'Call completed', sample_fields: ['call_sid', 'from', 'to', 'duration_sec', 'contact_id'] },
    { key: 'call.missed', label: 'Call missed', sample_fields: ['call_sid', 'from', 'to', 'contact_id', 'timeline_id'] },
    { key: 'sms.inbound', label: 'SMS received', sample_fields: ['from', 'to', 'body', 'contact_id', 'timeline_id'] },
    { key: 'sms.outbound', label: 'SMS sent', sample_fields: ['from', 'to', 'body', 'contact_id'] },
    { key: 'provider.assigned', label: 'Provider assigned to job', sample_fields: ['job_id', 'provider_user_id', 'provider_name', 'provider_phone'] },
    { key: 'payment.succeeded', label: 'Payment succeeded', sample_fields: ['amount', 'contact_id', 'invoice_id'] },
    { key: 'invoice.payment_failed', label: 'Invoice payment failed', sample_fields: ['invoice_id', 'amount'] },
    { key: 'subscription.past_due', label: 'Subscription past due', sample_fields: ['subscription_id', 'status'] },
    { key: 'agent_task.succeeded', label: 'Agent task succeeded', sample_fields: ['task_id', 'agent_type'] },
    { key: 'agent_task.failed', label: 'Agent task failed', sample_fields: ['task_id', 'agent_type', 'error'] },
    // TASKS-COUNT-BADGE-001: coarse, PII-free open-task-count ping. Carries ONLY
    // company_id — clients refetch their own scoped /api/tasks/count on it.
    { key: 'task.changed', label: 'Open-task count changed', sample_fields: ['company_id'] },
];

// Param hints per action type for the editor (label + which params it expects)
const ACTION_PARAM_HINTS = {
    send_sms: { to: 'phone (template)', from: 'proxy number (optional)', body: 'message (template)' },
    send_email: { to: 'email (template)', subject: 'subject (template)', body: 'body (template)' },
    create_task: { title: 'title (template)', description: 'description', priority: 'p1|p2|p3', due_at: 'ISO', owner_user_id: 'uuid' },
    assign_task: { task_id: 'id', owner_user_id: 'uuid' },
    set_action_required: { timeline_id: 'id (optional)', reason: 'text' },
    fsm_transition: { job_id: 'id (optional)', target_status: 'status' },
    run_agent_task: { agent_type: 'agent type', title: 'title', input: 'object' },
    webhook: { url: 'https URL', method: 'POST|GET', headers: 'object', body: 'object' },
};

const AGENT_TYPES = [
    { type: 'mcp_tool', label: 'Run an MCP tool', input_hint: { tool: 'tool name', args: 'object' } },
    { type: 'summarize_thread', label: 'Summarize a conversation', input_hint: { timeline_id: 'id' } },
    { type: 'noop', label: 'No-op (testing)', input_hint: {} },
];

function getCatalog() {
    return {
        event_types: EVENT_TYPES,
        action_types: ACTION_TYPES.map(type => ({ type, params: ACTION_PARAM_HINTS[type] || {} })),
        agent_types: AGENT_TYPES,
    };
}

const EVENT_TYPE_KEYS = EVENT_TYPES.map(e => e.key);
const AGENT_TYPE_KEYS = AGENT_TYPES.map(a => a.type);

module.exports = { getCatalog, EVENT_TYPES, AGENT_TYPES, EVENT_TYPE_KEYS, AGENT_TYPE_KEYS };
