'use strict';

/**
 * agentSkillsMcpRegistry — the service-CRM (`svc.*`) MCP tool registry.
 *
 * AGENT-SKILLS-001, AR-3 / spec §8 / architecture §4. This is the PARALLEL
 * triplet's registry: a THIN PROJECTION of the provider-neutral skill manifest
 * (`services/agentSkills/registry.js`) into `crmMcp*`-shaped tool descriptors.
 *
 * It deliberately MIRRORS `crmMcpToolRegistry.js` (same tool-def shape, same
 * `objectSchema/integerSchema/enumSchema/stringSchema` helpers, same
 * `normalizeTool(tool, kind)` producing `{ ...tool, kind, requiresConfirmation,
 * requiredPermission }`) but:
 *   - names are namespaced `svc.*` so they NEVER collide with the sales `crm.*`;
 *   - each tool ADDS `requiredLevel` ('L0'|'L1'|'L2') — a per-tool copy of the
 *     skill's verification level (the SKILL LAYER enforces it; this is metadata
 *     surfaced on tools/list so a caller knows the bar);
 *   - each tool ADDS `skill` — the camelCase provider-neutral skill name the
 *     executor hands to `agentSkills.runSkill(...)` (the MCP names are snake_case
 *     per MCP convention; the skill layer keys off camelCase).
 *
 * ZERO business logic lives here. Legacy skills flow through `runSkill`; the
 * ChatGPT dispatcher descriptors name dedicated read/write service handlers.
 * Both surfaces remain metadata-only projections with fail-closed permissions.
 *
 * The sales registry (`crmMcpToolRegistry.js`) is UNTOUCHED — this is additive.
 */

// Legacy service-CRM write permission key (distinct from the sales
// `sales.crm.write`). ChatGPT dispatcher writes use their entity + exact grants
// and OAuth write scope instead.
const SERVICE_WRITE_PERMISSION = 'service.crm.write';
const {
    FINANCE_TOOL_DEFINITIONS,
    buildMcpInputSchema,
} = require('./agentSkills/financeToolDefinitions');
const {
    READ_TOOL_PERMISSIONS: CHATGPT_READ_TOOL_PERMISSIONS,
    READ_TOOL_NAMES: CHATGPT_S1_TOOL_NAMES,
    READ_SCOPE: CHATGPT_READ_SCOPE,
    S1_GRANTS: CHATGPT_S1_GRANTS,
    WRITE_TOOL_PERMISSIONS: CHATGPT_WRITE_TOOL_PERMISSIONS,
    WRITE_TOOL_NAMES: CHATGPT_S2_WRITE_TOOL_NAMES,
    WRITE_SCOPE: CHATGPT_WRITE_SCOPE,
    S2_WRITE_GRANTS: CHATGPT_S2_WRITE_GRANTS,
    SEND_TOOL_PERMISSIONS: CHATGPT_SEND_TOOL_PERMISSIONS,
    SEND_TOOL_NAMES: CHATGPT_S3_SEND_TOOL_NAMES,
    SEND_SCOPE: CHATGPT_SEND_SCOPE,
    S3_SEND_GRANTS: CHATGPT_S3_SEND_GRANTS,
} = require('./chatgptMcpPermissions');

