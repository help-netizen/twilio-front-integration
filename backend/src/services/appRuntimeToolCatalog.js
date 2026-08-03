'use strict';

const registry = require('./agentSkillsMcpRegistry');
const { appRuntimeError } = require('./appRuntimeErrors');

const EXPECTED_HANDLERS = Object.freeze({
    'svc.list_jobs': 'listJobs',
    'svc.get_job': 'getJob',
    'svc.list_tasks': 'listTasks',
    'svc.create_task': 'createTask',
    'svc.list_estimates': 'listEstimates',
    'svc.get_estimate': 'getEstimate',
    'svc.add_note': 'addNote',
    'svc.list_leads': 'listLeads',
    'svc.get_lead': 'getLead',
    'svc.list_invoices': 'listInvoices',
    'svc.list_payments': 'listPayments',
});
const TOOL_NAMES = Object.freeze(Object.keys(EXPECTED_HANDLERS));
const WRITE_TOOLS = Object.freeze(['svc.create_task', 'svc.add_note']);
const BUSINESS_PERMISSIONS = Object.freeze({
    'svc.list_jobs': 'jobs.view',
    'svc.get_job': 'jobs.view',
    'svc.list_tasks': 'tasks.view',
    'svc.create_task': 'tasks.create',
    'svc.list_estimates': 'estimates.view',
    'svc.get_estimate': 'estimates.view',
    'svc.add_note': 'jobs.edit or jobs.done_pending_approval or leads.edit',
    'svc.list_leads': 'leads.view',
    'svc.get_lead': 'leads.view',
    'svc.list_invoices': 'invoices.view',
    'svc.list_payments': 'payments.view or financial_data.view',
});
const BUSINESS_PERMISSION_RULES = Object.freeze({
    ...Object.fromEntries(Object.entries(BUSINESS_PERMISSIONS).map(([name, permission]) => [
        name,
        Object.freeze({ any: Object.freeze([permission]) }),
    ])),
    'svc.add_note': Object.freeze({
        byParent: Object.freeze({
            job: Object.freeze({ any: Object.freeze(['jobs.edit', 'jobs.done_pending_approval']) }),
            lead: Object.freeze({ any: Object.freeze(['leads.edit']) }),
        }),
        any: Object.freeze(['jobs.edit', 'jobs.done_pending_approval', 'leads.edit']),
    }),
    'svc.list_payments': Object.freeze({
        any: Object.freeze(['payments.view', 'financial_data.view']),
    }),
});

function schemaHasUrlField(schema) {
    if (!schema || typeof schema !== 'object') return false;
    for (const [key, value] of Object.entries(schema.properties || {})) {
        if (/(^|_)(url|uri|href)($|_)/i.test(key)) return true;
        if (schemaHasUrlField(value)) return true;
    }
    if (schema.items && schemaHasUrlField(schema.items)) return true;
    return false;
}

function projectDescriptor(name) {
    const sourceDescriptor = registry.getTool(name);
    const descriptor = sourceDescriptor
        ? { ...sourceDescriptor, ...(sourceDescriptor.appRuntime || {}) }
        : null;
    const expectedKind = WRITE_TOOLS.includes(name) ? 'write' : 'read';
    if (!descriptor
        || descriptor.name !== name
        || descriptor.kind !== expectedKind
        || descriptor.handler !== EXPECTED_HANDLERS[name]
        || descriptor.inputSchema?.type !== 'object'
        || descriptor.inputSchema?.additionalProperties !== false
        || descriptor.outputSchema?.type !== 'object'
        || descriptor.outputSchema?.additionalProperties !== false
        || !descriptor.documentation
        || schemaHasUrlField(descriptor.inputSchema)) {
        throw new Error(`APP_RUNTIME_CATALOG_DRIFT: ${name}`);
    }
    return Object.freeze({
        name: descriptor.name,
        kind: descriptor.kind,
        handler: descriptor.handler,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema,
        documentation: descriptor.documentation,
        businessPermission: BUSINESS_PERMISSIONS[name],
        businessPermissions: BUSINESS_PERMISSION_RULES[name],
    });
}

const CATALOG = Object.freeze(TOOL_NAMES.map(projectDescriptor));
const BY_NAME = new Map(CATALOG.map((tool) => [tool.name, tool]));

function listTools() {
    return CATALOG.map((tool) => ({
        ...tool,
        inputSchema: { ...tool.inputSchema },
        outputSchema: { ...tool.outputSchema },
        documentation: {
            ...tool.documentation,
            responseNotes: [...tool.documentation.responseNotes],
            errors: tool.documentation.errors.map(error => ({ ...error })),
            examples: tool.documentation.examples.map(example => ({ ...example })),
        },
    }));
}

function getTool(name) {
    return BY_NAME.get(name) || null;
}

function requireTool(name) {
    const tool = getTool(name);
    if (!tool) {
        throw appRuntimeError('TOOL_NOT_FOUND', 'Tool not found.', 404);
    }
    return tool;
}

module.exports = {
    TOOL_NAMES,
    WRITE_TOOLS,
    EXPECTED_HANDLERS,
    BUSINESS_PERMISSIONS,
    BUSINESS_PERMISSION_RULES,
    projectDescriptor,
    listTools,
    getTool,
    requireTool,
};
