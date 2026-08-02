'use strict';

const db = require('../db/connection');
const executionService = require('./appExecutionService');
const requestValidator = require('./appRuntimeRequestValidator');
const { appRuntimeError } = require('./appRuntimeErrors');
const {
    COLLECTION_NAME,
    validateDataCollections,
} = require('./appDataCollectionValidator');

const MAX_LIST_ROWS = 500;
const MAX_WRITE_ROWS = 100;
const MAX_COLLECTION_ROWS = 5000;
const MAX_ROW_BYTES = 8 * 1024;
const MAX_INSTALLATION_BYTES = 20 * 1024 * 1024;
const BADGE_TONES = new Set([
    'neutral', 'positive', 'negative', 'warning', 'critical', 'info', 'success', 'danger',
]);

function invalid(message) {
    return appRuntimeError('APP_DATA_INVALID', message, 422);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireCollectionName(value) {
    if (typeof value !== 'string' || !COLLECTION_NAME.test(value)) {
        throw invalid('Collection name is invalid.');
    }
    return value;
}

function requireExactBody(value, allowedKeys, message) {
    requestValidator.requireArgumentsObject(value);
    const allowed = new Set(allowedKeys);
    if (Object.keys(value).some(key => !allowed.has(key))) throw invalid(message);
}

function normalizeListInput(value) {
    requireExactBody(value, ['limit', 'offset'], 'List request is invalid.');
    const limit = value.limit === undefined ? 100 : value.limit;
    const offset = value.offset === undefined ? 0 : value.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_ROWS) {
        throw invalid(`List limit must be an integer from 1 to ${MAX_LIST_ROWS}.`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
        throw invalid('List offset must be a non-negative integer.');
    }
    return { limit, offset };
}

function requireRows(value, key, operation) {
    requireExactBody(value, [key], `${operation} request is invalid.`);
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length < 1) {
        throw invalid(`${operation} request must contain at least one row.`);
    }
    if (rows.length > MAX_WRITE_ROWS) {
        throw invalid(`${operation} may contain no more than ${MAX_WRITE_ROWS} rows.`);
    }
    return rows;
}

function validCalendarDate(value) {
    const match = typeof value === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(value)
        : null;
    if (!match || Number.isNaN(Date.parse(value))) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3]);
}

function normalizeTypedValue(type, value, field) {
    if (type === 'text') {
        if (typeof value !== 'string') throw invalid(`Field "${field}" must be text.`);
        return value;
    }
    if (type === 'number' || type === 'currency') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw invalid(`Field "${field}" must be a finite number.`);
        }
        return value;
    }
    if (type === 'date') {
        if (!validCalendarDate(value)) {
            throw invalid(`Field "${field}" must be an ISO date or UTC date-time.`);
        }
        return value;
    }
    if (type === 'badge') {
        if (typeof value === 'string') return value;
        if (!isObject(value)
            || typeof value.label !== 'string'
            || !value.label.trim()
            || Object.keys(value).some(key => !['label', 'tone'].includes(key))
            || (value.tone !== undefined && !BADGE_TONES.has(value.tone))) {
            throw invalid(`Field "${field}" must be a valid badge.`);
        }
        return value.tone === undefined
            ? { label: value.label }
            : { label: value.label, tone: value.tone };
    }
    if (type === 'entity') {
        const idValid = Number.isSafeInteger(value?.id) && value.id > 0
            || typeof value?.id === 'string'
                && value.id.length > 0
                && value.id.length <= 128
                && /^[A-Za-z0-9_-]+$/.test(value.id);
        if (!isObject(value)
            || typeof value.entity !== 'string'
            || !COLLECTION_NAME.test(value.entity)
            || !idValid
            || Object.keys(value).some(key => !['entity', 'id', 'label'].includes(key))
            || (value.label !== undefined && typeof value.label !== 'string')) {
            throw invalid(`Field "${field}" must be a valid entity reference.`);
        }
        return value.label === undefined
            ? { entity: value.entity, id: value.id }
            : { entity: value.entity, id: value.id, label: value.label };
    }
    throw invalid(`Field "${field}" uses an unsupported type.`);
}