// MCP 2025-06-18 display labels for the ChatGPT dispatcher surface. Tool
// identifiers remain stable; legacy voice/customer svc.* descriptors are
// intentionally absent and therefore do not receive a title.
const DISPATCHER_TOOL_TITLES = Object.freeze({
    'svc.list_jobs': 'List jobs',
    'svc.get_job': 'Open a job',
    'svc.get_job_transitions': 'See a job\'s available status changes',
    'svc.list_leads': 'List leads',
    'svc.get_lead': 'Open a lead',
    'svc.get_lead_transitions': 'See a lead\'s available status changes',
    'svc.search_contacts': 'Search contacts',
    'svc.get_contact': 'Look up a contact',
    'svc.get_contact_history': 'See a contact\'s history',
    'svc.list_schedule': 'View the schedule',
    'svc.get_schedule_item': 'Open a schedule item',
    'svc.list_tasks': 'List tasks',
    'svc.list_entity_tasks': 'List tasks on a job or lead',
    'svc.list_task_assignees': 'List who can be assigned tasks',
    'svc.list_estimates': 'List estimates',
    'svc.get_estimate': 'Open an estimate',
    'svc.list_invoices': 'List invoices',
    'svc.get_invoice': 'Open an invoice',
    'svc.list_calls': 'View recent calls',
    'svc.create_lead': 'Create a lead',
    'svc.update_lead': 'Edit a lead',
    'svc.transition_lead': 'Change a lead\'s status',
    'svc.create_job': 'Create a job',
    'svc.update_job': 'Edit a job',
    'svc.transition_job': 'Change a job\'s status',
    'svc.add_note': 'Add a note',
    'svc.create_estimate': 'Create an estimate',
    'svc.update_estimate': 'Edit an estimate',
    'svc.create_invoice': 'Create an invoice',
    'svc.update_invoice': 'Edit an invoice',
    'svc.convert_estimate_to_invoice': 'Turn an estimate into an invoice',
    'svc.send_estimate': 'Email or text an estimate to the customer',
    'svc.send_invoice': 'Email or text an invoice to the customer',
});

const TOOL_PERMISSION_MAP = Object.freeze({
    'svc.identify_caller': ['contacts.view'],
    'svc.get_customer_overview': ['contacts.view'],
    'svc.get_job_status': ['jobs.view'],
    'svc.get_appointments': ['jobs.view'],
    'svc.get_job_history': ['jobs.view'],
    ...Object.fromEntries(FINANCE_TOOL_DEFINITIONS.map((definition) => [
        definition.mcpName,
        [...definition.requiredPermissions],
    ])),
    'svc.reschedule_appointment': ['jobs.edit'],
    'svc.cancel_appointment': ['jobs.close'],
    'svc.book_on_lead': ['leads.edit', 'leads.create'],
    ...Object.fromEntries(Object.entries(CHATGPT_READ_TOOL_PERMISSIONS).map(([name, permissions]) => [
        name,
        [...permissions, `mcp.tool.${name}`],
    ])),
    ...Object.fromEntries(Object.entries(CHATGPT_WRITE_TOOL_PERMISSIONS).map(([name, permissions]) => [
        name,
        [...permissions, `mcp.tool.${name}`],
    ])),
    ...Object.fromEntries(Object.entries(CHATGPT_SEND_TOOL_PERMISSIONS).map(([name, permissions]) => [
        name,
        [...permissions, `mcp.tool.${name}`],
    ])),
});

/**
 * The identity block every skill additionally accepts as *claims* (spec §2.1).
 * The skill layer re-derives the verification level from the DB against these —
 * they are never trusted as proof. Shared across all `svc.*` input schemas.
 * @returns {Object} JSON-schema property fragment for the identity block.
 */
function identityBlockProperties() {
    return {
        phone: stringSchema(),
        name: stringSchema(),
        zip: stringSchema(),
        street: stringSchema(),
        contact_id: stringSchema(),
    };
}

// --- READ tools (7) ---------------------------------------------------------
// identify_caller is L0 (it DERIVES L1/L2); overview/job_status/appointments are
// L1; job_history/estimate_summary/invoice_summary are L1 (AGENT-SKILLS-002 relaxed; sensitive reads).
const READ_TOOLS = [
    {
        name: 'svc.identify_caller',
        skill: 'identifyCaller',
        requiredLevel: 'L0',
        description:
            'Resolve who is calling (new vs. existing customer) and derive the verification level for the rest of the call. Never returns a raw PII dump.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
        }),
    },
    {
        name: 'svc.get_customer_overview',
        skill: 'getCustomerOverview',
        requiredLevel: 'L1',
        description:
            'One-line snapshot to route the conversation: open-job count, next appointment window, last job status phrase, and existence of an estimate/invoice. No amounts, no addresses.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
        }, ['contact_id']),
    },
    {
        name: 'svc.get_job_status',
        skill: 'getJobStatus',
        requiredLevel: 'L1',
        description:
            "Answer \"what's going on with my repair?\" for a specific or the most relevant open job. Status is a spoken phrase, never a raw code.",
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
            job_id: stringSchema(),
        }, ['contact_id']),
    },
    {
        name: 'svc.get_appointments',
        skill: 'getAppointments',
        requiredLevel: 'L1',
        description:
            'List scheduled appointments for the verified customer. Windows are stated as ranges, never an exact minute.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
        }, ['contact_id']),
    },
    {
        name: 'svc.get_job_history',
        skill: 'getJobHistory',
        requiredLevel: 'L1',
        description:
            "Summarized, speech-friendly timeline for a job (\"what did the tech say last time?\"). Internal/technician-private notes are redacted. Requires an identified caller (L1).",
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
            job_id: stringSchema(),
        }, ['contact_id', 'job_id']),
    },
    ...FINANCE_TOOL_DEFINITIONS.map((definition) => ({
        name: definition.mcpName,
        skill: definition.skillName,
        requiredLevel: definition.requiredLevel,
        description: definition.description,
        inputSchema: buildMcpInputSchema(definition),
    })),
];

