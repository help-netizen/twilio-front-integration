/**
 * Tiny inline JSON-Schema validator for document template descriptors.
 *
 * Supports the subset used in `schema/v1.json`:
 *   - type (single + array of two), required, additionalProperties
 *   - const, enum, pattern, minLength, maxLength, minItems, maxItems
 *   - nested object/array.
 *
 * Returns { valid: true } or { valid: false, errors: [{ path, message }] }.
 *
 * Why inline (no Ajv): the project intentionally avoids new runtime deps where
 * a small, predictable implementation suffices. Validation surface is small.
 */

'use strict';

const schemaV1 = require('./schema/v1.json');

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function checkType(value, type) {
    const types = Array.isArray(type) ? type : [type];
    return types.some(t => {
        if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
        if (t === 'number') return typeof value === 'number';
        if (t === 'null') return value === null;
        return typeOf(value) === t;
    });
}

function pushError(errors, path, message) {
    errors.push({ path: path || '/', message });
}

function validateNode(value, schema, path, errors) {
    if (schema.const !== undefined && value !== schema.const) {
        pushError(errors, path, `must be const ${JSON.stringify(schema.const)}`);
        return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        pushError(errors, path, `must be one of ${JSON.stringify(schema.enum)}`);
        return;
    }
    if (schema.type && !checkType(value, schema.type)) {
        pushError(errors, path, `must be ${JSON.stringify(schema.type)}, got ${typeOf(value)}`);
        return;
    }

    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            pushError(errors, path, `must be at least ${schema.minLength} characters`);
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            pushError(errors, path, `must be at most ${schema.maxLength} characters`);
        }
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
            pushError(errors, path, `must match pattern ${schema.pattern}`);
        }
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            pushError(errors, path, `must be >= ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            pushError(errors, path, `must be <= ${schema.maximum}`);
        }
    }

    if (typeOf(value) === 'object') {
        if (schema.required) {
            for (const key of schema.required) {
                if (!(key in value)) pushError(errors, `${path}/${key}`, 'is required');
            }
        }
        if (schema.properties) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in value) validateNode(value[key], propSchema, `${path}/${key}`, errors);
            }
        }
        if (schema.additionalProperties === false && schema.properties) {
            for (const key of Object.keys(value)) {
                if (!(key in schema.properties)) {
                    pushError(errors, `${path}/${key}`, 'is not an allowed property');
                }
            }
        }
    }

    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            pushError(errors, path, `must have at least ${schema.minItems} item(s)`);
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            pushError(errors, path, `must have at most ${schema.maxItems} item(s)`);
        }
        if (schema.items) {
            value.forEach((item, idx) => {
                validateNode(item, schema.items, `${path}/${idx}`, errors);
            });
        }
    }
}

function validateDescriptor(value) {
    const errors = [];
    validateNode(value, schemaV1, '', errors);
    return { valid: errors.length === 0, errors };
}

module.exports = {
    validateDescriptor,
    schemaV1,
};