function deriveRowKey(declaration, row) {
    // Length prefixes make both field/value boundaries unambiguous even when a
    // value contains the visible "|" separator; field order is declaration order.
    const segments = declaration.key_fields.map(field => {
        const value = row[field];
        if ((typeof value !== 'string' && typeof value !== 'number')
            || (typeof value === 'string' && !value.trim())
            || (typeof value === 'number' && !Number.isFinite(value))) {
            throw invalid(`Key field "${field}" must be a non-empty scalar.`);
        }
        const encoded = JSON.stringify(value);
        return `${field.length}:${field}${encoded.length}:${encoded}`;
    });
    const rowKey = segments.join('|');
    if (rowKey.length > 256) {
        throw invalid('Derived row key must not exceed 256 characters.');
    }
    return rowKey;
}

function normalizeDataRow(declaration, row, { keysOnly = false } = {}) {
    if (!isObject(row)) throw invalid('Each data row must be an object.');
    const columns = new Map(declaration.columns.map(column => [column.key, column]));
    const allowedKeys = keysOnly ? new Set(declaration.key_fields) : new Set(columns.keys());
    for (const key of Object.keys(row)) {
        if (!allowedKeys.has(key)) {
            throw invalid(`Row contains undeclared column "${key}".`);
        }
    }
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeTypedValue(columns.get(key).type, value, key);
    }
    for (const field of declaration.key_fields) {
        if (!Object.prototype.hasOwnProperty.call(normalized, field)) {
            throw invalid(`Key field "${field}" must be a non-empty scalar.`);
        }
    }
    const rowKey = deriveRowKey(declaration, normalized);
    if (!keysOnly && Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_ROW_BYTES) {
        throw invalid(`A data row must not exceed ${MAX_ROW_BYTES / 1024} KB.`);
    }
    return { rowKey, data: normalized };
}

function declaredCollection(dataCollections, collectionName) {
    const declarations = validateDataCollections(dataCollections || []);
    const declaration = declarations.find(item => item.name === collectionName);
    if (!declaration) {
        throw invalid(`Collection "${collectionName}" is not declared by the accepted app version.`);
    }
    return declaration;
}

