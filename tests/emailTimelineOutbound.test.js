'use strict';

/**
 * EMAIL-TIMELINE-001 — outbound send (emailTimelineService.sendForContact +
 * routes/emailTimeline.js). Covers TC-ET-024/025 (reply vs initiate), TC-ET-027
 * (409 not-connected), TC-ET-029 (404 foreign contact), TC-ET-030 (422 toEmail
 * not on contact), TC-ET-026 (stamp on_timeline), TC-ET-028/029 route auth
 * (403 / 401 / 404) and the company_id-only-from-companyFilter guard.
 *
 * Strategy: FAKE provider via providerRegistry (no googleapis); mock the query
 * modules so contact/thread resolution is controllable. `loadContactWithEmails`
 * runs over the raw `db` pool — mock `db.query` to feed its `{id, emails}` row.
 * Routes exercised with supertest over a controllable `appWith({permissions,companyId})`.
 *
 * Run:
 *   npx jest --runTestsByPath tests/emailTimelineOutbound.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const mockProvider = {
    getConnectionStatus: jest.fn(),
    pullChanges: jest.fn(),
    handlePushNotification: jest.fn(),
    sendMessage: jest.fn(),
};

// A realistic just-sent outbound email_messages row, as linkMessageToContact
// RETURNINGs it (raw row: has `direction`, no derived `is_outbound`).
function outboundRow(overrides = {}) {
    return {
        id: 9,
        thread_id: 77,
        provider_thread_id: 't-new',
        direction: 'outbound',
        from_name: null,
        from_email: 'mb@co.com',
        to_recipients_json: [CONTACT_EMAIL],
        subject: 'Message from Acme',
        body_text: 'hi',
        snippet: null,
        gmail_internal_at: '2026-06-23T13:00:00.000Z',
        sent_by_user_email: 'agent@co.com',
        ...overrides,
    };
}
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));

jest.mock('../backend/src/db/emailQueries', () => ({
    getNewestThreadIdForContact: jest.fn(),
    linkMessageToContact: jest.fn(),
    getTimelineEmailByContact: jest.fn(),
    // EMAIL-TIMELINE-001 follow-up — outbound link-by-recipient.
    findEmailContact: jest.fn(),
    getMessageLinkState: jest.fn(),
    listUnlinkedInboundForTimeline: jest.fn(),
    listUnlinkedOutboundForTimeline: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
}));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn() }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(), broadcast: jest.fn(),
}));
// requirePermission's 403 path calls auditService.log — stub so no DB write.
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');

const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const companyQueries = require('../backend/src/db/companyQueries');
const db = require('../backend/src/db/connection');
const realtimeService = require('../backend/src/services/realtimeService');
const svc = require('../backend/src/services/email/emailTimelineService');
const router = require('../backend/src/routes/emailTimeline');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const CONTACT = 'contact-1';
const TIMELINE = 'timeline-1';
const CONTACT_EMAIL = 'alice@example.com';

// loadContactWithEmails issues ONE db.query returning `{ id, emails: [...] }`.
function wireContactEmails(emails = [CONTACT_EMAIL], id = CONTACT) {
    db.query.mockResolvedValue({ rows: [{ id, emails }] });
}
function wireNoContact() {
    db.query.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockProvider.getConnectionStatus.mockResolvedValue({ connected: true, status: 'connected', email_address: 'mb@co.com' });
    mockProvider.pullChanges.mockResolvedValue({ messages: [], cursor: null });
    timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
    // Default: the just-sent row is already present → link returns the real row, so
    // the returned item is real (no synthetic fallback) and no re-import is needed.
    emailQueries.linkMessageToContact.mockResolvedValue(outboundRow());
    emailQueries.getTimelineEmailByContact.mockResolvedValue([]);
});

// ─── A. sendForContact — guards (P0): 409 / 404 / 422 ─────────────────────────────

describe('sendForContact — guards (P0)', () => {
    it('TC-ET-027: not-connected mailbox → 409 MAILBOX_NOT_CONNECTED, no send', async () => {
        mockProvider.getConnectionStatus.mockResolvedValue({ connected: false, status: 'reconnect_required', email_address: null });
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 409, code: 'MAILBOX_NOT_CONNECTED' });
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('getConnectionStatus throwing also maps to 409 (defensive)', async () => {
        mockProvider.getConnectionStatus.mockRejectedValue(new Error('token expired'));
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 409, code: 'MAILBOX_NOT_CONNECTED' });
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-ET-029(svc): foreign / missing contact → 404 CONTACT_NOT_FOUND, no send', async () => {
        wireNoContact();
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 404, code: 'CONTACT_NOT_FOUND' });
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-ET-030: toEmail not one of the contact\'s addresses → 422 EMAIL_NOT_ON_CONTACT, no send', async () => {
        wireContactEmails(['someoneelse@example.com']);
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 422, code: 'EMAIL_NOT_ON_CONTACT' });
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('toEmail is matched case-insensitively (Alice@Example.com vs stored alice@example.com)', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: 'Alice@Example.com' }))
            .resolves.toBeDefined();
        expect(mockProvider.sendMessage).toHaveBeenCalledTimes(1);
    });
});

// ─── B. sendForContact — reply vs initiate (P0, AC-5/AC-6) ────────────────────────

describe('sendForContact — reply vs initiate (P0)', () => {
    it('TC-ET-024: existing thread → reply (sendMessage carries providerThreadId)', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue('thr-existing');
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 'thr-existing' });
        // The just-sent row is present → link returns it (no refetch fallback needed).
        emailQueries.linkMessageToContact.mockResolvedValue(outboundRow({
            id: 5, provider_thread_id: 'thr-existing', body_text: 'hi',
        }));

        const item = await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL });

        const arg = mockProvider.sendMessage.mock.calls[0][1];
        expect(arg.providerThreadId).toBe('thr-existing');
        expect(arg).not.toHaveProperty('subject'); // reply path passes no auto-subject
        // getCompanyById is only needed for the auto-subject (initiate) path.
        expect(companyQueries.getCompanyById).not.toHaveBeenCalled();
        // Item is the FLAT read-projection shape (id from the linked row, not synthetic).
        expect(item).toMatchObject({
            id: 5, type: 'email', direction: 'outbound', is_outbound: true,
            from_email: 'mb@co.com', to_email: [CONTACT_EMAIL], thread_id: 77,
            body_text: 'hi', sent_at: '2026-06-23T13:00:00.000Z',
            sent_by_user_email: 'agent@co.com',
        });
        expect(item).not.toHaveProperty('from'); // no nested {from:{...}} shape
        // No re-import needed when the link succeeds first try.
        expect(mockProvider.pullChanges).not.toHaveBeenCalled();
    });

    it('TC-ET-025/031: no prior thread → initiate (no providerThreadId, subject "Message from <company>")', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme Plumbing' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-9', provider_thread_id: 't-new' });

        await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hello', toEmail: CONTACT_EMAIL });

        const arg = mockProvider.sendMessage.mock.calls[0][1];
        expect(arg.providerThreadId).toBeUndefined();
        expect(arg.subject).toBe('Message from Acme Plumbing');
    });

    it('initiate falls back to "Message from us" when company lookup fails', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockRejectedValue(new Error('no company'));
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-9', provider_thread_id: 't-new' });
        await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hello', toEmail: CONTACT_EMAIL });
        expect(mockProvider.sendMessage.mock.calls[0][1].subject).toBe('Message from us');
    });

    it('TC-ET-026: on success the just-sent row is stamped on_timeline + linked to contact', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });

        await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL });

        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'out-1', COMPANY_A,
            { contact_id: CONTACT, timeline_id: TIMELINE, on_timeline: true }
        );
    });

    it('FIX#2: on success the outbound item is broadcast over SSE with the timeline id', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        emailQueries.linkMessageToContact.mockResolvedValue(outboundRow({ id: 42 }));

        await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL });

        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        const [emitted, conv, tl] = realtimeService.publishMessageAdded.mock.calls[0];
        expect(emitted).toMatchObject({ id: 42, type: 'email', direction: 'outbound', is_outbound: true });
        expect(conv).toEqual({ id: null });
        expect(tl).toBe(TIMELINE);
    });

    it('FIX#2: import hiccup (first link returns null) → re-imports the thread then re-links, item is real', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        // First link finds no row (hydrate hiccup); after re-import the row exists.
        emailQueries.linkMessageToContact
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(outboundRow({ id: 9 }));

        const item = await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL });

        // Re-import goes through the PROVIDER (seam), then link is retried.
        expect(mockProvider.pullChanges).toHaveBeenCalledTimes(1);
        expect(mockProvider.pullChanges).toHaveBeenCalledWith(COMPANY_A, null);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        // The item is the real linked row (not the synthetic fallback).
        expect(item).toMatchObject({ id: 9, type: 'email', direction: 'outbound', is_outbound: true });
        // And it is broadcast on_timeline.
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        expect(realtimeService.publishMessageAdded.mock.calls[0][2]).toBe(TIMELINE);
    });

    it('FIX#2: still cannot link after re-import → does NOT throw (email was sent), best-effort item', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        emailQueries.linkMessageToContact.mockResolvedValue(null); // never links
        emailQueries.getTimelineEmailByContact.mockResolvedValue([]); // projection also empty

        const item = await svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL });

        expect(mockProvider.pullChanges).toHaveBeenCalledTimes(1); // tried once to reconcile
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2); // initial + retry
        // Best-effort synthetic item, still the flat outbound shape; never throws.
        expect(item).toMatchObject({
            type: 'email', direction: 'outbound', is_outbound: true,
            to_email: [CONTACT_EMAIL], body_text: 'hi',
        });
        expect(item.id).toBeNull();
    });

    it('FIX#2: a re-import failure is swallowed (best-effort) and still returns without throwing', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        emailQueries.linkMessageToContact.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        mockProvider.pullChanges.mockRejectedValue(new Error('history walk boom'));
        emailQueries.getTimelineEmailByContact.mockResolvedValue([]);

        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .resolves.toMatchObject({ type: 'email', direction: 'outbound' });
    });

    it('an EMAIL-001 reconnect_required (statusCode 409) from sendMessage maps to 409', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue('thr-1');
        const err = new Error('reconnect required'); err.statusCode = 409;
        mockProvider.sendMessage.mockRejectedValue(err);
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 409, code: 'MAILBOX_NOT_CONNECTED' });
    });

    it('an unexpected send error maps to 500 EMAIL_SEND_FAILED', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue('thr-1');
        mockProvider.sendMessage.mockRejectedValue(new Error('smtp exploded'));
        await expect(svc.sendForContact(COMPANY_A, CONTACT, { body: 'hi', toEmail: CONTACT_EMAIL }))
            .rejects.toMatchObject({ httpStatus: 500, code: 'EMAIL_SEND_FAILED' });
    });
});

// ─── C. Route POST /contacts/:contactId/send — auth, scoping, mapping ─────────────

function appWith({ permissions = ['messages.send'], companyId = COMPANY_A, authenticated = true } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (!authenticated) {
            return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Auth required' });
        }
        req.user = { sub: 'kc', email: 'agent@co.com', crmUser: { id: 'user-1' } };
        req.authz = { permissions };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', router);
    return app;
}

describe('POST /contacts/:contactId/send — route (P0)', () => {
    it('TC-ET-028: 401 without auth context', async () => {
        const res = await request(appWith({ authenticated: false }))
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(401);
    });

    it('TC-ET-028: 403 without messages.send permission (and no send attempted)', async () => {
        const res = await request(appWith({ permissions: [] }))
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(403);
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-ET-027(route): not-connected → 409 envelope { ok:false, error.code }', async () => {
        mockProvider.getConnectionStatus.mockResolvedValue({ connected: false, status: 'disconnected' });
        const res = await request(appWith())
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ ok: false, error: { code: 'MAILBOX_NOT_CONNECTED' } });
    });

    it('TC-ET-029(route): foreign :contactId → 404 (not 403), no cross-company leak', async () => {
        wireNoContact(); // loadContactWithEmails scoped to company finds nothing
        const res = await request(appWith())
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('CONTACT_NOT_FOUND');
        expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-ET-030(route): toEmail not on contact → 422', async () => {
        wireContactEmails(['other@example.com']);
        const res = await request(appWith())
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('EMAIL_NOT_ON_CONTACT');
    });

    it('happy path → 200 { ok:true, data:<email item> }', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue(null);
        companyQueries.getCompanyById.mockResolvedValue({ name: 'Acme' });
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 't-new' });
        const res = await request(appWith())
            .post(`/contacts/${CONTACT}/send`).send({ body: 'hi', toEmail: CONTACT_EMAIL });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toMatchObject({ type: 'email', direction: 'outbound' });
    });

    it('company_id comes ONLY from req.companyFilter (poisoned body/req.companyId ignored)', async () => {
        wireContactEmails([CONTACT_EMAIL]);
        emailQueries.getNewestThreadIdForContact.mockResolvedValue('thr-1');
        mockProvider.sendMessage.mockResolvedValue({ provider_message_id: 'out-1', provider_thread_id: 'thr-1' });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { sub: 'kc', email: 'agent@co.com', crmUser: { id: 'user-1' } };
            req.authz = { permissions: ['messages.send'] };
            req.companyFilter = { company_id: COMPANY_A };
            req.companyId = COMPANY_B; // poison
            next();
        });
        app.use('/', router);

        await request(app).post(`/contacts/${CONTACT}/send`)
            .send({ body: 'hi', toEmail: CONTACT_EMAIL, company_id: COMPANY_B });

        // Every company-scoped hop used COMPANY_A.
        expect(db.query.mock.calls[0][1][0]).toBe(COMPANY_A); // loadContactWithEmails
        expect(emailQueries.getNewestThreadIdForContact).toHaveBeenCalledWith(COMPANY_A, CONTACT);
        expect(mockProvider.sendMessage.mock.calls[0][0]).toBe(COMPANY_A);
    });
});

// ─── D. Route GET /mailbox-status — composer connection probe (FIX #2) ────────────

describe('GET /mailbox-status — route', () => {
    it('403 without messages.send permission', async () => {
        const res = await request(appWith({ permissions: [] })).get('/mailbox-status');
        expect(res.status).toBe(403);
        expect(mockProvider.getConnectionStatus).not.toHaveBeenCalled();
    });

    it('connected mailbox → { ok:true, data:{ connected:true, email_address } }, scoped to companyFilter', async () => {
        mockProvider.getConnectionStatus.mockResolvedValue({ connected: true, status: 'connected', email_address: 'mb@co.com' });
        const res = await request(appWith()).get('/mailbox-status');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { connected: true, email_address: 'mb@co.com' } });
        expect(mockProvider.getConnectionStatus).toHaveBeenCalledWith(COMPANY_A);
    });

    it('disconnected mailbox → connected:false, email_address null (no token leaked)', async () => {
        mockProvider.getConnectionStatus.mockResolvedValue({ connected: false, status: 'reconnect_required', email_address: null });
        const res = await request(appWith()).get('/mailbox-status');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { connected: false, email_address: null } });
    });

    it('getConnectionStatus throwing degrades to { ok:true, data:{ connected:false } } (never 500)', async () => {
        mockProvider.getConnectionStatus.mockRejectedValue(new Error('token store down'));
        const res = await request(appWith()).get('/mailbox-status');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { connected: false } });
    });
});

// ─── E. linkOutboundMessage — link-by-recipient (EMAIL-TIMELINE-001 follow-up) ────
//
// Outbound emails the agent sends (incl. directly from Gmail) must land on the
// recipient contact's timeline, RIGHT-aligned, WITHOUT raising unread, and live via
// SSE. Drafts must NEVER project (the customer's hard rule). Matching is by RECIPIENT
// (msg.to / to_recipients_json), reusing findEmailContact.

// A genuinely-SENT outbound normalized message (push shape: `to` = [{name,email}]).
function outboundMsg(overrides = {}) {
    return {
        provider_message_id: 'out-g1',
        provider_thread_id: 'gthr-9',
        from_email: 'mb@co.com',          // the mailbox itself
        from_name: 'Acme Support',
        to: [{ name: 'Alice', email: CONTACT_EMAIL }],
        subject: 'Re: your booking',
        body_text: 'on our way',
        internal_at: '2026-06-23T14:00:00.000Z',
        labelIds: ['SENT'],
        is_outbound: true,
        ...overrides,
    };
}

// The email_messages row linkMessageToContact RETURNINGs for an outbound link.
function linkedOutboundRow(overrides = {}) {
    return {
        id: 31, thread_id: 88, provider_thread_id: 'gthr-9', direction: 'outbound',
        from_name: 'Acme Support', from_email: 'mb@co.com',
        to_recipients_json: [{ name: 'Alice', email: CONTACT_EMAIL }],
        subject: 'Re: your booking', body_text: 'on our way', snippet: 'on our way',
        gmail_internal_at: '2026-06-23T14:00:00.000Z', sent_by_user_email: 'agent@co.com',
        ...overrides,
    };
}

function wireOutboundMatchAndLink() {
    emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT, full_name: 'Alice' });
    timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
    emailQueries.getMessageLinkState.mockResolvedValue(null);
    emailQueries.linkMessageToContact.mockResolvedValue(linkedOutboundRow());
}

describe('linkOutboundMessage — link-by-recipient (P0)', () => {
    it('matches by recipient → links contact/timeline/on_timeline, NO unread, publishes SSE (right-aligned)', async () => {
        wireOutboundMatchAndLink();

        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg());

        expect(res).toEqual({ linked: true, contactId: CONTACT, timelineId: TIMELINE });
        // Matched by RECIPIENT (the To address), not the From (which is the mailbox).
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith(CONTACT_EMAIL, COMPANY_A);
        // Link UPDATE carries the projection flags.
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'out-g1', COMPANY_A,
            { contact_id: CONTACT, timeline_id: TIMELINE, on_timeline: true }
        );
        // SSE fired with a FLAT outbound item + the timeline id (3rd arg).
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        const [emitted, conv, tl] = realtimeService.publishMessageAdded.mock.calls[0];
        expect(emitted).toMatchObject({
            id: 31, type: 'email', direction: 'outbound', is_outbound: true,
            from_email: 'mb@co.com', body_text: 'on our way', thread_id: 88,
            sent_at: '2026-06-23T14:00:00.000Z', sent_by_user_email: 'agent@co.com',
        });
        expect(conv).toEqual({ id: null });
        expect(tl).toBe(TIMELINE);
    });

    it('does NOT mark unread / set action-required (the agent sent it)', async () => {
        wireOutboundMatchAndLink();
        await svc.linkOutboundMessage(COMPANY_A, outboundMsg());
        // No unread side-effects are even importable here, so assert via what IS mocked:
        // findOrCreateTimelineByContact ran (timeline resolved) but the service must not
        // have called any unread/AR query — none of those are on the mocked surface, and
        // the result has no `unread`. The behavioral guarantee is the SSE-only path above;
        // here we additionally pin that markContactUnread is NOT reachable by checking the
        // emailQueries surface stayed link-only.
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast).not.toHaveBeenCalled(); // no thread.action_required
    });

    it('reads the stored-row shape too (to_recipients_json, no labelIds)', async () => {
        wireOutboundMatchAndLink();
        // Poll-path synthesized msg: to_recipients_json present, no `to`, no labelIds.
        const pollMsg = {
            provider_message_id: 'out-poll-1',
            to_recipients_json: [{ name: 'Alice', email: CONTACT_EMAIL }],
            subject: 'Re: booking', body_text: 'b', internal_at: '2026-06-23T14:00:00.000Z',
        };
        const res = await svc.linkOutboundMessage(COMPANY_A, pollMsg);
        expect(res).toMatchObject({ linked: true, contactId: CONTACT, timelineId: TIMELINE });
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith(CONTACT_EMAIL, COMPANY_A);
    });

    it('to_recipients_json as a JSON STRING is parsed (defensive)', async () => {
        wireOutboundMatchAndLink();
        const res = await svc.linkOutboundMessage(COMPANY_A, {
            provider_message_id: 'out-str-1',
            to_recipients_json: JSON.stringify([{ email: CONTACT_EMAIL }]),
        });
        expect(res).toMatchObject({ linked: true });
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith(CONTACT_EMAIL, COMPANY_A);
    });

    it('DRAFT-labelled outbound is excluded — no match, no link, no SSE (hard rule)', async () => {
        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg({ labelIds: ['DRAFT'] }));
        expect(res).toEqual({ skipped: 'draft' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('first matching recipient wins (multiple To, only the 2nd is a contact)', async () => {
        emailQueries.findEmailContact
            .mockResolvedValueOnce(null)                                  // stranger@x.com
            .mockResolvedValueOnce({ contact_id: CONTACT });             // alice@example.com
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(linkedOutboundRow());

        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg({
            to: [{ email: 'stranger@x.com' }, { email: CONTACT_EMAIL }],
        }));

        expect(res).toMatchObject({ linked: true, contactId: CONTACT });
        expect(emailQueries.findEmailContact).toHaveBeenNthCalledWith(1, 'stranger@x.com', COMPANY_A);
        expect(emailQueries.findEmailContact).toHaveBeenNthCalledWith(2, CONTACT_EMAIL, COMPANY_A);
    });

    it('no recipient matches a contact → skipped:no_contact (no link, no SSE)', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null);
        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg({ to: [{ email: 'nobody@x.com' }] }));
        expect(res).toEqual({ skipped: 'no_contact' });
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('no recipients at all → skipped:no_recipient (never reaches contact match)', async () => {
        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg({ to: [] }));
        expect(res).toEqual({ skipped: 'no_recipient' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });

    it('no provider_message_id → skipped:no_message (guard)', async () => {
        const res = await svc.linkOutboundMessage(COMPANY_A, { to: [{ email: CONTACT_EMAIL }] });
        expect(res).toEqual({ skipped: 'no_message' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });

    it('idempotent: already-linked row → no second SSE', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue({
            contact_id: CONTACT, timeline_id: TIMELINE, on_timeline: true,
        });
        emailQueries.linkMessageToContact.mockResolvedValue(linkedOutboundRow());

        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg());
        expect(res).toEqual({ linked: true, contactId: CONTACT, timelineId: TIMELINE, alreadyLinked: true });
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('un-imported row (link UPDATE returns null) → skipped:no_message, no SSE', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(null);
        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg());
        expect(res).toEqual({ skipped: 'no_message' });
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('never throws: a findEmailContact rejection is caught → {error}', async () => {
        emailQueries.findEmailContact.mockRejectedValue(new Error('db blip'));
        const res = await svc.linkOutboundMessage(COMPANY_A, outboundMsg());
        expect(res).toMatchObject({ error: 'db blip' });
    });
});

// ─── F. ingest routing — outbound→linkOutbound, inbound→linkInbound ───────────────

describe('ingestPushNotification — direction routing (P0)', () => {
    it('routes SENT/is_outbound msgs to the outbound projector and inbound to the inbound one', async () => {
        mockProvider.handlePushNotification.mockResolvedValue({ companyId: COMPANY_A, cursor: '500' });
        mockProvider.pullChanges.mockResolvedValue({
            messages: [
                outboundMsg({ provider_message_id: 'o1' }),                                 // → outbound link
                { provider_message_id: 'i1', from_email: 'alice@example.com',
                  to: [{ email: 'mb@co.com' }], labelIds: ['INBOX'], is_outbound: false },  // → inbound link
            ],
            cursor: '501',
        });
        // Outbound o1 matches by recipient; inbound i1 matches by From. Both share the
        // same findEmailContact mock (returns the contact) + link returning a row.
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact
            .mockResolvedValueOnce(linkedOutboundRow({ id: 1 }))                  // o1
            .mockResolvedValueOnce({ id: 2, direction: 'inbound' });             // i1

        const res = await svc.ingestPushNotification({ message: { data: 'x' } });

        expect(res).toEqual({ handled: true, company: COMPANY_A, processed: 2, linked: 2, skipped: 0 });
        // Outbound matched on its recipient (mb@co.com is the From; CONTACT_EMAIL is the To).
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith(CONTACT_EMAIL, COMPANY_A);
        // Inbound matched on its From.
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith('alice@example.com', COMPANY_A);
    });

    it('a DRAFT msg (even with SENT absent) routes to inbound which drops it as draft_or_sent', async () => {
        mockProvider.handlePushNotification.mockResolvedValue({ companyId: COMPANY_A, cursor: '1' });
        mockProvider.pullChanges.mockResolvedValue({
            messages: [{ provider_message_id: 'd1', from_email: 'mb@co.com',
                         to: [{ email: CONTACT_EMAIL }], labelIds: ['DRAFT'], is_outbound: false }],
            cursor: '2',
        });
        const res = await svc.ingestPushNotification({ message: { data: 'x' } });
        expect(res).toEqual({ handled: true, company: COMPANY_A, processed: 1, linked: 0, skipped: 1 });
        // Neither projector linked it; no recipient/contact lookup leaked through.
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
    });
});

describe('ingestPolledForCompany — outbound second pass (P1)', () => {
    it('drains unlinked outbound rows (recipient-match) after the inbound scan', async () => {
        emailQueries.listUnlinkedInboundForTimeline.mockResolvedValue([]); // no inbound backlog
        emailQueries.listUnlinkedOutboundForTimeline.mockResolvedValue([
            { provider_message_id: 'po1',
              to_recipients_json: [{ name: 'Alice', email: CONTACT_EMAIL }],
              subject: 'Re', body_text: 'b', gmail_internal_at: '2026-06-23T14:00:00.000Z' },
        ]);
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(linkedOutboundRow({ id: 7 }));

        const res = await svc.ingestPolledForCompany(COMPANY_A);

        // processed counts BOTH passes (0 inbound + 1 outbound); the outbound row linked.
        expect(res).toEqual({ company: COMPANY_A, processed: 1, linked: 1, skipped: 0 });
        expect(emailQueries.listUnlinkedOutboundForTimeline).toHaveBeenCalledWith(COMPANY_A, { limit: 100 });
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith(CONTACT_EMAIL, COMPANY_A);
        // No unread broadcast for the agent's own outbound.
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });
});

// ─── G. extractRecipientEmails — helper unit (both shapes) ────────────────────────

describe('extractRecipientEmails', () => {
    it('reads msg.to (array of {email}) lower/trim/deduped', () => {
        expect(svc.extractRecipientEmails({ to: [
            { email: 'A@X.com' }, { email: ' a@x.com ' }, { email: 'b@x.com' },
        ] })).toEqual(['a@x.com', 'b@x.com']);
    });
    it('reads to_recipients_json array when `to` absent', () => {
        expect(svc.extractRecipientEmails({ to_recipients_json: [{ email: 'c@x.com' }] }))
            .toEqual(['c@x.com']);
    });
    it('parses to_recipients_json JSON string', () => {
        expect(svc.extractRecipientEmails({ to_recipients_json: '[{"email":"d@x.com"}]' }))
            .toEqual(['d@x.com']);
    });
    it('returns [] for missing / malformed / empty', () => {
        expect(svc.extractRecipientEmails(null)).toEqual([]);
        expect(svc.extractRecipientEmails({})).toEqual([]);
        expect(svc.extractRecipientEmails({ to_recipients_json: 'not-json' })).toEqual([]);
        expect(svc.extractRecipientEmails({ to: [{ name: 'no addr' }] })).toEqual([]);
    });
});