// --- WRITE tools (3) --------------------------------------------------------
// Every write requires the framework write-gate (permission + confirmation) AND
// the skill-layer verification level below — the MCP call must satisfy BOTH,
// strictly stronger than either alone. (reschedule/cancel carry their own
// requiredLevel; book_on_lead is L1 per AGENT-SKILLS-002 §3.4.5.)
const WRITE_TOOLS = [
    {
        name: 'svc.reschedule_appointment',
        skill: 'rescheduleAppointment',
        requiredLevel: 'L1',
        description:
            'Move a verified customer\'s appointment to a previously offered-and-confirmed window; writes Albusto and pushes Zenbooker. Requires an identified caller (L1) plus write confirmation.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
            job_id: stringSchema(),
            new_preferred_slot: newPreferredSlotSchema(),
        }, ['contact_id', 'job_id', 'new_preferred_slot']),
    },
    {
        name: 'svc.cancel_appointment',
        skill: 'cancelAppointment',
        requiredLevel: 'L1',
        description:
            'Cancel a verified customer\'s appointment after exactly one genuine retention attempt. A non-empty reason and retention_attempted:true are required. Requires an identified caller (L1) plus write confirmation.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            contact_id: stringSchema(),
            job_id: stringSchema(),
            reason: stringSchema(),
            retention_attempted: booleanSchema(),
        }, ['contact_id', 'job_id', 'reason', 'retention_attempted']),
    },
    {
        // AGENT-SKILLS-002 §3.4.5 — book a caller-confirmed slot as a
        // schedule-blocking HOLD on the identified contact's EXISTING open lead
        // (UPDATE, never a duplicate; falls back to createLead only when the
        // contact has no open lead). L1 per the relaxation; NO jobId in this flow
        // (a lead, not a job). Keeps the svc.* surface at parity with the VAPI
        // bookOnLead tool-def (AC-10 equivalence). `chosen_slot` reuses the same
        // {date,start,end} nested shape as reschedule's new_preferred_slot.
        name: 'svc.book_on_lead',
        skill: 'bookOnLead',
        requiredLevel: 'L1',
        description:
            'Book a caller-confirmed window as a hold on the identified customer\'s existing open request (lead) — UPDATE, never a duplicate; creates a fresh request only if none is open. Requires L1 verification plus write confirmation.',
        inputSchema: objectSchema({
            ...identityBlockProperties(),
            // The window the caller confirmed, taken from a slot recommendSlots offered.
            chosen_slot: newPreferredSlotSchema(),
            // Optional geo of the validated service address; written to the hold only
            // when BOTH are finite (both-or-nothing), mirroring createLead.
            lat: { type: 'number' },
            lng: { type: 'number' },
            // Fallback-create fields — consumed ONLY when the contact has no open lead
            // (forwarded verbatim to the createLead skill).
            first_name: stringSchema(),
            last_name: stringSchema(),
            email: stringSchema(),
            apt: stringSchema(),
            city: stringSchema(),
            state: stringSchema(),
            unit_type: stringSchema(),
            problem_description: stringSchema(),
        }, ['chosen_slot']),
    },
];

