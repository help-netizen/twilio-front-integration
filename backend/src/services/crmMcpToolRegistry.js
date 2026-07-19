'use strict';

const SALES_WORKFLOW_KEYS = Object.freeze([
    'my_open_deals',
    'deals_closing_this_month',
    'deals_closing_this_quarter',
    'deals_without_activity',
    'deals_without_next_step',
    'risky_deals',
    'top_accounts_by_pipeline',
    'accounts_needing_follow_up',
    'contacts_missing_role_title_email',
    'tasks_due_this_week',
]);

const TOOL_PERMISSION_MAP = Object.freeze({
    'crm.search_accounts': ['contacts.view'],
    'crm.get_account': ['contacts.view'],
    'crm.find_stale_accounts': ['contacts.view'],
    'crm.search_contacts': ['contacts.view'],
    'crm.get_contact': ['contacts.view'],
    'crm.get_key_contacts': ['contacts.view'],
    'crm.search_deals': ['leads.view'],
    'crm.get_deal': ['leads.view'],
    'crm.get_attention_deals': ['leads.view'],
    'crm.get_pipeline': ['leads.view'],
    'crm.get_pipeline_by_owner': ['leads.view'],
    'crm.get_pipeline_by_team': ['leads.view'],
    'crm.get_pipeline_by_period': ['leads.view'],
    'crm.group_pipeline_by_stage': ['leads.view'],
    'crm.group_pipeline_by_forecast_category': ['leads.view'],
    'crm.get_forecast_totals': ['leads.view'],
    'crm.get_pipeline_changes': ['leads.view'],
    'crm.get_pipeline_risky_deals': ['leads.view'],
    'crm.get_pipeline_slippage': ['leads.view'],
    'crm.list_activities': ['contacts.view'],
    'crm.list_tasks': ['tasks.view'],
    'crm.list_notes': ['contacts.view'],
    'crm.get_metadata': ['contacts.view'],
    'crm.list_sales_workflows': ['contacts.view'],
    'crm.get_sales_list': ['contacts.view'],
    'crm.list_my_open_deals': ['leads.view'],
    'crm.get_last_customer_facing_activity': ['contacts.view'],
    'crm.find_deals_without_next_step': ['leads.view'],
    'crm.find_overdue_close_date_deals': ['leads.view'],
    'crm.find_deals_without_activity': ['leads.view'],
    'crm.find_deals_closing_between': ['leads.view'],
    'crm.find_deals_closing_this_month': ['leads.view'],
    'crm.find_deals_closing_this_quarter': ['leads.view'],
    'crm.find_risky_deals': ['leads.view'],
    'crm.top_accounts_by_pipeline': ['contacts.view'],
    'crm.accounts_needing_follow_up': ['contacts.view'],
    'crm.contacts_missing_role_title_email': ['contacts.view'],
    'crm.tasks_due_this_week': ['tasks.view'],
    'crm.find_overdue_tasks': ['tasks.view'],
    'crm.get_deal_history': ['leads.view'],
    'crm.update_deal_field': ['sales.crm.write'],
    'crm.update_deal_next_step': ['sales.crm.write'],
    'crm.update_deal_stage': ['sales.crm.write'],
    'crm.update_deal_forecast_category': ['sales.crm.write'],
    'crm.update_deal_close_date': ['sales.crm.write'],
    'crm.update_deal_amount': ['sales.crm.write'],
    'crm.update_deal_risk_summary': ['sales.crm.write'],
    'crm.update_deal_competitor': ['sales.crm.write'],
    'crm.create_task': ['sales.crm.write'],
    'crm.update_task_status': ['sales.crm.write'],
    'crm.create_note': ['sales.crm.write'],
});

