/**
 * EMAIL-HTML-RENDER-001 — TASK-EHR-011 — backend `body_html` plumbing.
 *
 * Pins that the timeline email projection now carries `body_html` end-to-end while
 * `body_text` (quote-stripped) is preserved and the company+contact scoping is
 * unchanged (leak = P0). Three change points:
 *   1. emailQueries.getTimelineEmailByContact — SELECT gains body_html; WHERE
 *      `company_id=$1 AND contact_id=$2 AND on_timeline=true` byte-identical.
 *   2. pulse.js REST mapping — email item gets `body_html: row.body_html || null`
 *      (RAW, un-quote-stripped) beside `body_text: toTimelineBody(...)`.
 *   3. emailTimelineService.toEmailItem — SSE-parity `body_html: row.body_html || null`.
 *
 * `toEmailItem` and the pulse.js inline mapping are NOT exported, so their shape is
 * pinned two ways: (a) the mapping CONTRACT is reproduced against a mocked row and
 * asserted, and (b) a source-anchored check asserts BOTH real sites still contain
 * the `body_html: row.body_html || null` mapping and still emit `body_text` — so a
 * future edit that drops the plumbing fails loudly here. The exported query is
 * exercised for real (db mocked) to prove the SELECT/WHERE.
 *
 * DOM-free / node-env. Run from the REAL repo root (the worktree is excluded by the
 * root jest `testPathIgnorePatterns`), e.g.:
 *   npx jest tests/emailHtmlRenderPlumbing.test.js \
 *     --testPathIgnorePatterns "/node_modules/" --runInBand --forceExit
 */
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const { toTimelineBody } = require('../backend/src/services/email/emailTimelineBody');

const ROOT = path.resolve(__dirname, '..');
const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const CONTACT_C = '11111111-1111-1111-1111-1111111111c1';

beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
});

// ── Change point #1: the exported query (real, db mocked) ────────────────────
describe('getTimelineEmailByContact — SELECT carries body_html; scoping unchanged', () => {
    it('SELECTs both body_html and body_text and keeps the company+contact+on_timeline WHERE', async () => {
        await emailQueries.getTimelineEmailByContact(COMPANY_A, CONTACT_C, {});

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];

        // body_html added to the projection; body_text still present.
        expect(sql).toMatch(/\bbody_html\b/);
        expect(sql).toMatch(/\bbody_text\b/);

        // Scoping byte-identical to today (leak = P0).
        expect(sql).toMatch(/WHERE\s+company_id\s*=\s*\$1\s+AND\s+contact_id\s*=\s*\$2\s+AND\s+on_timeline\s*=\s*true/);
        expect(sql).toMatch(/ORDER BY\s+gmail_internal_at\s+ASC,\s*id\s+ASC/);
        expect(params).toEqual([COMPANY_A, CONTACT_C]);
    });

    it('passes body_html through RAW from the row (no server-side sanitize/quote-strip)', async () => {
        const RAW = '<p>hi</p><script>alert(1)</script>';
        db.query.mockResolvedValueOnce({
            rows: [{ id: 7, direction: 'inbound', body_text: 'hi\n> quoted', body_html: RAW, snippet: 'hi' }],
        });
        const rows = await emailQueries.getTimelineEmailByContact(COMPANY_A, CONTACT_C, {});
        expect(rows[0].body_html).toBe(RAW); // untouched at the query layer — sanitized client-side
        expect(rows[0].body_text).toBe('hi\n> quoted');
    });
});

// ── Change points #2 & #3: mapping CONTRACT (reproduced) + source anchor ──────
// The REST (pulse.js) email item and toEmailItem both map:
//   body_html: row.body_html || null   (RAW)
//   body_text: toTimelineBody(row.body_text, { snippet: row.snippet })  (quote-stripped)
function mapEmailItem(row) {
    return {
        id: row.id,
        type: 'email',
        direction: row.direction,
        body_text: toTimelineBody(row.body_text, { snippet: row.snippet }),
        body_html: row.body_html || null,
    };
}

describe('email item mapping — body_html present (RAW), body_text quote-stripped', () => {
    it('non-empty body_html passes through raw; body_text is quote-stripped', () => {
        const item = mapEmailItem({
            id: 1, direction: 'inbound',
            body_html: '<p>hi</p>', body_text: 'hi\n> quoted', snippet: 'hi',
        });
        expect(item.body_html).toBe('<p>hi</p>');           // RAW, not sanitized/stripped
        expect(item).toHaveProperty('body_text');            // still present
        expect(item.body_text).toBe(toTimelineBody('hi\n> quoted', { snippet: 'hi' }));
        expect(item.body_text).not.toMatch(/>\s*quoted/);    // quote line was stripped
    });

    it('null/undefined/empty body_html coalesces to null (|| null), body_text still emitted', () => {
        expect(mapEmailItem({ id: 2, direction: 'outbound', body_html: null, body_text: 'hey', snippet: 'hey' }).body_html).toBeNull();
        expect(mapEmailItem({ id: 3, direction: 'outbound', body_text: 'hey', snippet: 'hey' }).body_html).toBeNull(); // undefined
        expect(mapEmailItem({ id: 4, direction: 'inbound', body_html: '', body_text: 'hey', snippet: 'hey' }).body_html).toBeNull(); // '' || null
        expect(mapEmailItem({ id: 4, direction: 'inbound', body_html: '', body_text: 'hey', snippet: 'hey' })).toHaveProperty('body_text', 'hey');
    });

    // Source anchor: guarantees the two NON-exported real mapping sites still carry
    // the plumbing (so this contract test can't pass while the ship regresses).
    it('both real mapping sites emit `body_html: row.body_html || null` beside body_text', () => {
        const pulseSrc = fs.readFileSync(path.join(ROOT, 'backend/src/routes/pulse.js'), 'utf8');
        const svcSrc = fs.readFileSync(path.join(ROOT, 'backend/src/services/email/emailTimelineService.js'), 'utf8');

        for (const [name, src] of [['pulse.js', pulseSrc], ['emailTimelineService.js', svcSrc]]) {
            expect(src).toMatch(/body_html:\s*row\.body_html\s*\|\|\s*null/); // #2 / #3
            expect(src).toMatch(/body_text:\s*toTimelineBody\(/);            // body_text still mapped
        }
    });
});
