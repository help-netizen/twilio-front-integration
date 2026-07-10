'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — PARSE (YLA-P-01..05).
 * Target: yelpLeadService.parseYelpLead(msg) (pure). Fail-safe contract: always
 * returns a parse object; unknown fields → null; NEVER throws.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadService.parse.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const { parseYelpLead } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

describe('parseYelpLead — extraction + fail-safe (P0/P1)', () => {
    it('YLA-P-01: full parse of the new-lead sample', () => {
        const p = parseYelpLead(yNew());
        expect(p).toMatchObject({
            name: 'Kim',
            service: 'dishwasher repair',
            zip: '02467',
            reply_to: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
            thread_token: '8160b36a1c2d3e4f',
        });
        // problem is asserted by substring, not exact text.
        expect(p.problem).toEqual(expect.stringContaining('Maytag'));
        expect(p.problem).toEqual(expect.stringContaining('mid cycle'));
        // name derives from the body header, NOT the last-initialed from_name ('Kim L.').
        expect(p.name).toBe('Kim');
    });

    it('YLA-P-02: fail-safe — missing ZIP → zip:null, still returns other fields', () => {
        // Remove the "Newton, MA 02467" city/state/zip line entirely.
        const body = yNew().body_text.replace('Newton, MA 02467', '');
        const p = parseYelpLead(yNew({ body_text: body }));
        expect(p.zip).toBeNull();
        expect(p.name).toBe('Kim');
        expect(p.service).toBe('dishwasher repair');
        expect(p.reply_to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        expect(p.thread_token).toBe('8160b36a1c2d3e4f');
    });

    it('YLA-P-03: fail-safe — no free-text detail → problem:null, service still parsed', () => {
        const body = [
            'Kim requested a quote from ABC Homes for a dishwasher repair.',
            'View: https://www.yelp.com/x?utm_source=request_a_quote_first_message',
        ].join('\n');
        const p = parseYelpLead(yNew({ body_text: body }));
        expect(p.problem).toBeNull();
        expect(p.service).toBe('dishwasher repair');
        expect(p.name).toBe('Kim');
    });

    it('YLA-P-04: reply_to + thread_token from the reply+<hex>@messaging.yelp.com local-part', () => {
        const p = parseYelpLead(yNew({ from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com' }));
        // Full relay address, verbatim (this is the send target).
        expect(p.reply_to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        // Only the hex between reply+ and @.
        expect(p.thread_token).toBe('8160b36a1c2d3e4f');
    });

    it('YLA-P-05: mangled From (no reply+ token) → reply_to:null, thread_token:null, still returns', () => {
        const p = parseYelpLead(yNew({ from_email: 'noreply@messaging.yelp.com' }));
        expect(p.reply_to).toBeNull();
        expect(p.thread_token).toBeNull();
        // Other fields best-effort from the body.
        expect(p.name).toBe('Kim');
        expect(p.service).toBe('dishwasher repair');
    });

    it('never throws on a garbage message', () => {
        expect(() => parseYelpLead(null)).not.toThrow();
        expect(() => parseYelpLead({})).not.toThrow();
        const p = parseYelpLead({ from_email: 123, body_text: {} });
        expect(p).toBeTruthy();
    });
});
