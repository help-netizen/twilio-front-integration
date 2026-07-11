'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — the subsuming Yelp timeline branch (jest-mocked unit).
 * Covers TC-01, TC-03, TC-04, TC-05, TC-10, TC-12 (+ fixture validation + the TC-11
 * jest companion). The DB seam + collaborators are mocked; the REAL parseConversationId
 * runs on the fixtures. yelpLeadService's ORCHESTRATORS (maybeHandleYelpLead /
 * maybeHandleYelpReply) are mocked so the timeline-unification branch is tested
 * INDEPENDENTLY of the greeter, but its pure gates (isYelpRelay / isYelpNoise /
 * parseYelpLead) are the REAL implementations (jest.requireActual).
 *
 * NAMED SABOTAGES (each must flip its case RED; revert after):
 *   TC-01 SAB-KEY-ON-RELAY · TC-03 SAB-DROP-EARLY-RETURN · TC-04 SAB-DROP-CONVID-GATE
 *   TC-05 SAB-GUARD-CONTACTID.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpTimelineDedup.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockMaybeHandleYelpLead = jest.fn(async () => ({ handled: false }));
const mockMaybeHandleYelpReply = jest.fn(async () => ({ handled: false }));
jest.mock('../backend/src/services/yelpLeadService', () => {
    const actual = jest.requireActual('../backend/src/services/yelpLeadService');
    return {
        ...actual, // REAL isYelpRelay / isYelpNoise / parseYelpLead / detect*
        maybeHandleYelpLead: mockMaybeHandleYelpLead,
        maybeHandleYelpReply: mockMaybeHandleYelpReply,
    };
});

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), getClient: jest.fn() }));

jest.mock('../backend/src/db/emailQueries', () => ({
    findEmailContact: jest.fn(),
    getMessageLinkState: jest.fn(),
    linkMessageToContact: jest.fn(),
    listUnlinkedInboundForTimeline: jest.fn(),
    listUnlinkedOutboundForTimeline: jest.fn(() => Promise.resolve([])),
    getTimelineEmailByContact: jest.fn(),
    getTimelineEmailByTimeline: jest.fn(),
    getNewestThreadIdForContact: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
    resolveYelpTimeline: jest.fn(),
    markTimelineUnread: jest.fn(),
    setActionRequired: jest.fn(),
    createTask: jest.fn(),
}));
jest.mock('../backend/src/db/queries', () => ({ markContactUnread: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    broadcast: jest.fn(),
}));
jest.mock('../backend/src/services/arConfigHelper', () => ({
    getTriggerConfig: jest.fn(async () => ({ enabled: false })),
}));
jest.mock('../backend/src/services/mailAgentService', () => ({
    isSenderMuted: jest.fn(async () => false),
    reviewInboundEmail: jest.fn(async () => ({})),
    isActive: jest.fn(async () => false),
}));
const mockProvider = {
    getConnectionStatus: jest.fn(), pullChanges: jest.fn(),
    handlePushNotification: jest.fn(), sendMessage: jest.fn(),
};
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));

const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const queries = require('../backend/src/db/queries');
const realtimeService = require('../backend/src/services/realtimeService');
const mailAgentService = require('../backend/src/services/mailAgentService');
const { parseConversationId } = require('../backend/src/services/yelpConversationId');
const svc = require('../backend/src/services/email/emailTimelineService');
const {
    CONV_ID, CONV_ID_2, DEFAULT_COMPANY_ID,
    yNew, yNewOtherConvo, yNoConvo, yReply, yReplyRespondable, yReply2, yConfirm, nonYelp,
} = require('./yelpFixtures');

const COMPANY = DEFAULT_COMPANY_ID;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.YELP_CONVO_ENABLED;
    mockMaybeHandleYelpLead.mockResolvedValue({ handled: false });
    mockMaybeHandleYelpReply.mockResolvedValue({ handled: false });
    mailAgentService.isSenderMuted.mockResolvedValue(false);
    mailAgentService.isActive.mockResolvedValue(false);
    emailQueries.findEmailContact.mockResolvedValue(null);
    emailQueries.getMessageLinkState.mockResolvedValue(null);
    emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound', thread_id: 'ythr-NEW-1' });
    timelinesQueries.resolveYelpTimeline.mockResolvedValue({
        id: 7001, yelp_conversation_id: CONV_ID, display_name: 'Kim', external_source: 'yelp',
    });
});

