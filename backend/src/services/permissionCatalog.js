/**
 * Permission Catalog — RBAC-ROLES-EDITOR-001 (RBAC-AUDIT-001 R4)
 *
 * Single runtime source of the human-readable permission grid for the in-app
 * "Roles & Access" editor. Covers every seeded permission key from:
 *   - 050_seed_role_configs.sql   (the base 50 keys)
 *   - 074_add_fsm_permissions.sql (fsm.viewer/editor/publisher/override)
 *   - 118_add_stripe_collection_permissions.sql (payments.collect_keyed/terminal)
 *   - 136_extend_tasks_for_crm_entities.sql (tasks.view/create/manage)
 *
 * Grouped per the RBAC audit categories. Keep this in sync with the seed
 * migrations so the matrix rows always match the keys the resolver understands.
 *
 * `PERMISSION_CATALOG` — ordered `[{ category, items: [{ key, label }] }]`.
 * `ALL_PERMISSION_KEYS` — flat array of every key (validation allowlist).
 */

const PERMISSION_CATALOG = [
    {
        category: 'Governance',
        items: [
            { key: 'tenant.company.view', label: 'View company settings' },
            { key: 'tenant.company.manage', label: 'Manage company settings' },
            { key: 'tenant.users.view', label: 'View users' },
            { key: 'tenant.users.manage', label: 'Manage users' },
            { key: 'tenant.roles.view', label: 'View roles & access' },
            { key: 'tenant.roles.manage', label: 'Manage roles & access' },
            { key: 'tenant.integrations.manage', label: 'Manage integrations' },
            { key: 'tenant.telephony.manage', label: 'Manage telephony' },
        ],
    },
    {
        category: 'Dashboard',
        items: [
            { key: 'dashboard.view', label: 'View dashboard' },
            { key: 'pulse.view', label: 'View Pulse' },
        ],
    },
    {
        category: 'Messaging',
        items: [
            { key: 'messages.view_internal', label: 'View internal messages' },
            { key: 'messages.view_client', label: 'View client messages' },
            { key: 'messages.send', label: 'Send messages' },
        ],
    },
    {
        category: 'Contacts & Leads',
        items: [
            { key: 'contacts.view', label: 'View contacts' },
            { key: 'contacts.edit', label: 'Edit contacts' },
            { key: 'leads.view', label: 'View leads' },
            { key: 'leads.create', label: 'Create leads' },
            { key: 'leads.edit', label: 'Edit leads' },
            { key: 'leads.convert', label: 'Convert leads' },
        ],
    },
    {
        category: 'Jobs & Schedule',
        items: [
            { key: 'jobs.view', label: 'View jobs' },
            { key: 'jobs.create', label: 'Create jobs' },
            { key: 'jobs.edit', label: 'Edit jobs' },
            { key: 'jobs.assign', label: 'Assign jobs' },
            { key: 'jobs.close', label: 'Close jobs' },
            { key: 'jobs.done_pending_approval', label: 'Mark job done (pending approval)' },
            { key: 'schedule.view', label: 'View schedule' },
            { key: 'schedule.dispatch', label: 'Dispatch on schedule' },
        ],
    },
    {
        category: 'Tasks',
        items: [
            { key: 'tasks.view', label: 'View tasks' },
            { key: 'tasks.create', label: 'Create tasks' },
            { key: 'tasks.manage', label: 'Manage all tasks' },
        ],
    },
    {
        category: 'Financial',
        items: [
            { key: 'financial_data.view', label: 'View financial data' },
            { key: 'estimates.view', label: 'View estimates' },
            { key: 'estimates.create', label: 'Create estimates' },
            { key: 'estimates.send', label: 'Send estimates' },
            { key: 'invoices.view', label: 'View invoices' },
            { key: 'invoices.create', label: 'Create invoices' },
            { key: 'invoices.send', label: 'Send invoices' },
            { key: 'payments.view', label: 'View payments' },
            { key: 'payments.collect_online', label: 'Collect payment online' },
            { key: 'payments.collect_offline', label: 'Collect payment offline' },
            { key: 'payments.collect_keyed', label: 'Collect payment (keyed card)' },
            { key: 'payments.collect_terminal', label: 'Collect payment (terminal / Tap to Pay)' },
            { key: 'payments.refund', label: 'Refund payments' },
        ],
    },
    {
        category: 'Reports',
        items: [
            { key: 'reports.dashboard.view', label: 'View reports dashboard' },
            { key: 'reports.jobs.view', label: 'View jobs reports' },
            { key: 'reports.leads.view', label: 'View leads reports' },
            { key: 'reports.calls.view', label: 'View calls reports' },
            { key: 'reports.payments.view', label: 'View payments reports' },
            { key: 'reports.financial.view', label: 'View financial reports' },
        ],
    },
    {
        category: 'Field & Other',
        items: [
            { key: 'provider.enabled', label: 'Field provider access' },
            { key: 'phone_calls.use', label: 'Make phone calls' },
            { key: 'call_masking.use', label: 'Use call masking' },
            { key: 'gps_tracking.view', label: 'View GPS tracking' },
            { key: 'gps_tracking.collect', label: 'Collect GPS location' },
            { key: 'client_job_history.view', label: 'View client job history' },
        ],
    },
    {
        category: 'FSM',
        items: [
            { key: 'fsm.viewer', label: 'View workflows' },
            { key: 'fsm.editor', label: 'Edit workflows' },
            { key: 'fsm.publisher', label: 'Publish workflows' },
            { key: 'fsm.override', label: 'Override workflow transitions' },
        ],
    },
];

const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap(group => group.items.map(item => item.key));

module.exports = {
    PERMISSION_CATALOG,
    ALL_PERMISSION_KEYS,
};
