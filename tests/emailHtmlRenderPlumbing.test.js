'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const {
    projectEmailTimelineItem,
} = require('../backend/src/services/email/emailTimelineItem');

const ROOT = path.resolve(__dirname, '..');
const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const CONTACT_C = '11111111-1111-1111-1111-1111111111c1';

beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
});

describe('raw email persistence/query contract stays unchanged', () => {
    it('SELECTs raw body_html/body_text with the existing tenant+contact scope', async () => {
        await emailQueries.getTimelineEmailByContact(COMPANY_A, CONTACT_C, {});

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/\bbody_html\b/);
        expect(sql).toMatch(/\bbody_text\b/);
        expect(sql).toMatch(/WHERE\s+company_id\s*=\s*\$1\s+AND\s+contact_id\s*=\s*\$2\s+AND\s+on_timeline\s*=\s*true/);
        expect(sql).toMatch(/ORDER BY\s+gmail_internal_at\s+ASC,\s*id\s+ASC/);
        expect(params).toEqual([COMPANY_A, CONTACT_C]);
    });

    it('query layer returns raw HTML and text byte-for-byte', async () => {
        const rawHtml = '<p>hi</p><script>alert(1)</script><div class="gmail_quote">old</div>';
        const rawText = 'hi\n\nOn Monday Sender wrote:\n> old';
        db.query.mockResolvedValueOnce({
            rows: [{ id: 7, body_text: rawText, body_html: rawHtml, snippet: 'hi' }],
        });

        const rows = await emailQueries.getTimelineEmailByContact(COMPANY_A, CONTACT_C, {});
        expect(rows[0].body_html).toBe(rawHtml);
        expect(rows[0].body_text).toBe(rawText);
    });
});

describe('shared Pulse email projector', () => {
    const rawRow = {
        company_id: COMPANY_A,
        id: 7,
        thread_id: 8,
        direction: 'inbound',
        from_email: 'sender@example.com',
        from_name: 'Sender',
        to_recipients_json: ['support@example.com'],
        subject: 'Re: Work',
        body_text: 'Fresh reply\n\nOn Monday Sender wrote:\n> old',
        body_html: '<p>Fresh reply</p><div class="gmail_quote">OLD-HTML</div>',
        snippet: 'Fresh reply',
        gmail_internal_at: '2026-07-27T12:00:00.000Z',
        sent_by_user_email: null,
    };

    it('emits stripped body_text + display_html and omits body_html', () => {
        const item = projectEmailTimelineItem(rawRow);

        expect(item.body_text).toBe('Fresh reply');
        expect(item.display_html).toBe('<p>Fresh reply</p>');
        expect(item).not.toHaveProperty('body_html');
        expect(item).toMatchObject({
            company_id: COMPANY_A,
            id: 7,
            type: 'email',
            direction: 'inbound',
            is_outbound: false,
            thread_id: 8,
        });
    });

    it('display_html is always string|null and remains null without usable HTML', () => {
        expect(projectEmailTimelineItem({ ...rawRow, body_html: null }).display_html).toBeNull();
        expect(projectEmailTimelineItem({ ...rawRow, body_html: '' }).display_html).toBeNull();
        expect(typeof projectEmailTimelineItem(rawRow).display_html).toBe('string');
    });

    it('REST, SSE, and send paths all call the shared projector and contain no inline raw mapping', () => {
        const pulseSource = fs.readFileSync(
            path.join(ROOT, 'backend/src/routes/pulse.js'),
            'utf8'
        );
        const serviceSource = fs.readFileSync(
            path.join(ROOT, 'backend/src/services/email/emailTimelineService.js'),
            'utf8'
        );

        expect(pulseSource.match(/projectEmailTimelineItem/g).length).toBeGreaterThanOrEqual(3);
        expect(serviceSource.match(/projectEmailTimelineItem/g).length).toBeGreaterThanOrEqual(7);
        expect(pulseSource).not.toMatch(/body_html\s*:/);
        expect(serviceSource).not.toMatch(/body_html\s*:/);
    });
});