const READ_TOOLS = [
    {
        name: 'crm.search_accounts',
        description: 'Search CRM accounts by text, domain, segment, or owner.',
        inputSchema: objectSchema({
            q: stringSchema(),
            domain: stringSchema(),
            icp_segment: stringSchema(),
            owner_user_id: stringSchema(),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }),
    },
    {
        name: 'crm.get_account',
        description: 'Get a CRM account card with linked contacts, deals, activities, and tasks.',
        inputSchema: objectSchema({ account_id: integerSchema(1) }, ['account_id']),
    },
    {
        name: 'crm.find_stale_accounts',
        description: 'Find accounts without CRM activity for N days.',
        inputSchema: objectSchema({
            days: integerSchema(1),
            owner_user_id: stringSchema(),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }, ['days']),
    },
    {
        name: 'crm.search_contacts',
        description: 'Search CRM contacts by name, email, account/company, or title.',
        inputSchema: objectSchema({
            q: stringSchema(),
            email: stringSchema(),
            company: stringSchema(),
            title: stringSchema(),
            account_id: integerSchema(1),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }),
    },
    {
        name: 'crm.get_contact',
        description: 'Get a CRM contact card with account links, deal roles, and communication history.',
        inputSchema: objectSchema({
            contact_id: integerSchema(1),
            account_id: integerSchema(1),
            deal_id: integerSchema(1),
        }, ['contact_id']),
    },
    {
        name: 'crm.get_key_contacts',
        description: 'Get key contacts for an account.',
        inputSchema: objectSchema({ account_id: integerSchema(1) }, ['account_id']),
    },
    {
        name: 'crm.search_deals',
        description: 'Search CRM deals by name, account, owner, stage, forecast category, or close-date window.',
        inputSchema: objectSchema({
            q: stringSchema(),
            account_id: integerSchema(1),
            owner_user_id: stringSchema(),
            stage: stringSchema(),
            forecast_category: stringSchema(),
            close_from: dateSchema(),
            close_to: dateSchema(),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }),
    },
    {
        name: 'crm.get_deal',
        description: 'Get a CRM deal card with contacts, activities, tasks, notes, and history.',
        inputSchema: objectSchema({ deal_id: integerSchema(1) }, ['deal_id']),
    },
    {
        name: 'crm.get_attention_deals',
        description: 'Get deals requiring attention this week.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.get_pipeline',
        description: 'Get pipeline by owner, team, and period with forecast grouping and slippage.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.get_pipeline_by_owner',
        description: 'Get pipeline analytics scoped to one owner.',
        inputSchema: objectSchema(pipelineFilterProperties(), ['owner_user_id']),
    },
    {
        name: 'crm.get_pipeline_by_team',
        description: 'Get pipeline analytics scoped to one team.',
        inputSchema: objectSchema(pipelineFilterProperties(), ['team_id']),
    },
    {
        name: 'crm.get_pipeline_by_period',
        description: 'Get pipeline analytics scoped to a close-date period.',
        inputSchema: objectSchema(pipelineFilterProperties(), ['period_start', 'period_end']),
    },
    {
        name: 'crm.group_pipeline_by_stage',
        description: 'Group open pipeline by stage with amount and weighted amount.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.group_pipeline_by_forecast_category',
        description: 'Group open pipeline by forecast category with amount and weighted amount.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.get_forecast_totals',
        description: 'Get total pipeline, weighted pipeline, commit, best case, and forecast pipeline totals.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.get_pipeline_changes',
        description: 'Get pipeline changes since a timestamp, defaulting to the last week.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.get_pipeline_risky_deals',
        description: 'Get risky pipeline deals within owner, team, and period filters.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.get_pipeline_slippage',
        description: 'Get pipeline slippage from close-date pushes, amount decreases, and stage regressions.',
        inputSchema: objectSchema(pipelineFilterProperties()),
    },
    {
        name: 'crm.list_activities',
        description: 'List CRM activities by account, deal, contact, type, or text search.',
        inputSchema: objectSchema({
            account_id: integerSchema(1),
            deal_id: integerSchema(1),
            contact_id: integerSchema(1),
            type: enumSchema(['email', 'call', 'meeting', 'note', 'task', 'stage_change']),
            q: stringSchema(),
            customer_facing: booleanSchema(),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }),
    },
    {
        name: 'crm.list_tasks',
        description: 'List CRM tasks by owner, linked entity, status, or due-date window.',
        inputSchema: objectSchema({
            owner_user_id: stringSchema(),
            account_id: integerSchema(1),
            deal_id: integerSchema(1),
            contact_id: integerSchema(1),
            status: stringSchema(),
            due_from: stringSchema(),
            due_to: stringSchema(),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }),
    },
    {
        name: 'crm.list_notes',
        description: 'List CRM notes by linked entity and source.',
        inputSchema: objectSchema({
            entity_type: enumSchema(['account', 'deal', 'contact']),
            entity_id: integerSchema(1),
            source: enumSchema(['manual', 'meeting_follow_up', 'forecast_review', 'deal_strategy']),
            limit: integerSchema(1, 100),
            offset: integerSchema(0),
        }, ['entity_type', 'entity_id']),
    },
    {
        name: 'crm.get_metadata',
        description: 'Get CRM metadata: pipeline stages, forecast categories, owners, activity types, task statuses, and stage rules.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.list_sales_workflows',
        description: 'List predefined Sales workflow selections and their matching MCP tools.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.get_sales_list',
        description: 'Get a predefined Sales workflow list.',
        inputSchema: objectSchema({
            list_key: enumSchema(SALES_WORKFLOW_KEYS),
            owner_user_id: stringSchema(),
            days: integerSchema(1),
            limit: integerSchema(1, 100),
        }, ['list_key']),
    },
    {
        name: 'crm.list_my_open_deals',
        description: 'Get open deals owned by the current user unless owner_user_id is explicitly supplied.',
        inputSchema: objectSchema({
            owner_user_id: stringSchema(),
            limit: integerSchema(1, 100),
        }),
    },
    {
        name: 'crm.get_last_customer_facing_activity',
        description: 'Get the latest customer-facing activity for an account, deal, or contact.',
        inputSchema: objectSchema({
            entity_type: enumSchema(['account', 'deal', 'contact']),
            entity_id: integerSchema(1),
        }, ['entity_type', 'entity_id']),
    },
    {
        name: 'crm.find_deals_without_next_step',
        description: 'Find open deals without a next step.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.find_overdue_close_date_deals',
        description: 'Find open deals with a close date before today.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.find_deals_without_activity',
        description: 'Find open deals without activity for N days, defaulting to the Sales workflow inactivity window.',
        inputSchema: objectSchema({ days: integerSchema(1) }),
    },
    {
        name: 'crm.find_deals_closing_between',
        description: 'Find open deals closing in a date window.',
        inputSchema: objectSchema({
            from_date: dateSchema(),
            to_date: dateSchema(),
        }, ['from_date', 'to_date']),
    },
    {
        name: 'crm.find_deals_closing_this_month',
        description: 'Find open deals closing this month.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.find_deals_closing_this_quarter',
        description: 'Find open deals closing this quarter.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.find_risky_deals',
        description: 'Find open deals with risk or blocker summaries.',
        inputSchema: objectSchema({ limit: integerSchema(1, 100) }),
    },
    {
        name: 'crm.top_accounts_by_pipeline',
        description: 'List top accounts by open pipeline amount.',
        inputSchema: objectSchema({ limit: integerSchema(1, 100) }),
    },
    {
        name: 'crm.accounts_needing_follow_up',
        description: 'Find accounts needing follow-up based on activity inactivity.',
        inputSchema: objectSchema({
            days: integerSchema(1),
            owner_user_id: stringSchema(),
            limit: integerSchema(1, 100),
        }),
    },
    {
        name: 'crm.contacts_missing_role_title_email',
        description: 'Find contacts missing role, title, or email for Sales workflows.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.tasks_due_this_week',
        description: 'Find open CRM tasks due this week.',
        inputSchema: objectSchema({}),
    },
    {
        name: 'crm.find_overdue_tasks',
        description: 'Find overdue open CRM tasks.',
        inputSchema: objectSchema({
            owner_user_id: stringSchema(),
            limit: integerSchema(1, 100),
        }),
    },
    {
        name: 'crm.get_deal_history',
        description: 'Get deal field history for a deal.',
        inputSchema: objectSchema({ deal_id: integerSchema(1) }, ['deal_id']),
    },
];

