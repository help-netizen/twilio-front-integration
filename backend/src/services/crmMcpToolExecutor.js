'use strict';

const crypto = require('crypto');
const registry = require('./crmMcpToolRegistry');
const mcpResponse = require('./crmMcpResponse');
const accountsService = require('./crmAccountsService');
const contactsService = require('./crmContactsService');
const dealsService = require('./crmDealsService');
const pipelineService = require('./crmPipelineService');
const activitiesService = require('./crmActivitiesService');
const tasksService = require('./crmTasksService');
const notesService = require('./crmNotesService');
const metadataService = require('./crmMetadataService');
const listsService = require('./crmListsService');
const { validateArguments } = require('./crmMcpSchemaValidator');

const WRITE_PERMISSION = 'sales.crm.write';
const DEAL_FIELD_WRITE_TOOLS = Object.freeze({
    'crm.update_deal_next_step': 'next_step',
    'crm.update_deal_stage': 'stage',
    'crm.update_deal_forecast_category': 'forecast_category',
    'crm.update_deal_close_date': 'close_date',
    'crm.update_deal_amount': 'amount',
    'crm.update_deal_risk_summary': 'risk_summary',
    'crm.update_deal_competitor': 'competitor',
});

function ensureRequestId(req) {
    const existing = req.requestId || req.traceId || null;
    if (existing) return existing;
    const generated = `crm-mcp-${crypto.randomUUID()}`;
    req.requestId = generated;
    req.traceId = generated;
    return generated;
}

function buildContext(req) {
    const requestId = ensureRequestId(req);
    return {
        companyId: req.companyFilter?.company_id || null,
        actorId: req.user?.crmUser?.id || null,
        actorEmail: req.user?.email || null,
        actorIp: req.ip || null,
        requestId,
        companyTimezone: req.authz?.company?.timezone || null,
        source: 'Codex/Sales MCP',
        createdBy: req.user ? 'user' : 'system',
        permissions: req.authz?.permissions || [],
    };
}

function contextWithConfirmation(context, confirmation) {
    if (!confirmation) return context;
    return {
        ...context,
        confirmation: {
            confirmationId: confirmation.confirmation_id || null,
            reason: confirmation.reason || null,
        },
    };
}

function requireCompanyContext(context) {
    if (!context.companyId) {
        throw mcpResponse.mcpError('access_denied', 'Company context required', { reason: 'TENANT_CONTEXT_REQUIRED' });
    }
}

function requireWriteAccess(context, tool, confirmation) {
    if (tool.kind !== 'write') return;
    if (!context.permissions.includes(WRITE_PERMISSION)) {
        throw mcpResponse.mcpError('access_denied', 'Insufficient CRM write permission', {
            required_permission: WRITE_PERMISSION,
        });
    }
    if (!confirmation?.confirmed || !confirmation?.confirmation_id) {
        throw mcpResponse.mcpError('confirmation_required', 'Write tool requires explicit confirmation', {
            required: ['confirmed', 'confirmation_id'],
        });
    }
}

function numericId(args, key) {
    const value = Number(args?.[key]);
    if (!Number.isInteger(value) || value < 1) {
        throw mcpResponse.mcpError('invalid_request', `${key} must be a positive integer`, { field: key });
    }
    return value;
}

function argsWithout(source, keys) {
    const result = { ...(source || {}) };
    for (const key of keys) delete result[key];
    return result;
}

function entityFilter(args) {
    return {
        [`${args.entity_type}_id`]: args.entity_id,
    };
}

function isIsoCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateGenericDealFieldValue(field, value) {
    if (value === null) return;
    if (field === 'amount') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw mcpResponse.mcpError('invalid_request', 'value must be a non-negative number for amount', {
                field: 'value',
            });
        }
        return;
    }
    if (field === 'close_date') {
        if (!isIsoCalendarDate(value)) {
            throw mcpResponse.mcpError('invalid_request', 'value must be a valid YYYY-MM-DD date for close_date', {
                field: 'value',
                format: 'YYYY-MM-DD',
            });
        }
        return;
    }
    if (typeof value !== 'string') {
        throw mcpResponse.mcpError('invalid_request', `value must be a string for ${field}`, { field: 'value' });
    }
}

async function execute(req, toolName, toolArguments = {}, confirmation = null) {
    const tool = registry.getTool(toolName);
    if (!tool) {
        throw mcpResponse.mcpError('unsupported_tool', `Unsupported CRM MCP tool: ${toolName || '(missing)'}`, {
            tool: toolName || null,
        });
    }
    const context = buildContext(req);
    requireCompanyContext(context);
    validateArguments(tool, toolArguments || {});
    requireWriteAccess(context, tool, confirmation);
    return dispatch(tool.name, contextWithConfirmation(context, confirmation), toolArguments || {});
}

