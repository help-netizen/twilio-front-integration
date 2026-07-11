'use strict';

/**
 * YELP-CONVO-BOOKING-001 — GREETER DEDUP (must-fix regression guard).
 *
 * THE DEFECT (never double-greet): with YELP_CONVO_ENABLED ON the first Yelp message is
 * greeted by a `yelp_convo` TURN-0 task claimed on `<pmid>:greet0`. Its `attachTask`
 * stamp on the bare-pmid LEAD claim is best-effort/swallowed. If that stamp FAILS, a
 * re-ingest of the same first message reaches reconcileLostTask (task_id NULL &
 * greeted_at NULL & lead_id set) which — before this fix — UNCONDITIONALLY re-enqueued
 * the `yelp_lead` greeter. Because `yelp_lead` de-dupes on a DIFFERENT namespace
 * (thread_token, via threadAlreadyGreeted) than the `<pmid>:greet0` claim, BOTH could
 * greet → a DOUBLE customer email.
 *
 * THE FIX (both asserted here):
 *   (1) PRIMARY — the turn-0 greeting now writes the SAME thread_token greeted-marker
 *       (markGreeted) that threadAlreadyGreeted() reads, so a later yelp_lead greeter
 *       suppresses. (YCB-GREET-DEDUP-01)
 *   (2) DEFENSE-IN-DEPTH — reconcileLostTask is flag-aware: it no-ops when the thread is
 *       already greeted and, under the flag, re-enqueues the `yelp_convo` greeter (whose
 *       `<pmid>:greet0` claim de-dupes) instead of `yelp_lead`. (YCB-GREET-DEDUP-02)
 *
 * These suites share ONE in-memory yelp_lead_events ledger across yelpLeadService AND the
 * agentHandlers greeters — that shared store is precisely what proves the unified dedup.
 *
 * RED WITHOUT THE FIX: revert BOTH edits (handler markGreeted→markReplied on greeting turn,
 * and reconcile→yelp_lead unconditional) and YCB-GREET-DEDUP-02 sees TWO sends (assert
 * ONE fails); reverting only the handler marker turns YCB-GREET-DEDUP-01 red.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpConvoGreeterDedup.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

// ── ONE shared in-memory yelp_lead_events ledger (yelpLeadService + both greeters) ──
const mockLedger = { rows: [], seq: 0 };
jest.mock('../backend/src/db/yelpLeadQueries', () => ({
    claimYelpLead: jest.fn(async (companyId, pmid, threadToken = null) => {
        const hit = mockLedger.rows.find(r => r.company_id === companyId && r.provider_message_id === pmid);
        if (hit) return { claimed: false };
        const row = {
            id: ++mockLedger.seq, company_id: companyId, provider_message_id: pmid,
            thread_token: threadToken, greeted_at: null, task_id: null, lead_id: null, status: 'claimed',
        };
        mockLedger.rows.push(row);
        return { claimed: true, id: row.id };
    }),
    releaseClaim: jest.fn(async (id) => {
        const i = mockLedger.rows.findIndex(r => r.id === id);
        if (i >= 0) mockLedger.rows.splice(i, 1);
    }),
    attachLead: jest.fn(async (id, leadId) => {
        const r = mockLedger.rows.find(x => x.id === id);
        if (r && r.lead_id == null) r.lead_id = leadId;
    }),
    attachTask: jest.fn(async (id, taskId) => {
        const r = mockLedger.rows.find(x => x.id === id);
        if (r) r.task_id = taskId;
    }),
    markGreeted: jest.fn(async (id, opts = {}) => {
        const r = mockLedger.rows.find(x => x.id === id);
        if (r) {
            r.greeted_at = new Date().toISOString();
            if (opts.leadId != null) r.lead_id = opts.leadId;
            if (opts.threadToken) r.thread_token = opts.threadToken;   // COALESCE-like: keep prior when null
            r.status = opts.status || 'greeted';
        }
    }),
    markReplied: jest.fn(async (companyId, pmid) => {
        const r = mockLedger.rows.find(x => x.company_id === companyId && x.provider_message_id === pmid);
        if (r) r.status = 'replied';   // NB: does NOT set greeted_at / thread_token (the whole point)
    }),
    threadAlreadyGreeted: jest.fn(async (companyId, threadToken) => !!(
        threadToken && mockLedger.rows.find(r =>
            r.company_id === companyId && r.thread_token === threadToken && r.greeted_at != null)
    )),
    getClaimByMessage: jest.fn(async (companyId, pmid) =>
        mockLedger.rows.find(r => r.company_id === companyId && r.provider_message_id === pmid) || null),
}));

// tasks INSERTs → capture the enqueued greeter tasks the worker would later run.
const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockCreateLead = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));

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

// The Phase-B brain is mocked at the handler seam: runTurn sends the ONE greeting email.
const mockRunTurn = jest.fn();
jest.mock('../backend/src/services/yelpConvoAgentService', () => ({ runTurn: mockRunTurn }));

// The SEND counter (shared by both greeters) + the yelp_lead greeter's builder.
const mockSendEmail = jest.fn();
const mockBuildGreeting = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));

const yelpLeadService = require('../backend/src/services/yelpLeadService');
const yelpLeadQueries = require('../backend/src/db/yelpLeadQueries');
const agentHandlers = require('../backend/src/services/agentHandlers');
const { yNew, convRow, taskRow, yelpInput, CONV_ID, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const THREAD_TOKEN = '8160b36a1c2d3e4f';   // = parseYelpLead(yNew()).thread_token
const RELAY = 'reply+8160b36a1c2d3e4f@messaging.yelp.com';

// The enqueued greeter tasks, reconstructed from each INSERT INTO tasks the service ran.
let enqueuedTasks;
let taskSeq;

// Run an enqueued task through the shared registry exactly as the worker would.
const runTask = (t) => agentHandlers.run({
    id: t.id, company_id: t.company_id, kind: 'agent', agent_type: t.agent_type,
    max_attempts: 3, lead_id: t.lead_id, agent_input: t.agent_input,
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    mockLedger.rows.length = 0;
    mockLedger.seq = 0;
    enqueuedTasks = [];
    taskSeq = 900;

    // The greeters run only under both gates ON (this is the defect's regime).
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    process.env.YELP_CONVO_ENABLED = 'true';

    // db.query: an INSERT INTO tasks returns a fresh id and is captured as a runnable task.
    mockQuery.mockImplementation(async (sql, params) => {
        if (/insert into tasks/i.test(sql)) {
            const id = ++taskSeq;
            let agent_input = {};
            try { agent_input = JSON.parse(params[1]); } catch (_e) { /* keep {} */ }
            enqueuedTasks.push({
                id, company_id: params[0],
                agent_type: /'yelp_convo'/.test(sql) ? 'yelp_convo' : 'yelp_lead',
                lead_id: params[3], agent_input,
            });
            return { rows: [{ id }] };
        }
        return { rows: [] };
    });

    mockCreateLead.mockResolvedValue({ UUID: 'lead-uuid-1', ClientId: '55', SerialId: 1001 });
    mockGetByConvId.mockResolvedValue(convRow({
        conversation_id: CONV_ID, status: 'open', phase: 'greet', turn_count: 0,
        lead_id: 55, lead_uuid: 'lead-uuid-1', last_reply_to: RELAY, last_thread_token: THREAD_TOKEN,
    }));
    mockUpdateState.mockResolvedValue(undefined);
    mockUpsertConversation.mockResolvedValue(undefined);

    // runTurn = the ONE greeting send for the turn-0 task.
    mockRunTurn.mockImplementation(async (companyId, conv) => {
        await mockSendEmail(companyId, { to: conv.last_reply_to, subject: 'Re: your request', body: 'greeting' });
        return { outcome: 'reply' };
    });
    mockSendEmail.mockResolvedValue({ provider_message_id: '<sent-1>' });
    mockBuildGreeting.mockResolvedValue('Hi Kim, ...');
});

