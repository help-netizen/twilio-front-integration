'use strict';

const jobsService = require('./jobsService');
const leadsService = require('./leadsService');
const contactsService = require('./contactsService');
const scheduleService = require('./scheduleService');
const fsmService = require('./fsmService');
const tasksQueries = require('../db/tasksQueries');
const queries = require('../db/chatgptMcpQueries');
const { resolveProviderScope } = require('../middleware/providerScope');
const { CrmServiceError } = require('./crmErrors');

class ChatgptMcpReadError extends CrmServiceError {
    constructor(code, message, httpStatus = 400) {
        super(code, message, httpStatus);
        this.name = 'ChatgptMcpReadError';
    }
}

function requireCompanyId(companyId) {
    if (!companyId) throw new ChatgptMcpReadError('TENANT_CONTEXT_REQUIRED', 'Company context required', 403);
}

function notFound(entity) {
    throw new ChatgptMcpReadError('NOT_FOUND', `${entity} not found`, 404);
}

const SENSITIVE_KEYS = /(secret|password|access.?token|refresh.?token|public.?token|api.?key)/i;
const RAW_KEYS = new Set(['zb_raw', 'zenbooker_data']);
const CALL_FIELDS = Object.freeze([
    'id',
    'direction',
    'status',
    'started_at',
    'answered_at',
    'ended_at',
    'duration_sec',
    'from_number',
    'to_number',
    'contact_id',
    'contact_name',
    'answered_by',
]);

function safeResult(value) {
    if (Array.isArray(value)) return value.map(safeResult);
    if (!value || typeof value !== 'object') return value;
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_KEYS.test(key) || RAW_KEYS.has(key)) continue;
        clean[key] = safeResult(child);
    }
    return clean;
}

function projectCall(row) {
    return Object.fromEntries(CALL_FIELDS.map((key) => [key, row?.[key] ?? null]));
}

async function transitions(companyId, machineKey, currentState, ownerRoleKey) {
    if (!currentState) return notFound(machineKey === 'job' ? 'Job' : 'Lead');
    if (!ownerRoleKey) {
        throw new ChatgptMcpReadError('MCP_BINDING_INVALID', 'Avatar owner role is required.', 403);
    }
    const result = await fsmService.getAvailableActions(
        companyId,
        machineKey,
        currentState,
        [ownerRoleKey]
    );
    if (result.fallback) return { workflow_available: false, actions: [] };
    return { workflow_available: true, actions: result.actions || [] };
}

function listFilters(args = {}) {
    return {
        limit: args.limit,
        offset: args.offset,
        search: args.search,
    };
}

