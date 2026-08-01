'use strict';

const { GATEWAY_TOOLS } = require('./config');

const MAX_SOURCE_BYTES = 64 * 1024;
const FORBIDDEN_IDENTIFIERS = new Set([
    'require',
    'process',
    'fetch',
    'eval',
    'Function',
    'WebAssembly',
]);
const TOOL_NAMES = new Set(GATEWAY_TOOLS);

class BuilderValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BuilderValidationError';
        this.code = code;
        this.stage = 'static_validation';
    }
}

function fail(code, message) {
    throw new BuilderValidationError(code, message);
}

function isIdentifierStart(char) {
    return /[A-Za-z_$]/.test(char || '');
}

function isIdentifierPart(char) {
    return /[A-Za-z0-9_$]/.test(char || '');
}

function canStartRegex(previous) {
    if (!previous) return true;
    if (previous.type === 'identifier' || previous.type === 'string'
        || previous.type === 'number' || previous.type === 'regex') return false;
    if ([')', ']', '}'].includes(previous.value)) return false;
    return true;
}

function tokenize(source) {
    const tokens = [];

    function add(type, value, index) {
        tokens.push({ type, value, index });
    }

    function readString(index, quote) {
        let cursor = index + 1;
        let escaped = false;
        while (cursor < source.length) {
            const char = source[cursor];
            if (char === '\\') {
                escaped = true;
                cursor += 2;
                continue;
            }
            if (char === quote) {
                const raw = source.slice(index + 1, cursor);
                add('string', escaped ? null : raw, index);
                return cursor + 1;
            }
            if (char === '\n' || char === '\r') {
                fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated string.');
            }
            cursor += 1;
        }
        fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated string.');
    }

    function readRegex(index) {
        let cursor = index + 1;
        let escaped = false;
        let inClass = false;
        while (cursor < source.length) {
            const char = source[cursor];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '[') {
                inClass = true;
            } else if (char === ']') {
                inClass = false;
            } else if (char === '/' && !inClass) {
                cursor += 1;
                while (/[A-Za-z]/.test(source[cursor] || '')) cursor += 1;
                add('regex', '/', index);
                return cursor;
            } else if (char === '\n' || char === '\r') {
                fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated regular expression.');
            }
            cursor += 1;
        }
        fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated regular expression.');
    }

    function readTemplate(index) {
        let cursor = index + 1;
        while (cursor < source.length) {
            const char = source[cursor];
            if (char === '\\') {
                cursor += 2;
                continue;
            }
            if (char === '`') return cursor + 1;
            if (char === '$' && source[cursor + 1] === '{') {
                cursor = scanCode(cursor + 2, true);
                continue;
            }
            cursor += 1;
        }
        fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated template literal.');
    }

    function scanCode(start, stopAtTemplateBrace = false) {
        let cursor = start;
        let braceDepth = 0;
        while (cursor < source.length) {
            const char = source[cursor];
            if (/\s/.test(char)) {
                cursor += 1;
                continue;
            }
            if (char.charCodeAt(0) > 127) {
                fail('SOURCE_TOKEN_UNSUPPORTED', 'Application code identifiers must use ASCII characters.');
            }
            if (char === '/' && source[cursor + 1] === '/') {
                cursor += 2;
                while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
                continue;
            }
            if (char === '/' && source[cursor + 1] === '*') {
                const end = source.indexOf('*/', cursor + 2);
                if (end === -1) fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated comment.');
                cursor = end + 2;
                continue;
            }
            if (char === '\'' || char === '"') {
                cursor = readString(cursor, char);
                continue;
            }
            if (char === '`') {
                cursor = readTemplate(cursor);
                continue;
            }
            if (isIdentifierStart(char)) {
                let end = cursor + 1;
                while (isIdentifierPart(source[end])) end += 1;
                add('identifier', source.slice(cursor, end), cursor);
                cursor = end;
                continue;
            }
            if (/[0-9]/.test(char)) {
                let end = cursor + 1;
                while (/[A-Za-z0-9_.]/.test(source[end] || '')) end += 1;
                add('number', source.slice(cursor, end), cursor);
                cursor = end;
                continue;
            }
            if (char === '/' && canStartRegex(tokens[tokens.length - 1])) {
                cursor = readRegex(cursor);
                continue;
            }
            if (char === '\\') {
                fail('SOURCE_TOKEN_UNSUPPORTED', 'Escaped JavaScript identifiers are not allowed.');
            }
            if (char === '{') braceDepth += 1;
            if (char === '}') {
                if (stopAtTemplateBrace && braceDepth === 0) return cursor + 1;
                braceDepth -= 1;
            }
            add('punctuator', char, cursor);
            cursor += 1;
        }
        if (stopAtTemplateBrace) {
            fail('SOURCE_PARSE_ERROR', 'Application source contains an unterminated template expression.');
        }
        return cursor;
    }

    scanCode(0, false);
    return tokens;
}

