'use strict';

const { AppRunnerError, GatewayError } = require('./errors');

const LIMITS = Object.freeze({
    collections: 4,
    keyFields: 4,
    columns: 20,
    listRows: 500,
    writeRows: 100,
    collectionRows: 5000,
    rowBytes: 8 * 1024,
    installationBytes: 20 * 1024 * 1024,
});
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COLUMN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TYPES = new Set(['text', 'number', 'currency', 'date', 'badge', 'entity']);
const TONES = new Set([
    'neutral', 'positive', 'negative', 'warning', 'critical', 'info', 'success', 'danger',
]);

function declarationFailure(message) {
    throw new AppRunnerError('DATA_COLLECTIONS_INVALID', message);
}

function operationFailure(message, code = 'APP_DATA_INVALID', status = 422) {
    throw new GatewayError(code, message, status);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, required, path, fail) {
    if (!isObject(value)) fail(`${path} must be an object.`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`${path}.${key} is not supported.`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            fail(`${path} must include "${key}".`);
        }
    }
}

function validateDataCollections(value) {
    if (!Array.isArray(value)) declarationFailure('data_collections must be an array.');
    if (value.length > LIMITS.collections) {
        declarationFailure(`data_collections must contain no more than ${LIMITS.collections} collections.`);
    }
    const names = new Set();
    return value.map((collection, index) => {
        const path = `data_collections[${index}]`;
        exactKeys(
            collection,
            ['name', 'key_fields', 'columns'],
            ['name', 'key_fields', 'columns'],
            path,
            declarationFailure
        );
        if (typeof collection.name !== 'string' || !NAME.test(collection.name)) {
            declarationFailure(`${path}.name must match /^[a-z][a-z0-9_]{0,63}$/.`);
        }
        if (names.has(collection.name)) declarationFailure(`${path}.name must be unique.`);
        names.add(collection.name);
        if (!Array.isArray(collection.columns)
            || collection.columns.length < 1
            || collection.columns.length > LIMITS.columns) {
            declarationFailure(`${path}.columns must contain between 1 and ${LIMITS.columns} columns.`);
        }
        const columnNames = new Set();
        const columns = collection.columns.map((column, columnIndex) => {
            const columnPath = `${path}.columns[${columnIndex}]`;
            exactKeys(column, ['key', 'type'], ['key', 'type'], columnPath, declarationFailure);
            if (typeof column.key !== 'string' || !COLUMN.test(column.key)) {
                declarationFailure(`${columnPath}.key must be a valid column key.`);
            }
            if (columnNames.has(column.key)) declarationFailure(`${columnPath}.key must be unique.`);
            if (!TYPES.has(column.type)) declarationFailure(`${columnPath}.type is not supported.`);
            columnNames.add(column.key);
            return { key: column.key, type: column.type };
        });
        if (!Array.isArray(collection.key_fields)
            || collection.key_fields.length < 1
            || collection.key_fields.length > LIMITS.keyFields) {
            declarationFailure(`${path}.key_fields must contain between 1 and ${LIMITS.keyFields} fields.`);
        }
        const keys = new Set();
        const keyFields = collection.key_fields.map((key, keyIndex) => {
            if (typeof key !== 'string' || !COLUMN.test(key)) {
                declarationFailure(`${path}.key_fields[${keyIndex}] must be a valid column key.`);
            }
            if (keys.has(key)) declarationFailure(`${path}.key_fields[${keyIndex}] must be unique.`);
            if (!columnNames.has(key)) {
                declarationFailure(`${path}.key_fields[${keyIndex}] must name a declared column.`);
            }
            keys.add(key);
            return key;
        });
        return { name: collection.name, key_fields: keyFields, columns };
    });
}

function calendarDate(value) {
    const match = typeof value === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(value)
        : null;
    if (!match || Number.isNaN(Date.parse(value))) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3]);
}

function typed(type, value, field) {
    if (type === 'text') {
        if (typeof value !== 'string') operationFailure(`Field "${field}" must be text.`);
        return value;
    }
    if (type === 'number' || type === 'currency') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            operationFailure(`Field "${field}" must be a finite number.`);
        }
        return value;
    }
    if (type === 'date') {
        if (!calendarDate(value)) operationFailure(`Field "${field}" must be an ISO date or UTC date-time.`);
        return value;
    }
    if (type === 'badge') {
        if (typeof value === 'string') return value;
        if (!isObject(value)
            || typeof value.label !== 'string'
            || !value.label.trim()
            || Object.keys(value).some(key => !['label', 'tone'].includes(key))
            || (value.tone !== undefined && !TONES.has(value.tone))) {
            operationFailure(`Field "${field}" must be a valid badge.`);
        }
        return value.tone === undefined
            ? { label: value.label }
            : { label: value.label, tone: value.tone };
    }
    const idValid = Number.isSafeInteger(value?.id) && value.id > 0
        || typeof value?.id === 'string'
            && value.id.length > 0
            && value.id.length <= 128
            && /^[A-Za-z0-9_-]+$/.test(value.id);
    if (!isObject(value)
        || typeof value.entity !== 'string'
        || !NAME.test(value.entity)
        || !idValid
        || Object.keys(value).some(key => !['entity', 'id', 'label'].includes(key))
        || (value.label !== undefined && typeof value.label !== 'string')) {
        operationFailure(`Field "${field}" must be a valid entity reference.`);
    }
    return value.label === undefined
        ? { entity: value.entity, id: value.id }
        : { entity: value.entity, id: value.id, label: value.label };
}