afterEach(() => {
    delete process.env.YELP_AUTORESPONDER_ENABLED;
    delete process.env.YELP_CONVO_ENABLED;
    jest.restoreAllMocks();
});

// The turn-0 greeting task the detector enqueues (agent_input carries greeting:true + the
// thread_token, the two fields the primary fix reads).
const greet0Task = () => ({
    id: 901, company_id: DEFAULT_COMPANY_ID, kind: 'agent', agent_type: 'yelp_convo', max_attempts: 3, lead_id: 55,
    agent_input: {
        conversation_id: CONV_ID,
        inbound_provider_message_id: 'ymsg-NEW-1:greet0',
        inbound_body_text: 'first message',
        reply_to: RELAY, thread_token: THREAD_TOKEN,
        lead_id: 55, lead_uuid: 'lead-uuid-1', greeting: true,
    },
});

// A same-thread yelp_lead greeter task (as reconcile would enqueue) — same thread_token.
const yelpLeadTask = (o = {}) =>
    taskRow({ agent_type: 'yelp_lead', company_id: DEFAULT_COMPANY_ID, agent_input: yelpInput(o) });

// ── YCB-GREET-DEDUP-01 · PRIMARY: turn-0 greeting stamps the SHARED thread_token marker ──
describe('YCB-GREET-DEDUP-01 · turn-0 convo greeting unifies the dedup namespace (primary fix)', () => {
    it('NEVER-DOUBLE-GREET: after the yelp_convo turn-0 greeting sends, a same-thread yelp_lead greeter SEES threadAlreadyGreeted and does NOT send a 2nd greeting', async () => {
        // (a) turn-0 greeting runs (flag ON) → sends exactly once + marks the thread greeted.
        const g0 = await runTask(greet0Task());
        expect(g0).toMatchObject({ handled: true, conversation_id: CONV_ID });
        expect(mockRunTurn).toHaveBeenCalledTimes(1);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        // the marker is keyed by the CONVERSATION thread_token (what threadAlreadyGreeted reads)
        expect(yelpLeadQueries.markGreeted).toHaveBeenCalledTimes(1);
        expect(yelpLeadQueries.markGreeted).toHaveBeenCalledWith(
            expect.any(Number),
            expect.objectContaining({ threadToken: THREAD_TOKEN, status: 'greeted', leadId: 55 }));
        expect(await yelpLeadQueries.threadAlreadyGreeted(DEFAULT_COMPANY_ID, THREAD_TOKEN)).toBe(true);

        // (b) a yelp_lead greeter on the SAME thread now SUPPRESSES (no 2nd send/build).
        const outLead = await runTask(yelpLeadTask());
        expect(outLead).toMatchObject({ skipped: 'already_greeted' });
        expect(mockBuildGreeting).not.toHaveBeenCalled();
        expect(mockSendEmail).toHaveBeenCalledTimes(1);   // still exactly ONE greeting total
    });
});