// ── Fixture validation (pins that varying hexes share a conv-id) ───────────────
describe('fixtures — conv-id is body-derived, relay-independent', () => {
    it('three varying relay hexes share ONE conv-id; the 2nd convo differs; no-conv-id → null', () => {
        expect(parseConversationId(yNew())).toBe(CONV_ID);
        expect(parseConversationId(yReplyRespondable())).toBe(CONV_ID);
        expect(parseConversationId(yReply2())).toBe(CONV_ID);
        expect(parseConversationId(yNewOtherConvo())).toBe(CONV_ID_2);
        expect(parseConversationId(yReply())).toBeNull();
        expect(parseConversationId(yNoConvo())).toBeNull();
    });
});

// ── TC-01 · conv-id is the timeline key (SAB-KEY-ON-RELAY) ─────────────────────
describe('TC-01 · varying relay hex collapses to ONE resolve; 2nd conv-id distinct', () => {
    it('resolves on the body conv-id (never the reply+<hex>); distinct convo → distinct id', async () => {
        timelinesQueries.resolveYelpTimeline.mockImplementation((co, cid) =>
            Promise.resolve({ id: cid === CONV_ID ? 7001 : 7002, yelp_conversation_id: cid, display_name: 'Kim' }));

        const r1 = await svc.linkInboundMessage(COMPANY, yNew());                 // reply+8160…
        const r2 = await svc.linkInboundMessage(COMPANY, yReplyRespondable());    // reply+aa11…
        const r3 = await svc.linkInboundMessage(COMPANY, yReply2());              // reply+ee55…
        const r4 = await svc.linkInboundMessage(COMPANY, yNewOtherConvo());       // reply+1122…, conv 2

        const keys = timelinesQueries.resolveYelpTimeline.mock.calls.map(c => c[1]);
        // (1) first three all resolved on CONV_ID (NOT the varying relay)
        expect(keys.slice(0, 3)).toEqual([CONV_ID, CONV_ID, CONV_ID]);
        // (2) never keyed on a hex / relay address
        for (const k of keys) {
            expect(k).not.toMatch(/@messaging\.yelp\.com/);
            expect(k).not.toMatch(/^reply\+/);
            expect(k).not.toMatch(/^[0-9a-f]{16}$/); // a bare relay hex token
        }
        // (3) 2nd conversation keyed on CONV_ID_2
        expect(keys[3]).toBe(CONV_ID_2);
        // (4) each links onto its resolved timeline id
        expect(r1).toMatchObject({ linked: true, timelineId: 7001 });
        expect(r2).toMatchObject({ linked: true, timelineId: 7001 });
        expect(r3).toMatchObject({ linked: true, timelineId: 7001 });
        expect(r4).toMatchObject({ linked: true, timelineId: 7002 });
    });
});

// ── TC-03 · NO contact ever created (SAB-DROP-EARLY-RETURN) ────────────────────
describe('TC-03 · no contact is created from a Yelp relay email', () => {
    it('links contactlessly and returns before findEmailContact / reviewInboundEmail', async () => {
        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'ymsg-NEW-1', COMPANY,
            { contact_id: null, timeline_id: 7001, on_timeline: true }
        );
        expect(res).toMatchObject({ linked: true, timelineId: 7001 });
        expect(res.skipped).toMatch(/^yelp_(convo|lead)$/);
    });
});

// ── TC-04 · no-conv-id ⇒ suppressed; non-Yelp still reaches Mail Secretary ─────
describe('TC-04 · suppress gate (SAB-DROP-CONVID-GATE)', () => {
    it('(a) relay with NO conv-id → {skipped:yelp_no_convo}; zero timeline, zero contact', async () => {
        const res = await svc.linkInboundMessage(COMPANY, yNoConvo());

        expect(res).toEqual({ skipped: 'yelp_no_convo' });
        expect(timelinesQueries.resolveYelpTimeline).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
    });

    it('(b) no-reply@notify.yelp.com confirmation → {skipped:yelp_no_convo}; no contact created', async () => {
        const res = await svc.linkInboundMessage(COMPANY, yConfirm());

        // Broadened gate (isYelpNoise): a Yelp system sender never creates a contact.
        expect(res).toEqual({ skipped: 'yelp_no_convo' });
        expect(timelinesQueries.resolveYelpTimeline).not.toHaveBeenCalled();
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
    });

    it('(c) non-Yelp no-contact inbound → {skipped:no_contact}; Mail Secretary consulted (regression guard)', async () => {
        const res = await svc.linkInboundMessage(COMPANY, nonYelp());

        expect(res).toEqual({ skipped: 'no_contact' });
        expect(timelinesQueries.resolveYelpTimeline).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).toHaveBeenCalledWith(
            COMPANY, expect.any(Object), { noContact: true }
        );
    });
});

