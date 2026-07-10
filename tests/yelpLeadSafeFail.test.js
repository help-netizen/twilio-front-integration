'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — SAFE-FAIL (YLA-S-01..05). maybeHandleYelpLead
 * NEVER throws; LLM/DB/relay failures never lose the lead or crash ingest.
 *
 * yelpGreetingService is REAL here (so the static-fallback path is genuinely
 * exercised); leadsService + emailService are spies; the DB seam is mocked.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadSafeFail.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockCreateLead = jest.fn();
const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));

const yelpGreetingService = require('../backend/src/services/yelpGreetingService');
const { maybeHandleYelpLead, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.GEMINI_API_KEY; // force the Gemini path to be skipped → static
    // Default: claim wins; threadAlreadyGreeted / markGreeted / releaseClaim → empty.
    mockQuery.mockImplementation(async (sql) =>
        /insert into yelp_lead_events/i.test(sql) ? { rows: [{ id: 9 }] } : { rows: [] }
    );
    mockCreateLead.mockResolvedValue({ UUID: 'u', SerialId: 1, ClientId: '55' });
    mockSendEmail.mockResolvedValue({ provider_message_id: 'sent-1' });
});

afterEach(() => {
    jest.restoreAllMocks(); // restore any spyOn(yelpGreetingService, ...)
});

describe('YLA-S-01: Gemini unavailable → STATIC greeting still sent + lead created (P1)', () => {
    it('(a) buildGreeting resolves to a non-empty static string naming the customer + service', async () => {
        const text = await yelpGreetingService.buildGreeting({ name: 'Kim', service: 'dishwasher repair' });
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toEqual(expect.stringContaining('Kim'));
        expect(text.toLowerCase()).toEqual(expect.stringContaining('dishwasher'));
    });

    it('(b) integration: lead created once + static greeting sent once', async () => {
        await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [, sendArgs] = mockSendEmail.mock.calls[0];
        expect(sendArgs.body).toEqual(expect.stringContaining('Kim'));
    });
});

describe('YLA-S-02: greeting builder throws entirely → never-throws, lead still created (P1)', () => {
    it('maybeHandleYelpLead resolves; createLead still called once', async () => {
        jest.spyOn(yelpGreetingService, 'buildGreeting').mockRejectedValue(new Error('both paths dead'));
        await expect(maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew())).resolves.toBeTruthy();
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
    });
});

describe('YLA-S-03: createLead throws → logged, claim released, ingest not crashed (P1, GAP#2)', () => {
    it('resolves to a handled sentinel; releaseClaim (DELETE) fired; no sendEmail', async () => {
        mockCreateLead.mockRejectedValue(new Error('DB down'));

        const res = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        // committed to the Yelp branch this cycle (does not fall through mid-way)…
        expect(res).toEqual({ handled: true, skipped: 'yelp_lead', reason: 'lead_create_failed' });
        // …but the claim was RELEASED so the next poll re-attempts (lead at-least-once).
        const deleteCall = mockQuery.mock.calls.find(([sql]) => /delete from yelp_lead_events/i.test(sql));
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[1]).toEqual([9]);
        // nothing was sent.
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

describe('YLA-S-04: absent/mangled relay From → BAIL, NO sendEmail (P1)', () => {
    it('lead created, but no send to a null relay; never throws', async () => {
        // messaging.yelp.com (still DETECTED) but no reply+<hex> → reply_to null.
        const msg = yNew({ from_email: 'noreply@messaging.yelp.com' });

        const res = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, msg);

        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ handled: true, skipped: 'yelp_lead', greeted: false });
    });
});

describe('YLA-S-05: env gate OFF → no-op; email flows to the normal pipeline (P1)', () => {
    it('returns not-handled without claiming/creating/sending', async () => {
        process.env.YELP_AUTORESPONDER_ENABLED = 'false';

        const res = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(res).toEqual({ handled: false });
        expect(mockQuery).not.toHaveBeenCalled();   // no claim attempted
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('non-default company → no-op even with the gate ON', async () => {
        process.env.YELP_AUTORESPONDER_ENABLED = 'true';
        const res = await maybeHandleYelpLead('00000000-0000-0000-0000-0000000000ff', yNew());
        expect(res).toEqual({ handled: false });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockCreateLead).not.toHaveBeenCalled();
    });
});
