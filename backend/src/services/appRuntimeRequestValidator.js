'use strict';

const schemaValidator = require('./crmMcpSchemaValidator');
const { appRuntimeError } = require('./appRuntimeErrors');

const FORBIDDEN_TENANT_KEYS = new Set([
    'companyid',
    'tenantid',
    'organizationid',
    'organisationid',
    'workspaceid',
]);

function normalizedKey(key) {
    return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function requireArgumentsObject(value) {
    if (!isPlainObject(value)) {
        throw appRuntimeError('INVALID_REQUEST', 'Request body must be a JSON object.', 400);
    }
    return value;
}

function rejectTenantSelectors(value) {
    const seen = new WeakSet();
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        for (const [key, child] of Object.entries(node)) {
            if (FORBIDDEN_TENANT_KEYS.has(normalizedKey(key))) {
                throw appRuntimeError(
                    'TENANT_SELECTOR_FORBIDDEN',
                    'Tenant selectors are not accepted.',
                    400
                );
            }
            visit(child);
        }
    };
    visit(value);
}

function validateArguments(tool, args) {
    try {
        schemaValidator.validateArguments(tool, args);
    } catch (error) {
        if (error?.mcpCode === 'invalid_request') {
            throw appRuntimeError('INVALID_ARGUMENTS', 'Tool arguments are invalid.', 422);
        }
        throw error;
    }
}

module.exports = {
    FORBIDDEN_TENANT_KEYS,
    normalizedKey,
    isPlainObject,
    requireArgumentsObject,
    rejectTenantSelectors,
    validateArguments,
};
