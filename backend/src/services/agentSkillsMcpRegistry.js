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

const APP_RUNTIME_JOB_STATUSES = Object.freeze([
    'Submitted',
    'Waiting for parts',
    'Part arrived',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
    'On the way',
]);

const APP_RUNTIME_ESTIMATE_STATUSES = Object.freeze([
    'draft',
    'sent',
    'viewed',
    'approved',
    'declined',
]);

const APP_RUNTIME_COMMON_ERRORS = Object.freeze([
    Object.freeze({ code: 'INVALID_ARGUMENTS', description: 'The arguments do not match the documented input schema.' }),
    Object.freeze({ code: 'TOOL_NOT_CONSENTED', description: 'The published app version or installation did not grant this tool.' }),
    Object.freeze({ code: 'ACCESS_DENIED', description: 'The live delegating user lacks the required business permission.' }),
    Object.freeze({ code: 'RUN_CALL_LIMIT', description: 'The run used its allowed gateway calls.' }),
    Object.freeze({ code: 'RATE_LIMITED', description: 'The installation exceeded its gateway request budget.' }),
    Object.freeze({ code: 'AUDIT_UNAVAILABLE', description: 'Albusto could not persist the required audit record, so no data was released.' }),
]);
const NO_SCHEMA_DEFAULT = Symbol('no-schema-default');

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
    dispatcherRead(
        'svc.list_jobs',
        'listJobs',
        'List visible company Jobs with exact status, text, and inclusive start-date filters. Results are ordered by most recently updated first.',
        strictObjectSchema({
            status: documentedSchema(
                enumSchema(APP_RUNTIME_JOB_STATUSES),
                'Exact Albusto Job workflow status to include. Omit to include every status. Returned Job rows expose this value as `blanc_status`; they do not contain a `status` field.'
            ),
            search: documentedSchema(
                stringSchema(),
                'Case-insensitive text contained in the Job number, service name, customer name, customer phone, address, tag name, or searchable custom metadata. Omit for no text filter.'
            ),
            start_date: documentedSchema(
                dateSchema(),
                'Inclusive lower bound on Job `start_date`, formatted `YYYY-MM-DD`. The boundary is midnight at the start of that calendar date in the owning company timezone. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound.'
            ),
            end_date: documentedSchema(
                dateSchema(),
                'Inclusive upper calendar date for Job `start_date`, formatted `YYYY-MM-DD`. The full day is included by using the following calendar date\'s midnight in the owning company timezone as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound.'
            ),
            only_open: documentedSchema(
                booleanSchema(),
                'When true, excludes `Job is Done` and `Canceled`. Defaults to false; it does not mean "scheduled today" and does not replace date filters.',
                false
            ),
            limit: documentedSchema(
                integerSchema(1, 100),
                'Maximum Job rows to return, from 1 through 100. Defaults to 50.',
                50
            ),
            offset: documentedSchema(
                integerSchema(0),
                'Zero-based row offset. Defaults to 0. Pass it explicitly and add `limit` while `has_more` is true to retrieve later pages.',
                0
            ),
        }),
        {
            outputSchema: listJobsOutputSchema(),
            documentation: {
                responseNotes: [
                    'The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.',
                    'Read Job status from `blanc_status`. There is no `status` field in a Job row.',
                    'Sensitive provider payloads are removed. Phone-bearing fields may also be absent when company masking applies.',
                    'Use offset pagination. Although `pagination.next_cursor` may be present, this Phase 1 descriptor does not accept a cursor argument.',
                ],
                errors: appRuntimeErrors(),
                examples: [{
                    title: 'Count every Job scheduled for today',
                    source: `export async function run(ctx) {
    const today = ctx.input.today;
    const page = await ctx.callTool('svc.list_jobs', {
        start_date: today,
        end_date: today,
        offset: 0,
        limit: 100,
    });
    return { count: page.results.length, has_more: page.has_more };
}`,
                }],
            },
        }
    ),
    dispatcherRead(
        'svc.get_job',
        'getJob',
        'Get one visible company-owned Job by its Albusto numeric ID.',
        strictObjectSchema({
            job_id: documentedSchema(
                integerSchema(1),
                'Positive Albusto Job ID, usually taken from `svc.list_jobs().results[].id`.'
            ),
        }, ['job_id']),
        {
            outputSchema: getJobOutputSchema(),
            documentation: {
                responseNotes: [
                    'The value returned by `ctx.callTool` is the Job object itself, not a `results` envelope.',
                    'Read Job status from `blanc_status`. There is no `status` field in the Job object.',
                    'Sensitive provider payloads are removed. Phone-bearing fields may also be absent when company masking applies.',
                ],
                errors: appRuntimeErrors(true),
                examples: [{
                    title: 'Open the first visible Job',
                    source: `export async function run(ctx) {
    const page = await ctx.callTool('svc.list_jobs', { offset: 0, limit: 1 });
    if (page.results.length === 0) return null;
    return ctx.callTool('svc.get_job', { job_id: Number(page.results[0].id) });
}`,
                }],
            },
        }
    ),
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
    dispatcherRead(
        'svc.list_tasks',
        'listTasks',
        'List visible company Tasks with status, parent, due-date, overdue, and text filters. Results are ordered by due date ascending, with undated Tasks last.',
        strictObjectSchema({
            status: documentedSchema(
                enumSchema(['open', 'done', 'all']),
                'Task status to include: `open`, `done`, or `all`. Defaults to `open`.',
                'open'
            ),
            parent_type: documentedSchema(
                enumSchema(['job', 'lead', 'estimate', 'invoice', 'contact', 'timeline']),
                'Restrict Tasks to one parent kind: `job`, `lead`, `estimate`, `invoice`, `contact`, or `timeline`. Omit for every parent kind.'
            ),
            overdue: documentedSchema(
                booleanSchema(),
                'When true, returns only open Tasks whose non-null `due_at` is earlier than the current time. Defaults to false.',
                false
            ),
            due_from: documentedSchema(
                dateSchema(),
                'Inclusive lower bound on Task `due_at`, formatted `YYYY-MM-DD`, at midnight at the start of that calendar date in the owning company timezone. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound.'
            ),
            due_to: documentedSchema(
                dateSchema(),
                'Inclusive upper calendar date for Task `due_at`, formatted `YYYY-MM-DD`. The full day is included by using the following calendar date\'s midnight in the owning company timezone as an exclusive bound. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound.'
            ),
            search: documentedSchema(
                stringSchema(),
                'Case-insensitive text contained in the Task description, parent label, or assignee name. Omit for no text filter.'
            ),
            limit: documentedSchema(
                integerSchema(1, 100),
                'Maximum Task rows to return, from 1 through 100. Defaults to 50.',
                50
            ),
            offset: documentedSchema(
                integerSchema(0),
                'Zero-based row offset. Defaults to 0. Pass it explicitly and add `limit` while `pagination.has_more` is true to retrieve later pages.',
                0
            ),
        }),
        {
            outputSchema: listTasksOutputSchema(),
            documentation: {
                responseNotes: [
                    'Task rows are under `tasks`, not `results`.',
                    'The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.',
                    'Users without `tasks.manage` receive only Tasks they own or authored.',
                    'Use offset pagination. Although `pagination.next_cursor` may be present, this Phase 1 descriptor does not accept a cursor argument.',
                ],
                errors: appRuntimeErrors(),
                examples: [{
                    title: 'List open Tasks due today',
                    source: `export async function run(ctx) {
    const today = ctx.input.today;
    const page = await ctx.callTool('svc.list_tasks', {
        status: 'open',
        due_from: today,
        due_to: today,
        offset: 0,
        limit: 100,
    });
    return page.tasks
        .map((task) => ({
            id: task.id,
            description: task.description,
            parent: task.parent_label,
        }));
}`,
                }],
            },
        }
    ),
    dispatcherRead('svc.list_entity_tasks', 'listEntityTasks', 'List Tasks on a company-owned Job or Lead.', strictObjectSchema({
        parent_type: enumSchema(['job', 'lead']), parent_id: stringSchema(), include_done: booleanSchema(),
    }, ['parent_type', 'parent_id'])),
    dispatcherRead('svc.list_task_assignees', 'listTaskAssignees', 'List active company users eligible for task assignment.', strictObjectSchema({ limit: integerSchema(1, 500) })),
    dispatcherRead(
        'svc.list_estimates',
        'listEstimates',
        'List company-owned Estimates with exact status, accepted-date, and text filters. Results are ordered by newest creation time first.',
        strictObjectSchema({
            status: documentedSchema(
                enumSchema(APP_RUNTIME_ESTIMATE_STATUSES),
                'Exact Estimate status to include: `draft`, `sent`, `viewed`, `approved`, or `declined`. Omit to include every status.'
            ),
            accepted_from: documentedSchema(
                dateSchema(),
                'Inclusive lower bound on Estimate `accepted_at`, formatted `YYYY-MM-DD`. The boundary is midnight at the start of that calendar date in the owning company timezone. Estimates without `accepted_at` do not match. Missing or invalid company timezone configuration falls back to UTC. Omit for no lower bound.'
            ),
            accepted_to: documentedSchema(
                dateSchema(),
                'Inclusive upper calendar date for Estimate `accepted_at`, formatted `YYYY-MM-DD`. The full company-local day is included by using the following calendar date\'s midnight as an exclusive bound. Estimates without `accepted_at` do not match. Missing or invalid company timezone configuration falls back to UTC. Omit for no upper bound.'
            ),
            search: documentedSchema(
                stringSchema(),
                'Case-insensitive text contained in the Estimate number, summary, or notes. Omit for no text filter.'
            ),
            limit: documentedSchema(
                integerSchema(1, 100),
                'Maximum Estimate rows to return, from 1 through 100. Defaults to 50.',
                50
            ),
            offset: documentedSchema(
                integerSchema(0),
                'Zero-based row offset. Defaults to 0. Add `limit` while `pagination.has_more` is true to retrieve later pages.',
                0
            ),
        }),
        {
            outputSchema: listEstimatesOutputSchema(),
            documentation: {
                responseNotes: [
                    'The value returned by `ctx.callTool` is the documented object itself; the internal gateway envelope is already removed.',
                    '`accepted_from` and `accepted_to` are inclusive company-calendar dates applied only to `accepted_at`; the upper bound includes the entire selected day.',
                    '`order_list_count` can be zero. Use `svc.get_estimate` to read the internal parts list for a selected Estimate.',
                    'Use offset pagination. Results are ordered by `created_at` descending, then Estimate ID descending.',
                ],
                errors: appRuntimeErrors(),
                examples: [{
                    title: 'List approved Estimates accepted today',
                    source: `export async function run(ctx) {
    return ctx.callTool('svc.list_estimates', {
        status: 'approved',
        accepted_from: ctx.input.today,
        accepted_to: ctx.input.today,
        offset: 0,
        limit: 100,
    });
}`,
                }],
            },
        }
    ),
    dispatcherRead(
        'svc.get_estimate',
        'getEstimate',
        'Get one company-owned Estimate with its customer-facing line items and internal parts-to-order list.',
        strictObjectSchema({
            estimate_id: documentedSchema(
                integerSchema(1),
                'Positive Albusto Estimate ID, usually taken from `svc.list_estimates().results[].id`.'
            ),
        }, ['estimate_id']),
        {
            outputSchema: getEstimateOutputSchema(),
            documentation: {
                responseNotes: [
                    'The value returned by `ctx.callTool` is the Estimate object itself, not a `results` envelope.',
                    '`items` and `order_list` are always arrays and may be empty.',
                    '`order_list` is the internal parts-to-order list. Each row contains only `part_number`, `part_name`, and `quantity`; it does not contain prices.',
                ],
                errors: appRuntimeErrors(true, 'Estimate'),
                examples: [{
                    title: 'Read the parts required by an approved Estimate',
                    source: `export async function run(ctx) {
    const page = await ctx.callTool('svc.list_estimates', {
        status: 'approved',
        offset: 0,
        limit: 1,
    });
    if (page.results.length === 0) return [];
    const estimate = await ctx.callTool('svc.get_estimate', {
        estimate_id: Number(page.results[0].id),
    });
    return estimate.order_list;
}`,
                }],
            },
        }
    ),
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