// CHATGPT-CRM-MCP-001 S1 — dispatcher reads. These are intentionally separate
// from the caller-verification skills above: the OAuth binding is the actor and
// company authority, and each descriptor also requires its exact AI-only grant.
const DISPATCHER_READ_TOOLS = [
    dispatcherRead('svc.list_jobs', 'listJobs', 'List company Jobs with bounded filters.', strictObjectSchema({
        status: stringSchema(), search: stringSchema(), start_date: dateSchema(), end_date: dateSchema(),
        only_open: booleanSchema(), limit: integerSchema(1, 100), offset: integerSchema(0),
    })),
    dispatcherRead('svc.get_job', 'getJob', 'Get one company-owned Job.', strictObjectSchema({ job_id: integerSchema(1) }, ['job_id'])),
    dispatcherRead('svc.get_job_transitions', 'getJobTransitions', 'List actions from the company-published Job workflow.', strictObjectSchema({ job_id: integerSchema(1) }, ['job_id'])),
    dispatcherRead('svc.list_leads', 'listLeads', 'List company Leads with bounded filters.', strictObjectSchema({
        status: stringSchema(), source: stringSchema(), search: stringSchema(), only_open: booleanSchema(),
        limit: integerSchema(1, 100), offset: integerSchema(0),
    })),
    dispatcherRead('svc.get_lead', 'getLead', 'Get one company-owned Lead.', strictObjectSchema({ lead_uuid: stringSchema() }, ['lead_uuid'])),
    dispatcherRead('svc.get_lead_transitions', 'getLeadTransitions', 'List actions from the company-published Lead workflow.', strictObjectSchema({ lead_uuid: stringSchema() }, ['lead_uuid'])),
    dispatcherRead('svc.search_contacts', 'searchContacts', 'Search company Contacts by name, phone, or email.', strictObjectSchema({
        search: stringSchema(), limit: integerSchema(1, 100), offset: integerSchema(0),
    })),
    dispatcherRead('svc.get_contact', 'getContact', 'Get one company-owned Contact with owned emails and addresses.', strictObjectSchema({ contact_id: integerSchema(1) }, ['contact_id'])),
    dispatcherRead('svc.get_contact_history', 'getContactHistory', 'Get bounded company-owned Contact history.', strictObjectSchema({
        contact_id: integerSchema(1), limit: integerSchema(1, 100),
    }, ['contact_id'])),
    dispatcherRead('svc.list_schedule', 'listSchedule', 'List company Schedule items in a bounded range.', strictObjectSchema({
        start_date: dateSchema(), end_date: dateSchema(),
        entity_types: arraySchema(enumSchema(['job', 'lead', 'task']), 3),
        statuses: arraySchema(stringSchema(), 20), assignee_id: stringSchema(),
        unassigned_only: booleanSchema(), search: stringSchema(),
        limit: integerSchema(1, 100), offset: integerSchema(0),
    })),
    dispatcherRead('svc.list_calls', 'listCalls', 'List recent company calls from Pulse without provider identifiers, pricing, or recordings.', strictObjectSchema({
        limit: integerSchema(1, 50), direction: enumSchema(['inbound', 'outbound']),
        contact_id: integerSchema(1), date_from: dateSchema(), date_to: dateSchema(),
    })),
    dispatcherRead('svc.get_schedule_item', 'getScheduleItem', 'Get one company-owned Schedule item.', strictObjectSchema({
        entity_type: enumSchema(['job', 'lead', 'task']), entity_id: integerSchema(1),
    }, ['entity_type', 'entity_id'])),
    dispatcherRead('svc.list_tasks', 'listTasks', 'List company Tasks with bounded filters.', strictObjectSchema({
        status: stringSchema(), parent_type: enumSchema(['job', 'lead', 'estimate', 'invoice', 'contact', 'timeline']),
        overdue: booleanSchema(), due_from: dateSchema(), due_to: dateSchema(), search: stringSchema(),
        limit: integerSchema(1, 100), offset: integerSchema(0),
    })),
    dispatcherRead('svc.list_entity_tasks', 'listEntityTasks', 'List Tasks on a company-owned Job or Lead.', strictObjectSchema({
        parent_type: enumSchema(['job', 'lead']), parent_id: stringSchema(), include_done: booleanSchema(),
    }, ['parent_type', 'parent_id'])),
    dispatcherRead('svc.list_task_assignees', 'listTaskAssignees', 'List active company users eligible for task assignment.', strictObjectSchema({ limit: integerSchema(1, 500) })),
    dispatcherRead('svc.list_estimates', 'listEstimates', 'List actionable company Estimates without revision double-counting.', financeListSchema(true)),
    dispatcherRead('svc.get_estimate', 'getEstimate', 'Get one company-owned Estimate and its line items.', strictObjectSchema({ estimate_id: integerSchema(1) }, ['estimate_id'])),
    dispatcherRead('svc.list_invoices', 'listInvoices', 'List company Invoices with balance fields.', financeListSchema(false)),
    dispatcherRead('svc.get_invoice', 'getInvoice', 'Get one company-owned Invoice, line items, and payment rollup.', strictObjectSchema({ invoice_id: integerSchema(1) }, ['invoice_id'])),
];