function deriveRowKey(declaration, row) {
    const rowKey = declaration.key_fields.map(field => {
        const value = row[field];
        if ((typeof value !== 'string' && typeof value !== 'number')
            || (typeof value === 'string' && !value.trim())
            || (typeof value === 'number' && !Number.isFinite(value))) {
            operationFailure(`Key field "${field}" must be a non-empty scalar.`);
        }
        const encoded = JSON.stringify(value);
        return `${field.length}:${field}${encoded.length}:${encoded}`;
    }).join('|');
    if (rowKey.length > 256) operationFailure('Derived row key must not exceed 256 characters.');
    return rowKey;
}

function normalizedRow(declaration, row, keysOnly = false) {
    if (!isObject(row)) operationFailure('Each data row must be an object.');
    const columns = new Map(declaration.columns.map(column => [column.key, column]));
    const allowed = keysOnly ? new Set(declaration.key_fields) : new Set(columns.keys());
    for (const key of Object.keys(row)) {
        if (!allowed.has(key)) operationFailure(`Row contains undeclared column "${key}".`);
    }
    const data = {};
    for (const [key, value] of Object.entries(row)) data[key] = typed(columns.get(key).type, value, key);
    for (const field of declaration.key_fields) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) {
            operationFailure(`Key field "${field}" must be a non-empty scalar.`);
        }
    }
    const rowKey = deriveRowKey(declaration, data);
    if (!keysOnly && Buffer.byteLength(JSON.stringify(data), 'utf8') > LIMITS.rowBytes) {
        operationFailure('A data row must not exceed 8 KB.');
    }
    return { rowKey, data };
}

function requireArray(value, operation) {
    if (!Array.isArray(value) || value.length < 1) {
        operationFailure(`${operation} request must contain at least one row.`);
    }
    if (value.length > LIMITS.writeRows) {
        operationFailure(`${operation} may contain no more than ${LIMITS.writeRows} rows.`);
    }
}

function createDryRunDataStore(rawDeclarations) {
    const declarations = validateDataCollections(rawDeclarations);
    const byName = new Map(declarations.map(item => [item.name, item]));
    const stores = new Map(declarations.map(item => [item.name, new Map()]));
    const report = {
        list: { calls: 0, rows: 0 },
        upsert: { calls: 0, rows: 0 },
        delete: { calls: 0, rows: 0 },
    };

    const declarationFor = collection => {
        if (typeof collection !== 'string' || !NAME.test(collection)) {
            operationFailure('Collection name is invalid.');
        }
        const declaration = byName.get(collection);
        if (!declaration) {
            operationFailure(`Collection "${collection}" is not declared by the dry-run artifact.`);
        }
        return declaration;
    };

    async function handle(operation, collection, payload) {
        const declaration = declarationFor(collection);
        if (!Object.prototype.hasOwnProperty.call(report, operation)) {
            operationFailure('Data operation not found.', 'NOT_FOUND', 404);
        }
        report[operation].calls += 1;
        if (operation === 'list') {
            if (!isObject(payload) || Object.keys(payload).some(key => !['limit', 'offset'].includes(key))) {
                operationFailure('List request is invalid.');
            }
            const limit = payload.limit === undefined ? 100 : payload.limit;
            const offset = payload.offset === undefined ? 0 : payload.offset;
            if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listRows) {
                operationFailure('List limit must be an integer from 1 to 500.');
            }
            if (!Number.isInteger(offset) || offset < 0) {
                operationFailure('List offset must be a non-negative integer.');
            }
            const allRows = [...stores.get(collection).values()];
            const rows = allRows.slice(offset, offset + limit).map(row => row.data);
            report.list.rows += rows.length;
            return { rows, pagination: { limit, offset, total: allRows.length } };
        }
        if (operation === 'upsert') {
            requireArray(payload, 'Upsert');
            const normalized = payload.map(row => normalizedRow(declaration, row));
            if (new Set(normalized.map(row => row.rowKey)).size !== normalized.length) {
                operationFailure('Upsert rows must have unique derived keys within one request.');
            }
            const candidate = new Map(stores.get(collection));
            for (const row of normalized) candidate.set(row.rowKey, row);
            if (candidate.size > LIMITS.collectionRows) {
                operationFailure('Collection row limit of 5,000 would be exceeded.');
            }
            let bytes = 0;
            for (const [name, store] of stores) {
                const selected = name === collection ? candidate : store;
                for (const row of selected.values()) bytes += Buffer.byteLength(JSON.stringify(row.data));
            }
            if (bytes > LIMITS.installationBytes) {
                operationFailure('Installation data limit of 20 MB would be exceeded.');
            }
            stores.set(collection, candidate);
            report.upsert.rows += normalized.length;
            return { upserted: normalized.length };
        }
        requireArray(payload, 'Delete');
        const keys = payload.map(row => normalizedRow(declaration, row, true).rowKey);
        let deleted = 0;
        for (const rowKey of keys) {
            if (stores.get(collection).delete(rowKey)) deleted += 1;
        }
        report.delete.rows += deleted;
        return { deleted };
    }

    return {
        handle,
        report: () => JSON.parse(JSON.stringify(report)),
    };
}

module.exports = {
    LIMITS,
    createDryRunDataStore,
    deriveRowKey,
    validateDataCollections,
};
