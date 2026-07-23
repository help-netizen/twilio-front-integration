'use strict';

const { mcpError } = require('./crmMcpResponse');

function validateArguments(tool, args = {}) {
    const schema = tool?.inputSchema;
    if (!schema || schema.type !== 'object') return;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw mcpError('invalid_request', 'arguments must be an object', { field: 'arguments' });
    }

    for (const key of schema.required || []) {
        const propertySchema = schema.properties?.[key];
        const acceptsAnyValue = !propertySchema || Object.keys(propertySchema).length === 0;
        const acceptsNull = propertySchema?.nullable === true;
        if (
            !Object.prototype.hasOwnProperty.call(args, key)
            || args[key] === undefined
            || (args[key] === null && !acceptsAnyValue && !acceptsNull)
        ) {
            throw mcpError('invalid_request', `${key} is required`, { field: key });
        }
    }

    for (const [key, value] of Object.entries(args)) {
        const propertySchema = schema.properties?.[key];
        if (!propertySchema) {
            if (schema.additionalProperties === false) {
                throw mcpError('invalid_request', `${key} is not allowed`, { field: key });
            }
            continue;
        }
        if (Object.keys(propertySchema).length === 0) continue;
        if (value === null && propertySchema.nullable === true) continue;
        if (value === null) continue;
        validateValue(key, value, propertySchema);
    }
}

function validateValue(key, value, schema) {
    if (schema.enum && !schema.enum.includes(value)) {
        throw mcpError('invalid_request', `${key} must be one of: ${schema.enum.join(', ')}`, {
            field: key,
            allowed_values: schema.enum,
        });
    }
    if (schema.type === 'integer') {
        if (!Number.isInteger(value)) {
            throw mcpError('invalid_request', `${key} must be an integer`, { field: key });
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
            throw mcpError('invalid_request', `${key} must be >= ${schema.minimum}`, { field: key });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            throw mcpError('invalid_request', `${key} must be <= ${schema.maximum}`, { field: key });
        }
    }
    if (schema.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw mcpError('invalid_request', `${key} must be a number`, { field: key });
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
            throw mcpError('invalid_request', `${key} must be >= ${schema.minimum}`, { field: key });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            throw mcpError('invalid_request', `${key} must be <= ${schema.maximum}`, { field: key });
        }
    }
    if (schema.type === 'string' && typeof value !== 'string') {
        throw mcpError('invalid_request', `${key} must be a string`, { field: key });
    }
    if (schema.type === 'string' && schema.format === 'date' && !isIsoDate(value)) {
        throw mcpError('invalid_request', `${key} must be a valid YYYY-MM-DD date`, {
            field: key,
            format: 'YYYY-MM-DD',
        });
    }
    if (schema.type === 'string' && schema.format === 'date-time' && !isIsoDateTime(value)) {
        throw mcpError('invalid_request', `${key} must be a valid ISO 8601 timestamp`, {
            field: key,
            format: 'date-time',
        });
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
        throw mcpError('invalid_request', `${key} must be a boolean`, { field: key });
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            throw mcpError('invalid_request', `${key} must be an array`, { field: key });
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            throw mcpError('invalid_request', `${key} must contain at most ${schema.maxItems} items`, { field: key });
        }
        value.forEach((item, index) => validateValue(`${key}[${index}]`, item, schema.items || {}));
    }
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw mcpError('invalid_request', `${key} must be an object`, { field: key });
        }
        for (const requiredKey of schema.required || []) {
            const requiredSchema = schema.properties?.[requiredKey];
            const acceptsNull = requiredSchema?.nullable === true;
            if (
                !Object.prototype.hasOwnProperty.call(value, requiredKey)
                || value[requiredKey] === undefined
                || (value[requiredKey] === null && !acceptsNull)
            ) {
                throw mcpError('invalid_request', `${key}.${requiredKey} is required`, {
                    field: `${key}.${requiredKey}`,
                });
            }
        }
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
            const nestedSchema = schema.properties?.[nestedKey];
            if (!nestedSchema) {
                if (schema.additionalProperties === false) {
                    throw mcpError('invalid_request', `${key}.${nestedKey} is not allowed`, {
                        field: `${key}.${nestedKey}`,
                    });
                }
                continue;
            }
            if (nestedValue === null && nestedSchema.nullable === true) continue;
            if (nestedValue === null) continue;
            validateValue(`${key}.${nestedKey}`, nestedValue, nestedSchema);
        }
    }
}

function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIsoDateTime(value) {
    if (typeof value !== 'string') return false;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return false;
    return /[tT]/.test(value) && /(Z|[+-]\d{2}:\d{2})$/.test(value);
}

module.exports = {
    validateArguments,
};
