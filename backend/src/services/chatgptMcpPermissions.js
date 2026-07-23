'use strict';

const APP_KEY = 'chatgpt-crm-mcp';
const BUNDLE_VERSION = 2;
const READ_SCOPE = 'albusto.mcp.read';

const READ_TOOL_PERMISSIONS = Object.freeze({
    'svc.list_jobs': ['jobs.view'],
    'svc.get_job': ['jobs.view'],
    'svc.get_job_transitions': ['jobs.view'],
    'svc.list_leads': ['leads.view'],
    'svc.get_lead': ['leads.view'],
    'svc.get_lead_transitions': ['leads.view'],
    'svc.search_contacts': ['contacts.view'],
    'svc.get_contact': ['contacts.view'],
    'svc.get_contact_history': ['contacts.view'],
    'svc.list_schedule': ['schedule.view'],
    'svc.list_calls': ['pulse.view'],
    'svc.get_schedule_item': ['schedule.view'],
    'svc.list_tasks': ['tasks.view'],
    'svc.list_entity_tasks': ['tasks.view', 'jobs.view', 'leads.view'],
    'svc.list_task_assignees': ['tasks.view'],
    'svc.list_estimates': ['estimates.view'],
    'svc.get_estimate': ['estimates.view'],
    'svc.list_invoices': ['invoices.view'],
    'svc.get_invoice': ['invoices.view'],
});

const READ_TOOL_NAMES = Object.freeze(Object.keys(READ_TOOL_PERMISSIONS));
const BUSINESS_READ_PERMISSIONS = Object.freeze([
    ...new Set(Object.values(READ_TOOL_PERMISSIONS).flat()),
]);
const EXACT_READ_TOOL_PERMISSIONS = Object.freeze(
    READ_TOOL_NAMES.map((name) => `mcp.tool.${name}`)
);
const S1_GRANTS = Object.freeze([
    ...BUSINESS_READ_PERMISSIONS,
    ...EXACT_READ_TOOL_PERMISSIONS,
]);

module.exports = {
    APP_KEY,
    BUNDLE_VERSION,
    READ_SCOPE,
    READ_TOOL_PERMISSIONS,
    READ_TOOL_NAMES,
    BUSINESS_READ_PERMISSIONS,
    EXACT_READ_TOOL_PERMISSIONS,
    S1_GRANTS,
};
