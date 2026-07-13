'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-002 — yelp_lead HANDLER (greets + closes, retry-safe).
 * Target: agentHandlers.HANDLERS.yelp_lead via agentHandlers.run(task). The send +
 * greeting assertions RE-HOMED from the retired 001 YLA-H/YLA-S inline-send cases.
 * Covers C-01..C-05.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadHandler.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockThreadAlreadyGreeted = jest.fn();
const mockMarkGreeted = jest.fn();
jest.mock('../backend/src/db/yelpLeadQueries', () => ({
    threadAlreadyGreeted: mockThreadAlreadyGreeted,
    markGreeted: mockMarkGreeted,
    claimYelpLead: jest.fn(),
    releaseClaim: jest.fn(),
    getClaimByMessage: jest.fn(),
    attachLead: jest.fn(),
    attachTask: jest.fn(),
}));

const mockBuildGreeting = jest.fn();
const mockSendEmail = jest.fn();
const mockGetThreading = jest.fn();
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/db/emailQueries', () => ({ getThreadingByProviderMessageId: mockGetThreading }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const agentHandlers = require('../backend/src/services/agentHandlers');
const { taskRow, yelpInput, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const yelpTask = (inputOverrides = {}) =>
    taskRow({ agent_type: 'yelp_lead', company_id: DEFAULT_COMPANY_ID, agent_input: yelpInput(inputOverrides) });

beforeEach(() => {
    jest.clearAllMocks();
    mockThreadAlreadyGreeted.mockResolvedValue(false);
    mockBuildGreeting.mockResolvedValue('Hi Kim, ...');
    mockSendEmail.mockResolvedValue({ provider_message_id: '<sent-x>' });
    mockGetThreading.mockResolvedValue({
        message_id_header: '<20260711.abc@messaging.yelp.com>',
        provider_thread_id: 'gmail-thread-99',
        subject: 'You have a new dishwasher repair request',
        // quote fields (YELP-REPLY-FORMAT-001): the greeting must embed the quoted original
        body_text: 'Kim requested a quote from ABC Homes for a dishwasher repair.',
        body_html: null,
        from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
        from_name: 'Yelp Inbox',
        gmail_internal_at: '2026-07-11T21:39:23.000Z',
    });
});

// ── C-01 · HANDLER-sends-once (P0, req #5) ────────────────────────────────────
describe('C-01 · HANDLER-sends-once (SAB-HANDLER-SKIP-SEND)', () => {
    it('reply_to present + not-yet-greeted → buildGreeting → ONE sendEmail(to=reply_to) → markGreeted', async () => {
        const out = await agentHandlers.run(yelpTask());

        // (1) greeting built with the PARSED context
        expect(mockBuildGreeting).toHaveBeenCalledTimes(1);
        expect(mockBuildGreeting).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Kim',
                service: 'dishwasher repair',
                problem: expect.stringContaining('Maytag'),
            })
        );
        // (2) exactly one send, to the relay reply address, from the task's company
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [company, args] = mockSendEmail.mock.calls[0];
        expect(company).toBe(DEFAULT_COMPANY_ID);
        expect(args.to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        expect(args.body).toContain('Hi Kim, ...');
        expect(String(args.subject || '')).not.toHaveLength(0);
        // (2b) YELP reply-threading — the reply carries In-Reply-To/References (the
        //      inbound Message-ID) + the Gmail thread, else Yelp bounces it. The
        //      threading is looked up by the inbound provider_message_id + company.
        expect(mockGetThreading).toHaveBeenCalledWith('ymsg-NEW-1', DEFAULT_COMPANY_ID);
        expect(args.inReplyTo).toBe('<20260711.abc@messaging.yelp.com>');
        expect(args.references).toBe('<20260711.abc@messaging.yelp.com>');
        expect(args.threadId).toBe('gmail-thread-99');
        // (2c) YELP-REPLY-FORMAT-001 — the parser also needs the Gmail-style QUOTED
        //      ORIGINAL (multipart/alternative + "… wrote:" + "> " lines) or the
        //      greeting bounces cant_parse (proven on prod, thread "Ryan P.").
        expect(args.textBody).toMatch(/wrote:/);
        expect(args.textBody).toContain('> Kim requested a quote from ABC Homes');
        expect(args.body).toContain('gmail_quote');
        // (3) markGreeted stamps the ledger
        expect(mockMarkGreeted).toHaveBeenCalledTimes(1);
        expect(mockMarkGreeted).toHaveBeenCalledWith(7, expect.objectContaining({
            status: 'greeted',
            greetingProviderMessageId: '<sent-x>',
            leadId: 55,
            threadToken: '8160b36a1c2d3e4f',
        }));
        // (4) success output → worker will stamp succeeded
        expect(out).toMatchObject({ greeted: true, lead_id: 55 });
    });
});

// ── C-02 · HANDLER-no-double-send (P0, req #6) ────────────────────────────────
describe('C-02 · HANDLER-no-double-send (SAB-DROP-GREETED-GUARD)', () => {
    it('re-run after a prior greeting → threadAlreadyGreeted(true) → NO 2nd sendEmail, no throw', async () => {
        mockThreadAlreadyGreeted.mockResolvedValue(true);

        const out = await agentHandlers.run(yelpTask());

        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockBuildGreeting).not.toHaveBeenCalled();
        expect(out).toMatchObject({ skipped: 'already_greeted' });
    });
});

// ── C-03 · no reply_to → handled_no_send, NOT an error (P1, req #7) ────────────
describe('C-03 · no reply_to → handled_no_send', () => {
    it('markGreeted(handled_no_send), NO sendEmail, resolves (never throws / retries)', async () => {
        const out = await agentHandlers.run(yelpTask({ reply_to: null, thread_token: null }));

        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockBuildGreeting).not.toHaveBeenCalled();
        expect(mockMarkGreeted).toHaveBeenCalledTimes(1);
        expect(mockMarkGreeted).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'handled_no_send' }));
        expect(out).toMatchObject({ skipped: 'no_reply_to' });
    });
});

// ── C-04 · transient send failure → handler THROWS so the worker retries (P1) ──
describe('C-04 · transient send failure → rethrow (drives the retry)', () => {
    it('sendEmail throws → run() rejects; thread NOT marked greeted (next attempt re-sends)', async () => {
        mockSendEmail.mockRejectedValue(new Error('SMTP 503'));

        await expect(agentHandlers.run(yelpTask())).rejects.toThrow(/SMTP 503/);

        // nothing recorded as greeted for a failed attempt → the guard stays false on retry
        const greetedCalls = mockMarkGreeted.mock.calls.filter(([, o]) => o && o.status === 'greeted');
        expect(greetedCalls).toHaveLength(0);
    });
});

// ── C-05 · registry wiring (P2) ───────────────────────────────────────────────
describe('C-05 · registry', () => {
    it('yelp_lead is registered; an unknown agent_type still throws', async () => {
        expect(typeof agentHandlers.HANDLERS.yelp_lead).toBe('function');
        await expect(agentHandlers.run({ agent_type: 'nope', agent_input: {} }))
            .rejects.toThrow(/Unknown agent_type/);
    });
});