// CHATGPT-CRM-MCP-001 S2a — dispatcher writes. Each call is executed by the
// shared transactional executor only after a fresh live-binding recheck.
const LEAD_EDIT_PROPERTIES = Object.freeze({
    first_name: stringSchema(),
    last_name: stringSchema(),
    company_name: stringSchema(),
    phone: stringSchema(),
    email: stringSchema(),
    source: stringSchema(),
    description: stringSchema(),
    comments: stringSchema(),
    address: stringSchema(),
    unit: stringSchema(),
    city: stringSchema(),
    state: stringSchema(),
    postal_code: stringSchema(),
    job_type: stringSchema(),
    contact_id: integerSchema(1),
});

const JOB_EDIT_PROPERTIES = Object.freeze({
    contact_id: integerSchema(1),
    customer_name: stringSchema(),
    customer_phone: stringSchema(),
    customer_email: stringSchema(),
    service_name: stringSchema(),
    description: stringSchema(),
    start_date: stringSchema(),
    end_date: stringSchema(),
    address: stringSchema(),
    city: stringSchema(),
    territory: stringSchema(),
    job_source: stringSchema(),
});

const FINANCIAL_ITEM_PROPERTIES = Object.freeze({
    name: stringSchema(),
    description: nullableSchema(stringSchema()),
    quantity: numberSchema(0.000001),
    unit_price: numberSchema(0),
    unit: nullableSchema(stringSchema()),
    taxable: booleanSchema(),
});

const ESTIMATE_ITEM_PROPERTIES = Object.freeze({
    ...FINANCIAL_ITEM_PROPERTIES,
    price_book_item_id: nullableSchema(integerSchema(1)),
});

const ESTIMATE_EDIT_PROPERTIES = Object.freeze({
    contact_id: integerSchema(1),
    lead_id: integerSchema(1),
    job_id: integerSchema(1),
    summary: nullableSchema(stringSchema()),
    notes: nullableSchema(stringSchema()),
    internal_note: nullableSchema(stringSchema()),
    tax_rate: numberSchema(0, 100),
    discount_type: nullableSchema(enumSchema(['fixed', 'percentage'])),
    discount_value: numberSchema(0),
    currency: stringSchema(),
    signature_required: booleanSchema(),
});

const INVOICE_EDIT_PROPERTIES = Object.freeze({
    contact_id: integerSchema(1),
    lead_id: integerSchema(1),
    job_id: integerSchema(1),
    estimate_id: integerSchema(1),
    title: nullableSchema(stringSchema()),
    notes: nullableSchema(stringSchema()),
    internal_note: nullableSchema(stringSchema()),
    tax_rate: numberSchema(0, 100),
    discount_amount: numberSchema(0),
    payment_terms: nullableSchema(stringSchema()),
    due_date: nullableSchema(dateSchema()),
});

function itemCreateSchema(properties) {
    return strictObjectSchema(properties, ['name', 'quantity', 'unit_price']);
}