// ── YCB-GREET-DEDUP-02 · END-TO-END: flag ON + attachTask stamp FAILS + re-ingest ⇒ ONE greeting ──
describe('YCB-GREET-DEDUP-02 · lost-lead-claim reconcile after a failed turn-0 stamp does NOT double-greet', () => {
    it('EXACTLY-ONE-GREETING: first-ingest attachTask throws (stamp lost) → turn-0 greets once → re-ingest reconcile is suppressed (no 2nd greeter survives)', async () => {
        // (1) FIRST ingest: the turn-0 greeter is enqueued, but stamping the task id on the
        //     bare-pmid LEAD claim FAILS (best-effort/swallowed) → claim stays task_id NULL.
        yelpLeadQueries.attachTask.mockImplementationOnce(async () => { throw new Error('stamp lost'); });
        const first = await yelpLeadService.maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());
        expect(first).toMatchObject({ handled: true, skipped: 'yelp_convo' });
        expect(enqueuedTasks).toHaveLength(1);
        expect(enqueuedTasks[0].agent_type).toBe('yelp_convo');
        // the bare-pmid lead claim really is in the lost state the reconcile keys off.
        const bare = await yelpLeadQueries.getClaimByMessage(DEFAULT_COMPANY_ID, 'ymsg-NEW-1');
        expect(bare).toMatchObject({ task_id: null, greeted_at: null, lead_id: 55 });

        // (2) the worker runs the enqueued turn-0 greeter → the ONE greeting send + marker.
        await runTask(enqueuedTasks[0]);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);

        // (3) RE-INGEST the SAME first message → claim is lost → reconcileLostTask.
        const second = await yelpLeadService.maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());
        expect(mockCreateLead).toHaveBeenCalledTimes(1);                 // never a 2nd lead
        expect(second).toMatchObject({ reason: 'already_greeted_thread' }); // no-op'd on the shared marker

        // (4) Drain ANY greeter the reconcile enqueued (fixed: none; unfixed: a 2nd yelp_lead).
        for (const t of enqueuedTasks.slice(1)) await runTask(t);

        // THE INVARIANT: exactly ONE customer greeting total; the reconcile greeter is suppressed.
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockBuildGreeting).not.toHaveBeenCalled();
    });
});
