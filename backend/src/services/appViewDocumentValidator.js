'use strict';

const MAX_BLOCKS = 64;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 20;
const MAX_CHART_SERIES = 24;
const MAX_STRING_LENGTH = 500;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const TRUNCATION_MARKER = '… [truncated]';

const BLOCK_TYPES = new Set(['stat_row', 'chart', 'table', 'list', 'text', 'empty']);
const VALUE_TYPES = new Set(['text', 'number', 'currency', 'date', 'badge', 'entity']);
const ALIGNMENTS = new Set(['left', 'center', 'right']);
const CHART_TYPES = new Set(['bar', 'line']);
const CHART_FORMATS = new Set(['number', 'currency', 'percent']);
const TONES = new Set([
    'neutral', 'positive', 'negative', 'warning', 'critical', 'info', 'success', 'danger',
]);
const FORBIDDEN_KEY = /(^|_)(?:url|uri|href|html|markup|style|script|image|src|srcdoc)(?:_|$)/i;
const URL_VALUE = /(?:\b(?:https?|ftp):\/\/|\b(?:javascript|data|file|mailto|tel):|(?:^|[\s("'])\/\/[a-z0-9]|(?:^|[\s("'])www\.)/i;
const MARKUP_VALUE = /<\/?(?:[a-z][a-z0-9-]*|!doctype)(?:\s[^>]*)?>/i;
const SCRIPT_VALUE = /(?:\bon[a-z]+\s*=|\bdocument\.(?:cookie|location)|\bwindow\.(?:location|open)|\b(?:eval|Function)\s*\()/i;

class AppViewDocumentValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppViewDocumentValidationError';
        this.code = 'VIEW_DOCUMENT_INVALID';
        this.httpStatus = 422;
    }
}

function fail(path, message) {
    throw new AppViewDocumentValidationError(`${path} ${message}`);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, path) {
    if (!isObject(value)) fail(path, 'must be an object.');
}

function requireExactKeys(value, allowedKeys, requiredKeys, path) {
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

function rejectForbiddenContent(value, path = 'View document', seen = new Set()) {
    if (typeof value === 'string') {
        if (URL_VALUE.test(value)) fail(path, 'must not contain a URL.');
        if (MARKUP_VALUE.test(value)) fail(path, 'must not contain markup.');
        if (SCRIPT_VALUE.test(value)) fail(path, 'must not contain script content.');
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) fail(path, 'must be JSON-serializable.');
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => rejectForbiddenContent(item, `${path}[${index}]`, seen));
    } else {
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_KEY.test(key) || /^on[a-z]+$/i.test(key)) {
                fail(`${path}.${key}`, 'is not allowed.');
            }
            rejectForbiddenContent(item, `${path}.${key}`, seen);
        }
    }
    seen.delete(value);
}

function boundedString(value, path, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail(path, 'must be a string.');
    if (!allowEmpty && value.trim().length === 0) fail(path, 'must not be empty.');
    const characters = Array.from(value);
    if (characters.length <= MAX_STRING_LENGTH) return value;
    const markerLength = Array.from(TRUNCATION_MARKER).length;
    return `${characters.slice(0, MAX_STRING_LENGTH - markerLength).join('')}${TRUNCATION_MARKER}`;
}

function finiteNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(path, 'must be a finite number.');
    }
    return value;
}

function entityValue(value, path) {
    requireObject(value, path);
    requireExactKeys(value, ['entity', 'id'], ['entity', 'id'], path);
    if (typeof value.entity !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.entity)) {
        fail(`${path}.entity`, 'must be a valid entity type.');
    }
    const idIsNumber = Number.isSafeInteger(value.id) && value.id > 0;
    const idIsString = typeof value.id === 'string'
        && value.id.length > 0
        && value.id.length <= 128
        && /^[A-Za-z0-9_-]+$/.test(value.id);
    if (!idIsNumber && !idIsString) fail(`${path}.id`, 'must be a valid entity id.');
    return { entity: value.entity, id: value.id };
}

function badgeValue(value, path) {
    if (typeof value === 'string') return boundedString(value, path);
    requireObject(value, path);
    requireExactKeys(value, ['label', 'tone'], ['label'], path);
    const badge = { label: boundedString(value.label, `${path}.label`) };
    if (value.tone !== undefined) {
        if (!TONES.has(value.tone)) fail(`${path}.tone`, 'is not supported.');
        badge.tone = value.tone;
    }
    return badge;
}

