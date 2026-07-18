'use strict';

const originalFeatureAuth = process.env.FEATURE_AUTH_ENABLED;
process.env.FEATURE_AUTH_ENABLED = 'true';

const mockDb = { query: jest.fn() };
const mockConvQueries = {
    getMessages: jest.fn(),
    getMessagesPageDesc: jest.fn(),
};
const mockEmailQueries = {
    getTimelineEmailByContact: jest.fn(),
    getTimelineEmailByTimeline: jest.fn(),
    getTimelineEmailPageByContact: jest.fn(),
    getTimelineEmailPageByTimeline: jest.fn(),
};
const mockContactsService = { getContactEmails: jest.fn() };
const mockJwt = { verify: jest.fn((_token, _key, _options, callback) => callback(new Error('invalid token'))) };

jest.mock('../backend/src/db/connection', () => mockDb);
jest.mock('../backend/src/db/conversationsQueries', () => mockConvQueries);
jest.mock('../backend/src/db/emailQueries', () => mockEmailQueries);
jest.mock('../backend/src/services/contactsService', () => mockContactsService);
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: jest.fn() }));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('../backend/src/db/queries', () => ({
    markThreadHandled: jest.fn(),
    snoozeThread: jest.fn(),
    assignThread: jest.fn(),
    setActionRequired: jest.fn(),
    createTask: jest.fn(),
    findOrCreateTimeline: jest.fn(),
}));
jest.mock('jsonwebtoken', () => mockJwt);
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));

const express = require('express');
const request = require('supertest');
const timelinePage = require('../backend/src/services/timelinePage');
const pulseRouter = require('../backend/src/routes/pulse');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const legacyGolden = require('./fixtures/timeline-legacy-golden.json');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const CONTACT = {
    id: 42,
    company_id: COMPANY_A,
    phone_e164: '+15085550100',
    secondary_phone: '+15085550199',
    full_name: 'Golden Customer',
    email: 'primary@example.com',
};
const TIMELINE = {
    id: 77,
    company_id: COMPANY_A,
    contact_id: CONTACT.id,
    phone_e164: CONTACT.phone_e164,
    display_name: 'Golden Thread',
    external_source: 'fixture',
};
const CONVERSATION = {
    id: '11111111-1111-4111-8111-111111111111',
    company_id: COMPANY_A,
    customer_e164: CONTACT.phone_e164,
    proxy_e164: '+16175550123',
    last_message_at: '2026-07-12T14:00:00.000Z',
};

const GOLDEN_DATA = {
    calls: [
        {
            id: '9002', call_sid: 'CA-golden-new', parent_call_sid: null,
            direction: 'inbound', from_number: CONTACT.phone_e164, to_number: '+16175550123',
            status: 'completed', is_final: true,
            started_at: '2026-07-12T15:00:00.123Z', answered_at: '2026-07-12T15:00:03.123Z',
            ended_at: '2026-07-12T15:02:00.123Z', duration_sec: 117,
            answered_by: 'agent@example.com', price: '-0.0250', price_unit: 'USD',
            created_at: '2026-07-12T15:00:00.123Z', updated_at: '2026-07-12T15:02:01.000Z',
            contact: JSON.stringify(CONTACT), call_count: '2',
            recording_sid: 'RE-golden', recording_status: 'completed', recording_duration_sec: 117,
            transcript_status: 'completed', transcript_text: 'Golden transcript',
            transcript_raw_payload: JSON.stringify({ gemini_summary: 'Golden summary' }),
            ts: '2026-07-12T15:00:00.123000Z',
        },
        {
            id: '9001', call_sid: 'CA-golden-null-start', parent_call_sid: null,
            direction: 'outbound', from_number: '+16175550123', to_number: CONTACT.phone_e164,
            status: 'no-answer', is_final: true, started_at: null, answered_at: null,
            ended_at: '2026-07-11T10:00:15.000Z', duration_sec: 0,
            answered_by: null, price: null, price_unit: null,
            created_at: '2026-07-11T10:00:00.654Z', updated_at: '2026-07-11T10:00:15.000Z',
            contact: CONTACT, recording_sid: null, transcript_status: null,
            ts: '2026-07-11T10:00:00.654000Z',
        },
    ],
    messages: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', company_id: COMPANY_A,
        conversation_id: CONVERSATION.id, direction: 'inbound', body: 'Photo attached',
        created_at: '2026-07-12T14:00:00.000Z', date_created_remote: '2026-07-12T14:00:00.000Z',
        media: JSON.stringify([{
            id: 'media-1', twilio_media_sid: 'ME-golden', filename: 'photo.jpg',
            content_type: 'image/jpeg', size_bytes: 12345, preview_kind: 'image',
        }]),
        ts: '2026-07-12T14:00:00.000000Z',
    }],
    emails: [{
        id: '7001', thread_id: '6001', provider_thread_id: 'gmail-thread-golden',
        direction: 'inbound', from_name: 'Golden Customer', from_email: 'primary@example.com',
        to_recipients_json: ['support@example.com'], subject: 'Golden email',
        body_text: 'Fresh reply\n\nOn Sun, Jul 12, 2026 at 9:00 AM Support <support@example.com> wrote:\n> quoted text',
        body_html: '<p>Fresh reply</p><blockquote>quoted text</blockquote>', snippet: 'Fresh reply',
        gmail_internal_at: '2026-07-12T13:00:00.000Z', sent_by_user_email: null,
        is_outbound: false, ts: '2026-07-12T13:00:00.000000Z',
    }],
    estimates: [{
        id: '3001', reference: 'EST-3001', status: 'accepted', total: '125.00',
        occurred_at: '2026-07-10T12:00:00.000Z', ts: '2026-07-10T12:00:00.000000Z',
    }],
    invoices: [{
        id: '4001', reference: 'INV-4001', status: 'paid', total: '125.00', amount_paid: '125.00',
        occurred_at: '2026-07-10T13:00:00.000Z', ts: '2026-07-10T13:00:00.000000Z',
    }],
};