function itemUpdateSchema(properties) {
    return strictObjectSchema({
        item_id: integerSchema(1),
        ...properties,
    }, ['item_id']);
}

const DISPATCHER_WRITE_TOOLS = [
    dispatcherWrite('svc.create_lead', 'createLead', 'Create a company Lead and canonically link or create its Contact.', strictObjectSchema({
        ...LEAD_EDIT_PROPERTIES,
        note: stringSchema(),
    }, ['first_name', 'last_name'])),
    dispatcherWrite('svc.update_lead', 'updateLead', 'Edit dispatcher-visible fields on one company-owned Lead; status is not accepted.', strictObjectSchema({
        lead_uuid: stringSchema(),
        ...LEAD_EDIT_PROPERTIES,
    }, ['lead_uuid'])),
    dispatcherWrite('svc.transition_lead', 'transitionLead', 'Apply an available dispatcher action from the company-published Lead workflow.', strictObjectSchema({
        lead_uuid: stringSchema(),
        action: stringSchema(),
    }, ['lead_uuid', 'action'])),
    dispatcherWrite('svc.create_job', 'createJob', 'Create a company Job and canonically link or create its Contact.', strictObjectSchema({
        ...JOB_EDIT_PROPERTIES,
        note: stringSchema(),
    }, ['customer_name'])),
    dispatcherWrite('svc.update_job', 'updateJob', 'Edit dispatcher-visible fields on one company-owned Job; status is not accepted.', strictObjectSchema({
        job_id: integerSchema(1),
        ...JOB_EDIT_PROPERTIES,
    }, ['job_id'])),
    dispatcherWrite('svc.transition_job', 'transitionJob', 'Apply an available dispatcher action from the company-published Job workflow.', strictObjectSchema({
        job_id: integerSchema(1),
        action: stringSchema(),
    }, ['job_id', 'action'])),
    dispatcherWrite('svc.add_note', 'addNote', 'Add a text-only internal note to a company-owned Job, Lead, or Contact.', strictObjectSchema({
        parent_type: enumSchema(['job', 'lead', 'contact']),
        parent_id: stringSchema(),
        text: stringSchema(),
    }, ['parent_type', 'parent_id', 'text'])),
    dispatcherWrite('svc.create_estimate', 'createEstimate', 'Create a draft company Estimate with server-calculated totals and bounded line items.', strictObjectSchema({
        ...ESTIMATE_EDIT_PROPERTIES,
        items: arraySchema(itemCreateSchema(ESTIMATE_ITEM_PROPERTIES), 50),
    })),
    dispatcherWrite('svc.update_estimate', 'updateEstimate', 'Edit a company Estimate and apply bounded add/update/remove line-item operations; totals remain server-calculated.', strictObjectSchema({
        estimate_id: integerSchema(1),
        ...ESTIMATE_EDIT_PROPERTIES,
        items_add: arraySchema(itemCreateSchema(ESTIMATE_ITEM_PROPERTIES), 50),
        items_update: arraySchema(itemUpdateSchema(ESTIMATE_ITEM_PROPERTIES), 50),
        item_ids_remove: arraySchema(integerSchema(1), 50),
    }, ['estimate_id'])),
    dispatcherWrite('svc.create_invoice', 'createInvoice', 'Create a draft company Invoice with server-calculated totals and bounded line items.', strictObjectSchema({
        ...INVOICE_EDIT_PROPERTIES,
        currency: stringSchema(),
        items: arraySchema(itemCreateSchema(FINANCIAL_ITEM_PROPERTIES), 50),
    })),
    dispatcherWrite('svc.update_invoice', 'updateInvoice', 'Edit a company Invoice and apply bounded add/update/remove line-item operations; totals remain server-calculated.', strictObjectSchema({
        invoice_id: integerSchema(1),
        ...INVOICE_EDIT_PROPERTIES,
        items_add: arraySchema(itemCreateSchema(FINANCIAL_ITEM_PROPERTIES), 50),
        items_update: arraySchema(itemUpdateSchema(FINANCIAL_ITEM_PROPERTIES), 50),
        item_ids_remove: arraySchema(integerSchema(1), 50),
    }, ['invoice_id'])),
    dispatcherWrite(
        'svc.convert_estimate_to_invoice',
        'convertEstimateToInvoice',
        'Convert one approved company Estimate to its canonical draft Invoice, returning an existing linked Invoice on replay.',
        strictObjectSchema({
            estimate_id: integerSchema(1),
        }, ['estimate_id'])
    ),
];