function dateValue(value, path) {
    const match = typeof value === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(value)
        : null;
    const calendarDate = match
        ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
        : null;
    const calendarMatches = calendarDate
        && calendarDate.getUTCFullYear() === Number(match[1])
        && calendarDate.getUTCMonth() === Number(match[2]) - 1
        && calendarDate.getUTCDate() === Number(match[3]);
    if (!match || !calendarMatches || Number.isNaN(Date.parse(value))) {
        fail(path, 'must be an ISO date or UTC date-time.');
    }
    return value;
}

function typedValue(type, value, path) {
    if (type === 'text') return boundedString(value, path, { allowEmpty: true });
    if (type === 'number' || type === 'currency') return finiteNumber(value, path);
    if (type === 'date') return dateValue(value, path);
    if (type === 'badge') return badgeValue(value, path);
    if (type === 'entity') return entityValue(value, path);
    fail(path, 'uses an unsupported value type.');
}

function validateStatRow(block, path) {
    requireExactKeys(block, ['type', 'items'], ['type', 'items'], path);
    if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 4) {
        fail(`${path}.items`, 'must contain between 1 and 4 items.');
    }
    return {
        type: 'stat_row',
        items: block.items.map((item, index) => {
            const itemPath = `${path}.items[${index}]`;
            requireObject(item, itemPath);
            requireExactKeys(item, ['label', 'value', 'tone', 'trend'], ['label', 'value'], itemPath);
            if (typeof item.value !== 'string' && (
                typeof item.value !== 'number' || !Number.isFinite(item.value)
            )) {
                fail(`${itemPath}.value`, 'must be text or a finite number.');
            }
            const normalized = {
                label: boundedString(item.label, `${itemPath}.label`),
                value: typeof item.value === 'string'
                    ? boundedString(item.value, `${itemPath}.value`)
                    : item.value,
            };
            if (item.tone !== undefined) {
                if (!TONES.has(item.tone)) fail(`${itemPath}.tone`, 'is not supported.');
                normalized.tone = item.tone;
            }
            if (item.trend !== undefined) {
                normalized.trend = boundedString(item.trend, `${itemPath}.trend`);
            }
            return normalized;
        }),
    };
}

function validateChart(block, path) {
    requireExactKeys(block, ['type', 'chart_type', 'series', 'format'], ['type', 'chart_type', 'series'], path);
    if (!CHART_TYPES.has(block.chart_type)) fail(`${path}.chart_type`, 'must be "bar" or "line".');
    if (!Array.isArray(block.series) || block.series.length > MAX_CHART_SERIES) {
        fail(`${path}.series`, `must contain no more than ${MAX_CHART_SERIES} entries.`);
    }
    const normalized = {
        type: 'chart',
        chart_type: block.chart_type,
        series: block.series.map((item, index) => {
            const itemPath = `${path}.series[${index}]`;
            requireObject(item, itemPath);
            requireExactKeys(item, ['label', 'value'], ['label', 'value'], itemPath);
            return {
                label: boundedString(item.label, `${itemPath}.label`),
                value: finiteNumber(item.value, `${itemPath}.value`),
            };
        }),
    };
    if (block.format !== undefined) {
        if (!CHART_FORMATS.has(block.format)) fail(`${path}.format`, 'is not supported.');
        normalized.format = block.format;
    }
    return normalized;
}

function validateTable(block, path) {
    requireExactKeys(block, ['type', 'columns', 'rows'], ['type', 'columns', 'rows'], path);
    if (!Array.isArray(block.columns)
        || block.columns.length < 1
        || block.columns.length > MAX_TABLE_COLUMNS) {
        fail(`${path}.columns`, `must contain between 1 and ${MAX_TABLE_COLUMNS} columns.`);
    }
    if (!Array.isArray(block.rows) || block.rows.length > MAX_TABLE_ROWS) {
        fail(`${path}.rows`, `must contain no more than ${MAX_TABLE_ROWS} rows.`);
    }
    const keys = new Set();
    const columns = block.columns.map((column, index) => {
        const columnPath = `${path}.columns[${index}]`;
        requireObject(column, columnPath);
        requireExactKeys(column, ['key', 'label', 'type', 'align'], ['key', 'label', 'type', 'align'], columnPath);
        if (typeof column.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(column.key)) {
            fail(`${columnPath}.key`, 'must be a valid column key.');
        }
        if (keys.has(column.key)) fail(`${columnPath}.key`, 'must be unique.');
        keys.add(column.key);
        if (!VALUE_TYPES.has(column.type)) fail(`${columnPath}.type`, 'is not supported.');
        if (!ALIGNMENTS.has(column.align)) fail(`${columnPath}.align`, 'is not supported.');
        return {
            key: column.key,
            label: boundedString(column.label, `${columnPath}.label`),
            type: column.type,
            align: column.align,
        };
    });
    const byKey = new Map(columns.map(column => [column.key, column]));
    const rows = block.rows.map((row, index) => {
        const rowPath = `${path}.rows[${index}]`;
        requireObject(row, rowPath);
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
            const column = byKey.get(key);
            if (!column) fail(`${rowPath}.${key}`, 'does not have a matching column.');
            normalized[key] = typedValue(column.type, value, `${rowPath}.${key}`);
        }
        return normalized;
    });
    return { type: 'table', columns, rows };
}