function dispatcherRead(name, handler, description, inputSchema, metadata = {}) {
    return {
        name,
        handler,
        requiredLevel: null,
        requiredOAuthScopes: [CHATGPT_READ_SCOPE],
        description,
        inputSchema,
        ...metadata,
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

function documentedSchema(schema, description, defaultValue = NO_SCHEMA_DEFAULT) {
    return {
        ...schema,
        description,
        ...(defaultValue === NO_SCHEMA_DEFAULT ? {} : { default: defaultValue }),
    };
}

function appRuntimeErrors(includeNotFound = false, notFoundEntity = 'Job') {
    return [
        ...APP_RUNTIME_COMMON_ERRORS.map(error => ({ ...error })),
        ...(includeNotFound
            ? [{
                code: 'NOT_FOUND',
                description: notFoundEntity === 'Job'
                    ? 'The Job does not exist or is outside the live company/provider scope.'
                    : `The ${notFoundEntity} does not exist or is outside the live company scope.`,
            }]
            : []),
    ];
}

function nullableOutput(type, description, extras = {}) {
    const types = Array.isArray(type) ? type : [type];
    return { type: [...types, 'null'], description, ...extras };
}

function outputField(type, description, extras = {}) {
    return { type, description, ...extras };
}

function jobOutputProperties({ includeBalances = false } = {}) {
    return {
        id: outputField(['integer', 'string'], 'Albusto Job ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers.'),
        lead_id: nullableOutput(['integer', 'string'], 'Linked Lead ID, when one exists.'),
        lead_serial_id: nullableOutput('string', 'Human-readable linked Lead serial ID.'),
        contact_id: nullableOutput(['integer', 'string'], 'Linked Contact ID.'),
        zenbooker_job_id: nullableOutput('string', 'Linked Zenbooker Job ID, when synchronized.'),
        blanc_status: outputField('string', 'Current Albusto Job workflow status. This is the status field to use.'),
        zb_status: nullableOutput('string', 'Current provider substatus, when available.'),
        zb_rescheduled: outputField('boolean', 'Whether the provider marks the Job as rescheduled.'),
        zb_canceled: outputField('boolean', 'Whether the provider marks the Job as canceled.'),
        job_number: nullableOutput('string', 'Human-readable Job number.'),
        service_name: nullableOutput('string', 'Service name.'),
        start_date: nullableOutput('string', 'Scheduled start timestamp in ISO 8601 format.', { format: 'date-time' }),
        end_date: nullableOutput('string', 'Scheduled end timestamp in ISO 8601 format.', { format: 'date-time' }),
        customer_name: nullableOutput('string', 'Customer display name.'),
        customer_phone: nullableOutput('string', 'Customer phone; the field can be omitted by masking.'),
        customer_email: nullableOutput('string', 'Customer email.'),
        address: nullableOutput('string', 'Service street address.'),
        city: nullableOutput('string', 'Service city.'),
        postal_code: nullableOutput('string', 'Service postal code when the projection supplies it.'),
        territory: nullableOutput('string', 'Service territory.'),
        invoice_total: nullableOutput(['string', 'number'], 'Provider invoice total when available.'),
        invoice_status: nullableOutput('string', 'Provider invoice status when available.'),
        assigned_techs: outputField('array', 'Assigned technician summaries.', {
            items: outputField('object', 'One assigned technician summary.', { additionalProperties: true }),
        }),
        assigned_provider_user_ids: outputField('array', 'Albusto user IDs mirrored as assigned providers.', {
            items: outputField('string', 'One assigned Albusto user ID.'),
        }),
        notes: outputField('array', 'Safe Job note summaries; secret-bearing keys are removed.', {
            items: outputField('object', 'One safe note summary.', { additionalProperties: true }),
        }),
        tags: outputField('array', 'Job tags.', {
            items: outputField('object', 'One Job tag.', {
                additionalProperties: false,
                properties: {
                    id: outputField(['integer', 'string'], 'Tag ID.'),
                    name: outputField('string', 'Tag name.'),
                    color: nullableOutput('string', 'Tag color token.'),
                    is_active: outputField('boolean', 'Whether the tag is active.'),
                },
            }),
        }),
        job_type: nullableOutput('string', 'Job type inherited from the originating Lead when available.'),
        job_source: nullableOutput('string', 'Job acquisition source when available.'),
        description: nullableOutput('string', 'Job description.'),
        comments: nullableOutput('string', 'Job comments.'),
        metadata: outputField('object', 'Safe app-visible custom metadata.', { additionalProperties: true }),
        company_id: outputField('string', 'Owning company ID derived by the gateway; never accepted as input.'),
        created_at: nullableOutput('string', 'Creation timestamp in ISO 8601 format.', { format: 'date-time' }),
        updated_at: nullableOutput('string', 'Last update timestamp in ISO 8601 format.', { format: 'date-time' }),
        lat: nullableOutput('number', 'Service latitude when available.'),
        lng: nullableOutput('number', 'Service longitude when available.'),
        ...(includeBalances ? {
            amount_paid: nullableOutput(['string', 'number'], 'Locally recorded paid amount when an invoice exists.'),
            balance_due: nullableOutput(['string', 'number'], 'Locally calculated outstanding amount when an invoice exists.'),
        } : {}),
    };
}

function paginationOutputSchema() {
    return outputField('object', 'Pagination metadata for the returned page.', {
        additionalProperties: false,
        properties: {
            mode: outputField('string', 'Pagination mode: `offset` when offset was supplied, otherwise `cursor`.', {
                enum: ['offset', 'cursor'],
            }),
            limit: outputField('integer', 'Applied page size.'),
            returned: outputField('integer', 'Number of rows in this page.'),
            has_more: outputField('boolean', 'Whether another page exists.'),
            next_cursor: nullableOutput('string', 'Opaque next-page cursor. Phase 1 App Studio descriptors do not accept it as input.'),
            total: nullableOutput('integer', 'Total matching rows when calculated for this page.'),
        },
    });
}

function listJobsOutputSchema() {
    return outputField('object', 'A page of visible Jobs and pagination metadata.', {
        additionalProperties: false,
        properties: {
            results: outputField('array', 'Job rows for this page.', {
                items: outputField('object', 'One visible Job row.', {
                    additionalProperties: false,
                    properties: jobOutputProperties({ includeBalances: true }),
                }),
            }),
            total: nullableOutput('integer', 'Total matching Jobs when calculated for this page.'),
            offset: outputField('integer', 'Applied zero-based offset.'),
            limit: outputField('integer', 'Applied page size.'),
            has_more: outputField('boolean', 'Whether another page exists.'),
            facets: nullableOutput('object', 'Available list facets when calculated for this page.', {
                additionalProperties: false,
                properties: {
                    providers: outputField('array', 'Distinct visible provider names.', {
                        items: outputField('string', 'Provider display name.'),
                    }),
                },
            }),
            pagination: paginationOutputSchema(),
        },
    });
}

function getJobOutputSchema() {
    return outputField('object', 'One visible Job object. It has `blanc_status` and intentionally has no `status` or raw provider payload.', {
        additionalProperties: false,
        properties: jobOutputProperties(),
    });
}

function taskOutputProperties() {
    return {
        id: outputField(['integer', 'string'], 'Albusto Task ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers.'),
        company_id: outputField('string', 'Owning company ID derived by the gateway; never accepted as input.'),
        description: outputField('string', 'Task text.'),
        status: outputField('string', 'Task status.', { enum: ['open', 'done'] }),
        due_at: nullableOutput('string', 'Due timestamp in ISO 8601 format.', { format: 'date-time' }),
        completed_at: nullableOutput('string', 'Completion timestamp in ISO 8601 format.', { format: 'date-time' }),
        created_at: nullableOutput('string', 'Creation timestamp in ISO 8601 format.', { format: 'date-time' }),
        owner_user_id: nullableOutput('string', 'Owning Albusto user ID.'),
        author_user_id: nullableOutput('string', 'Authoring Albusto user ID.'),
        thread_id: nullableOutput(['integer', 'string'], 'Parent timeline ID for conversation Tasks.'),
        kind: nullableOutput('string', 'Task kind.'),
        agent_type: nullableOutput('string', 'Agent type for agent-created Tasks.'),
        agent_output: nullableOutput(['object', 'array', 'string', 'number', 'boolean'], 'Safe structured agent output when available.'),
        actions: nullableOutput('array', 'Available Task actions when present.', {
            items: outputField('object', 'One Task action.', { additionalProperties: true }),
        }),
        assignee_name: nullableOutput('string', 'Assignee display name.'),
        assignee_email: nullableOutput('string', 'Assignee email.'),
        author_name: nullableOutput('string', 'Author display name.'),
        parent_type: nullableOutput('string', 'Parent entity kind.', {
            enum: ['job', 'lead', 'estimate', 'invoice', 'contact', 'timeline', null],
        }),
        parent_id: nullableOutput(['integer', 'string'], 'Parent entity ID.'),
        parent_label: nullableOutput('string', 'Human-readable parent label.'),
    };
}

function listTasksOutputSchema() {
    return outputField('object', 'A page of visible Tasks and pagination metadata.', {
        additionalProperties: false,
        properties: {
            tasks: outputField('array', 'Task rows for this page. This key is `tasks`, not `results`.', {
                items: outputField('object', 'One visible Task row.', {
                    additionalProperties: false,
                    properties: taskOutputProperties(),
                }),
            }),
            pagination: paginationOutputSchema(),
        },
    });
}

function estimateSummaryOutputProperties() {
    return {
        id: outputField(['integer', 'string'], 'Albusto Estimate ID. Live PostgreSQL BIGINT values are serialized as decimal strings; sandbox fixtures may use integers.'),
        estimate_number: outputField('string', 'Human-readable Estimate number.'),
        status: outputField('string', 'Current Estimate status.', {
            enum: APP_RUNTIME_ESTIMATE_STATUSES,
        }),
        subtotal: outputField(['string', 'number'], 'Estimate subtotal before tax.'),
        tax_amount: outputField(['string', 'number'], 'Estimate tax amount.'),
        total: outputField(['string', 'number'], 'Estimate total including tax.'),
        contact_id: nullableOutput(['integer', 'string'], 'Linked Contact ID, when one exists.'),
        job_id: nullableOutput(['integer', 'string'], 'Linked Job ID, when one exists.'),
        lead_id: nullableOutput(['integer', 'string'], 'Linked Lead ID, when one exists.'),
        accepted_at: nullableOutput('string', 'Approval timestamp in ISO 8601 format; null until the Estimate is approved.', { format: 'date-time' }),
        created_at: outputField('string', 'Creation timestamp in ISO 8601 format.', { format: 'date-time' }),
        items_count: outputField('integer', 'Number of line items on the Estimate.'),
        order_list_count: outputField('integer', 'Number of internal parts-to-order rows. This can be zero.'),
    };
}

function estimateItemOutputSchema() {
    return outputField('object', 'One customer-facing Estimate line item.', {
        additionalProperties: false,
        properties: {
            name: outputField('string', 'Line-item name.'),
            description: nullableOutput('string', 'Line-item description, when present.'),
            quantity: outputField(['string', 'number'], 'Line-item quantity.'),
            unit: nullableOutput('string', 'Unit label, when present.'),
            unit_price: outputField(['string', 'number'], 'Price per unit.'),
            amount: outputField(['string', 'number'], 'Extended line amount.'),
            item_type: nullableOutput('string', 'Line-item type, when classified.'),
        },
    });
}

function estimateOrderListOutputSchema() {
    return outputField('object', 'One internal part that must be ordered.', {
        additionalProperties: false,
        properties: {
            part_number: outputField('string', 'Manufacturer or distributor part number.'),
            part_name: outputField('string', 'English part name.'),
            quantity: outputField('number', 'Quantity to order.'),
        },
    });
}

function listEstimatesOutputSchema() {
    return outputField('object', 'A page of company-owned Estimates and pagination metadata.', {
        additionalProperties: false,
        properties: {
            results: outputField('array', 'Estimate summary rows for this page.', {
                items: outputField('object', 'One company-owned Estimate summary.', {
                    additionalProperties: false,
                    properties: estimateSummaryOutputProperties(),
                }),
            }),
            pagination: outputField('object', 'Offset pagination metadata for the returned Estimate page.', {
                additionalProperties: false,
                properties: {
                    mode: outputField('string', 'Pagination mode. Estimate pages always use `offset`.', {
                        enum: ['offset'],
                    }),
                    limit: outputField('integer', 'Applied page size.'),
                    returned: outputField('integer', 'Number of Estimate rows in this page.'),
                    has_more: outputField('boolean', 'Whether another Estimate page exists.'),
                    next_cursor: nullableOutput('string', 'Always null because Estimate pages use offset pagination.'),
                    total: outputField('integer', 'Total matching Estimates.'),
                },
            }),
        },
    });
}

function getEstimateOutputSchema() {
    return outputField('object', 'One company-owned Estimate with line items and its internal parts-to-order list.', {
        additionalProperties: false,
        properties: {
            ...estimateSummaryOutputProperties(),
            items: outputField('array', 'Customer-facing Estimate line items in their saved display order. This array may be empty.', {
                items: estimateItemOutputSchema(),
            }),
            order_list: outputField('array', 'Internal parts-to-order rows. This array may be empty.', {
                items: estimateOrderListOutputSchema(),
            }),
        },
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