// CHATGPT-CRM-MCP-001 S3 — external customer sends remain `kind=write` for
// the shared transaction/confirmation executor, but have their own OAuth scope
// and consent-grant bundle. The recipient is intentionally absent: the handler
// resolves it from the company-owned document Contact.
const DISPATCHER_SEND_TOOLS = [
    dispatcherSend(
        'svc.send_estimate',
        'sendEstimate',
        'Send one company Estimate to its linked Contact by email or SMS.',
        strictObjectSchema({
            estimate_id: integerSchema(1),
            channel: enumSchema(['email', 'sms']),
            message: stringSchema(500),
        }, ['estimate_id', 'channel'])
    ),
    dispatcherSend(
        'svc.send_invoice',
        'sendInvoice',
        'Send one company Invoice to its linked Contact by email or SMS.',
        strictObjectSchema({
            invoice_id: integerSchema(1),
            channel: enumSchema(['email', 'sms']),
            message: stringSchema(500),
            include_payment_link: booleanSchema(),
        }, ['invoice_id', 'channel'])
    ),
];

const TOOLS = Object.freeze([
    ...READ_TOOLS.map((tool) => normalizeTool(tool, 'read')),
    ...WRITE_TOOLS.map((tool) => normalizeTool(tool, 'write')),
    ...DISPATCHER_READ_TOOLS.map((tool) => normalizeTool(tool, 'read')),
    ...DISPATCHER_WRITE_TOOLS.map((tool) => normalizeTool(tool, 'write')),
    ...DISPATCHER_SEND_TOOLS.map((tool) => normalizeTool(tool, 'write')),
]);
const LEGACY_TOOL_NAMES = new Set([...READ_TOOLS, ...WRITE_TOOLS].map((tool) => tool.name));
const CHATGPT_TOOL_NAMES = Object.freeze([
    ...CHATGPT_S1_TOOL_NAMES,
    ...CHATGPT_S2_WRITE_TOOL_NAMES,
    ...CHATGPT_S3_SEND_TOOL_NAMES,
]);

// --- schema helpers (mirror crmMcpToolRegistry.js) --------------------------

function stringSchema(maxLength) {
    return {
        type: 'string',
        ...(maxLength !== undefined ? { maxLength } : {}),
    };
}

function integerSchema(minimum, maximum) {
    return { type: 'integer', minimum, ...(maximum ? { maximum } : {}) };
}

function numberSchema(minimum, maximum) {
    return {
        type: 'number',
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
    };
}

function booleanSchema() {
    return { type: 'boolean' };
}

function enumSchema(values) {
    return { type: 'string', enum: values };
}

function dateSchema() {
    return { type: 'string', format: 'date' };
}

function arraySchema(items, maxItems) {
    return { type: 'array', items, maxItems };
}

function objectSchema(properties, required = []) {
    return {
        type: 'object',
        additionalProperties: true,
        properties,
        required,
    };
}

function strictObjectSchema(properties, required = []) {
    return { type: 'object', additionalProperties: false, properties, required };
}

function nullableSchema(schema) {
    return { ...schema, nullable: true };
}

function dispatcherRead(name, handler, description, inputSchema) {
    return {
        name,
        handler,
        requiredLevel: null,
        requiredOAuthScopes: [CHATGPT_READ_SCOPE],
        description,
        inputSchema,
    };
}

function dispatcherWrite(name, handler, description, inputSchema) {
    return {
        name,
        handler,
        requiredLevel: null,
        requiredOAuthScopes: [CHATGPT_WRITE_SCOPE],
        confirmationClass: 'W',
        destructiveHint: false,
        description,
        inputSchema,
    };
}