const KINDS = ['call', 'sms', 'email', 'estimate', 'invoice'];

function displayTs(ts) {
    return ts.replace(/(\.\d{3})\d{3}Z$/, '$1Z');
}

function walkTs(index) {
    if (index < 18) {
        return `2026-07-12T11:00:${String(59 - index).padStart(2, '0')}.900000Z`;
    }
    if (index <= 22) return '2026-07-12T11:00:40.500000Z';
    return `2026-07-12T11:00:${String(63 - index).padStart(2, '0')}.400000Z`;
}

function smsId(index) {
    return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`;
}

function makeWalkData() {
    const data = { calls: [], messages: [], emails: [], estimates: [], invoices: [] };
    for (let index = 0; index < 50; index++) {
        const kind = index >= 18 && index <= 22 ? KINDS[index - 18] : KINDS[index % KINDS.length];
        const ts = walkTs(index);
        if (kind === 'call') {
            data.calls.push({
                id: String(90000 - index), call_sid: `CA-walk-${index}`, parent_call_sid: null,
                direction: index % 2 ? 'outbound' : 'inbound',
                from_number: CONTACT.phone_e164, to_number: CONVERSATION.proxy_e164,
                status: 'completed', is_final: true, started_at: displayTs(ts), answered_at: null,
                ended_at: displayTs(ts), duration_sec: index, answered_by: null,
                price: null, price_unit: null, created_at: displayTs(ts), updated_at: displayTs(ts),
                contact: CONTACT, recording_sid: null, transcript_status: null, ts,
            });
        } else if (kind === 'sms') {
            data.messages.push({
                id: smsId(index), company_id: COMPANY_A, conversation_id: CONVERSATION.id,
                direction: index % 2 ? 'inbound' : 'outbound', body: `SMS ${index}`,
                created_at: displayTs(ts), date_created_remote: displayTs(ts),
                media: index === 19 ? JSON.stringify([{ id: 'walk-media', content_type: 'image/png' }]) : [],
                ts,
            });
        } else if (kind === 'email') {
            data.emails.push({
                id: String(80000 - index), thread_id: String(70000 - index),
                provider_thread_id: `provider-${index}`, direction: index % 2 ? 'inbound' : 'outbound',
                from_name: 'Fixture Sender', from_email: 'sender@example.com',
                to_recipients_json: ['receiver@example.com'], subject: `Email ${index}`,
                body_text: `Email body ${index}`, body_html: null, snippet: `Email body ${index}`,
                gmail_internal_at: displayTs(ts), sent_by_user_email: null,
                is_outbound: index % 2 === 0, ts,
            });
        } else if (kind === 'estimate') {
            data.estimates.push({
                id: String(60000 - index), reference: `EST-${index}`, status: 'accepted', total: `${100 + index}.00`,
                occurred_at: displayTs(ts), ts,
            });
        } else {
            const amountPaid = index % 3 === 0 ? `${100 + index}.00` : index % 3 === 1 ? '25.00' : '0.00';
            data.invoices.push({
                id: String(50000 - index), reference: `INV-${index}`, status: 'open', total: `${100 + index}.00`,
                amount_paid: amountPaid, occurred_at: displayTs(ts), ts,
            });
        }
    }
    return data;
}

let state;

function resetState() {
    state = {
        companyId: COMPANY_A,
        contact: { ...CONTACT },
        timeline: { ...TIMELINE },
        conversations: [{ ...CONVERSATION }],
        companyOwnNumbers: [CONVERSATION.proxy_e164],
        data: GOLDEN_DATA,
        timelineExists: true,
        contactExists: true,
        providerVisible: true,
        failPagedCalls: false,
        events: [],
    };
}

function compareNativeIds(left, right) {
    const a = String(left);
    const b = String(right);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        if (a.length !== b.length) return a.length < b.length ? -1 : 1;
        return a === b ? 0 : a < b ? -1 : 1;
    }
    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();
    return lowerA === lowerB ? 0 : lowerA < lowerB ? -1 : 1;
}

function appliesPredicate(row, predicate) {
    if (!predicate) return true;
    if (predicate.mode === 'lte') return row.ts <= predicate.ts;
    if (predicate.mode === 'lt') return row.ts < predicate.ts;
    return row.ts < predicate.ts
        || (row.ts === predicate.ts && compareNativeIds(row.id, predicate.id) < 0);
}

function sourcePage(rows, kind, limit, predicate) {
    return rows
        .filter(row => appliesPredicate(row, predicate))
        .slice()
        .sort((left, right) => timelinePage.compareDesc(
            { ts: left.ts, kind, id: String(left.id) },
            { ts: right.ts, kind, id: String(right.id) }
        ))
        .slice(0, limit);
}

function predicateFromSql(sql, params) {
    if (/\(\$3::timestamptz, \$4::bigint\)/.test(sql)) {
        return { mode: 'tuple', ts: params[2], id: params[3] };
    }
    if (/<= \$3::timestamptz/.test(sql)) return { mode: 'lte', ts: params[2] };
    if (/< \$3::timestamptz/.test(sql)) return { mode: 'lt', ts: params[2] };
    return null;
}

function recordEvent(tag, sql, params) {
    state.events.push({ tag, sql: String(sql), params: params || [] });
}

async function dispatchDb(sql, params = []) {
    const text = String(sql);
    if (/SELECT \* FROM timelines WHERE id =/i.test(text)) {
        recordEvent('timeline_guard', text, params);
        return { rows: state.timelineExists ? [state.timeline] : [] };
    }
    if (/SELECT \* FROM contacts WHERE id =/i.test(text)) {
        recordEvent('contact_guard', text, params);
        return { rows: state.contactExists && state.contact ? [state.contact] : [] };
    }
    if (/SELECT \* FROM timelines WHERE contact_id =/i.test(text)) {
        recordEvent('timeline_by_contact', text, params);
        return { rows: state.timelineExists && state.timeline ? [state.timeline] : [] };
    }
    if (/FROM jobs pj/i.test(text)) {
        recordEvent('provider_guard', text, params);
        return { rows: state.providerVisible ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT DISTINCT from_number AS n FROM calls/i.test(text)) {
        recordEvent('discovery', text, params);
        const numbers = new Set();
        for (const row of state.data.calls) {
            if (row.from_number) numbers.add(row.from_number);
            if (row.to_number) numbers.add(row.to_number);
        }
        return { rows: [...numbers].map(n => ({ n })) };
    }
    if (/SELECT DISTINCT proxy_e164 FROM sms_conversations/i.test(text)) {
        recordEvent('company_number_lookup', text, params);
        return { rows: state.companyOwnNumbers.map(proxy_e164 => ({ proxy_e164 })) };
    }
    if (/FROM sms_conversations/i.test(text)) {
        recordEvent('conversation_lookup', text, params);
        const phoneDigits = new Set(params[0]);
        return {
            rows: state.conversations.filter(conversation =>
                conversation.company_id === params[1]
                && phoneDigits.has(conversation.customer_e164.replace(/\D/g, ''))
            ),
        };
    }
    if (/SELECT c\.\*, to_json\(co\)/i.test(text)) {
        recordEvent('calls', text, params);
        const paged = /LIMIT \$\d+/.test(text);
        if (paged && state.failPagedCalls) throw new Error('calls leg failed');
        if (!paged) {
            return {
                rows: state.data.calls.slice().sort((left, right) => {
                    if (left.started_at == null) return right.started_at == null ? 0 : 1;
                    if (right.started_at == null) return -1;
                    return left.started_at > right.started_at ? -1 : left.started_at < right.started_at ? 1 : 0;
                }),
            };
        }
        return { rows: sourcePage(state.data.calls, 'call', params[params.length - 1], predicateFromSql(text, params)) };
    }
    if (/FROM estimates/i.test(text)) {
        recordEvent('estimates', text, params);
        if (!/LIMIT \$\d+/.test(text)) return { rows: state.data.estimates };
        return { rows: sourcePage(state.data.estimates, 'estimate', params[params.length - 1], predicateFromSql(text, params)) };
    }
    if (/FROM invoices/i.test(text)) {
        recordEvent('invoices', text, params);
        if (!/LIMIT \$\d+/.test(text)) return { rows: state.data.invoices };
        return { rows: sourcePage(state.data.invoices, 'invoice', params[params.length - 1], predicateFromSql(text, params)) };
    }
    return { rows: [] };
}

function stripTs(row) {
    const copy = { ...row };
    delete copy.ts;
    return copy;
}

function configureMocks() {
    mockDb.query.mockReset().mockImplementation(dispatchDb);
    mockConvQueries.getMessages.mockReset().mockImplementation(async (conversationId, { limit }) => state.data.messages
        .filter(row => row.conversation_id === conversationId)
        .slice()
        .sort((left, right) => left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : compareNativeIds(left.id, right.id))
        .slice(0, limit)
        .map(stripTs));
    mockConvQueries.getMessagesPageDesc.mockReset().mockImplementation(async (conversationIds, companyId, options) => {
        recordEvent('sms', 'getMessagesPageDesc', [conversationIds, companyId, options]);
        const rows = [];
        for (const conversationId of conversationIds) {
            rows.push(...sourcePage(
                state.data.messages.filter(row => row.conversation_id === conversationId),
                'sms', options.limit, options.cursorPred
            ));
        }
        return rows;
    });
    mockEmailQueries.getTimelineEmailByContact.mockReset().mockImplementation(async () => state.data.emails
        .slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : compareNativeIds(a.id, b.id)));
    mockEmailQueries.getTimelineEmailByTimeline.mockReset().mockImplementation(async () => state.data.emails
        .slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : compareNativeIds(a.id, b.id)));
    const emailPage = async (kind, companyId, id, options) => {
        recordEvent(kind, kind, [companyId, id, options]);
        return sourcePage(state.data.emails, 'email', options.limit, options.cursorPred);
    };
    mockEmailQueries.getTimelineEmailPageByContact.mockReset()
        .mockImplementation((companyId, id, options) => emailPage('email_contact', companyId, id, options));
    mockEmailQueries.getTimelineEmailPageByTimeline.mockReset()
        .mockImplementation((companyId, id, options) => emailPage('email_timeline', companyId, id, options));
    mockContactsService.getContactEmails.mockReset().mockResolvedValue([
        'primary@example.com',
        'billing@example.com',
    ]);
}

function stubApp({ permissions = ['pulse.view', 'financial_data.view'], scopes = {}, devMode = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'kc-user', email: 'agent@example.com', crmUser: { id: 'crm-user' }, _devMode: devMode,
        };
        req.authz = {
            permissions, scopes,
            company: { id: COMPANY_A, status: 'active' },
            membership: { id: 'membership-1', role_key: 'dispatcher' },
        };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/api/pulse', pulseRouter);
    return app;
}

function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/pulse', authenticate, requireCompanyAccess, pulseRouter);
    return app;
}

function clearActivity() {
    state.events = [];
    mockDb.query.mockClear();
    mockConvQueries.getMessages.mockClear();
    mockConvQueries.getMessagesPageDesc.mockClear();
    mockEmailQueries.getTimelineEmailByContact.mockClear();
    mockEmailQueries.getTimelineEmailByTimeline.mockClear();
    mockEmailQueries.getTimelineEmailPageByContact.mockClear();
    mockEmailQueries.getTimelineEmailPageByTimeline.mockClear();
    mockContactsService.getContactEmails.mockClear();
}

function expectNoFeedLegs() {
    expect(state.events.filter(event => [
        'discovery', 'company_number_lookup', 'conversation_lookup', 'calls', 'sms',
        'email_contact', 'email_timeline', 'estimates', 'invoices',
    ].includes(event.tag))).toEqual([]);
    expect(mockConvQueries.getMessages).not.toHaveBeenCalled();
    expect(mockConvQueries.getMessagesPageDesc).not.toHaveBeenCalled();
    expect(mockEmailQueries.getTimelineEmailByContact).not.toHaveBeenCalled();
    expect(mockEmailQueries.getTimelineEmailPageByContact).not.toHaveBeenCalled();
    expect(mockEmailQueries.getTimelineEmailPageByTimeline).not.toHaveBeenCalled();
}

function comparable(item) {
    const kind = item.src === 'financial'
        ? (item.id.startsWith('estimate-') ? 'estimate' : 'invoice')
        : item.src;
    return {
        ts: item.ts,
        kind,
        id: item.src === 'financial' ? item.id.slice(item.id.indexOf('-') + 1) : item.id,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    resetState();
    configureMocks();
});

afterAll(() => {
    if (originalFeatureAuth == null) delete process.env.FEATURE_AUTH_ENABLED;
    else process.env.FEATURE_AUTH_ENABLED = originalFeatureAuth;
});

test('TC-TRP-020: legacy/paged branch selection on both endpoints, after unchanged guards', async () => {
    for (const path of ['/api/pulse/timeline-by-id/not-an-int', '/api/pulse/timeline/not-an-int']) {
        const invalid = await request(stubApp()).get(path);
        expect(invalid.status).toBe(400);
    }
    expect(mockDb.query).not.toHaveBeenCalled();

    const mergeSpy = jest.spyOn(timelinePage, 'mergePage');
    try {
        for (const path of [`/api/pulse/timeline-by-id/${TIMELINE.id}`, `/api/pulse/timeline/${CONTACT.id}`]) {
            clearActivity();
            mergeSpy.mockClear();
            const legacy = await request(stubApp({ scopes: { job_visibility: 'assigned_only' } })).get(path);
            expect(legacy.status).toBe(200);
            expect(legacy.body).not.toHaveProperty('page');
            expect(legacy.body).not.toHaveProperty('meta');
            expect(mockConvQueries.getMessages).toHaveBeenCalled();
            expect(mergeSpy).not.toHaveBeenCalled();
            expect(state.events.findIndex(event => event.tag === 'provider_guard'))
                .toBeLessThan(state.events.findIndex(event => event.tag === 'calls'));

            clearActivity();
            mergeSpy.mockClear();
            const paged = await request(stubApp({ scopes: { job_visibility: 'assigned_only' } })).get(`${path}?limit=20`);
            expect(paged.status).toBe(200);
            expect(paged.body).toEqual(expect.objectContaining({
                page: expect.objectContaining({ items: expect.any(Array), next_cursor: null, has_more: false }),
                meta: expect.any(Object),
            }));
            expect(mockConvQueries.getMessages).not.toHaveBeenCalled();
            expect(mockConvQueries.getMessagesPageDesc).toHaveBeenCalled();
            expect(mergeSpy).toHaveBeenCalledTimes(1);
            expect(state.events.findIndex(event => event.tag === 'provider_guard'))
                .toBeLessThan(state.events.findIndex(event => event.tag === 'discovery'));
        }
    } finally {
        mergeSpy.mockRestore();
    }
});

test('TC-TRP-021: invalid limit returns 400 before every SQL call', async () => {
    for (const endpoint of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        for (const limit of ['abc', '0', '-5', '1.5', '']) {
            clearActivity();
            const response = await request(stubApp()).get(`/api/pulse/${endpoint}?limit=${limit}`);
            expect(response.status).toBe(400);
            expect(response.body).toEqual({ error: 'Invalid limit' });
            expect(mockDb.query).not.toHaveBeenCalled();
            expectNoFeedLegs();
        }
    }
});

test('TC-TRP-022: malformed cursor and before-without-limit return 400 before SQL', async () => {
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const invalid = [
        'junk',
        encoded({ v: 2, ts: '2026-07-12T12:00:00.000000Z', k: 0, id: '1' }),
        encoded({ v: 1, ts: '2026-07-12T12:00:00.000Z', k: 0, id: '1' }),
        encoded({ v: 1, ts: '2026-07-12T12:00:00.000000Z', k: 0, id: '../' }),
    ];
    const valid = timelinePage.encodeCursor({ ts: '2026-07-12T12:00:00.000000Z', k: 0, id: '1' });
    for (const endpoint of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        for (const cursor of invalid) {
            clearActivity();
            const response = await request(stubApp())
                .get(`/api/pulse/${endpoint}?limit=20&before=${encodeURIComponent(cursor)}`);
            expect(response.status).toBe(400);
            expect(response.body).toEqual({ error: 'Invalid cursor' });
            expect(mockDb.query).not.toHaveBeenCalled();
            expectNoFeedLegs();
        }
        clearActivity();
        const withoutLimit = await request(stubApp())
            .get(`/api/pulse/${endpoint}?before=${encodeURIComponent(valid)}`);
        expect(withoutLimit.status).toBe(400);
        expect(withoutLimit.body).toEqual({ error: 'Invalid cursor' });
        expect(mockDb.query).not.toHaveBeenCalled();
        expectNoFeedLegs();
    }
});

test('TC-TRP-023: real authenticate returns 401 for missing and invalid tokens in both modes', async () => {
    for (const endpoint of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        for (const suffix of ['', '?limit=20']) {
            clearActivity();
            const missing = await request(realAuthApp()).get(`/api/pulse/${endpoint}${suffix}`);
            expect(missing.status).toBe(401);
            clearActivity();
            const invalid = await request(realAuthApp()).get(`/api/pulse/${endpoint}${suffix}`)
                .set('Authorization', 'Bearer garbage');
            expect(invalid.status).toBe(401);
            expect(mockDb.query).not.toHaveBeenCalled();
            expectNoFeedLegs();
        }
    }
});

test('TC-TRP-024: missing pulse.view returns 403 before SQL in both modes/endpoints', async () => {
    for (const endpoint of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        for (const suffix of ['', '?limit=20']) {
            clearActivity();
            const response = await request(stubApp({ permissions: [] })).get(`/api/pulse/${endpoint}${suffix}`);
            expect(response.status).toBe(403);
            expect(mockDb.query).not.toHaveBeenCalled();
            expectNoFeedLegs();
        }
    }
});

test('TC-TRP-025: foreign timeline/contact IDs are tenant-safe 404s before feed legs', async () => {
    state.timelineExists = false;
    for (const suffix of ['', '?limit=20']) {
        clearActivity();
        const response = await request(stubApp()).get(`/api/pulse/timeline-by-id/999${suffix}`);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Timeline not found' });
        expectNoFeedLegs();
    }
    state.timelineExists = true;
    state.contactExists = false;
    clearActivity();
    const response = await request(stubApp()).get('/api/pulse/timeline/999?limit=20');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Contact not found' });
    expectNoFeedLegs();
});

test('TC-TRP-026: assigned_only invisibility and orphan timelines 404 before feed legs', async () => {
    state.providerVisible = false;
    for (const path of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        clearActivity();
        const response = await request(stubApp({ scopes: { job_visibility: 'assigned_only' } }))
            .get(`/api/pulse/${path}?limit=20`);
        expect(response.status).toBe(404);
        expectNoFeedLegs();
    }
    state.timeline = { ...TIMELINE, contact_id: null };
    state.contact = null;
    clearActivity();
    const orphan = await request(stubApp({ scopes: { job_visibility: 'assigned_only' } }))
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(orphan.status).toBe(404);
    expect(orphan.body).toEqual({ error: 'Timeline not found' });
    expectNoFeedLegs();
});

test('TC-TRP-027: no-limit response on both endpoints is byte-identical to frozen golden', async () => {
    const expectedKeys = [
        'calls', 'messages', 'conversations', 'email_messages', 'financial_events',
        'timeline_id', 'display_name', 'external_source', 'contact',
    ];
    for (const path of [`timeline-by-id/${TIMELINE.id}`, `timeline/${CONTACT.id}`]) {
        clearActivity();
        const response = await request(stubApp()).get(`/api/pulse/${path}`);
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toEqual(expectedKeys);
        expect(response.body).toEqual(legacyGolden);
        expect(JSON.stringify(response.body)).toBe(JSON.stringify(legacyGolden));
        expect(response.body.calls.at(-1).started_at).toBeNull();
        expect(response.body.messages[0].media).toEqual(expect.any(Array));
        expect(response.body.email_messages[0].body_text).toBe('Fresh reply');
        expect(JSON.stringify(response.body)).not.toContain('"ts"');
    }
});

test('TC-TRP-028: three-page walk is complete, ordered, DTO-identical to legacy, and meta is page-1 only', async () => {
    state.data = makeWalkData();
    const legacy = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}`);
    expect(legacy.status).toBe(200);

    const pages = [];
    let before = null;
    for (let index = 0; index < 3; index++) {
        const query = before ? `?limit=20&before=${encodeURIComponent(before)}` : '?limit=20';
        const response = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}${query}`);
        expect(response.status).toBe(200);
        pages.push(response.body);
        before = response.body.page.next_cursor;
    }

    expect(pages.map(entry => entry.page.items.length)).toEqual([20, 20, 10]);
    expect(pages.map(entry => entry.page.has_more)).toEqual([true, true, false]);
    expect(pages[2].page.next_cursor).toBeNull();
    expect(pages[0]).toHaveProperty('meta');
    expect(pages[0].meta.conversations[0].proxy_e164).toBe(CONVERSATION.proxy_e164);
    expect(pages[1]).not.toHaveProperty('meta');
    expect(pages[2]).not.toHaveProperty('meta');

    const items = pages.flatMap(entry => entry.page.items);
    expect(new Set(items.map(item => `${item.src}:${item.id}`)).size).toBe(50);
    for (let index = 1; index < items.length; index++) {
        expect(timelinePage.compareDesc(comparable(items[index - 1]), comparable(items[index]))).toBeLessThan(0);
    }
    for (const item of items) {
        expect(item.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        expect(item.data).not.toHaveProperty('ts');
    }

    const legacyByKey = new Map([
        ...legacy.body.calls.map(data => [`call:${data.id}`, data]),
        ...legacy.body.messages.map(data => [`sms:${data.id}`, data]),
        ...legacy.body.email_messages.map(data => [`email:${data.id}`, data]),
        ...legacy.body.financial_events.map(data => [`financial:${data.id}`, data]),
    ]);
    for (const item of items) {
        expect(item.data).toEqual(legacyByKey.get(`${item.src}:${item.id}`));
    }
});

test('TC-TRP-029: valid limits are passed through and values above 50 clamp silently', async () => {
    state.data = makeWalkData();
    for (const [raw, expected] of [[500, 50], [50, 50], [20, 20]]) {
        clearActivity();
        const response = await request(stubApp())
            .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=${raw}`);
        expect(response.status).toBe(200);
        expect(response.body.page.items.length).toBeLessThanOrEqual(expected);
        for (const event of state.events.filter(entry => ['calls', 'estimates', 'invoices'].includes(entry.tag))) {
            expect(event.params.at(-1)).toBe(expected);
        }
        expect(mockConvQueries.getMessagesPageDesc.mock.calls[0][2].limit).toBe(expected);
        expect(mockEmailQueries.getTimelineEmailPageByContact.mock.calls[0][2].limit).toBe(expected);
    }
});