function validateSourcePolicy(source) {
    if (typeof source !== 'string' || !source.trim()) {
        fail('SOURCE_REQUIRED', 'Application source must be a non-empty JavaScript module.');
    }
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    if (sourceBytes > MAX_SOURCE_BYTES) {
        fail('SOURCE_TOO_LARGE', 'Application source exceeds 64 KiB.');
    }

    const tokens = tokenize(source);
    for (const token of tokens) {
        if (token.type !== 'identifier') continue;
        if (FORBIDDEN_IDENTIFIERS.has(token.value)) {
            fail('FORBIDDEN_IDENTIFIER', `Application source uses forbidden identifier: ${token.value}.`);
        }
        if (token.value === 'import') {
            fail('IMPORT_FORBIDDEN', 'Application modules may not import dependencies.');
        }
        if (token.value === 'albusto') {
            fail('ENTRY_POINT_INVALID', 'Applications must use ctx.callTool, not a global capability.');
        }
    }

    const exportIndexes = tokens
        .map((token, index) => token.value === 'export' ? index : -1)
        .filter(index => index >= 0);
    const runIdentifiers = tokens.filter(token => token.type === 'identifier' && token.value === 'run');
    if (exportIndexes.length !== 1 || runIdentifiers.length !== 1) {
        fail('ENTRY_POINT_INVALID', 'Application module must export exactly one async function named run.');
    }
    const entry = exportIndexes[0];
    const expected = ['export', 'async', 'function', 'run', '(', 'ctx', ')'];
    const actual = tokens.slice(entry, entry + expected.length).map(token => token.value);
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        fail('ENTRY_POINT_INVALID', 'Entry point must be export async function run(ctx).');
    }

    const tools = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === 'identifier' && token.value === 'ctx'
            && tokens[index + 1]?.value === '[') {
            fail('CALL_TOOL_INVALID', 'Computed ctx property access is not allowed.');
        }
        if (token.type !== 'identifier' || token.value !== 'callTool') continue;
        const direct = tokens[index - 2]?.value === 'ctx'
            && tokens[index - 1]?.value === '.'
            && tokens[index + 1]?.value === '('
            && tokens[index + 2]?.type === 'string'
            && typeof tokens[index + 2]?.value === 'string';
        if (!direct) {
            fail('CALL_TOOL_INVALID', 'Tool calls must use ctx.callTool with a literal tool name.');
        }
        const toolName = tokens[index + 2].value;
        if (!TOOL_NAMES.has(toolName)) {
            fail('UNKNOWN_TOOL', `Application calls an unknown tool: ${toolName}.`);
        }
        if (!tools.includes(toolName)) tools.push(toolName);
    }

    return Object.freeze({
        sourceBytes,
        tools: Object.freeze(tools),
        entryPoint: 'run',
    });
}

module.exports = {
    MAX_SOURCE_BYTES,
    FORBIDDEN_IDENTIFIERS,
    BuilderValidationError,
    validateSourcePolicy,
    tokenize,
};