async function withTransaction(database, work) {
    const client = await database.getClient();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function loadGatewayCollection(client, context, collectionName, { forUpdate = false } = {}) {
    const { rows } = await client.query(
        `SELECT version.data_collections
         FROM marketplace_installations installation
         JOIN app_versions version
           ON version.app_id = installation.app_id
          AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
          AND version.status = 'published'
         WHERE installation.company_id = $1
           AND installation.id = $2
           AND installation.app_id = $3
           AND version.id = $4
           AND installation.status = 'connected'
         ${forUpdate ? 'FOR UPDATE OF installation' : 'FOR SHARE OF installation'}`,
        [context.company_id, context.installation_id, context.app_id, context.version_id]
    );
    if (!rows[0]) {
        throw appRuntimeError('APP_RUNTIME_INACTIVE', 'App runtime authorization is not active.', 403);
    }
    return declaredCollection(rows[0].data_collections, collectionName);
}

async function listRows(client, companyId, installationId, collectionName, input, human) {
    const totalResult = await client.query(
        `SELECT COUNT(*)::integer AS total
         FROM app_data_rows
         WHERE company_id = $1
           AND installation_id = $2
           AND collection = $3`,
        [companyId, installationId, collectionName]
    );
    const { rows } = await client.query(
        `SELECT data, created_at, updated_at
         FROM app_data_rows
         WHERE company_id = $1
           AND installation_id = $2
           AND collection = $3
         ORDER BY updated_at DESC, row_key
         LIMIT $4 OFFSET $5`,
        [companyId, installationId, collectionName, input.limit, input.offset]
    );
    return {
        rows: human ? rows : rows.map(row => row.data),
        pagination: {
            limit: input.limit,
            offset: input.offset,
            total: Number(totalResult.rows[0]?.total || 0),
        },
    };
}

function createAppDataService({
    database = db,
    execution = executionService,
} = {}) {
    async function list(context, collectionName, rawInput) {
        requireCollectionName(collectionName);
        requestValidator.rejectTenantSelectors(rawInput);
        const input = normalizeListInput(rawInput);
        return withTransaction(database, async client => {
            await loadGatewayCollection(client, context, collectionName);
            return listRows(
                client,
                context.company_id,
                context.installation_id,
                collectionName,
                input,
                false
            );
        });
    }

    async function upsert(context, collectionName, rawInput) {
        requireCollectionName(collectionName);
        requestValidator.rejectTenantSelectors(rawInput);
        const rawRows = requireRows(rawInput, 'rows', 'Upsert');
        return withTransaction(database, async client => {
            const declaration = await loadGatewayCollection(
                client,
                context,
                collectionName,
                { forUpdate: true }
            );
            const normalizedRows = rawRows.map(row => normalizeDataRow(declaration, row));
            if (new Set(normalizedRows.map(row => row.rowKey)).size !== normalizedRows.length) {
                throw invalid('Upsert rows must have unique derived keys within one request.');
            }
            await client.query(
                `INSERT INTO app_data_rows
                    (company_id, installation_id, collection, row_key, data)
                 SELECT $1, $2, $3, incoming.row_key, incoming.data
                 FROM jsonb_to_recordset($4::jsonb) AS incoming(row_key text, data jsonb)
                 ON CONFLICT (company_id, installation_id, collection, row_key) DO UPDATE
                 SET data = EXCLUDED.data,
                     updated_at = clock_timestamp()`,
                [context.company_id, context.installation_id, collectionName, JSON.stringify(
                    normalizedRows.map(row => ({ row_key: row.rowKey, data: row.data }))
                )]
            );
            const limits = await client.query(
                `SELECT
                    COUNT(*) FILTER (WHERE collection = $3)::integer AS collection_rows,
                    COALESCE(SUM(octet_length(data::text)), 0)::bigint AS installation_bytes
                 FROM app_data_rows
                 WHERE company_id = $1
                   AND installation_id = $2`,
                [context.company_id, context.installation_id, collectionName]
            );
            if (Number(limits.rows[0].collection_rows) > MAX_COLLECTION_ROWS) {
                throw invalid(`Collection row limit of ${MAX_COLLECTION_ROWS.toLocaleString('en-US')} would be exceeded.`);
            }
            if (Number(limits.rows[0].installation_bytes) > MAX_INSTALLATION_BYTES) {
                throw invalid(`Installation data limit of ${MAX_INSTALLATION_BYTES / 1024 / 1024} MB would be exceeded.`);
            }
            return { upserted: normalizedRows.length };
        });
    }

    async function remove(context, collectionName, rawInput) {
        requireCollectionName(collectionName);
        requestValidator.rejectTenantSelectors(rawInput);
        const rawKeys = requireRows(rawInput, 'keys', 'Delete');
        return withTransaction(database, async client => {
            const declaration = await loadGatewayCollection(
                client,
                context,
                collectionName,
                { forUpdate: true }
            );
            const rowKeys = rawKeys.map(key => normalizeDataRow(
                declaration,
                key,
                { keysOnly: true }
            ).rowKey);
            const deleted = await client.query(
                `DELETE FROM app_data_rows
                 WHERE company_id = $1
                   AND installation_id = $2
                   AND collection = $3
                   AND row_key = ANY($4::text[])
                 RETURNING row_key`,
                [context.company_id, context.installation_id, collectionName, rowKeys]
            );
            return { deleted: deleted.rows.length };
        });
    }

    async function listForViewer({
        companyId,
        installationId,
        actorId,
        collection,
        limit,
        offset,
    }) {
        requireCollectionName(collection);
        const input = normalizeListInput({ limit, offset });
        return withTransaction(database, async client => {
            const { rows } = await client.query(
                `SELECT installation.id AS installation_id,
                        installation.company_id,
                        installation.app_id,
                        version.data_collections,
                        ARRAY(
                            SELECT tool.tool_name
                            FROM app_version_tools tool
                            WHERE tool.version_id = version.id
                            ORDER BY tool.tool_name
                        ) AS allowed_tools
                 FROM marketplace_installations installation
                 JOIN marketplace_apps app
                   ON app.id = installation.app_id
                  AND app.status = 'published'
                 JOIN app_versions version
                   ON version.app_id = installation.app_id
                  AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
                  AND version.status = 'published'
                 WHERE installation.company_id = $1
                   AND installation.id = $2
                   AND installation.status = 'connected'
                 FOR SHARE OF installation`,
                [companyId, installationId]
            );
            if (!rows[0]) {
                throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
            }
            await execution.requireViewerAccess(rows[0], actorId, client);
            declaredCollection(rows[0].data_collections, collection);
            const result = await listRows(
                client,
                companyId,
                installationId,
                collection,
                input,
                true
            );
            return { collection, ...result };
        });
    }

    return { list, upsert, remove, listForViewer };
}

const service = createAppDataService();

module.exports = {
    ...service,
    MAX_LIST_ROWS,
    MAX_WRITE_ROWS,
    MAX_COLLECTION_ROWS,
    MAX_ROW_BYTES,
    MAX_INSTALLATION_BYTES,
    createAppDataService,
    deriveRowKey,
    normalizeDataRow,
    normalizeListInput,
};
