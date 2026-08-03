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
const { ACTION_ID_PATTERN, MAX_ACTIONS } = require('./appActionValidator');

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
    // A reference carries optional display text: without it a table can only
    // show a raw id where the reader expects a job number.
    requireExactKeys(value, ['entity', 'id', 'label'], ['entity', 'id'], path);
    if (typeof value.entity !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.entity)) {
        fail(`${path}.entity`, 'must be a valid entity type.');
    }
    const idIsNumber = Number.isSafeInteger(value.id) && value.id > 0;
    const idIsString = typeof value.id === 'string'
        && value.id.length > 0
        && value.id.length <= 128
        && /^[A-Za-z0-9_-]+$/.test(value.id);
    if (!idIsNumber && !idIsString) fail(`${path}.id`, 'must be a valid entity id.');
    const reference = { entity: value.entity, id: value.id };
    if (value.label !== undefined) reference.label = boundedString(value.label, `${path}.label`);
    return reference;
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

function validateTable(block, path, context) {
    requireExactKeys(
        block,
        ['type', 'title', 'columns', 'rows', 'key', 'row_actions'],
        ['type', 'columns', 'rows'],
        path
    );
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
    if (block.key !== undefined) {
        if (typeof block.key !== 'string' || !byKey.has(block.key)) {
            fail(`${path}.key`, 'must name a declared column.');
        }
    }
    if (block.row_actions !== undefined && block.key === undefined) {
        fail(`${path}.row_actions`, 'requires a table key.');
    }
    let rowActions;
    if (block.row_actions !== undefined) {
        if (!Array.isArray(block.row_actions) || block.row_actions.length > context.maxActions) {
            fail(`${path}.row_actions`, `must contain no more than ${context.maxActions} actions.`);
        }
        const ids = new Set();
        rowActions = block.row_actions.map((action, index) => {
            const actionPath = `${path}.row_actions[${index}]`;
            requireObject(action, actionPath);
            requireExactKeys(action, ['id', 'label', 'tone'], ['id'], actionPath);
            if (typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id)) {
                fail(`${actionPath}.id`, 'must be a valid action id.');
            }
            if (!context.allowedActionIds.has(action.id)) {
                fail(`${actionPath}.id`, 'is not declared by this app version.');
            }
            if (ids.has(action.id)) fail(`${actionPath}.id`, 'must be unique.');
            ids.add(action.id);
            const normalized = { id: action.id };
            if (action.label !== undefined) {
                normalized.label = boundedString(action.label, `${actionPath}.label`);
            }
            if (action.tone !== undefined) {
                if (!TONES.has(action.tone)) fail(`${actionPath}.tone`, 'is not supported.');
                normalized.tone = action.tone;
            }
            return normalized;
        });
    }
    const rows = block.rows.map((row, index) => {
        const rowPath = `${path}.rows[${index}]`;
        requireObject(row, rowPath);
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
            const column = byKey.get(key);
            if (!column) fail(`${rowPath}.${key}`, 'does not have a matching column.');
            normalized[key] = typedValue(column.type, value, `${rowPath}.${key}`);
        }
        if (block.key !== undefined) {
            if (!Object.prototype.hasOwnProperty.call(normalized, block.key)) {
                fail(`${rowPath}.${block.key}`, 'is required as the row key.');
            }
            const value = normalized[block.key];
            const serialized = typeof value === 'string'
                ? value
                : JSON.stringify(value);
            if (serialized.trim().length === 0) {
                fail(`${rowPath}.${block.key}`, 'must not be empty.');
            }
            if (context.rowKeys.has(serialized)) {
                fail(`${rowPath}.${block.key}`, 'must be unique in the view document.');
            }
            context.rowKeys.add(serialized);
        }
        return normalized;
    });
    const normalized = { type: 'table', columns, rows };
    if (block.title !== undefined) normalized.title = boundedString(block.title, `${path}.title`);
    if (block.key !== undefined) normalized.key = block.key;
    if (rowActions !== undefined) normalized.row_actions = rowActions;
    return normalized;
}

