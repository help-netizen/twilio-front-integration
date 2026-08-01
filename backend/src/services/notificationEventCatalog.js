'use strict';

/**
 * NOTIF-REWORK-001 notification event catalog.
 *
 * This ordered, versioned allowlist is the only source of notification policy
 * keys. Internal routing/scope fields never come from an API request. The
 * public projection is deliberately exact so the settings UI can render it
 * without learning backend recipient rules.
 */

const NOTIFICATION_CATALOG_VERSION = 1;

const ROLES = Object.freeze({
    ALL: Object.freeze(['tenant_admin', 'manager', 'dispatcher', 'provider']),
    OFFICE: Object.freeze(['tenant_admin', 'manager', 'dispatcher']),
    ADMIN_MANAGER: Object.freeze(['tenant_admin', 'manager']),
    ADMIN: Object.freeze(['tenant_admin']),
});

// M1.T2 must not advertise producer work that is scheduled for M1.T4.
const CURRENT_PRODUCERS = new Set([
    'lead.created',
    'job.created',
    'job.status_changed',
    'sms.inbound',
    'agent_task.failed',
]);

function item({
    event_type,
    category,
    label,
    description,
    default_enabled,
    required_permission,
    default_audience_summary,
    record_scope,
    supported_channels,
    default_role_keys,
    source_event_type = event_type,
    source_predicate = null,
}) {
    return Object.freeze({
        event_type,
        category,
        label,
        description,
        default_enabled,
        required_permission,
        default_audience_summary,
        supported_channels: Object.freeze([...supported_channels]),
        producer_available: CURRENT_PRODUCERS.has(event_type),
        source_event_type,
        source_predicate,
        record_scope,
        default_role_keys: Object.freeze([...default_role_keys]),
    });
}

const B = Object.freeze(['browser_push']);
const BN = Object.freeze(['browser_push', 'native_push']);

