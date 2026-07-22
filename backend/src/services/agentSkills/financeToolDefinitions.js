'use strict';

const VAPI_TOOL_SERVER_URL = 'https://api.albusto.com/api/vapi-tools';
const VAPI_TOOL_SECRET_PLACEHOLDER = 'REPLACE_WITH_VAPI_TOOLS_SECRET';

const IDENTITY_FIELDS = Object.freeze({
    phone: Object.freeze({ type: 'string', description: 'Caller phone. Voice supplies this automatically.' }),
    name: Object.freeze({ type: 'string', description: 'Optional caller name; never required for finance disclosure.' }),
    zip: Object.freeze({ type: 'string', description: 'Optional ZIP; never required for finance disclosure.' }),
    street: Object.freeze({ type: 'string', description: 'Optional street; never required for finance disclosure.' }),
    contactId: Object.freeze({ type: 'string', description: 'Optional contact selector. It is never accepted as proof or tenant scope.' }),
});

const SUBJECT_FIELDS = Object.freeze({
    jobId: Object.freeze({ type: 'string', description: 'Specific repair/job being discussed. Use it when known.' }),
    leadId: Object.freeze({ type: 'string', description: 'Numeric lead/request being discussed, if known.' }),
    leadUuid: Object.freeze({ type: 'string', description: 'Lead/request UUID being discussed, if known.' }),
});

const FINANCE_TOOL_DEFINITIONS = Object.freeze([
    Object.freeze({
        skillName: 'getEstimateSummary',
        mcpName: 'svc.get_estimate_summary',
        kind: 'read',
        requiredLevel: 'L1',
        requiredPermissions: Object.freeze(['estimates.view']),
        documentField: 'estimateId',
        documentFieldDescription: 'Specific estimate to summarize, if known.',
        description:
            'Get the sent or approved estimate for this customer and repair, including up to five customer-facing line items and totals. Phone match (L1) is sufficient. Draft estimates are never disclosed. A shared phone requires an unambiguous repair subject.',
    }),
    Object.freeze({
        skillName: 'getInvoiceSummary',
        mcpName: 'svc.get_invoice_summary',
        kind: 'read',
        requiredLevel: 'L1',
        requiredPermissions: Object.freeze(['invoices.view']),
        documentField: 'invoiceId',
        documentFieldDescription: 'Specific invoice to summarize, if known.',
        description:
            'Get the invoice for this customer and repair, including up to five customer-facing line items, total, paid, and due. Phone match (L1) is sufficient. Draft invoices are never disclosed. A shared phone requires an unambiguous repair subject. Never collects payment data.',
    }),
]);

const BY_SKILL = new Map(FINANCE_TOOL_DEFINITIONS.map((definition) => [definition.skillName, definition]));
const BY_MCP = new Map(FINANCE_TOOL_DEFINITIONS.map((definition) => [definition.mcpName, definition]));

function cloneSchema(schema) {
    return JSON.parse(JSON.stringify(schema));
}

function camelToSnake(value) {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function financeProperties(definition, { snakeCase = false, includeIdentity = true } = {}) {
    const source = {
        ...(includeIdentity ? IDENTITY_FIELDS : {}),
        ...SUBJECT_FIELDS,
        [definition.documentField]: {
            type: 'string',
            description: definition.documentFieldDescription,
        },
    };
    const entries = Object.entries(source).map(([name, schema]) => [snakeCase ? camelToSnake(name) : name, cloneSchema(schema)]);
    return Object.fromEntries(entries);
}

function buildVapiTool(definition, options = {}) {
    const url = options.serverUrl || VAPI_TOOL_SERVER_URL;
    const secret = options.serverSecret || VAPI_TOOL_SECRET_PLACEHOLDER;
    return {
        type: 'function',
        server: { url, secret },
        function: {
            name: definition.skillName,
            parameters: {
                type: 'object',
                required: [],
                properties: financeProperties(definition, { includeIdentity: false }),
            },
            description: definition.description,
        },
    };
}

function buildVapiFinanceTools(options = {}) {
    return FINANCE_TOOL_DEFINITIONS.map((definition) => buildVapiTool(definition, options));
}

function buildMcpInputSchema(definition) {
    return {
        type: 'object',
        additionalProperties: true,
        properties: financeProperties(definition, { snakeCase: true, includeIdentity: true }),
        required: [],
    };
}

function getFinanceDefinitionBySkill(skillName) {
    return BY_SKILL.get(skillName) || null;
}

function getFinanceDefinitionByMcp(mcpName) {
    return BY_MCP.get(mcpName) || null;
}

function isFinanceSkill(skillName) {
    return BY_SKILL.has(skillName);
}

module.exports = {
    VAPI_TOOL_SERVER_URL,
    VAPI_TOOL_SECRET_PLACEHOLDER,
    FINANCE_TOOL_DEFINITIONS,
    buildVapiFinanceTools,
    buildMcpInputSchema,
    getFinanceDefinitionBySkill,
    getFinanceDefinitionByMcp,
    isFinanceSkill,
};