async function execute(handler, context, args = {}) {
    const companyId = context?.companyId;
    requireCompanyId(companyId);
    const providerScope = resolveProviderScope(context.ownerScopes, context.ownerUserId);
    const ownerPermissions = new Set(context.ownerPermissions || []);
    let result;
    switch (handler) {
        case 'listJobs':
            result = await jobsService.listJobs({
                companyId,
                ...listFilters(args),
                blancStatus: args.status,
                startDate: args.start_date,
                endDate: args.end_date,
                onlyOpen: args.only_open,
                sortBy: 'updated_at',
                sortOrder: 'desc',
                providerScope,
            });
            break;
        case 'getJob':
            result = await jobsService.getJobById(args.job_id, companyId, providerScope);
            if (!result) notFound('Job');
            break;
        case 'getJobTransitions': {
            const job = await jobsService.getJobById(args.job_id, companyId, providerScope);
            if (!job) notFound('Job');
            result = await transitions(
                companyId,
                'job',
                job.blanc_status,
                context.ownerRoleKey
            );
            break;
        }
        case 'listLeads':
            result = await leadsService.listLeads({
                companyId,
                ...listFilters(args),
                status: args.status ? [args.status] : undefined,
                source: args.source ? [args.source] : undefined,
                only_open: args.only_open !== false,
                sort_by: 'CreatedDate',
                sort_order: 'desc',
            });
            break;
        case 'getLead':
            result = await queries.getLead(companyId, args.lead_uuid);
            if (!result) notFound('Lead');
            break;
        case 'getLeadTransitions': {
            const lead = await queries.getLead(companyId, args.lead_uuid);
            if (!lead) notFound('Lead');
            result = await transitions(
                companyId,
                'lead',
                lead.status,
                context.ownerRoleKey
            );
            break;
        }
        case 'searchContacts':
            result = await contactsService.listContacts({
                companyId,
                ...listFilters(args),
                providerScope,
            });
            break;
        case 'getContact': {
            const visible = await contactsService.getById(
                args.contact_id,
                companyId,
                providerScope
            );
            if (!visible) notFound('Contact');
            result = await queries.getContact(companyId, args.contact_id);
            if (!result) notFound('Contact');
            break;
        }
        case 'getContactHistory': {
            const visible = await contactsService.getById(
                args.contact_id,
                companyId,
                providerScope
            );
            if (!visible) notFound('Contact');
            result = await queries.getContactHistory(companyId, args.contact_id, args.limit);
            if (!result) notFound('Contact');
            break;
        }
        case 'listSchedule':
            result = await scheduleService.getScheduleItems(companyId, {
                startDate: args.start_date,
                endDate: args.end_date,
                entityTypes: args.entity_types,
                statuses: args.statuses,
                assigneeId: args.assignee_id,
                unassignedOnly: args.unassigned_only,
                search: args.search,
                limit: args.limit,
                offset: args.offset,
            }, providerScope);
            break;
        case 'getScheduleItem':
            try {
                result = await scheduleService.getScheduleItemDetail(
                    companyId,
                    args.entity_type,
                    args.entity_id,
                    providerScope
                );
            } catch (err) {
                if (err?.code === 'NOT_FOUND') notFound('Schedule item');
                throw err;
            }
            break;
        case 'listTasks':
            result = await tasksQueries.listTasksPage(companyId, {
                status: args.status === 'all' ? undefined : (args.status || 'open'),
                parent_type: args.parent_type,
                overdue: args.overdue,
                due_from: args.due_from,
                due_to: args.due_to,
                search: args.search,
                limit: args.limit,
                offset: args.offset,
                sort_by: 'due_at',
                sort_order: 'asc',
                ...(!ownerPermissions.has('tasks.manage')
                    ? { scopeOwnerId: context.ownerUserId }
                    : {}),
            });
            break;
        case 'listEntityTasks': {
            const exists = args.parent_type === 'job'
                ? await tasksQueries.jobParentVisible(
                    companyId,
                    args.parent_id,
                    providerScope
                )
                : await tasksQueries.parentExists(
                    companyId,
                    args.parent_type,
                    args.parent_id
                );
            if (!exists) notFound(args.parent_type === 'job' ? 'Job' : 'Lead');
            result = {
                tasks: await tasksQueries.listEntityTasks(companyId, {
                    parentType: args.parent_type,
                    parentId: args.parent_id,
                    includeDone: args.include_done === true,
                }),
            };
            break;
        }
        case 'listTaskAssignees':
            result = await queries.listAssignees(companyId, args.limit);
            break;
        case 'listCalls': {
            const page = await queries.listCalls(companyId, args, providerScope);
            result = {
                rows: (page.rows || []).map(projectCall),
                total: page.total || 0,
            };
            break;
        }
        case 'listEstimates':
            result = await queries.listEstimates(companyId, args);
            break;
        case 'getEstimate':
            result = await queries.getEstimate(companyId, args.estimate_id);
            if (!result) notFound('Estimate');
            break;
        case 'listInvoices':
            result = await queries.listInvoices(companyId, args);
            break;
        case 'getInvoice':
            result = await queries.getInvoice(companyId, args.invoice_id);
            if (!result) notFound('Invoice');
            break;
        default:
            throw new ChatgptMcpReadError('UNSUPPORTED_TOOL', 'Unsupported read handler', 404);
    }
    return safeResult(result);
}

module.exports = {
    ChatgptMcpReadError,
    execute,
    safeResult,
};