test('TC-TRP-030: contactless timeline pages email by timeline and skips SMS/financial legs', async () => {
    const emailOnly = makeWalkData().emails.slice(0, 3);
    state.timeline = {
        ...TIMELINE, contact_id: null, phone_e164: null,
        display_name: 'Yelp Guest', external_source: 'yelp',
    };
    state.contact = null;
    state.conversations = [];
    state.data = { calls: [], messages: [], emails: emailOnly, estimates: [], invoices: [] };
    const response = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(response.status).toBe(200);
    expect(response.body.page.items).toHaveLength(3);
    expect(response.body.page.items.every(item => item.src === 'email')).toBe(true);
    expect(mockEmailQueries.getTimelineEmailPageByTimeline).toHaveBeenCalledWith(
        COMPANY_A, TIMELINE.id, expect.objectContaining({ limit: 20 })
    );
    expect(mockEmailQueries.getTimelineEmailPageByContact).not.toHaveBeenCalled();
    expect(mockConvQueries.getMessagesPageDesc).not.toHaveBeenCalled();
    expect(state.events.some(event => event.tag === 'estimates' || event.tag === 'invoices')).toBe(false);
    expect(response.body.meta).toMatchObject({
        contact: null, display_name: 'Yelp Guest', external_source: 'yelp',
    });
});