const NOTIFICATION_EVENT_CATALOG = Object.freeze([
    item({ event_type: 'lead.created', category: 'Leads', label: 'New lead', description: 'A new lead was created.', default_enabled: true, required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', supported_channels: B, default_role_keys: ROLES.OFFICE }),
    item({ event_type: 'lead.assigned', category: 'Leads', label: 'Lead assigned', description: 'A lead was assigned to an office user.', default_enabled: true, required_permission: 'leads.view', default_audience_summary: 'Assignee and office roles', record_scope: 'office_only_lead_with_assignee', supported_channels: B, default_role_keys: ROLES.OFFICE }),
    item({ event_type: 'lead.unassigned', category: 'Leads', label: 'Lead unassigned', description: 'An office user was removed from a lead.', default_enabled: true, required_permission: 'leads.view', default_audience_summary: 'Removed assignee and office roles', record_scope: 'office_only_lead_with_previous_recipient', supported_channels: B, default_role_keys: ROLES.OFFICE }),
    item({ event_type: 'lead.review_required', category: 'Leads', label: 'Lead needs review', description: 'A lead entered Review and needs a human decision.', default_enabled: true, required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', supported_channels: B, default_role_keys: ROLES.OFFICE }),
    item({ event_type: 'lead.converted', category: 'Leads', label: 'Lead converted', description: 'A lead was converted to a job.', default_enabled: true, required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', supported_channels: B, default_role_keys: ROLES.OFFICE }),
    item({ event_type: 'lead.status_changed', category: 'Leads', label: 'Other lead status changes', description: 'A routine lead status changed.', default_enabled: false, required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', supported_channels: B, default_role_keys: ROLES.OFFICE, source_predicate: 'exclude_review_and_converted' }),
    item({ event_type: 'lead.updated', category: 'Leads', label: 'Lead updated', description: 'Lead details changed.', default_enabled: false, required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', supported_channels: B, default_role_keys: ROLES.OFFICE }),

    item({ event_type: 'job.created', category: 'Jobs & schedule', label: 'Job created', description: 'A new job was created.', default_enabled: false, required_permission: 'jobs.view', default_audience_summary: 'Office roles; assigned providers when present', record_scope: 'job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'job.assigned', category: 'Jobs & schedule', label: 'Job assigned', description: 'A provider was assigned to a job.', default_enabled: true, required_permission: 'jobs.view', default_audience_summary: 'Office roles and newly assigned provider', record_scope: 'job_assignment_with_added_recipients', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'job.unassigned', category: 'Jobs & schedule', label: 'Job unassigned', description: 'A provider was removed from a job.', default_enabled: true, required_permission: 'jobs.view', default_audience_summary: 'Office roles and removed provider', record_scope: 'job_assignment_with_previous_recipient', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'job.rescheduled', category: 'Jobs & schedule', label: 'Job rescheduled', description: "A job's appointment window changed.", default_enabled: true, required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'job.status_changed', category: 'Jobs & schedule', label: 'Important job status change', description: 'A job moved to On the way, Waiting for parts, Part arrived, Visit completed, Job is Done, or Canceled.', default_enabled: true, required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL, source_predicate: 'important_target_status' }),
    item({ event_type: 'job.updated', category: 'Jobs & schedule', label: 'Other job updates', description: 'Non-critical job details changed.', default_enabled: false, required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'job.sync_completed', category: 'Jobs & schedule', label: 'Job sync completed', description: 'A job sync completed successfully.', default_enabled: false, required_permission: 'jobs.view', default_audience_summary: 'Admins and managers', record_scope: 'office_only_job', supported_channels: B, default_role_keys: ROLES.ADMIN_MANAGER }),

    item({ event_type: 'sms.inbound', category: 'Messages & calls', label: 'New text message', description: 'A customer sent an inbound SMS.', default_enabled: true, required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'email.inbound', category: 'Messages & calls', label: 'New email', description: 'A customer sent an inbound email.', default_enabled: true, required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'yelp.message_received', category: 'Messages & calls', label: 'New Yelp message', description: 'A customer sent a Yelp message.', default_enabled: true, required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'call.inbound_started', category: 'Messages & calls', label: 'Incoming call', description: 'An inbound customer call started.', default_enabled: false, required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'call.missed', category: 'Messages & calls', label: 'Missed call', description: 'An inbound call reached a terminal unanswered outcome.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'call.voicemail_received', category: 'Messages & calls', label: 'Voicemail received', description: 'A caller left a voicemail.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'call.completed', category: 'Messages & calls', label: 'Call completed', description: 'A customer call completed.', default_enabled: false, required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'sms.outbound', category: 'Messages & calls', label: 'Text message sent', description: 'A staff-authored SMS was sent.', default_enabled: false, required_permission: 'messages.view_client', default_audience_summary: 'Initiating user and permitted office roles', record_scope: 'actor_and_active_contact', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'message.delivery_failed', category: 'Messages & calls', label: 'Message delivery failed', description: 'A customer message could not be delivered.', default_enabled: true, required_permission: 'messages.send', default_audience_summary: 'Initiating user and permitted office roles', record_scope: 'actor_and_active_contact', supported_channels: BN, default_role_keys: ROLES.ALL }),

    item({ event_type: 'ai_call.booked', category: 'AI outcomes', label: 'AI call booked', description: 'An AI call produced a tentative booking or human-review outcome.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'ai_call.declined', category: 'AI outcomes', label: 'AI call declined or needs handoff', description: 'A customer declined or requested human follow-up.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'ai_call.exhausted', category: 'AI outcomes', label: 'AI call attempts exhausted', description: 'The AI call retry ladder ended without resolution.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'ai_call.failed', category: 'AI outcomes', label: 'AI call failed', description: 'An AI call ended in a hard operational failure.', default_enabled: true, required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'ai_call.retry_scheduled', category: 'AI outcomes', label: 'AI call retry scheduled', description: 'A transient outcome scheduled another attempt.', default_enabled: false, required_permission: 'pulse.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'lead_office_or_job_assignment', supported_channels: B, default_role_keys: ROLES.OFFICE }),

    item({ event_type: 'estimate.client_accepted', category: 'Estimates, invoices & payments', label: 'Estimate accepted', description: 'A client accepted an estimate.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'estimate.client_declined', category: 'Estimates, invoices & payments', label: 'Estimate declined', description: 'A client declined an estimate.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'estimate.send_failed', category: 'Estimates, invoices & payments', label: 'Estimate delivery failed', description: 'An estimate could not be sent.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'estimate.sent', category: 'Estimates, invoices & payments', label: 'Estimate sent', description: 'An estimate was sent to a client.', default_enabled: false, required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'estimate.viewed', category: 'Estimates, invoices & payments', label: 'Estimate viewed', description: 'A client viewed an estimate.', default_enabled: false, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'invoice.send_failed', category: 'Estimates, invoices & payments', label: 'Invoice delivery failed', description: 'An invoice could not be sent.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'invoice.sent', category: 'Estimates, invoices & payments', label: 'Invoice sent', description: 'An invoice was sent to a client.', default_enabled: false, required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'invoice.viewed', category: 'Estimates, invoices & payments', label: 'Invoice viewed', description: 'A client viewed an invoice.', default_enabled: false, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'invoice.voided', category: 'Estimates, invoices & payments', label: 'Invoice voided', description: 'An invoice was voided.', default_enabled: false, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'payment.succeeded', category: 'Estimates, invoices & payments', label: 'Payment received', description: 'A customer payment succeeded or was recorded.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'payment.failed', category: 'Estimates, invoices & payments', label: 'Payment failed', description: 'A customer payment failed.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'payment.disputed', category: 'Estimates, invoices & payments', label: 'Payment disputed', description: 'A customer payment was disputed.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'payment.refunded', category: 'Estimates, invoices & payments', label: 'Payment refunded', description: 'A customer payment was refunded.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'payment.voided', category: 'Estimates, invoices & payments', label: 'Payment voided', description: 'A recorded customer payment was voided.', default_enabled: true, required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent', supported_channels: BN, default_role_keys: ROLES.ALL }),

    item({ event_type: 'task.assigned', category: 'Tasks', label: 'Task assigned', description: 'A task was assigned to a user.', default_enabled: true, required_permission: 'tasks.view', default_audience_summary: 'Task owner; task managers for unassigned work', record_scope: 'task_owner_author_or_manager', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'task.reassigned', category: 'Tasks', label: 'Task reassigned', description: 'Task ownership changed.', default_enabled: true, required_permission: 'tasks.view', default_audience_summary: 'New owner, removed owner minimally, and task managers', record_scope: 'task_owner_author_or_previous_recipient', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'task.due', category: 'Tasks', label: 'Task due soon', description: 'A task reached its configured due-soon window.', default_enabled: true, required_permission: 'tasks.view', default_audience_summary: 'Task owner and task managers', record_scope: 'task_owner_author_or_manager', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'task.overdue', category: 'Tasks', label: 'Task overdue', description: 'An open task passed its due time.', default_enabled: true, required_permission: 'tasks.view', default_audience_summary: 'Task owner and task managers', record_scope: 'task_owner_author_or_manager', supported_channels: BN, default_role_keys: ROLES.ALL }),
    item({ event_type: 'task.completed', category: 'Tasks', label: 'Task completed', description: 'A task was completed.', default_enabled: false, required_permission: 'tasks.view', default_audience_summary: 'Task owner, author, and task managers', record_scope: 'task_owner_author_or_manager', supported_channels: BN, default_role_keys: ROLES.ALL }),

    item({ event_type: 'review.received', category: 'Reviews', label: 'Review received', description: 'A customer submitted a job/provider review.', default_enabled: true, required_permission: 'jobs.view', default_audience_summary: 'Office roles and providers assigned to the reviewed job', record_scope: 'rated_job_assignment', supported_channels: BN, default_role_keys: ROLES.ALL }),

    item({ event_type: 'agent_task.failed', category: 'System & billing', label: 'Automation task failed', description: 'An internal agent task failed and needs administrator attention.', default_enabled: true, required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only', supported_channels: B, default_role_keys: ROLES.ADMIN }),
    item({ event_type: 'integration.delivery_failed', category: 'System & billing', label: 'Integration delivery failed', description: 'A configured integration could not deliver or synchronize required data.', default_enabled: true, required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only', supported_channels: B, default_role_keys: ROLES.ADMIN }),
    item({ event_type: 'sync.completed', category: 'System & billing', label: 'Sync completed', description: 'A background integration sync completed successfully.', default_enabled: false, required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only', supported_channels: B, default_role_keys: ROLES.ADMIN }),
    item({ event_type: 'billing.subscription_past_due', category: 'System & billing', label: 'Albusto subscription past due', description: "The company's Albusto subscription requires attention.", default_enabled: true, required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only', supported_channels: B, default_role_keys: ROLES.ADMIN }),
    item({ event_type: 'billing.invoice_payment_failed', category: 'System & billing', label: 'Albusto billing payment failed', description: "Payment for the company's Albusto invoice failed.", default_enabled: true, required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only', supported_channels: B, default_role_keys: ROLES.ADMIN }),
    item({ event_type: 'contact.updated', category: 'System & billing', label: 'Contact updated', description: 'Contact details changed.', default_enabled: false, required_permission: 'contacts.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact', supported_channels: BN, default_role_keys: ROLES.ALL }),
]);

const CATALOG_BY_EVENT_TYPE = new Map(
    NOTIFICATION_EVENT_CATALOG.map(entry => [entry.event_type, entry])
);

function getNotificationCatalogEntry(eventType) {
    return CATALOG_BY_EVENT_TYPE.get(eventType) || null;
}

function toPublicCatalogItem(entry) {
    return {
        event_type: entry.event_type,
        category: entry.category,
        label: entry.label,
        description: entry.description,
        default_enabled: entry.default_enabled,
        required_permission: entry.required_permission,
        default_audience_summary: entry.default_audience_summary,
        supported_channels: [...entry.supported_channels],
        producer_available: entry.producer_available,
    };
}

function getPublicNotificationEventCatalog() {
    return NOTIFICATION_EVENT_CATALOG.map(toPublicCatalogItem);
}

module.exports = {
    NOTIFICATION_CATALOG_VERSION,
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
    getPublicNotificationEventCatalog,
    toPublicCatalogItem,
};
