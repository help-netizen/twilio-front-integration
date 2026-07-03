/**
 * MAIL-AGENT-001 — exclusion-rule mini-query parser + matcher.
 *
 * One rule per line. A line MATCHES an email ⇒ the email is EXCLUDED from AI
 * review (lines are OR; tokens within a line are AND).
 *
 *   token      := [-]field:pattern | [-]pattern
 *   field      := from | subject | body | any        (bare pattern = any → from+subject)
 *   pattern    := /regex/[i] | "quoted string" | bareword
 *                 (plain patterns are case-insensitive substring matches)
 *   '-' prefix := token must NOT match
 *
 * Examples:
 *   from:@newsletters. subject:unsubscribe
 *   subject:/^(promo|sale)/i
 *   from:notifications@github.com -subject:"security alert"
 *
 * The same module powers the runtime filter, PUT /settings validation, and the
 * settings-page tester — one source of truth for the syntax.
 */

const FIELDS = new Set(['from', 'subject', 'body', 'any']);
const MAX_PATTERN_LEN = 300;
const MAX_RULES = 200;

/** Split a rule line into raw tokens, honouring "quoted strings" and /regex/ bodies. */
function tokenizeLine(line) {
    const tokens = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        while (i < n && /\s/.test(line[i])) i++;
        if (i >= n) break;
        let start = i;
        let inQuote = false;
        let inRegex = false;
        for (; i < n; i++) {
            const ch = line[i];
            if (inQuote) {
                if (ch === '"') inQuote = false;
            } else if (inRegex) {
                if (ch === '/' && line[i - 1] !== '\\') inRegex = false;
            } else if (ch === '"') {
                inQuote = true;
            } else if (ch === '/') {
                inRegex = true;
            } else if (/\s/.test(ch)) {
                break;
            }
        }
        tokens.push(line.slice(start, i));
    }
    return tokens;
}

/** Parse a single token into {negate, field, kind:'contains'|'regex', value|regex}. Throws on bad syntax. */
function parseToken(raw) {
    let token = raw;
    let negate = false;
    if (token.startsWith('-')) { negate = true; token = token.slice(1); }
    if (!token) throw new Error('empty token');

    let field = 'any';
    const colon = token.indexOf(':');
    if (colon > 0) {
        const maybeField = token.slice(0, colon).toLowerCase();
        if (FIELDS.has(maybeField)) {
            field = maybeField;
            token = token.slice(colon + 1);
        }
    }
    if (!token) throw new Error('empty pattern');

    // /regex/[i] form
    if (token.startsWith('/')) {
        const lastSlash = token.lastIndexOf('/');
        if (lastSlash <= 0) throw new Error(`unterminated regex: ${raw}`);
        const body = token.slice(1, lastSlash);
        const flags = token.slice(lastSlash + 1);
        if (!body) throw new Error('empty regex');
        if (body.length > MAX_PATTERN_LEN) throw new Error('pattern too long (max 300 chars)');
        if (!/^i?$/.test(flags)) throw new Error(`unsupported regex flags "${flags}" (only i)`);
        let regex;
        try {
            regex = new RegExp(body, flags || undefined);
        } catch (e) {
            throw new Error(`invalid regex: ${e.message}`);
        }
        return { negate, field, kind: 'regex', regex };
    }

    // "quoted" or bare substring
    let value = token;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
    }
    if (!value) throw new Error('empty pattern');
    if (value.length > MAX_PATTERN_LEN) throw new Error('pattern too long (max 300 chars)');
    return { negate, field, kind: 'contains', value: value.toLowerCase() };
}

/**
 * Parse the whole rules text.
 * Returns { rules: [{line, tokens}] }. Throws { line, message } on the first bad line.
 * Blank lines and #-comments are skipped (line numbers stay 1-based on the raw text).
 */
function parseRules(text) {
    const rules = [];
    const lines = String(text || '').split('\n');
    if (lines.length > MAX_RULES) {
        const err = new Error(`too many rules (max ${MAX_RULES} lines)`);
        err.line = MAX_RULES + 1;
        throw err;
    }
    for (let idx = 0; idx < lines.length; idx++) {
        const raw = lines[idx].trim();
        if (!raw || raw.startsWith('#')) continue;
        try {
            const tokens = tokenizeLine(raw).map(parseToken);
            if (tokens.length) rules.push({ line: idx + 1, tokens });
        } catch (e) {
            const err = new Error(e.message);
            err.line = idx + 1;
            throw err;
        }
    }
    return { rules };
}

function fieldText(fields, field) {
    switch (field) {
        case 'from': return fields.from;
        case 'subject': return fields.subject;
        case 'body': return fields.body;
        default: return `${fields.from}\n${fields.subject}`; // 'any' = from+subject
    }
}

function tokenMatches(token, fields) {
    const text = fieldText(fields, token.field) || '';
    const hit = token.kind === 'regex'
        ? token.regex.test(text)
        : text.toLowerCase().includes(token.value);
    return token.negate ? !hit : hit;
}

/**
 * Match an email against parsed rules.
 * @param {{rules:Array}} parsed — output of parseRules
 * @param {{from?:string, subject?:string, body?:string}} email
 * @returns {{excluded:boolean, ruleLine:number|null}}
 */
function matchEmail(parsed, email) {
    const fields = {
        from: String(email.from || ''),
        subject: String(email.subject || ''),
        body: String(email.body || ''),
    };
    for (const rule of parsed.rules) {
        if (rule.tokens.every(t => tokenMatches(t, fields))) {
            return { excluded: true, ruleLine: rule.line };
        }
    }
    return { excluded: false, ruleLine: null };
}

module.exports = { parseRules, matchEmail };