function dispatcherSend(name, handler, description, inputSchema) {
    return {
        name,
        handler,
        requiredLevel: null,
        requiredOAuthScopes: [CHATGPT_SEND_SCOPE],
        confirmationClass: 'W',
        destructiveHint: false,
        description,
        inputSchema,
    };
}

function financeListSchema(estimates) {
    return strictObjectSchema({
        status: stringSchema(), contact_id: integerSchema(1), lead_id: integerSchema(1),
        job_id: integerSchema(1), ...(estimates
            ? { include_archived: booleanSchema() }
            : { estimate_id: integerSchema(1) }),
        search: stringSchema(), limit: integerSchema(1, 100), offset: integerSchema(0),
    });
}

/**
 * Schema for `new_preferred_slot` — one of the windows previously offered and
 * confirmed by the caller (spec §4.5). Nested object; the skill layer validates
 * time semantics, this just shapes the field.
 * @returns {Object} JSON-schema for the nested slot object.
 */
function newPreferredSlotSchema() {
    return {
        type: 'object',
        additionalProperties: true,
        properties: {
            date: stringSchema(),
            start: stringSchema(),
            end: stringSchema(),
        },
        required: ['date', 'start', 'end'],
    };
}

/**
 * Freeze a tool descriptor with the derived kind-driven fields. Mirrors
 * `crmMcpToolRegistry.normalizeTool` but keeps the projection-only `skill` and
 * `requiredLevel` fields intact and attaches fail-closed business permissions.
 * @param {Object} tool Raw tool def (name/skill/requiredLevel/description/inputSchema).
 * @param {'read'|'write'} kind Read vs. state-mutating write.
 * @returns {Readonly<Object>} Frozen normalized tool descriptor.
 */
function normalizeTool(tool, kind) {
    const requiredPermissions = TOOL_PERMISSION_MAP[tool.name] || [];
    const title = DISPATCHER_TOOL_TITLES[tool.name];
    return Object.freeze({
        ...tool,
        ...(title ? { title } : {}),
        kind,
        requiresConfirmation: kind === 'write',
        requiredPermission: requiredPermissions[0] || null,
        requiredPermissions: Object.freeze([...requiredPermissions]),
        frameworkWritePermission: kind === 'write' && !tool.handler
            ? SERVICE_WRITE_PERMISSION
            : null,
    });
}

/**
 * List all `svc.*` tools (optionally filtered by kind), each as a shallow copy
 * with a shallow-copied inputSchema — same contract as `crmMcpToolRegistry.listTools`.
 * @param {{ kind?: 'read'|'write' }} [filters]
 * @returns {Object[]} Tool descriptors.
 */
function listTools(filters = {}) {
    const kind = filters?.kind || null;
    return TOOLS
        .filter((tool) => filters?.dispatcherOnly !== true || CHATGPT_TOOL_NAMES.includes(tool.name))
        .filter((tool) => filters?.includeDispatcher === true || LEGACY_TOOL_NAMES.has(tool.name))
        .filter((tool) => !kind || tool.kind === kind)
        .map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
}

/**
 * Resolve a tool descriptor by its `svc.*` name.
 * @param {string} name MCP tool name.
 * @returns {Object|null}
 */
function getTool(name) {
    return TOOLS.find((tool) => tool.name === name) || null;
}

/**
 * Map an MCP `svc.*` tool name to the camelCase skill name the skill layer keys
 * off (spec §8: the executor calls `runSkill(skillFor(toolName), ...)`).
 * @param {string} name MCP tool name.
 * @returns {string|null} Skill name, or null if the tool is unknown.
 */
function skillFor(name) {
    const tool = getTool(name);
    return tool ? tool.skill : null;
}

module.exports = {
    SERVICE_WRITE_PERMISSION,
    TOOL_PERMISSION_MAP,
    CHATGPT_S1_TOOL_NAMES,
    CHATGPT_S1_GRANTS,
    CHATGPT_S2_WRITE_TOOL_NAMES,
    CHATGPT_S2_WRITE_GRANTS,
    CHATGPT_S3_SEND_TOOL_NAMES,
    CHATGPT_S3_SEND_GRANTS,
    CHATGPT_TOOL_NAMES,
    listTools,
    getTool,
    skillFor,
};
