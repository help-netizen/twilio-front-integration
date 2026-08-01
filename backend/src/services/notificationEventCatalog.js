'use strict';

/**
 * NOTIF-REWORK-001 notification event catalog.
 *
 * This ordered, versioned allowlist is the only source of notifiable event
 * keys. Internal routing/scope fields never come from an API request. The
 * public projection is deliberately exact for diagnostics and future UI use.
 */

const NOTIFICATION_CATALOG_VERSION = 1;

const NOTIFICATION_CATEGORIES = Object.freeze([
    Object.freeze({
        key: 'job_schedule',
        label: 'Job & schedule updates',
        description: 'Job assignments, schedule changes, status updates, and reviews.',
        user_configurable: true,
    }),
    Object.freeze({
        key: 'leads',
        label: 'Leads',
        description: 'New leads, assignments, status changes, and review requests.',
        user_configurable: true,
    }),
    Object.freeze({
        key: 'calls_messages',
        label: 'Calls & messages',
        description: 'Customer calls, messages, delivery failures, and AI-call outcomes.',
        user_configurable: true,
    }),
    Object.freeze({
        key: 'finance',
        label: 'Estimates, invoices & payments',
        description: 'Estimate, invoice, and payment activity you are allowed to access.',
        user_configurable: true,
    }),
    Object.freeze({
        key: 'tasks',
        label: 'Tasks',
        description: 'Task assignments, due dates, overdue alerts, and completions.',
        user_configurable: true,
    }),
    Object.freeze({
        key: 'admin_system',
        label: 'Administration & system',
        description: 'Internal integration, sync, automation, and billing alerts.',
        user_configurable: false,
    }),
]);

const CATEGORY_BY_KEY = new Map(NOTIFICATION_CATEGORIES.map(category => [category.key, category]));

const CURRENT_PRODUCERS = new Set([
    'lead.created',
    'lead.assigned',
    'lead.unassigned',
    'lead.review_required',
    'lead.converted',
    'job.created',
    'job.assigned',
    'job.unassigned',
    'job.rescheduled',
    'job.status_changed',
    'sms.inbound',
    'email.inbound',
    'yelp.message_received',
    'call.missed',
    'call.voicemail_received',
    'message.delivery_failed',
    'ai_call.booked',
    'ai_call.declined',
    'ai_call.exhausted',
    'ai_call.failed',
    'estimate.client_accepted',
    'estimate.client_declined',
    'estimate.send_failed',
    'invoice.send_failed',
    'payment.succeeded',
    'payment.failed',
    'payment.disputed',
    'payment.refunded',
    'payment.voided',
    'task.assigned',
    'task.reassigned',
    'task.due',
    'task.overdue',
    'review.received',
    'agent_task.failed',
]);

function item({
    event_type,
    category_key,
    label,
    description,
    required_permission,
    default_audience_summary,
    record_scope,
    source_event_type = event_type,
    source_predicate = null,
}) {
    const category = CATEGORY_BY_KEY.get(category_key);
    if (!category) throw new Error(`Unknown notification category: ${category_key}`);
    return Object.freeze({
        event_type,
        category_key,
        category_label: category.label,
        label,
        description,
        required_permission,
        default_audience_summary,
        producer_available: CURRENT_PRODUCERS.has(event_type),
        source_event_type,
        source_predicate,
        record_scope,
    });
}