test('TC-TRP-031: financial legs use the exact permission/dev-mode gate before the cut', async () => {
    state.data = makeWalkData();
    clearActivity();
    const denied = await request(stubApp({ permissions: ['pulse.view'] }))
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(denied.status).toBe(200);
    expect(denied.body.page.items).toHaveLength(20);
    expect(denied.body.page.items.some(item => item.src === 'financial')).toBe(false);
    expect(state.events.some(event => event.tag === 'estimates' || event.tag === 'invoices')).toBe(false);

    clearActivity();
    const allowed = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(allowed.body.page.items.some(item => item.src === 'financial')).toBe(true);
    expect(allowed.body.page.items.filter(item => item.src === 'financial').map(item => item.data.type))
        .toEqual(expect.arrayContaining(['estimate_created', 'invoice_paid', 'invoice_partial_payment', 'invoice_created']));

    clearActivity();
    const dev = await request(stubApp({ permissions: [], devMode: true }))
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(dev.status).toBe(200);
    expect(dev.body.page.items.some(item => item.src === 'financial')).toBe(true);
});

test('TC-TRP-032: every discovery/source leg takes company A only from companyFilter', async () => {
    state.data = makeWalkData();
    const response = await request(stubApp())
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20&company_id=${COMPANY_B}`)
        .send({ company_id: COMPANY_B });
    expect(response.status).toBe(200);

    const byTag = tag => state.events.filter(event => event.tag === tag);
    expect(byTag('calls')[0].params[1]).toBe(COMPANY_A);
    expect(byTag('discovery')[0].params[1]).toBe(COMPANY_A);
    expect(byTag('company_number_lookup')[0].params[0]).toBe(COMPANY_A);
    expect(byTag('conversation_lookup')[0].params[1]).toBe(COMPANY_A);
    expect(byTag('estimates')[0].params[1]).toBe(COMPANY_A);
    expect(byTag('invoices')[0].params[1]).toBe(COMPANY_A);
    expect(mockConvQueries.getMessagesPageDesc.mock.calls[0][1]).toBe(COMPANY_A);
    expect(mockEmailQueries.getTimelineEmailPageByContact.mock.calls[0][0]).toBe(COMPANY_A);
    expect(JSON.stringify(response.body)).not.toContain(COMPANY_B);
});

test('TC-TRP-033: pages are disjoint and the detector catches an ignored cursor', async () => {
    state.data = makeWalkData();
    const first = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    const cursor = first.body.page.next_cursor;
    const second = await request(stubApp())
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20&before=${encodeURIComponent(cursor)}`);
    const firstKeys = new Set(first.body.page.items.map(item => `${item.src}:${item.id}`));
    expect(second.body.page.items.filter(item => firstKeys.has(`${item.src}:${item.id}`))).toEqual([]);
    expect(timelinePage.compareDesc(
        comparable(first.body.page.items.at(-1)), comparable(second.body.page.items[0])
    )).toBeLessThan(0);
    expect(second.body.page.items).not.toEqual(first.body.page.items);

    const parseSpy = jest.spyOn(timelinePage, 'parseCursor').mockReturnValue(null);
    try {
        const sabotaged = await request(stubApp())
            .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20&before=${encodeURIComponent(cursor)}`);
        const violations = sabotaged.body.page.items
            .filter(item => firstKeys.has(`${item.src}:${item.id}`));
        expect(violations.length).toBeGreaterThan(0);
    } finally {
        parseSpy.mockRestore();
    }
});

test('TC-TRP-034: a cursor older than history returns a normal empty page; unexpected failures stay 500', async () => {
    state.data = makeWalkData();
    const deepCursor = timelinePage.encodeCursor({
        ts: '2000-01-01T00:00:00.000000Z', k: 4, id: '0',
    });
    const response = await request(stubApp())
        .get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20&before=${deepCursor}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
        page: { items: [], next_cursor: null, has_more: false },
    });

    state.failPagedCalls = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const failed = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({ error: 'Failed to fetch timeline' });
    } finally {
        errorSpy.mockRestore();
    }
});

test('TC-TRP-035: company call legs cannot leak proxy-keyed SMS into legacy or paged timelines', async () => {
    const externalCallPhone = '+15085550222';
    const secondaryConversation = {
        ...CONVERSATION,
        id: '22222222-2222-4222-8222-222222222222',
        customer_e164: CONTACT.secondary_phone,
    };
    const externalConversation = {
        ...CONVERSATION,
        id: '33333333-3333-4333-8333-333333333333',
        customer_e164: externalCallPhone,
    };
    const leakedCompanyConversation = {
        ...CONVERSATION,
        id: '44444444-4444-4444-8444-444444444444',
        customer_e164: CONVERSATION.proxy_e164,
    };
    state.conversations = [
        { ...CONVERSATION },
        secondaryConversation,
        externalConversation,
        leakedCompanyConversation,
    ];
    state.data = {
        ...GOLDEN_DATA,
        calls: GOLDEN_DATA.calls.map((call, index) => index === 0
            ? { ...call, from_number: externalCallPhone }
            : { ...call }),
        messages: [
            ...GOLDEN_DATA.messages,
            {
                ...GOLDEN_DATA.messages[0],
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
                conversation_id: secondaryConversation.id,
                body: 'Secondary phone SMS',
                ts: '2026-07-12T13:59:00.000000Z',
            },
            {
                ...GOLDEN_DATA.messages[0],
                id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
                conversation_id: externalConversation.id,
                body: 'External call leg SMS',
                ts: '2026-07-12T13:58:00.000000Z',
            },
            {
                ...GOLDEN_DATA.messages[0],
                id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
                conversation_id: leakedCompanyConversation.id,
                body: 'Must not leak',
                ts: '2026-07-12T13:57:00.000000Z',
            },
        ],
    };

    const expectedConversationIds = [
        CONVERSATION.id,
        secondaryConversation.id,
        externalConversation.id,
    ];
    const legacy = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.conversations.map(conversation => conversation.id)).toEqual(expectedConversationIds);
    expect(legacy.body.messages.map(message => message.conversation_id))
        .toEqual(expect.arrayContaining(expectedConversationIds));
    expect(JSON.stringify(legacy.body)).not.toContain(leakedCompanyConversation.id);

    clearActivity();
    const paged = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(paged.status).toBe(200);
    expect(paged.body.meta.conversations.map(conversation => conversation.id)).toEqual(expectedConversationIds);
    expect(paged.body.page.items.filter(item => item.src === 'sms').map(item => item.data.conversation_id))
        .toEqual(expect.arrayContaining(expectedConversationIds));
    expect(JSON.stringify(paged.body)).not.toContain(leakedCompanyConversation.id);

    for (const event of state.events.filter(entry => entry.tag === 'company_number_lookup')) {
        expect(event.params).toEqual([COMPANY_A]);
    }
});

test('TC-TRP-036: answered_by=ai reaches both legacy and paged Pulse timeline calls', async () => {
    state.data = {
        ...GOLDEN_DATA,
        calls: GOLDEN_DATA.calls.map((call, index) => index === 0
            ? { ...call, answered_by: 'ai' }
            : { ...call }),
    };

    const legacy = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.calls.find(call => call.call_sid === 'CA-golden-new').answered_by).toBe('ai');

    const paged = await request(stubApp()).get(`/api/pulse/timeline-by-id/${TIMELINE.id}?limit=20`);
    expect(paged.status).toBe(200);
    const callItem = paged.body.page.items.find(item => item.src === 'call' && item.data.call_sid === 'CA-golden-new');
    expect(callItem.data.answered_by).toBe('ai');
});
