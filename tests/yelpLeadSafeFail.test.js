'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-002 — greeting SAFE-FAIL, re-homed onto the yelp_lead
 * HANDLER. The 001 inline-send safe-fail cases (YLA-S-01/02) are retired — the send
 * moved out of maybeHandleYelpLead into agentHandlers.HANDLERS.yelp_lead. Here
 * yelpGreetingService is REAL (so the deterministic static-fallback path is genuinely
 * exercised — the mocked handler suite mocks buildGreeting, so this is the ONLY place
 * the fallback is proven end-to-end), while the mailbox + ledger are mocked.
 *
 * The DETECTOR safe-fail (createLead throws → releaseClaim; enqueue throws → hold
 * claim; env/scope gate) is re-homed to tests/yelpLeadEnqueue.test.js (B-02..B-04).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadSafeFail.test.js \
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

const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/db/emailQueries', () => ({ getThreadingByProviderMessageId: jest.fn().mockResolvedValue(null) }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

// yelpGreetingService is REAL here → the static fallback is genuinely exercised.
const yelpGreetingService = require('../backend/src/services/yelpGreetingService');
const agentHandlers = require('../backend/src/services/agentHandlers');
const { taskRow, yelpInput, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const yelpTask = () =>
    taskRow({ agent_type: 'yelp_lead', company_id: DEFAULT_COMPANY_ID, agent_input: yelpInput() });

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GEMINI_API_KEY; // force the static fallback (no live Gemini)
    mockThreadAlreadyGreeted.mockResolvedValue(false);
    mockSendEmail.mockResolvedValue({ provider_message_id: 'sent-1' });
});

afterEach(() => jest.restoreAllMocks());

describe('YLA-S-01 (re-homed): Gemini unavailable → STATIC greeting still sent by the handler', () => {
    it('(a) buildGreeting resolves to a non-empty static string naming the customer + service', async () => {
        const text = await yelpGreetingService.buildGreeting({ name: 'Kim', service: 'dishwasher repair' });
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toEqual(expect.stringContaining('Kim'));
        expect(text.toLowerCase()).toEqual(expect.stringContaining('dishwasher'));
    });

    it('(b) handler end-to-end: the static greeting is sent exactly once to the relay', async () => {
        const out = await agentHandlers.run(yelpTask());

        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [company, args] = mockSendEmail.mock.calls[0];
        expect(company).toBe(DEFAULT_COMPANY_ID);
        expect(args.to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        expect(args.body).toEqual(expect.stringContaining('Kim')); // real static body
        expect(mockMarkGreeted).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'greeted' }));
        expect(out).toMatchObject({ greeted: true, lead_id: 55 });
    });
});

describe('YLA-S-02 (re-homed): Gemini transport error → buildGreeting falls back, never throws', () => {
    it('a dead Gemini fetch still yields the static template (the handler never sees a throw from buildGreeting)', async () => {
        process.env.GEMINI_API_KEY = 'test-key'; // take the Gemini path…
        const origFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('network dead')); // …then kill it
        try {
            const text = await yelpGreetingService.buildGreeting({ name: 'Kim', service: 'dishwasher repair' });
            expect(text).toEqual(expect.stringContaining('Kim'));
            expect(text.toLowerCase()).toEqual(expect.stringContaining('dishwasher'));
        } finally {
            global.fetch = origFetch;
            delete process.env.GEMINI_API_KEY;
        }
    });
});