function validateList(block, path) {
    requireExactKeys(block, ['type', 'title', 'items'], ['type', 'items'], path);
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

function validateBlock(block, index, context) {
    const path = `View document.blocks[${index}]`;
    requireObject(block, path);
    if (!BLOCK_TYPES.has(block.type)) fail(`${path}.type`, 'is not supported.');
    if (block.type === 'stat_row') return validateStatRow(block, path);
    if (block.type === 'chart') return validateChart(block, path);
    if (block.type === 'table') return validateTable(block, path, context);
    if (block.type === 'list') return validateList(block, path);
    return validateTextBlock(block, path);
}

function validateViewDocument(document, options = {}) {
    rejectForbiddenContent(document);
    // An app that answers in one sentence is the most common app there is, and
    // making it assemble a document for a single line would be ceremony. A plain
    // string is shorthand for one text block; it is escaped on render like any
    // other app-supplied string, so the shortcut costs nothing.
    if (typeof document === 'string') {
        return validateViewDocument({
            view_version: 1,
            title: 'Result',
            blocks: [{ type: 'text', text: document }],
        }, options);
    }
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
    const allowedActionIds = new Set(options.allowedActionIds || []);
    const context = { allowedActionIds, maxActions: MAX_ACTIONS, rowKeys: new Set() };
    normalized.blocks = document.blocks.map((block, index) => validateBlock(block, index, context));
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

// The contract the code generator is shown. It is rendered from the same
// constants the validator enforces, so the two cannot drift — a generator told
// a limit we do not enforce produces apps that fail on their first run.
function renderViewDocumentContract() {
    return [
        'YOUR RETURN VALUE BUILDS THE SCREEN.',
        'Return either a plain string (shown as one line of text) or a view document:',
        '{"view_version":1,"title":"...","subtitle":"...","blocks":[...]}',
        'Blocks — use the one that fits; a table is usually the most useful:',
        '  {"type":"stat_row","items":[{"label":"Outstanding","value":"$4,180","tone":"danger","trend":"+$620 this week"}]}',
        '  {"type":"chart","chart_type":"bar","series":[{"label":"Miles","value":1640}],"format":"currency"}',
        '  {"type":"table","title":"Jobs","columns":[',
        '     {"key":"purchase_id","label":"Purchase","type":"text","align":"left"},',
        '     {"key":"job","label":"Job","type":"entity","align":"left"},',
        '     {"key":"amount","label":"Balance","type":"currency","align":"right"}],',
        '   "rows":[{"purchase_id":"purchase-41","job":{"entity":"job","id":1219,"label":"NAC-1219"},"amount":192}],',
        '   "key":"purchase_id","row_actions":[{"id":"mark_ordered","label":"Mark ordered","tone":"success"}]}',
        '  {"type":"list","title":"Follow up","items":[{"title":"Second visit needed","subtitle":"Cambridge","badge":{"label":"14 days","tone":"danger"}}]}',
        '  {"type":"text","text":"..."}   {"type":"empty","text":"Nothing outstanding"}',
        'Every table column declares key, label, type and align — all four are required.',
        'For row actions, set key to a declared column whose row values are non-empty and unique in the document,',
        'then set row_actions to declared version action ids with optional label and tone. row_actions requires key.',
        'A cell must match its column type: currency and number take a plain number (192, not "$192.00"),',
        'date takes "YYYY-MM-DD", badge takes {"label":"...","tone":"..."}, entity takes {"entity":"job","id":1219}.',
        `tone is one of ${[...TONES].join(', ')}.`,
        'To link to a record, emit an entity reference — {"entity":"job","id":1219,"label":"NAC-1219"}.',
        'You cannot emit HTML, a URL, an image or a style: such a document is rejected and the run fails.',
        `Limits: ${MAX_BLOCKS} blocks, ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_COLUMNS} columns per table,`,
        `${MAX_CHART_SERIES} chart series, ${MAX_STRING_LENGTH} characters per string, ${MAX_DOCUMENT_BYTES} bytes in total.`,
    ].join('\n');
}

module.exports = {
    renderViewDocumentContract,
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