function validateList(block, path) {
    requireExactKeys(block, ['type', 'items'], ['type', 'items'], path);
    if (!Array.isArray(block.items) || block.items.length > MAX_TABLE_ROWS) {
        fail(`${path}.items`, `must contain no more than ${MAX_TABLE_ROWS} items.`);
    }
    return {
        type: 'list',
        items: block.items.map((item, index) => {
            const itemPath = `${path}.items[${index}]`;
            requireObject(item, itemPath);
            requireExactKeys(item, ['title', 'subtitle', 'badge', 'ref'], ['title'], itemPath);
            const normalized = { title: boundedString(item.title, `${itemPath}.title`) };
            if (item.subtitle !== undefined) {
                normalized.subtitle = boundedString(item.subtitle, `${itemPath}.subtitle`, { allowEmpty: true });
            }
            if (item.badge !== undefined) normalized.badge = badgeValue(item.badge, `${itemPath}.badge`);
            if (item.ref !== undefined) normalized.ref = entityValue(item.ref, `${itemPath}.ref`);
            return normalized;
        }),
    };
}

function validateTextBlock(block, path) {
    requireExactKeys(block, ['type', 'text'], ['type', 'text'], path);
    return { type: block.type, text: boundedString(block.text, `${path}.text`) };
}

function validateBlock(block, index) {
    const path = `View document.blocks[${index}]`;
    requireObject(block, path);
    if (!BLOCK_TYPES.has(block.type)) fail(`${path}.type`, 'is not supported.');
    if (block.type === 'stat_row') return validateStatRow(block, path);
    if (block.type === 'chart') return validateChart(block, path);
    if (block.type === 'table') return validateTable(block, path);
    if (block.type === 'list') return validateList(block, path);
    return validateTextBlock(block, path);
}

function validateViewDocument(document) {
    rejectForbiddenContent(document);
    requireObject(document, 'View document');
    requireExactKeys(
        document,
        ['view_version', 'title', 'subtitle', 'blocks'],
        ['view_version', 'title', 'blocks'],
        'View document'
    );
    if (document.view_version !== 1) fail('View document.view_version', 'must be 1.');
    if (!Array.isArray(document.blocks) || document.blocks.length > MAX_BLOCKS) {
        fail('View document.blocks', `must contain no more than ${MAX_BLOCKS} blocks.`);
    }
    const normalized = {
        view_version: 1,
        title: boundedString(document.title, 'View document.title'),
    };
    if (document.subtitle !== undefined) {
        normalized.subtitle = boundedString(
            document.subtitle,
            'View document.subtitle',
            { allowEmpty: true }
        );
    }
    normalized.blocks = document.blocks.map(validateBlock);
    let bytes;
    try {
        bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    } catch (_error) {
        fail('View document', 'must be JSON-serializable.');
    }
    if (bytes > MAX_DOCUMENT_BYTES) {
        fail('View document', `must not exceed ${MAX_DOCUMENT_BYTES} bytes.`);
    }
    return { document: normalized, bytes };
}

module.exports = {
    MAX_BLOCKS,
    MAX_TABLE_ROWS,
    MAX_TABLE_COLUMNS,
    MAX_CHART_SERIES,
    MAX_STRING_LENGTH,
    MAX_DOCUMENT_BYTES,
    TRUNCATION_MARKER,
    AppViewDocumentValidationError,
    rejectForbiddenContent,
    validateViewDocument,
};
