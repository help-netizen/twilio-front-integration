'use strict';

const { normalizeBaseUrl, resolvePublicOrigin } = require('./appConnectionValidator');

const MAX_SETTINGS = 8;
const MAX_SETTING_LABEL_LENGTH = 40;
const SETTING_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SETTING_TYPES = Object.freeze([
    'text', 'number', 'email', 'url', 'boolean', 'select',
]);
const SETTING_TYPE_SET = new Set(SETTING_TYPES);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AppSettingsValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppSettingsValidationError';
        this.code = 'APP_SETTINGS_INVALID';
        this.httpStatus = 422;
    }
}

function fail(path, message) {
    throw new AppSettingsValidationError(`${path} ${message}`);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, allowedKeys, requiredKeys, path) {
    if (!isObject(value)) fail(path, 'must be an object.');
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(`${path}.${key}`, 'is not supported.');
    }
    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            fail(path, `must include "${key}".`);
        }
    }
}

function validateSettings(value) {
    if (!Array.isArray(value)) fail('settings', 'must be an array.');
    if (value.length > MAX_SETTINGS) {
        fail('settings', `must contain no more than ${MAX_SETTINGS} fields.`);
    }
    const keys = new Set();
    return value.map((field, index) => {
        const path = `settings[${index}]`;
        requireExactKeys(
            field,
            ['key', 'label', 'type', 'options', 'required'],
            ['key', 'label', 'type'],
            path
        );
        if (typeof field.key !== 'string' || !SETTING_KEY.test(field.key)) {
            fail(`${path}.key`, 'must match /^[a-z][a-z0-9_]{0,31}$/.');
        }
        if (keys.has(field.key)) fail(`${path}.key`, 'must be unique.');
        keys.add(field.key);
        if (typeof field.label !== 'string'
            || field.label.trim().length === 0
            || Array.from(field.label).length > MAX_SETTING_LABEL_LENGTH) {
            fail(
                `${path}.label`,
                `must be a non-empty string of at most ${MAX_SETTING_LABEL_LENGTH} characters.`
            );
        }
        if (typeof field.type !== 'string' || !SETTING_TYPE_SET.has(field.type)) {
            fail(`${path}.type`, `must be one of ${SETTING_TYPES.join(', ')}.`);
        }
        if (field.required !== undefined && typeof field.required !== 'boolean') {
            fail(`${path}.required`, 'must be a boolean.');
        }
        if (field.type === 'select') {
            if (!Array.isArray(field.options) || field.options.length === 0) {
                fail(`${path}.options`, 'must be a non-empty array for a select field.');
            }
            if (field.options.some(option => typeof option !== 'string' || !option.length)) {
                fail(`${path}.options`, 'must contain only non-empty strings.');
            }
            if (new Set(field.options).size !== field.options.length) {
                fail(`${path}.options`, 'must contain unique values.');
            }
        } else if (field.options !== undefined) {
            fail(`${path}.options`, 'is supported only for a select field.');
        }
        const normalized = {
            key: field.key,
            label: field.label,
            type: field.type,
        };
        if (field.type === 'select') normalized.options = [...field.options];
        if (field.required !== undefined) normalized.required = field.required;
        return normalized;
    });
}

function normalizeSettingValue(field, value, path) {
    if (field.type === 'text') {
        if (typeof value !== 'string') fail(path, 'must be text.');
        return value;
    }
    if (field.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail(path, 'must be a finite number.');
        }
        return value;
    }
    if (field.type === 'email') {
        if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) {
            fail(path, 'must be a valid email address.');
        }
        return value;
    }
    if (field.type === 'url') {
        try {
            return normalizeBaseUrl(value, path);
        } catch (error) {
            throw new AppSettingsValidationError(error.message);
        }
    }
    if (field.type === 'boolean') {
        if (typeof value !== 'boolean') fail(path, 'must be a boolean.');
        return value;
    }
    if (field.type === 'select') {
        if (typeof value !== 'string' || !field.options.includes(value)) {
            fail(path, 'must be one of the declared options.');
        }
        return value;
    }
    fail(path, 'uses an unsupported type.');
}

function validateSettingValues(declarations, value) {
    const fields = validateSettings(declarations || []);
    if (!isObject(value)) fail('settings values', 'must be an object.');
    const declarationsByKey = new Map(fields.map(field => [field.key, field]));
    for (const key of Object.keys(value)) {
        if (!declarationsByKey.has(key)) {
            fail(`settings values.${key}`, 'is not declared by the accepted app version.');
        }
    }
    const normalized = {};
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(value, field.key)) {
            if (field.required) fail(`settings values.${field.key}`, 'is required.');
            continue;
        }
        const normalizedValue = normalizeSettingValue(
            field,
            value[field.key],
            `settings values.${field.key}`
        );
        if (field.required && typeof normalizedValue === 'string' && !normalizedValue.trim()) {
            fail(`settings values.${field.key}`, 'is required.');
        }
        normalized[field.key] = normalizedValue;
    }
    return normalized;
}

async function validateSettingDestinations(declarations, values, options = {}) {
    const fields = validateSettings(declarations || []);
    for (const field of fields) {
        if (field.type !== 'url'
            || !Object.prototype.hasOwnProperty.call(values, field.key)) continue;
        try {
            await resolvePublicOrigin(values[field.key], options);
        } catch (error) {
            throw new AppSettingsValidationError(error.message);
        }
    }
    return values;
}

function declaredSettingValues(declarations, value) {
    const fields = validateSettings(declarations || []);
    const stored = isObject(value) ? value : {};
    const declared = {};
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(stored, field.key)) continue;
        try {
            declared[field.key] = normalizeSettingValue(
                field,
                stored[field.key],
                `settings values.${field.key}`
            );
        } catch (_error) {
            // Accepted-version changes can make stored metadata stale. Runtime
            // receives only values valid for the current declaration.
        }
    }
    return declared;
}

function renderSettingsContract() {
    return [
        'APP INSTALLATION SETTINGS CONTRACT:',
        `The response field settings is an array of at most ${MAX_SETTINGS} declarations.`,
        'Use [] when the app needs no tenant configuration. Each declaration has:',
        '{"key":"supplier_email","label":"Supplier email","type":"email","required":true}',
        `key must match ${SETTING_KEY}; label is at most ${MAX_SETTING_LABEL_LENGTH} characters.`,
        `type is one of ${SETTING_TYPES.join(', ')}. The secret type is forbidden; credentials use connections.`,
        'A select declaration also has a non-empty unique string options array; other types have no options.',
        'Inside run(ctx), ctx.settings is a frozen object containing only declared current values.',
        'ctx.company is frozen {name, timezone} with no id. ctx.input.trigger is manual, schedule, action, or event.',
        'Use ctx.log(message) for author diagnostics: strings only, at most 500 characters per line and 50 lines per run.',
        'Logs are author-only run diagnostics and must never be returned in the view document.',
    ].join('\n');
}

module.exports = {
    MAX_SETTINGS,
    MAX_SETTING_LABEL_LENGTH,
    SETTING_KEY,
    SETTING_TYPES,
    AppSettingsValidationError,
    declaredSettingValues,
    renderSettingsContract,
    validateSettingDestinations,
    validateSettingValues,
    validateSettings,
};
