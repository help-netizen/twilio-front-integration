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