const ALLOWED_DEAL_UPDATE_FIELDS = Object.freeze([
    'next_step',
    'stage',
    'forecast_category',
    'close_date',
    'amount',
    'risk_summary',
    'competitor',
]);

const WRITE_TOOLS = [
    {
        name: 'crm.update_deal_field',
        description: 'Update one allowlisted deal field and return before/after values.',
        inputSchema: objectSchema({
            deal_id: integerSchema(1),
            field: enumSchema(ALLOWED_DEAL_UPDATE_FIELDS),
            value: {},
        }, ['deal_id', 'field', 'value']),
    },
    dealFieldWriteTool('crm.update_deal_next_step', 'next_step', nullable(stringSchema())),
    dealFieldWriteTool('crm.update_deal_stage', 'stage', stringSchema()),
    dealFieldWriteTool('crm.update_deal_forecast_category', 'forecast_category', nullable(stringSchema())),
    dealFieldWriteTool('crm.update_deal_close_date', 'close_date', nullable(dateSchema())),
    dealFieldWriteTool('crm.update_deal_amount', 'amount', nullable(numberSchema(0))),
    dealFieldWriteTool('crm.update_deal_risk_summary', 'risk_summary', nullable(stringSchema())),
    dealFieldWriteTool('crm.update_deal_competitor', 'competitor', nullable(stringSchema())),
    {
        name: 'crm.create_task',
        description: 'Create a CRM task linked to an account, deal, contact, or Pulse thread.',
        inputSchema: objectSchema({
            title: stringSchema(),
            description: stringSchema(),
            due_at: stringSchema(),
            owner_user_id: stringSchema(),
            account_id: integerSchema(1),
            deal_id: integerSchema(1),
            contact_id: integerSchema(1),
            thread_id: stringSchema(),
        }, ['title']),
    },
    {
        name: 'crm.update_task_status',
        description: 'Update CRM task status and return before/after values.',
        inputSchema: objectSchema({
            task_id: integerSchema(1),
            status: stringSchema(),
        }, ['task_id', 'status']),
    },
    {
        name: 'crm.create_note',
        description: 'Create a CRM note linked to an account, deal, or contact.',
        inputSchema: objectSchema({
            entity_type: enumSchema(['account', 'deal', 'contact']),
            entity_id: integerSchema(1),
            text: stringSchema(),
            source: enumSchema(['manual', 'meeting_follow_up', 'forecast_review', 'deal_strategy']),
        }, ['entity_type', 'entity_id', 'text', 'source']),
    },
];

