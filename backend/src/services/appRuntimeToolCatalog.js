'use strict';

const registry = require('./agentSkillsMcpRegistry');
const { appRuntimeError } = require('./appRuntimeErrors');

const EXPECTED_HANDLERS = Object.freeze({
    'svc.list_jobs': 'listJobs',
    'svc.get_job': 'getJob',
    'svc.list_tasks': 'listTasks',
    'svc.list_estimates': 'listEstimates',
    'svc.get_estimate': 'getEstimate',
});
const TOOL_NAMES = Object.freeze(Object.keys(EXPECTED_HANDLERS));
const BUSINESS_PERMISSIONS = Object.freeze({
    'svc.list_jobs': 'jobs.view',
    'svc.get_job': 'jobs.view',
    'svc.list_tasks': 'tasks.view',
    'svc.list_estimates': 'estimates.view',
    'svc.get_estimate': 'estimates.view',
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
    const descriptor = registry.getTool(name);
    if (!descriptor
        || descriptor.name !== name
        || descriptor.kind !== 'read'
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
    EXPECTED_HANDLERS,
    BUSINESS_PERMISSIONS,
    listTools,
    getTool,
    requireTool,
};