const NOTIFICATION_EVENT_CATALOG = Object.freeze([
    item({ event_type: 'lead.created', category_key: 'leads', label: 'New lead', description: 'A new lead was created.', required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead' }),
    item({ event_type: 'lead.assigned', category_key: 'leads', label: 'Lead assigned', description: 'A lead was assigned to an office user.', required_permission: 'leads.view', default_audience_summary: 'Assignee and office roles', record_scope: 'office_only_lead_with_assignee' }),
    item({ event_type: 'lead.unassigned', category_key: 'leads', label: 'Lead unassigned', description: 'An office user was removed from a lead.', required_permission: 'leads.view', default_audience_summary: 'Removed assignee and office roles', record_scope: 'office_only_lead_with_previous_recipient' }),
    item({ event_type: 'lead.review_required', category_key: 'leads', label: 'Lead needs review', description: 'A lead entered Review and needs a human decision.', required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead' }),
    item({ event_type: 'lead.converted', category_key: 'leads', label: 'Lead converted', description: 'A lead was converted to a job.', required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead' }),
    item({ event_type: 'lead.status_changed', category_key: 'leads', label: 'Other lead status changes', description: 'A routine lead status changed.', required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead', source_predicate: 'exclude_review_and_converted' }),
    item({ event_type: 'lead.updated', category_key: 'leads', label: 'Lead updated', description: 'Lead details changed.', required_permission: 'leads.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'office_only_lead' }),

    item({ event_type: 'job.created', category_key: 'job_schedule', label: 'Job created', description: 'A new job was created.', required_permission: 'jobs.view', default_audience_summary: 'Office roles; assigned providers when present', record_scope: 'job_assignment' }),
    item({ event_type: 'job.assigned', category_key: 'job_schedule', label: 'Job assigned', description: 'A provider was assigned to a job.', required_permission: 'jobs.view', default_audience_summary: 'Office roles and newly assigned provider', record_scope: 'job_assignment_with_added_recipients' }),
    item({ event_type: 'job.unassigned', category_key: 'job_schedule', label: 'Job unassigned', description: 'A provider was removed from a job.', required_permission: 'jobs.view', default_audience_summary: 'Office roles and removed provider', record_scope: 'job_assignment_with_previous_recipient' }),
    item({ event_type: 'job.rescheduled', category_key: 'job_schedule', label: 'Job rescheduled', description: "A job's appointment window changed.", required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment' }),
    item({ event_type: 'job.status_changed', category_key: 'job_schedule', label: 'Important job status change', description: 'A job moved to On the way, Waiting for parts, Part arrived, Visit completed, Job is Done, or Canceled.', required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment', source_predicate: 'important_target_status' }),
    item({ event_type: 'job.updated', category_key: 'job_schedule', label: 'Other job updates', description: 'Non-critical job details changed.', required_permission: 'jobs.view', default_audience_summary: 'Office roles and assigned providers', record_scope: 'job_assignment' }),
    item({ event_type: 'job.sync_completed', category_key: 'job_schedule', label: 'Job sync completed', description: 'A job sync completed successfully.', required_permission: 'jobs.view', default_audience_summary: 'Admins and managers', record_scope: 'office_only_job' }),

    item({ event_type: 'sms.inbound', category_key: 'calls_messages', label: 'New text message', description: 'A customer sent an inbound SMS.', required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'email.inbound', category_key: 'calls_messages', label: 'New email', description: 'A customer sent an inbound email.', required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'yelp.message_received', category_key: 'calls_messages', label: 'New Yelp message', description: 'A customer sent a Yelp message.', required_permission: 'messages.view_client', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'call.inbound_started', category_key: 'calls_messages', label: 'Incoming call', description: 'An inbound customer call started.', required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'call.missed', category_key: 'calls_messages', label: 'Missed call', description: 'An inbound call reached a terminal unanswered outcome.', required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'call.voicemail_received', category_key: 'calls_messages', label: 'Voicemail received', description: 'A caller left a voicemail.', required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'call.completed', category_key: 'calls_messages', label: 'Call completed', description: 'A customer call completed.', required_permission: 'pulse.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact_or_office_orphan' }),
    item({ event_type: 'sms.outbound', category_key: 'calls_messages', label: 'Text message sent', description: 'A staff-authored SMS was sent.', required_permission: 'messages.view_client', default_audience_summary: 'Initiating user and permitted office roles', record_scope: 'actor_and_active_contact' }),
    item({ event_type: 'message.delivery_failed', category_key: 'calls_messages', label: 'Message delivery failed', description: 'A customer message could not be delivered.', required_permission: 'messages.send', default_audience_summary: 'Initiating user and permitted office roles', record_scope: 'actor_and_active_contact' }),

    item({ event_type: 'ai_call.booked', category_key: 'calls_messages', label: 'AI call booked', description: 'An AI call produced a tentative booking or human-review outcome.', required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment' }),
    item({ event_type: 'ai_call.declined', category_key: 'calls_messages', label: 'AI call declined or needs handoff', description: 'A customer declined or requested human follow-up.', required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment' }),
    item({ event_type: 'ai_call.exhausted', category_key: 'calls_messages', label: 'AI call attempts exhausted', description: 'The AI call retry ladder ended without resolution.', required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment' }),
    item({ event_type: 'ai_call.failed', category_key: 'calls_messages', label: 'AI call failed', description: 'An AI call ended in a hard operational failure.', required_permission: 'pulse.view', default_audience_summary: 'Office roles; assigned provider only for a job outcome', record_scope: 'lead_office_or_job_assignment' }),
    item({ event_type: 'ai_call.retry_scheduled', category_key: 'calls_messages', label: 'AI call retry scheduled', description: 'A transient outcome scheduled another attempt.', required_permission: 'pulse.view', default_audience_summary: 'Admins, managers, and dispatchers', record_scope: 'lead_office_or_job_assignment' }),

    item({ event_type: 'estimate.client_accepted', category_key: 'finance', label: 'Estimate accepted', description: 'A client accepted an estimate.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'estimate.client_declined', category_key: 'finance', label: 'Estimate declined', description: 'A client declined an estimate.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'estimate.send_failed', category_key: 'finance', label: 'Estimate delivery failed', description: 'An estimate could not be sent.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent' }),
    item({ event_type: 'estimate.sent', category_key: 'finance', label: 'Estimate sent', description: 'An estimate was sent to a client.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent' }),
    item({ event_type: 'estimate.viewed', category_key: 'finance', label: 'Estimate viewed', description: 'A client viewed an estimate.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'invoice.send_failed', category_key: 'finance', label: 'Invoice delivery failed', description: 'An invoice could not be sent.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent' }),
    item({ event_type: 'invoice.sent', category_key: 'finance', label: 'Invoice sent', description: 'An invoice was sent to a client.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Initiator and financial-alert recipients', record_scope: 'actor_and_financial_parent' }),
    item({ event_type: 'invoice.viewed', category_key: 'finance', label: 'Invoice viewed', description: 'A client viewed an invoice.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'invoice.voided', category_key: 'finance', label: 'Invoice voided', description: 'An invoice was voided.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'payment.succeeded', category_key: 'finance', label: 'Payment received', description: 'A customer payment succeeded or was recorded.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'payment.failed', category_key: 'finance', label: 'Payment failed', description: 'A customer payment failed.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'payment.disputed', category_key: 'finance', label: 'Payment disputed', description: 'A customer payment was disputed.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'payment.refunded', category_key: 'finance', label: 'Payment refunded', description: 'A customer payment was refunded.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),
    item({ event_type: 'payment.voided', category_key: 'finance', label: 'Payment voided', description: 'A recorded customer payment was voided.', required_permission: 'notifications.financial.receive', default_audience_summary: 'Financial-alert recipients; provider only for own job', record_scope: 'financial_parent' }),

    item({ event_type: 'task.assigned', category_key: 'tasks', label: 'Task assigned', description: 'A task was assigned to a user.', required_permission: 'tasks.view', default_audience_summary: 'Task owner; task managers for unassigned work', record_scope: 'task_owner_author_or_manager' }),
    item({ event_type: 'task.reassigned', category_key: 'tasks', label: 'Task reassigned', description: 'Task ownership changed.', required_permission: 'tasks.view', default_audience_summary: 'New owner, removed owner minimally, and task managers', record_scope: 'task_owner_author_or_previous_recipient' }),
    item({ event_type: 'task.due', category_key: 'tasks', label: 'Task due soon', description: 'A task reached its configured due-soon window.', required_permission: 'tasks.view', default_audience_summary: 'Task owner and task managers', record_scope: 'task_owner_author_or_manager' }),
    item({ event_type: 'task.overdue', category_key: 'tasks', label: 'Task overdue', description: 'An open task passed its due time.', required_permission: 'tasks.view', default_audience_summary: 'Task owner and task managers', record_scope: 'task_owner_author_or_manager' }),
    item({ event_type: 'task.completed', category_key: 'tasks', label: 'Task completed', description: 'A task was completed.', required_permission: 'tasks.view', default_audience_summary: 'Task owner, author, and task managers', record_scope: 'task_owner_author_or_manager' }),

    item({ event_type: 'review.received', category_key: 'job_schedule', label: 'Review received', description: 'A customer submitted a job/provider review.', required_permission: 'jobs.view', default_audience_summary: 'Office roles and providers assigned to the reviewed job', record_scope: 'rated_job_assignment' }),

    item({ event_type: 'agent_task.failed', category_key: 'admin_system', label: 'Automation task failed', description: 'An internal agent task failed and needs administrator attention.', required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only' }),
    item({ event_type: 'integration.delivery_failed', category_key: 'admin_system', label: 'Integration delivery failed', description: 'A configured integration could not deliver or synchronize required data.', required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only' }),
    item({ event_type: 'sync.completed', category_key: 'admin_system', label: 'Sync completed', description: 'A background integration sync completed successfully.', required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only' }),
    item({ event_type: 'billing.subscription_past_due', category_key: 'admin_system', label: 'Albusto subscription past due', description: "The company's Albusto subscription requires attention.", required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only' }),
    item({ event_type: 'billing.invoice_payment_failed', category_key: 'admin_system', label: 'Albusto billing payment failed', description: "Payment for the company's Albusto invoice failed.", required_permission: 'tenant.company.manage', default_audience_summary: 'Company administrators', record_scope: 'admin_only' }),
    item({ event_type: 'contact.updated', category_key: 'calls_messages', label: 'Contact updated', description: 'Contact details changed.', required_permission: 'contacts.view', default_audience_summary: 'Office roles and providers with an active job for the contact', record_scope: 'active_contact' }),
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
        category_key: entry.category_key,
        category_label: entry.category_label,
        label: entry.label,
        description: entry.description,
        required_permission: entry.required_permission,
        default_audience_summary: entry.default_audience_summary,
        producer_available: entry.producer_available,
    };
}

function getPublicNotificationEventCatalog() {
    return NOTIFICATION_EVENT_CATALOG.map(toPublicCatalogItem);
}

module.exports = {
    NOTIFICATION_CATALOG_VERSION,
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
    getPublicNotificationEventCatalog,
    toPublicCatalogItem,
};