async function dispatch(toolName, context, args) {
    const companyId = context.companyId;
    if (DEAL_FIELD_WRITE_TOOLS[toolName]) {
        const field = DEAL_FIELD_WRITE_TOOLS[toolName];
        return dealsService.updateDeal(companyId, numericId(args, 'deal_id'), { [field]: args.value }, context);
    }

    switch (toolName) {
        case 'crm.search_accounts':
            return accountsService.listAccounts(companyId, args);
        case 'crm.get_account':
            return accountsService.getAccountCard(companyId, numericId(args, 'account_id'));
        case 'crm.find_stale_accounts':
            return accountsService.getStaleAccounts(companyId, args.days, args);
        case 'crm.search_contacts':
            return contactsService.listContacts(companyId, args);
        case 'crm.get_contact':
            return contactsService.getContactCard(companyId, numericId(args, 'contact_id'), args);
        case 'crm.get_key_contacts':
            return contactsService.getKeyContactsByAccount(companyId, numericId(args, 'account_id'));
        case 'crm.search_deals':
            return dealsService.listDeals(companyId, args);
        case 'crm.get_deal':
            return dealsService.getDealCard(companyId, numericId(args, 'deal_id'));
        case 'crm.get_attention_deals':
            return dealsService.getAttentionDeals(companyId);
        case 'crm.get_pipeline':
            return pipelineService.getPipeline(companyId, args);
        case 'crm.get_pipeline_by_owner':
            return pipelineService.getPipelineByOwner(companyId, args);
        case 'crm.get_pipeline_by_team':
            return pipelineService.getPipelineByTeam(companyId, args);
        case 'crm.get_pipeline_by_period':
            return pipelineService.getPipelineByPeriod(companyId, args);
        case 'crm.group_pipeline_by_stage':
            return pipelineService.getPipelineStageGroups(companyId, args);
        case 'crm.group_pipeline_by_forecast_category':
            return pipelineService.getPipelineForecastGroups(companyId, args);
        case 'crm.get_forecast_totals':
            return pipelineService.getForecastTotals(companyId, args);
        case 'crm.get_pipeline_changes':
            return pipelineService.getPipelineChanges(companyId, args);
        case 'crm.get_pipeline_risky_deals':
            return pipelineService.getPipelineRiskyDeals(companyId, args);
        case 'crm.get_pipeline_slippage':
            return pipelineService.getPipelineSlippage(companyId, args);
        case 'crm.list_activities':
            return activitiesService.listActivities(companyId, args);
        case 'crm.list_tasks':
            return tasksService.listTasks(companyId, args);
        case 'crm.list_notes':
            return notesService.listNotes(companyId, args);
        case 'crm.get_metadata':
            return metadataService.getMetadata(companyId);
        case 'crm.list_sales_workflows':
            return listsService.listWorkflows();
        case 'crm.get_sales_list':
            return listsService.getList(companyId, args.list_key, argsWithout(args, ['list_key']), context);
        case 'crm.list_my_open_deals':
            return listsService.getList(companyId, 'my_open_deals', args, context);
        case 'crm.get_last_customer_facing_activity':
            return activitiesService.getLastCustomerFacing(companyId, entityFilter(args));
        case 'crm.find_deals_without_next_step':
            return dealsService.getDealsWithoutNextStep(companyId);
        case 'crm.find_overdue_close_date_deals':
            return dealsService.getOverdueCloseDateDeals(companyId);
        case 'crm.find_deals_without_activity':
            return listsService.getList(companyId, 'deals_without_activity', args, context);
        case 'crm.find_deals_closing_between':
            return dealsService.getDealsClosingBetween(companyId, args.from_date, args.to_date);
        case 'crm.find_deals_closing_this_month':
            return listsService.getList(companyId, 'deals_closing_this_month', {}, context);
        case 'crm.find_deals_closing_this_quarter':
            return listsService.getList(companyId, 'deals_closing_this_quarter', {}, context);
        case 'crm.find_risky_deals':
            return listsService.getList(companyId, 'risky_deals', args, context);
        case 'crm.top_accounts_by_pipeline':
            return listsService.getList(companyId, 'top_accounts_by_pipeline', args, context);
        case 'crm.accounts_needing_follow_up':
            return listsService.getList(companyId, 'accounts_needing_follow_up', args, context);
        case 'crm.contacts_missing_role_title_email':
            return listsService.getList(companyId, 'contacts_missing_role_title_email', {}, context);
        case 'crm.tasks_due_this_week':
            return listsService.getList(companyId, 'tasks_due_this_week', {}, context);
        case 'crm.find_overdue_tasks':
            return tasksService.listTasks(companyId, { ...args, overdue: true });
        case 'crm.get_deal_history':
            return dealsService.getDealHistory(companyId, numericId(args, 'deal_id'));
        case 'crm.update_deal_field': {
            const field = args.field;
            if (!field) {
                throw mcpResponse.mcpError('invalid_request', 'field is required', { field: 'field' });
            }
            validateGenericDealFieldValue(field, args.value);
            return dealsService.updateDeal(companyId, numericId(args, 'deal_id'), { [field]: args.value }, context);
        }
        case 'crm.create_task':
            return tasksService.createTask(companyId, args, context);
        case 'crm.update_task_status':
            return tasksService.updateTaskStatus(companyId, numericId(args, 'task_id'), args.status, context);
        case 'crm.create_note':
            return notesService.createNote(companyId, args, context);
        default:
            throw mcpResponse.mcpError('unsupported_tool', `Unsupported CRM MCP tool: ${toolName}`, { tool: toolName });
    }
}

module.exports = {
    WRITE_PERMISSION,
    buildContext,
    execute,
};