// ── TC-05 · contactless idempotency (SAB-GUARD-CONTACTID) ─────────────────────
describe('TC-05 · push→poll redelivery links once; no 2nd unread / SSE', () => {
    it('guard keys on on_timeline+timeline_id (NOT contact_id) so a contactless re-link is idempotent', async () => {
        // 1st delivery: not yet linked.
        emailQueries.getMessageLinkState.mockResolvedValueOnce(null);
        const first = await svc.linkInboundMessage(COMPANY, yNew());

        // 2nd delivery (redeliver): already on the timeline, contact_id NULL.
        emailQueries.getMessageLinkState.mockResolvedValueOnce({
            contact_id: null, timeline_id: 7001, on_timeline: true,
        });
        const second = await svc.linkInboundMessage(COMPANY, yNew());

        expect(timelinesQueries.markTimelineUnread).toHaveBeenCalledTimes(1);
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        expect(first).toMatchObject({ linked: true, timelineId: 7001 });
        expect(first.alreadyLinked).toBeUndefined();
        expect(second).toMatchObject({ linked: true, timelineId: 7001, alreadyLinked: true });
    });
});

// ── TC-10 · safe-fail — resolver throw is contained (fail-open) ────────────────
describe('TC-10 · safe-fail: a resolver/link throw is contained; no junk-contact path', () => {
    it('resolveYelpTimeline throws → no throw out, no findEmailContact/review, greeter still attempted', async () => {
        timelinesQueries.resolveYelpTimeline.mockRejectedValue(new Error('resolve boom'));

        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(mockMaybeHandleYelpLead).toHaveBeenCalledTimes(1); // greeter best-effort
        expect(res.error).toBeUndefined();
        expect(res.linked).not.toBe(true); // no linked:true on a failed resolve
    });

    it('linkMessageToContact throws → same fail-open, contact path not re-enabled', async () => {
        emailQueries.linkMessageToContact.mockRejectedValue(new Error('link boom'));

        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(res.error).toBeUndefined();
        expect(res.linked).not.toBe(true);
    });
});

// ── TC-12 · decoupling + regression; TC-11 jest companion ─────────────────────
describe('TC-12 · non-Yelp untouched; greeter still enqueues under the subsuming branch', () => {
    it('non-Yelp inbound never enters the Yelp branch (resolveYelpTimeline not called)', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: 'c1', full_name: 'Jane' });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 't1' });
        emailQueries.linkMessageToContact.mockResolvedValue({ id: 9, direction: 'inbound' });

        await svc.linkInboundMessage(COMPANY, nonYelp());
        expect(timelinesQueries.resolveYelpTimeline).not.toHaveBeenCalled();
    });

    it('greeter STILL fires after the link: link (contact_id:null) then maybeHandleYelpLead', async () => {
        mockMaybeHandleYelpLead.mockResolvedValue({ handled: true, skipped: 'yelp_lead' });

        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'ymsg-NEW-1', COMPANY, { contact_id: null, timeline_id: 7001, on_timeline: true });
        expect(mockMaybeHandleYelpLead).toHaveBeenCalledTimes(1);
        // TC-11 companion: the link happens BEFORE the greeter enqueue.
        expect(emailQueries.linkMessageToContact.mock.invocationCallOrder[0])
            .toBeLessThan(mockMaybeHandleYelpLead.mock.invocationCallOrder[0]);
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_lead' });
    });

    it('a respondable reply drives maybeHandleYelpReply (lead not-handled → reply router)', async () => {
        mockMaybeHandleYelpLead.mockResolvedValue({ handled: false });
        mockMaybeHandleYelpReply.mockResolvedValue({ handled: true, skipped: 'yelp_convo' });

        const res = await svc.linkInboundMessage(COMPANY, yReplyRespondable());

        expect(mockMaybeHandleYelpLead).toHaveBeenCalledTimes(1);
        expect(mockMaybeHandleYelpReply).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_convo' });
    });

    it('unification holds with the greeter OFF/failing: yNew still links contactlessly', async () => {
        mockMaybeHandleYelpLead.mockRejectedValue(new Error('greeter down'));
        mockMaybeHandleYelpReply.mockRejectedValue(new Error('greeter down'));

        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'ymsg-NEW-1', COMPANY, { contact_id: null, timeline_id: 7001, on_timeline: true });
        expect(res).toMatchObject({ linked: true, timelineId: 7001 });
    });
});

// ── TC-12 structural — the resolver module is decoupled from the Mail Secretary ─
describe('TC-12 structural · resolveYelpTimeline module imports no Mail Secretary', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

    it('timelinesQueries.js (host of resolveYelpTimeline) requires no mailAgentService / reviewInboundEmail', () => {
        const src = read('../backend/src/db/timelinesQueries.js');
        expect(src).toMatch(/resolveYelpTimeline/);
        expect(src).not.toMatch(/mailAgentService|reviewInboundEmail/);
    });
});
