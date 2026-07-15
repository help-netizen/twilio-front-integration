'use strict';

/**
 * YELP-CONVO-BOOKING-001 — `yelp_convo` HANDLER (agentHandlers.HANDLERS.yelp_convo via
 * agentHandlers.run). Covers BOTH gates:
 *   • Phase A (YELP_CONVO_ENABLED OFF) — thin durable ACK (record the turn, no LLM/send).
 *   • Phase B (YELP_CONVO_ENABLED ON)  — claim-first → runTurn → markReplied (F group:
 *     YCB-IDEM-01/-02/-03, YCB-SAFE-02) + YCB-DEC-03 registry.
 *
 * Sabotage SAB-IDEM-DROP-CLAIM (procedure, run manually): remove the
 * claimYelpLead(companyId, inbound_pmid) guard (always run the turn). Then YCB-IDEM-01
 * turns RED — a re-ingested provider_message_id re-runs runTurn (a 2nd send). Named
 * check: IDEM-claim-at-most-once. Revert after confirming.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpConvoHandler.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockGetByConvId = jest.fn();
const mockUpdateState = jest.fn();
jest.mock('../backend/src/db/yelpConversationQueries', () => ({
    getByConvId: mockGetByConvId,
    getByConversationId: mockGetByConvId,
    getActiveByConversationId: jest.fn(),
    upsertConversation: jest.fn(),
    updateState: mockUpdateState,
    setPhaseStatus: jest.fn(),
}));

const mockClaimYelpLead = jest.fn();
const mockMarkReplied = jest.fn();
jest.mock('../backend/src/db/yelpLeadQueries', () => ({
    claimYelpLead: mockClaimYelpLead,
    markReplied: mockMarkReplied,
    releaseClaim: jest.fn(),
    markGreeted: jest.fn(),
    threadAlreadyGreeted: jest.fn(),
    getClaimByMessage: jest.fn(),
    attachLead: jest.fn(),
    attachTask: jest.fn(),
}));

// The Phase-B brain — mocked at the handler seam (its own loop is covered in
// tests/yelpConvoAgentLoop.test.js).
const mockRunTurn = jest.fn();
jest.mock('../backend/src/services/yelpConvoAgentService', () => ({ runTurn: mockRunTurn }));

// Prove Phase A does ZERO send/LLM work; drive processBatch for YCB-SAFE-02.
const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
const mockEmit = jest.fn();
jest.mock('../backend/src/services/eventBus', () => ({ emit: mockEmit }));

const agentHandlers = require('../backend/src/services/agentHandlers');
const agentWorker = require('../backend/src/services/agentWorker');
const { convTask, convRow, taskRow, CONV_ID, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.YELP_CONVO_ENABLED;                 // default: Phase A (brain OFF)
    mockGetByConvId.mockResolvedValue(convRow({ turn_count: 1 }));
    mockClaimYelpLead.mockResolvedValue({ claimed: true, id: 70 });
    mockUpdateState.mockResolvedValue(convRow({ turn_count: 2 }));
    mockRunTurn.mockResolvedValue({ outcome: 'reply' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════ PHASE A (brain OFF) — thin ack ═══════════════════════

describe('yelp_convo Phase-A ack — claim-first, record one turn (brain OFF)', () => {
    it('open conv + claimed → updateState(turn_count++, last_inbound) once, no send, no runTurn', async () => {
        const out = await agentHandlers.run(convTask());

        expect(mockClaimYelpLead).toHaveBeenCalledTimes(1);
        expect(mockClaimYelpLead).toHaveBeenCalledWith(DEFAULT_COMPANY_ID, 'ymsg-REPLY-1');
        expect(mockUpdateState).toHaveBeenCalledTimes(1);
        expect(mockUpdateState).toHaveBeenCalledWith(
            DEFAULT_COMPANY_ID, CONV_ID,
            expect.objectContaining({ turn_count: 2, last_inbound_message_id: 'ymsg-REPLY-1' }));
        expect(mockRunTurn).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(out).toMatchObject({ acked: true, phase_a: true, conversation_id: CONV_ID, turn_count: 2 });
    });
});

describe('YCB-IDEM-01 (Phase A) · IDEM-claim-at-most-once (SAB-IDEM-DROP-CLAIM)', () => {
    it('claim {claimed:false} → updateState NOT called, {skipped:already_handled_inbound}, no throw', async () => {
        mockClaimYelpLead.mockResolvedValue({ claimed: false });

        const out = await agentHandlers.run(convTask());

        expect(mockUpdateState).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(out).toMatchObject({ skipped: 'already_handled_inbound', conversation_id: CONV_ID });
    });
});

describe('yelp_convo · missing conversation row → soft no-op', () => {
    it('getByConvId → null → {skipped:no_conversation}, no claim, no updateState, no throw', async () => {
        mockGetByConvId.mockResolvedValue(null);

        const out = await agentHandlers.run(convTask());

        expect(mockClaimYelpLead).not.toHaveBeenCalled();
        expect(mockUpdateState).not.toHaveBeenCalled();
        expect(out).toMatchObject({ skipped: 'no_conversation', conversation_id: CONV_ID });
    });
});

describe('yelp_convo · claim store error is non-fatal', () => {
    it('claimYelpLead throws → {skipped:claim_error}, does not reject', async () => {
        mockClaimYelpLead.mockRejectedValue(new Error('ledger down'));

        const out = await agentHandlers.run(convTask());

        expect(out).toMatchObject({ skipped: 'claim_error' });
        expect(mockUpdateState).not.toHaveBeenCalled();
    });
});

// ═══════════════════════ PHASE B (brain ON) — real order ══════════════════════

describe('yelp_convo Phase-B — claim-first → runTurn → markReplied (brain ON)', () => {
    it('open + claimed → runTurn(companyId, conv, inbound) once; markReplied post-send; no thin ack', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';

        const out = await agentHandlers.run(convTask());

        // claim FIRST (before any turn work)
        expect(mockClaimYelpLead).toHaveBeenCalledTimes(1);
        expect(mockClaimYelpLead).toHaveBeenCalledWith(DEFAULT_COMPANY_ID, 'ymsg-REPLY-1');
        // the brain ran with the loaded conv + the inbound (body = untrusted data)
        expect(mockRunTurn).toHaveBeenCalledTimes(1);
        const [companyArg, convArg, inboundArg] = mockRunTurn.mock.calls[0];
        expect(companyArg).toBe(DEFAULT_COMPANY_ID);
        expect(convArg).toMatchObject({ conversation_id: CONV_ID });
        expect(inboundArg).toMatchObject({ provider_message_id: 'ymsg-REPLY-1' });
        // POST-SEND marker
        expect(mockMarkReplied).toHaveBeenCalledWith(DEFAULT_COMPANY_ID, 'ymsg-REPLY-1');
        expect(out).toMatchObject({ handled: true, conversation_id: CONV_ID, outcome: 'reply' });
    });

    it('claimed reply with no extracted content skips without running or sending', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';

        const out = await agentHandlers.run(convTask({
            agent_input: {
                conversation_id: CONV_ID,
                inbound_provider_message_id: 'ymsg-EMPTY-1',
                inbound_body_text: null,
            },
        }));

        expect(mockClaimYelpLead).toHaveBeenCalledWith(DEFAULT_COMPANY_ID, 'ymsg-EMPTY-1');
        expect(mockRunTurn).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockMarkReplied).not.toHaveBeenCalled();
        expect(out).toEqual({ skipped: 'no_reply_content', conversation_id: CONV_ID });
    });
});

describe('YCB-IDEM-01 [B] · claim {claimed:false} → NO runTurn, NO markReplied, no throw', () => {
    it('re-ingested inbound short-circuits at the claim (checked FIRST)', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockClaimYelpLead.mockResolvedValue({ claimed: false });

        const out = await agentHandlers.run(convTask());

        expect(mockRunTurn).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockMarkReplied).not.toHaveBeenCalled();
        expect(out).toMatchObject({ skipped: 'already_handled_inbound', conversation_id: CONV_ID });
    });
});

describe('YCB-IDEM-02 · crash after send-before-persist → at-most-once on re-run', () => {
    it('attempt1 sends + markReplied throws (swallowed); attempt2 claim=false → runTurn once total', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockClaimYelpLead.mockResolvedValueOnce({ claimed: true, id: 70 }).mockResolvedValueOnce({ claimed: false });
        mockMarkReplied.mockRejectedValueOnce(new Error('persist crash')); // swallowed → attempt1 still succeeds

        const out1 = await agentHandlers.run(convTask());   // attempt 1
        const out2 = await agentHandlers.run(convTask());   // attempt 2 (retry, same pmid)

        expect(mockRunTurn).toHaveBeenCalledTimes(1);        // never a 2nd turn/send
        expect(out1).toMatchObject({ handled: true });
        expect(out2).toMatchObject({ skipped: 'already_handled_inbound' });
    });
});

describe('YCB-IDEM-03 · only a sendEmail fault reaches the worker; other throws caught', () => {
    it('(a) runTurn resolves (safe reply) → handler resolves, no throw', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockRunTurn.mockResolvedValue({ outcome: 'reply', safe: true });

        await expect(agentHandlers.run(convTask())).resolves.toMatchObject({ handled: true });
    });
    it('(b) runTurn rejects (sendEmail fault) → handler REJECTS; inbound NOT markReplied', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockRunTurn.mockRejectedValue(new Error('SMTP 503'));

        await expect(agentHandlers.run(convTask())).rejects.toThrow(/SMTP 503/);
        expect(mockMarkReplied).not.toHaveBeenCalled();      // retry will re-attempt the send
    });
    it('(c) post-send markReplied throws → swallowed, task still succeeds', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockMarkReplied.mockRejectedValue(new Error('ledger blip'));

        await expect(agentHandlers.run(convTask())).resolves.toMatchObject({ handled: true });
    });
});

describe('YCB-SAFE-02 · a yelp_convo throw is contained by processBatch; sibling task unaffected', () => {
    it('runTurn throws (non-send) → that task hits the retry branch; the noop sibling succeeds; loop resolves', async () => {
        process.env.YELP_CONVO_ENABLED = 'true';
        mockRunTurn.mockRejectedValue(new Error('unexpected internal error'));
        // claim UPDATE returns a 2-task batch; every follow-up write returns empty.
        const batch = [convTask({ id: 1 }), taskRow({ id: 2, agent_type: 'noop', max_attempts: 1 })];
        mockQuery.mockImplementation(async (sql) =>
            /update tasks set agent_status\s*=\s*'running'/i.test(sql) ? { rows: batch } : { rows: [] });

        await expect(agentWorker.processBatch()).resolves.toBe(2); // loop did not crash

        const writes = mockQuery.mock.calls.filter(([sql]) =>
            /update tasks/i.test(sql) && !/agent_status\s*=\s*'running'/i.test(sql));
        // both tasks got a follow-up write: yelp_convo (re-queued, max_attempts=3) + noop (succeeded)
        expect(writes.length).toBe(2);
        expect(writes.some(([sql]) => /agent_status\s*=\s*'queued'/i.test(sql))).toBe(true);    // yelp_convo retry
        expect(writes.some(([sql]) => /agent_status\s*=\s*'succeeded'/i.test(sql))).toBe(true);  // noop sibling
    });
});

// ── YCB-DEC-03 · registry: yelp_convo added, yelp_lead intact, unknown still throws ──
describe('YCB-DEC-03 · shared registry — additive, existing types intact', () => {
    it('yelp_convo registered, yelp_lead still registered, unknown agent_type throws', async () => {
        expect(typeof agentHandlers.HANDLERS.yelp_convo).toBe('function');
        expect(typeof agentHandlers.HANDLERS.yelp_lead).toBe('function');
        await expect(agentHandlers.run({ agent_type: 'nope', agent_input: {} }))
            .rejects.toThrow(/Unknown agent_type/);
    });
});
