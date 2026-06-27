'use strict';

/**
 * EMAIL-TIMELINE-001 — inbound link pipeline (emailTimelineService.linkInboundMessage
 * + ingestPushNotification). Covers TC-ET-001/003/004/005 (exclusion filter),
 * TC-ET-008/019/021 link/no-link/idempotency behaviours at the service layer, and
 * the push-fan ingest (decoded-null + per-message link + never-throws).
 *
 * Strategy: mock the DB query modules + realtimeService + providerRegistry so NO
 * real Gmail / Pub-Sub / Postgres is touched. We mock the QUERY layer (not the raw
 * `db` pool) so the service's own branch logic runs over controllable rows, and we
 * assert the side-effect calls (link / markContactUnread / markTimelineUnread / SSE)
 * are or are NOT made.
 *
 * Run:
 *   npx jest --runTestsByPath tests/emailTimelineInbound.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

// ── The seam: a FAKE provider (no googleapis). providerRegistry.get() returns it. ──
const mockProvider = {
    getConnectionStatus: jest.fn(),
    pullChanges: jest.fn(),
    handlePushNotification: jest.fn(),
    sendMessage: jest.fn(),
};
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));

jest.mock('../backend/src/db/emailQueries', () => ({
    findEmailContact: jest.fn(),
    getMessageLinkState: jest.fn(),
    linkMessageToContact: jest.fn(),
    listUnlinkedInboundForTimeline: jest.fn(),
    getTimelineEmailByContact: jest.fn(),
    getNewestThreadIdForContact: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
    markTimelineUnread: jest.fn(),
    setActionRequired: jest.fn(),
    createTask: jest.fn(),
}));
jest.mock('../backend/src/db/queries', () => ({ markContactUnread: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn() }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    broadcast: jest.fn(),
}));
// Action-Required config — default OFF so the AR branch stays quiet unless a test
// opts in (keeps the unread/SSE assertions clean). Mocked so no real DB read.
jest.mock('../backend/src/services/arConfigHelper', () => ({
    getTriggerConfig: jest.fn(async () => ({ enabled: false })),
}));

const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const queries = require('../backend/src/db/queries');
const realtimeService = require('../backend/src/services/realtimeService');
const providerRegistry = require('../backend/src/services/mail/providerRegistry');
const svc = require('../backend/src/services/email/emailTimelineService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const CONTACT = 'contact-1';
const TIMELINE = 'timeline-1';

// A genuine INBOX external inbound message that WOULD match a contact.
function inboundMsg(overrides = {}) {
    return {
        provider_message_id: 'gmsg-1',
        provider_thread_id: 'gthr-1',
        from_email: 'alice@example.com',
        from_name: 'Alice',
        subject: 'Hello',
        body_text: 'hi there',
        internal_at: '2026-06-23T12:00:00.000Z',
        labelIds: ['INBOX'],
        is_outbound: false,
        ...overrides,
    };
}

// Wire the happy path: contact match → timeline resolves → not-yet-linked → link OK.
function wireMatchAndLink() {
    emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT, full_name: 'Alice' });
    timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
    emailQueries.getMessageLinkState.mockResolvedValue(null); // no prior link
    emailQueries.linkMessageToContact.mockResolvedValue({
        id: 1, thread_id: 'gthr-1', direction: 'inbound',
        from_name: 'Alice', from_email: 'alice@example.com',
        to_recipients_json: ['mailbox@co.com'], subject: 'Hello',
        body_text: 'hi there', snippet: 'hi there',
        gmail_internal_at: '2026-06-23T12:00:00.000Z', sent_by_user_email: null,
    });
    queries.markContactUnread.mockResolvedValue(undefined);
    timelinesQueries.markTimelineUnread.mockResolvedValue(undefined);
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── A. Exclusion filter — draft / sent / own (P0, AC-2, the draft-noise guard) ───

describe('linkInboundMessage — exclusion filter (P0, AC-2)', () => {
    it('TC-ET-001: DRAFT label excluded — no contact lookup, no link, no unread, no SSE', async () => {
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg({ labelIds: ['DRAFT'] }));
        expect(res).toEqual({ skipped: 'draft_or_sent' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(timelinesQueries.markTimelineUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('TC-ET-003: SENT label excluded (incl. INBOX,SENT combo)', async () => {
        const r1 = await svc.linkInboundMessage(COMPANY_A, inboundMsg({ labelIds: ['SENT'] }));
        const r2 = await svc.linkInboundMessage(COMPANY_A, inboundMsg({ labelIds: ['INBOX', 'SENT'] }));
        expect(r1).toEqual({ skipped: 'draft_or_sent' });
        expect(r2).toEqual({ skipped: 'draft_or_sent' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
    });

    it('TC-ET-004: own-address self-send (is_outbound) excluded BEFORE any contact match', async () => {
        // is_outbound wins even with an INBOX label present.
        const res = await svc.linkInboundMessage(
            COMPANY_A,
            inboundMsg({ is_outbound: true, from_email: 'mailbox@co.com', labelIds: ['INBOX'] })
        );
        expect(res).toEqual({ skipped: 'outbound' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('TC-ET-005: genuine INBOX external inbound passes the filter → reaches contact match', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null); // no match, but we only assert it was REACHED
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith('alice@example.com', COMPANY_A);
        expect(res).toEqual({ skipped: 'no_contact' });
    });

    it('no provider_message_id → skipped:no_message (guard, no work)', async () => {
        const res = await svc.linkInboundMessage(COMPANY_A, { from_email: 'x@y.com' });
        expect(res).toEqual({ skipped: 'no_message' });
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });
});

// ─── B. Contact match / no-match (P0, AC-1/AC-3) ──────────────────────────────────

describe('linkInboundMessage — contact match / no-match (P0)', () => {
    it('TC-ET-008: no contact match → inbox-only: no link, no unread, no SSE, no contact created', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null);
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg({ from_email: 'nobody@unknown.com' }));
        expect(res).toEqual({ skipped: 'no_contact' });
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('multi-match tie-break is delegated to findEmailContact (called with from_email + companyId)', async () => {
        // The service does not tie-break itself; it trusts findEmailContact to return the single winner.
        wireMatchAndLink();
        await svc.linkInboundMessage(COMPANY_A, inboundMsg({ from_email: 'Shared@Example.com' }));
        expect(emailQueries.findEmailContact).toHaveBeenCalledTimes(1);
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith('Shared@Example.com', COMPANY_A);
    });

    it('TC-ET-019: match → links contact_id/timeline_id/on_timeline + sets unread (both) + SSE', async () => {
        wireMatchAndLink();
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());

        expect(res).toEqual({ linked: true, contactId: CONTACT, timelineId: TIMELINE });
        // Link UPDATE carries the projection flags.
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'gmsg-1', COMPANY_A,
            { contact_id: CONTACT, timeline_id: TIMELINE, on_timeline: true }
        );
        // Unread mirrored 1:1 with inbound SMS: contact + timeline.
        expect(queries.markContactUnread).toHaveBeenCalledWith(CONTACT, expect.any(Date));
        expect(timelinesQueries.markTimelineUnread).toHaveBeenCalledWith(TIMELINE);
        // SSE carries the timeline id (3rd positional arg of publishMessageAdded)
        // and a FLAT email item matching the read projection (no nested {from:{...}}).
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        const [emitted, , tl] = realtimeService.publishMessageAdded.mock.calls[0];
        expect(tl).toBe(TIMELINE);
        expect(emitted).toMatchObject({
            id: 1, type: 'email', direction: 'inbound', is_outbound: false,
            from_email: 'alice@example.com', from_name: 'Alice',
            to_email: ['mailbox@co.com'], subject: 'Hello',
            body_text: 'hi there', thread_id: 'gthr-1',
            sent_at: '2026-06-23T12:00:00.000Z', sent_by_user_email: null,
        });
        expect(emitted).not.toHaveProperty('from'); // flat shape, not nested
    });

    it('contact resolved but timeline cannot resolve (cross-tenant) → bail no_contact, no side effects', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue(null);
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());
        expect(res).toEqual({ skipped: 'no_contact' });
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
    });

    it('history-walk touched an un-imported message (link UPDATE returns null) → skipped:no_message', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(null); // no local row to link
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());
        expect(res).toEqual({ skipped: 'no_message' });
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });
});

// ─── C. Idempotency — re-delivery does not re-unread / re-SSE (P0, AC-1/AC-11) ─────

describe('linkInboundMessage — idempotent re-delivery (P0)', () => {
    it('TC-ET-021: already-linked row → re-link is a no-op; no second unread, no second SSE', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        // Pre-existing link state: already on the timeline.
        emailQueries.getMessageLinkState.mockResolvedValue({
            contact_id: CONTACT, timeline_id: TIMELINE, on_timeline: true,
        });
        emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound' });

        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());

        expect(res).toEqual({ linked: true, contactId: CONTACT, timelineId: TIMELINE, alreadyLinked: true });
        // The link UPDATE may still fire (harmless no-op) but the side effects must NOT.
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(timelinesQueries.markTimelineUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('never throws: a side-effect failure (markContactUnread rejects) still returns linked', async () => {
        wireMatchAndLink();
        queries.markContactUnread.mockRejectedValue(new Error('db blip'));
        const res = await svc.linkInboundMessage(COMPANY_A, inboundMsg());
        // The catch around side effects keeps the link result intact.
        expect(res).toEqual({ linked: true, contactId: CONTACT, timelineId: TIMELINE });
    });
});

// ─── D. ingestPushNotification — decode → pull → link each (P0) ───────────────────

describe('ingestPushNotification (P0)', () => {
    it('decoded null (unknown/foreign mailbox) → {handled:false}, no pull, no link', async () => {
        mockProvider.handlePushNotification.mockResolvedValue(null);
        const res = await svc.ingestPushNotification({ message: { data: 'x' } });
        expect(res).toEqual({ handled: false });
        expect(mockProvider.pullChanges).not.toHaveBeenCalled();
    });

    it('happy path: pulls touched messages and links each (counts linked vs skipped)', async () => {
        mockProvider.handlePushNotification.mockResolvedValue({ companyId: COMPANY_A, cursor: '999' });
        mockProvider.pullChanges.mockResolvedValue({
            messages: [
                inboundMsg({ provider_message_id: 'm1' }),          // will link
                inboundMsg({ provider_message_id: 'm2', labelIds: ['DRAFT'] }), // skipped (draft)
            ],
            cursor: '1000',
        });
        // m1 matches+links; m2 dies in the filter (findEmailContact only reached for m1).
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound' });

        const res = await svc.ingestPushNotification({ message: { data: 'x' } });

        expect(mockProvider.pullChanges).toHaveBeenCalledWith(COMPANY_A, '999');
        expect(res).toEqual({ handled: true, company: COMPANY_A, processed: 2, linked: 1, skipped: 1 });
    });

    it('never throws on provider error → {handled:false, error}', async () => {
        mockProvider.handlePushNotification.mockRejectedValue(new Error('pubsub boom'));
        const res = await svc.ingestPushNotification({ message: { data: 'x' } });
        expect(res).toEqual({ handled: false, error: 'pubsub boom' });
    });

    it('pullChanges returns non-array messages → processed 0, never throws', async () => {
        mockProvider.handlePushNotification.mockResolvedValue({ companyId: COMPANY_A, cursor: '1' });
        mockProvider.pullChanges.mockResolvedValue({ messages: undefined, cursor: '1' });
        const res = await svc.ingestPushNotification({ message: { data: 'x' } });
        expect(res).toEqual({ handled: true, company: COMPANY_A, processed: 0, linked: 0, skipped: 0 });
    });
});

// ─── E. ingestPolledForCompany — shares linkInboundMessage (P1, TC-ET-023 sibling) ─

describe('ingestPolledForCompany (P1)', () => {
    it('maps each unlinked inbound row through linkInboundMessage (is_outbound:false forced)', async () => {
        emailQueries.listUnlinkedInboundForTimeline.mockResolvedValue([
            { provider_message_id: 'p1', from_email: 'alice@example.com', from_name: 'Alice',
              subject: 'Hi', body_text: 'b', gmail_internal_at: '2026-06-23T12:00:00.000Z' },
        ]);
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: CONTACT });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: TIMELINE });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound' });

        const res = await svc.ingestPolledForCompany(COMPANY_A);
        expect(res).toEqual({ company: COMPANY_A, processed: 1, linked: 1, skipped: 0 });
        // The synthesized msg carried is_outbound:false (so the filter never drops a poll row on that axis).
        expect(emailQueries.findEmailContact).toHaveBeenCalledWith('alice@example.com', COMPANY_A);
    });

    it('safe-fail: listUnlinkedInboundForTimeline rejects → zeroed summary, never throws', async () => {
        emailQueries.listUnlinkedInboundForTimeline.mockRejectedValue(new Error('db down'));
        const res = await svc.ingestPolledForCompany(COMPANY_A);
        expect(res).toMatchObject({ company: COMPANY_A, processed: 0, linked: 0, skipped: 0, error: 'db down' });
    });
});
