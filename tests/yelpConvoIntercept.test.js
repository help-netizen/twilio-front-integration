'use strict';

/**
 * YELP-CONVO-BOOKING-001 — INTERCEPT ROUTING (YCB-INT-01..05, YCB-DEC-04, YCB-DEC-01).
 * Higher-fidelity harness: the DB seam + collaborators are mocked, but the REAL
 * yelpLeadService.maybeHandleYelpLead / maybeHandleYelpReply and the REAL conv-id
 * parser run, driven through emailTimelineService.linkInboundMessage. This exercises
 * A5 (first-message upsert + reply routing) AND A6 (intercept wiring) together.
 *
 * Sabotage SAB-INT-DROP-REPLY-BRANCH (procedure, run manually): remove the
 * maybeHandleYelpReply branch from linkInboundMessage (or make detectYelpReply return
 * false). Then YCB-INT-02 turns RED — the reply creates no yelp_convo task and falls
 * to the Mail Secretary / a new lead instead. Named check: INT-reply-to-convo-not-lead.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpConvoIntercept.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockCreateLead = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));

const mockClaimYelpLead = jest.fn();
jest.mock('../backend/src/db/yelpLeadQueries', () => ({
    claimYelpLead: mockClaimYelpLead,
    releaseClaim: jest.fn(),
    getClaimByMessage: jest.fn(),
    attachLead: jest.fn(),
    attachTask: jest.fn(),
    markGreeted: jest.fn(),
    markReplied: jest.fn(),
    threadAlreadyGreeted: jest.fn(),
}));

const mockUpsertConversation = jest.fn();
const mockGetByConvId = jest.fn();
const mockUpdateState = jest.fn();
jest.mock('../backend/src/db/yelpConversationQueries', () => ({
    upsertConversation: mockUpsertConversation,
    getByConvId: mockGetByConvId,
    getByConversationId: mockGetByConvId,
    getActiveByConversationId: jest.fn(),
    updateState: mockUpdateState,
    setPhaseStatus: jest.fn(),
}));

// Prove zero LLM/SMTP work on the ingest path.
const mockSendEmail = jest.fn();
const mockBuildGreeting = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));

// Mail-timeline collaborators (mirror tests/yelpLeadHook.test.js).
jest.mock('../backend/src/db/emailQueries', () => ({
    findEmailContact: jest.fn(),
    getMessageLinkState: jest.fn(),
    linkMessageToContact: jest.fn(),
    listUnlinkedInboundForTimeline: jest.fn(),
    listUnlinkedOutboundForTimeline: jest.fn(() => Promise.resolve([])),
    getTimelineEmailByContact: jest.fn(),
    getNewestThreadIdForContact: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
    resolveYelpTimeline: jest.fn(), // YELP-TIMELINE-DEDUP-001
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
    getConnectionStatus: jest.fn(),
    pullChanges: jest.fn(),
    handlePushNotification: jest.fn(),
    sendMessage: jest.fn(),
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
const svc = require('../backend/src/services/email/emailTimelineService');
const { yNew, yReplyRespondable, yConfirm, nonYelp, convRow, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const COMPANY = DEFAULT_COMPANY_ID;
const taskInsertsOfType = (type) =>
    mockQuery.mock.calls.filter(([sql]) => /insert into tasks/i.test(sql) && sql.includes(`'${type}'`));

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.YELP_CONVO_ENABLED;
    mockQuery.mockImplementation(async (sql) =>
        /insert into tasks/i.test(sql) ? { rows: [{ id: 900 }] } : { rows: [] }
    );
    mockClaimYelpLead.mockResolvedValue({ claimed: true, id: 7 });
    mockCreateLead.mockResolvedValue({ UUID: 'lead-uuid', SerialId: 1001, ClientId: '55' });
    mockUpsertConversation.mockResolvedValue(convRow({ phase: 'greet' }));
    mockGetByConvId.mockResolvedValue(null);
    mockUpdateState.mockResolvedValue(convRow());
    mailAgentService.isSenderMuted.mockResolvedValue(false);
    emailQueries.findEmailContact.mockResolvedValue(null);
    // YELP-TIMELINE-DEDUP-001 subsuming-branch defaults: every Yelp relay message
    // now ALSO links to its conv-id timeline (contactless) before the greeter runs.
    timelinesQueries.resolveYelpTimeline.mockImplementation((co, cid) =>
        Promise.resolve({ id: 7001, yelp_conversation_id: cid, display_name: 'Kim L.', external_source: 'yelp' }));
    emailQueries.getMessageLinkState.mockResolvedValue(null);
    emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound', thread_id: 'ythr-NEW-1' });
});

// ── YCB-INT-01 · first-message → lead + conversation upsert (+ greet) ──────────
describe('YCB-INT-01 · first message → lead + conversation upsert + greet (Phase A)', () => {
    it('createLead once, upsert (company, convId), yelp_lead enqueued, {skipped:yelp_lead}', async () => {
        const res = await svc.linkInboundMessage(COMPANY, yNew());

        // MIGRATED (YELP-TIMELINE-DEDUP-001): the subsuming branch links the contactless
        // timeline + SSEs, then STILL greets → a hybrid {linked,timelineId,skipped} shape.
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_lead' });

        // (1) exactly one lead, JobSource Yelp
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        expect(mockCreateLead.mock.calls[0][0]).toMatchObject({ JobSource: 'Yelp' });

        // (2) a conversation upsert keyed on the STABLE body conv-id
        expect(mockUpsertConversation).toHaveBeenCalledTimes(1);
        expect(mockUpsertConversation).toHaveBeenCalledWith(
            COMPANY, '9Xk2mZ7bQ1',
            expect.objectContaining({ lead_id: 55, lead_uuid: 'lead-uuid', phase: 'greet' })
        );

        // (3) the greeting task is STILL enqueued (Phase A first-greeting unbroken)
        expect(taskInsertsOfType('yelp_lead')).toHaveLength(1);
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);

        // (4) NEW: the message links to the conv-id timeline (contactless) + SSEs.
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'ymsg-NEW-1', COMPANY, { contact_id: null, timeline_id: 7001, on_timeline: true });
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        // INVARIANTS THAT STAY: no Mail-Secretary review, no CONTACT unread, no junk
        // contact lookup (contactless → markTimelineUnread, not markContactUnread).
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });
});

// ── YCB-INT-01 [B] · greeter switch — flag ON → first message enqueues yelp_convo turn-0 ──
describe('YCB-INT-01 [B] · GREETER-SWITCH — YELP_CONVO_ENABLED ON → yelp_convo turn-0 (one greeter)', () => {
    it('first message → createLead + upsert, but the greeter is a yelp_convo TURN-0 (not yelp_lead)', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        try {
            const res = await svc.linkInboundMessage(COMPANY, yNew());

            // same lead + same conversation upsert as Phase A
            expect(mockCreateLead).toHaveBeenCalledTimes(1);
            expect(mockUpsertConversation).toHaveBeenCalledWith(
                COMPANY, '9Xk2mZ7bQ1', expect.objectContaining({ phase: 'greet' }));

            // the greeter is SUBSUMED: exactly one yelp_convo task, ZERO yelp_lead tasks
            const convoInserts = taskInsertsOfType('yelp_convo');
            const leadInserts = taskInsertsOfType('yelp_lead');
            expect(convoInserts).toHaveLength(1);
            expect(leadInserts).toHaveLength(0);
            const input = JSON.parse(convoInserts[0][1][1]);
            expect(input).toMatchObject({ conversation_id: '9Xk2mZ7bQ1', greeting: true, lead_id: 55 });
            // turn-0 claim key is suffixed so it never collides with the lead claim on the bare pmid
            expect(input.inbound_provider_message_id).toBe('ymsg-NEW-1:greet0');

            // still short-circuits the Mail Secretary, now as yelp_convo (+ linked)
            expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_convo' });
            expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        } finally {
            delete process.env.YELP_CONVO_ENABLED;
        }
    });

    it('flag OFF (Phase A) still greets via yelp_lead (control — no double greeter)', async () => {
        // beforeEach already deleted YELP_CONVO_ENABLED → Phase A path.
        const res = await svc.linkInboundMessage(COMPANY, yNew());
        expect(taskInsertsOfType('yelp_lead')).toHaveLength(1);
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);
        expect(res).toMatchObject({ linked: true, skipped: 'yelp_lead' });
    });
});

// ── YCB-INT-02 · respondable reply → yelp_convo turn, NOT a new lead ───────────
describe('YCB-INT-02 · INT-reply-to-convo-not-lead (SAB-INT-DROP-REPLY-BRANCH)', () => {
    it('reply matching an OPEN conversation → one yelp_convo task, no createLead', async () => {
        mockGetByConvId.mockResolvedValue(convRow()); // an existing OPEN row, lead 55

        const res = await svc.linkInboundMessage(COMPANY, yReplyRespondable());

        // (1) a reply is NEVER a new lead
        expect(mockCreateLead).not.toHaveBeenCalled();

        // (2) exactly one yelp_convo task with the turn contract
        const inserts = taskInsertsOfType('yelp_convo');
        expect(inserts).toHaveLength(1);
        const [sql, params] = inserts[0];
        expect(sql).toMatch(/'queued',\s*3\s*,/);        // agent_status='queued', max_attempts 3
        expect(sql).toMatch(/'lead'/);                   // subject_type
        expect(params[3]).toBe(55);                      // lead_id param
        const input = JSON.parse(params[1]);
        expect(input).toMatchObject({
            conversation_id: '9Xk2mZ7bQ1',
            inbound_provider_message_id: 'ymsg-REPLY-1',
            reply_to: 'reply+aa11bb22cc33dd44@messaging.yelp.com', // THIS reply's fresh hex
            lead_uuid: 'lead-uuid-0001',
            lead_id: 55,
        });

        // (3) last_reply_to refreshed to the new hex
        expect(mockUpdateState).toHaveBeenCalledWith(
            COMPANY, '9Xk2mZ7bQ1',
            expect.objectContaining({ last_reply_to: 'reply+aa11bb22cc33dd44@messaging.yelp.com' })
        );

        // (4) short-circuit — now ALSO links the contactless conv-id timeline + SSEs
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_convo' });
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });
});

// ── YCB-INT-03 · reply with NO known conversation → safe fall-through ──────────
describe('YCB-INT-03 · unknown / null conv-id reply → fall-through, not misthreaded', () => {
    it('unknown conv-id → no yelp_convo task, no createLead, no write, falls through', async () => {
        mockGetByConvId.mockResolvedValue(null); // no matching conversation
        const msg = yReplyRespondable({
            body_text: 'Kim replied. View: https://www.yelp.com/mail/click?url=%2Fthread%2FUNKNOWNxyz&utm_source=request_a_quote_new_message_respondable',
        });

        const res = await svc.linkInboundMessage(COMPANY, msg);

        expect(mockGetByConvId).toHaveBeenCalledWith(COMPANY, 'UNKNOWNxyz');
        // MIGRATED: an unknown conv-id is NOT misthreaded (no convo task, no lead, no
        // cross-thread write) — but it DOES key its own contactless timeline (every
        // conv-id message is visible), so the result is the hybrid link shape, not
        // {skipped:'no_contact'}. It never reaches the junk-contact path.
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(mockUpdateState).not.toHaveBeenCalled();     // no cross-thread write
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_convo' });
    });

    it('no conv-id in a respondable body → parser null → suppressed, no throw', async () => {
        const msg = yReplyRespondable({
            body_text: 'Kim replied. View: https://www.yelp.com/messaging?utm_source=request_a_quote_new_message_respondable',
        });

        const res = await svc.linkInboundMessage(COMPANY, msg);

        // MIGRATED: a Yelp relay with NO parseable conv-id is suppressed at the TOP of
        // the branch (before the greeters) — zero timeline, zero contact.
        expect(timelinesQueries.resolveYelpTimeline).not.toHaveBeenCalled();
        expect(mockGetByConvId).not.toHaveBeenCalled();     // never looked up a garbage key
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(res).toEqual({ skipped: 'yelp_no_convo' });
    });
});

// ── YCB-INT-04 · no-reply@*yelp.com confirmation → ignored ─────────────────────
describe('YCB-INT-04 · no-reply@notify.yelp.com → ignored by both branches', () => {
    it('wrong sender domain → no lead, no upsert, no yelp_convo/lead task', async () => {
        const res = await svc.linkInboundMessage(COMPANY, yConfirm());

        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(mockUpsertConversation).not.toHaveBeenCalled();
        expect(mockGetByConvId).not.toHaveBeenCalled();
        expect(taskInsertsOfType('yelp_lead')).toHaveLength(0);
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);
        // MIGRATED: a Yelp SYSTEM sender (no-reply@notify.yelp.com) is now suppressed by
        // the isYelpNoise gate → {skipped:'yelp_no_convo'}, guaranteeing no junk contact
        // (previously it fell to the Secretary's no-contact path). Either way: no contact.
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(res).toEqual({ skipped: 'yelp_no_convo' });
    });
});

// ── YCB-INT-05 · non-Yelp inbound → still reaches the Mail Secretary ───────────
describe('YCB-INT-05 · non-Yelp → Mail Secretary reached (control)', () => {
    it('both Yelp branches skipped; reviewInboundEmail({noContact:true}) once', async () => {
        const res = await svc.linkInboundMessage(COMPANY, nonYelp());

        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(0);
        expect(mailAgentService.reviewInboundEmail).toHaveBeenCalledTimes(1);
        expect(mailAgentService.reviewInboundEmail).toHaveBeenCalledWith(
            COMPANY, expect.any(Object), { noContact: true }
        );
        expect(res).toEqual({ skipped: 'no_contact' });
    });
});

// ── YCB-DEC-04 · a Yelp reply short-circuits the Mail Secretary ────────────────
describe('YCB-DEC-04 · reply short-circuits the Mail Secretary (no duplicate review/AR)', () => {
    it('known-conv reply → only the yelp_convo task; no review/task/unread/SSE/contact', async () => {
        mockGetByConvId.mockResolvedValue(convRow());

        const res = await svc.linkInboundMessage(COMPANY, yReplyRespondable());

        // MIGRATED: the reply short-circuits the Mail Secretary AND links the contactless
        // conv-id timeline (SSE now fires; contact unread does NOT — it's contactless).
        expect(res).toMatchObject({ linked: true, timelineId: 7001, skipped: 'yelp_convo' });
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
        expect(taskInsertsOfType('yelp_convo')).toHaveLength(1);
    });
});

// ── YCB-DEC-01 · the new Yelp-convo modules require NO Mail Secretary ──────────
describe('YCB-DEC-01 · module decoupling from the Mail Secretary (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

    it('yelpConversationId.js requires no mailAgentService / mailAgentClassifier', () => {
        expect(read('../backend/src/services/yelpConversationId.js'))
            .not.toMatch(/mailAgentService|mailAgentClassifier/);
    });
    it('yelpConversationQueries.js requires no mailAgentService / mailAgentClassifier', () => {
        expect(read('../backend/src/db/yelpConversationQueries.js'))
            .not.toMatch(/mailAgentService|mailAgentClassifier/);
    });
    it('agentHandlers.js (host of yelp_convo) requires no mailAgentClassifier', () => {
        const src = read('../backend/src/services/agentHandlers.js');
        expect(src).toMatch(/yelp_convo/);
        expect(src).not.toMatch(/mailAgentClassifier/);
    });
    it('yelpConvoAgentService.js (the Phase-B brain) does not REQUIRE the Mail Secretary', () => {
        // The brain COPIES the Gemini transport shape (documented in comments) but must
        // not IMPORT the Mail Secretary — assert no require() of either module.
        const src = read('../backend/src/services/yelpConvoAgentService.js');
        expect(src).not.toMatch(/require\([^)]*mailAgent(Service|Classifier)[^)]*\)/);
    });
});
