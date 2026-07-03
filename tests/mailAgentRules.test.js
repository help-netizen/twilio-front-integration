/**
 * MAIL-AGENT-001 — exclusion-rule mini-query parser + matcher.
 * Pure functions; no DB, no network.
 */

const { parseRules, matchEmail } = require('../backend/src/services/mailAgentRules');

const excluded = (rules, email) => matchEmail(parseRules(rules), email).excluded;

describe('mailAgentRules — parsing', () => {
    test('blank lines and # comments are ignored', () => {
        const parsed = parseRules('# newsletters\n\nfrom:@news.\n');
        expect(parsed.rules).toHaveLength(1);
        expect(parsed.rules[0].line).toBe(3);
    });

    test('bad regex throws with 1-based line number', () => {
        expect.assertions(2);
        try {
            parseRules('from:ok@x.com\nsubject:/broken(/');
        } catch (e) {
            expect(e.line).toBe(2);
            expect(e.message).toMatch(/invalid regex/i);
        }
    });

    test('unsupported regex flags are rejected (only i allowed)', () => {
        expect(() => parseRules('from:/x/g')).toThrow(/flags/);
        expect(() => parseRules('from:/x/i')).not.toThrow();
    });

    test('overlong patterns are rejected', () => {
        expect(() => parseRules('subject:' + 'a'.repeat(301))).toThrow(/too long/);
    });
});

describe('mailAgentRules — matching', () => {
    test('field:substring is a case-insensitive contains on that field', () => {
        expect(excluded('subject:unsubscribe', { subject: 'Click to UNSUBSCRIBE' })).toBe(true);
        expect(excluded('subject:unsubscribe', { subject: 'Need help' })).toBe(false);
    });

    test('bare pattern searches from+subject (any), not body', () => {
        expect(excluded('invoice', { from: 'billing@vendor.com', subject: 'Your invoice' })).toBe(true);
        expect(excluded('invoice', { from: 'x@y.z', subject: 'hello', body: 'invoice inside' })).toBe(false);
    });

    test('body: targets the body', () => {
        expect(excluded('body:coupon', { subject: 'y', body: 'your COUPON' })).toBe(true);
    });

    test('/regex/i works per field', () => {
        expect(excluded('subject:/^(promo|sale)/i', { subject: 'PROMO: deals' })).toBe(true);
        expect(excluded('subject:/^(promo|sale)/i', { subject: 'not a promo' })).toBe(false);
    });

    test('tokens on one line AND together; minus negates', () => {
        const rules = 'from:notifications@github.com -subject:"security alert"';
        expect(excluded(rules, { from: 'notifications@github.com', subject: 'PR merged' })).toBe(true);
        expect(excluded(rules, { from: 'notifications@github.com', subject: 'Security Alert: leak' })).toBe(false);
    });

    test('lines OR together and report the matched line', () => {
        const parsed = parseRules('from:@spam.io\nsubject:webinar');
        const hit = matchEmail(parsed, { from: 'x@ok.com', subject: 'Join our webinar' });
        expect(hit.excluded).toBe(true);
        expect(hit.ruleLine).toBe(2);
    });

    test('quoted strings keep spaces', () => {
        expect(excluded('subject:"weekly digest"', { subject: 'Your Weekly Digest #12' })).toBe(true);
        expect(excluded('subject:"weekly digest"', { subject: 'weekly summary digest' })).toBe(false);
    });

    test('empty rules exclude nothing', () => {
        expect(excluded('', { from: 'a@b.c', subject: 'anything' })).toBe(false);
    });
});
