'use strict';

const MAX_COLLECTIONS = 4;
const MAX_KEY_FIELDS = 4;
const MAX_COLUMNS = 20;
const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COLUMN_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const VALUE_TYPES = Object.freeze(['text', 'number', 'currency', 'date', 'badge', 'entity']);
const VALUE_TYPE_SET = new Set(VALUE_TYPES);

class AppDataCollectionValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppDataCollectionValidationError';
        this.code = 'DATA_COLLECTIONS_INVALID';
        this.httpStatus = 422;
    }
}

function fail(path, message) {
    throw new AppDataCollectionValidationError(`${path} ${message}`);
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

function validateDataCollections(value) {
    if (!Array.isArray(value)) {
        fail('data_collections', 'must be an array.');
    }
    if (value.length > MAX_COLLECTIONS) {
        fail('data_collections', `must contain no more than ${MAX_COLLECTIONS} collections.`);
    }
    const collectionNames = new Set();
    return value.map((collection, collectionIndex) => {
        const path = `data_collections[${collectionIndex}]`;
        requireExactKeys(collection, ['name', 'key_fields', 'columns'], [
            'name', 'key_fields', 'columns',
        ], path);
        if (typeof collection.name !== 'string' || !COLLECTION_NAME.test(collection.name)) {
            fail(`${path}.name`, 'must match /^[a-z][a-z0-9_]{0,63}$/.');
        }
        if (collectionNames.has(collection.name)) fail(`${path}.name`, 'must be unique.');
        collectionNames.add(collection.name);

        if (!Array.isArray(collection.columns)
            || collection.columns.length < 1
            || collection.columns.length > MAX_COLUMNS) {
            fail(`${path}.columns`, `must contain between 1 and ${MAX_COLUMNS} columns.`);
        }
        const columnKeys = new Set();
        const columns = collection.columns.map((column, columnIndex) => {
            const columnPath = `${path}.columns[${columnIndex}]`;
            requireExactKeys(column, ['key', 'type'], ['key', 'type'], columnPath);
            if (typeof column.key !== 'string' || !COLUMN_KEY.test(column.key)) {
                fail(`${columnPath}.key`, 'must be a valid column key.');
            }
            if (columnKeys.has(column.key)) fail(`${columnPath}.key`, 'must be unique.');
            columnKeys.add(column.key);
            if (!VALUE_TYPE_SET.has(column.type)) {
                fail(`${columnPath}.type`, `must be one of: ${VALUE_TYPES.join(', ')}.`);
            }
            return { key: column.key, type: column.type };
        });

        if (!Array.isArray(collection.key_fields)
            || collection.key_fields.length < 1
            || collection.key_fields.length > MAX_KEY_FIELDS) {
            fail(`${path}.key_fields`, `must contain between 1 and ${MAX_KEY_FIELDS} fields.`);
        }
        const keyFields = [];
        const keyFieldSet = new Set();
        for (let index = 0; index < collection.key_fields.length; index += 1) {
            const key = collection.key_fields[index];
            if (typeof key !== 'string' || !COLUMN_KEY.test(key)) {
                fail(`${path}.key_fields[${index}]`, 'must be a valid column key.');
            }
            if (keyFieldSet.has(key)) fail(`${path}.key_fields[${index}]`, 'must be unique.');
            if (!columnKeys.has(key)) {
                fail(`${path}.key_fields[${index}]`, 'must name a declared column.');
            }
            keyFieldSet.add(key);
            keyFields.push(key);
        }
        return { name: collection.name, key_fields: keyFields, columns };
    });
}

function validateDataCollectionEvolution(previousValue, nextValue) {
    const previous = validateDataCollections(previousValue || []);
    const next = validateDataCollections(nextValue || []);
    const nextByName = new Map(next.map(collection => [collection.name, collection]));
    for (const oldCollection of previous) {
        const newCollection = nextByName.get(oldCollection.name);
        if (!newCollection) {
            fail(`data_collections.${oldCollection.name}`, 'cannot be removed after publication.');
        }
        if (JSON.stringify(newCollection.key_fields) !== JSON.stringify(oldCollection.key_fields)) {
            fail(`data_collections.${oldCollection.name}.key_fields`, 'cannot change after publication.');
        }
        const newColumns = new Map(newCollection.columns.map(column => [column.key, column]));
        for (const oldColumn of oldCollection.columns) {
            const newColumn = newColumns.get(oldColumn.key);
            if (!newColumn) {
                fail(
                    `data_collections.${oldCollection.name}.columns.${oldColumn.key}`,
                    'cannot be removed after publication.'
                );
            }
            if (newColumn.type !== oldColumn.type) {
                fail(
                    `data_collections.${oldCollection.name}.columns.${oldColumn.key}.type`,
                    'cannot change after publication.'
                );
            }
        }
    }
    return next;
}

function renderDataCollectionsContract() {
    return [
        'APP DATA CONTRACT:',
        `The response field data_collections is an array of at most ${MAX_COLLECTIONS} declarations.`,
        'Use [] when the app needs no persistent memory. Each declaration is exactly:',
        '{"name":"purchases","key_fields":["estimate_id","part_number"],',
        ' "columns":[{"key":"estimate_id","type":"number"},{"key":"part_number","type":"text"}]}',
        `name must match ${COLLECTION_NAME}. key_fields has 1-${MAX_KEY_FIELDS} unique column keys.`,
        `columns has 1-${MAX_COLUMNS} unique entries; type is one of ${VALUE_TYPES.join(', ')}.`,
        'Every key field must name a declared column. Existing key fields and columns cannot be removed or changed.',
        'Inside run(ctx), persistent memory is available only as:',
        'await ctx.data.list(collection, {limit, offset}) -> {rows, pagination}',
        'await ctx.data.upsert(collection, rows) -> {upserted}',
        'await ctx.data.delete(collection, keys) -> {deleted}',
        'The CRM derives row identity from key_fields. Never supply row_key.',
        'A data call failure is catchable; limits are 10 data calls per run, 100 rows per write/delete,',
        '500 list rows, 5,000 stored rows per collection, 8 KB per row, and 20 MB per installation.',
    ].join('\n');
}

module.exports = {
    MAX_COLLECTIONS,
    MAX_KEY_FIELDS,
    MAX_COLUMNS,
    COLLECTION_NAME,
    COLUMN_KEY,
    VALUE_TYPES,
    AppDataCollectionValidationError,
    validateDataCollections,
    validateDataCollectionEvolution,
    renderDataCollectionsContract,
};