const TOOLS = Object.freeze([
    ...READ_TOOLS.map(tool => normalizeTool(tool, 'read')),
    ...WRITE_TOOLS.map(tool => normalizeTool(tool, 'write')),
]);

function stringSchema() {
    return { type: 'string' };
}

function dateSchema() {
    return { type: 'string', format: 'date' };
}

function integerSchema(minimum, maximum) {
    return { type: 'integer', minimum, ...(maximum ? { maximum } : {}) };
}

function numberSchema(minimum, maximum) {
    return { type: 'number', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) };
}

function booleanSchema() {
    return { type: 'boolean' };
}

function enumSchema(values) {
    return { type: 'string', enum: values };
}

function pipelineFilterProperties() {
    return {
        owner_user_id: stringSchema(),
        team_id: stringSchema(),
        period_start: dateSchema(),
        period_end: dateSchema(),
        since: dateTimeSchema(),
    };
}

function dateTimeSchema() {
    return { type: 'string', format: 'date-time' };
}

function objectSchema(properties, required = []) {
    return {
        type: 'object',
        additionalProperties: true,
        properties,
        required,
    };
}

function nullable(schema) {
    return { ...schema, nullable: true };
}

function dealFieldWriteTool(name, field, valueSchema) {
    return {
        name,
        description: `Update deal.${field} and return before/after values.`,
        inputSchema: objectSchema({
            deal_id: integerSchema(1),
            value: valueSchema,
        }, ['deal_id', 'value']),
        updateField: field,
    };
}

function normalizeTool(tool, kind) {
    const requiredPermissions = TOOL_PERMISSION_MAP[tool.name] || [];
    return Object.freeze({
        ...tool,
        kind,
        requiresConfirmation: kind === 'write',
        requiredPermission: requiredPermissions[0] || null,
        requiredPermissions: Object.freeze([...requiredPermissions]),
        frameworkWritePermission: kind === 'write' ? 'sales.crm.write' : null,
    });
}

function listTools(filters = {}) {
    const kind = filters?.kind || null;
    return TOOLS
        .filter(tool => !kind || tool.kind === kind)
        .map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
}

function getTool(name) {
    return TOOLS.find(tool => tool.name === name) || null;
}

module.exports = {
    TOOL_PERMISSION_MAP,
    listTools,
    getTool,
};
