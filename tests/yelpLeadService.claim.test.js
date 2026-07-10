'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — IDEMPOTENT CLAIM, unit (YLA-C-01, YLA-C-04).
 *   YLA-C-01: claim SQL is INSERT … ON CONFLICT DO NOTHING RETURNING; params
 *             company-scoped; first wins, second no-ops (db.query stubbed).
 *   YLA-C-04: claim runs BEFORE createLead/greet/send; a LOST claim makes ZERO
 *             of them (ordering via mock.invocationCallOrder).
 *
 * NOTE (R3): the claim runs BEFORE parse, so thread_token is unknown at claim time
 * and binds as null → params are [companyId, pmid, null]. The company+pmid binding
 * (the load-bearing, tenant-safe part) is asserted via params.slice(0,2).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadService.claim.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

// Collaborators mocked as spies for the ordering test.
const mockCreateLead = jest.fn();
const mockBuildGreeting = jest.fn();
const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));

const yelpLeadQueries = require('../backend/src/db/yelpLeadQueries');
const { maybeHandleYelpLead, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

const COMPANY = DEFAULT_COMPANY_ID;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.GEMINI_API_KEY; // greeting builder is mocked anyway
});

describe('claimYelpLead — SQL shape + idempotency (YLA-C-01, P0)', () => {
    it('claim SQL is INSERT … ON CONFLICT (company_id, provider_message_id) DO NOTHING RETURNING', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // first claim wins
            .mockResolvedValueOnce({ rows: [] });         // second no-ops

        const first = await yelpLeadQueries.claimYelpLead(COMPANY, 'ymsg-NEW-1');
        const second = await yelpLeadQueries.claimYelpLead(COMPANY, 'ymsg-NEW-1');

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/insert into yelp_lead_events/i);
        expect(sql).toMatch(/on conflict\s*\(\s*company_id\s*,\s*provider_message_id\s*\)\s*do nothing/i);
        expect(sql).toMatch(/returning/i);
        // Company + pmid binding (tenant-safe) — 3rd bind is the null thread_token.
        expect(params.slice(0, 2)).toEqual([COMPANY, 'ymsg-NEW-1']);
        expect(params[2]).toBeNull();

        expect(first).toEqual({ claimed: true, id: 1 });
        expect(second).toEqual({ claimed: false });
    });
});

describe('claim-before-create ordering (YLA-C-04, P1)', () => {
    it('LOST claim → createLead, buildGreeting, sendEmail each NOT called', async () => {
        // INSERT returns no row → claim lost. Any other query returns empty.
        mockQuery.mockImplementation(async (sql) =>
            /insert into yelp_lead_events/i.test(sql) ? { rows: [] } : { rows: [] }
        );

        const res = await maybeHandleYelpLead(COMPANY, yNew());

        expect(res).toEqual({ handled: true, skipped: 'yelp_lead', reason: 'already_claimed' });
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(mockBuildGreeting).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('WON claim → the claim db.query fires BEFORE the first createLead call', async () => {
        mockQuery.mockImplementation(async (sql) =>
            /insert into yelp_lead_events/i.test(sql) ? { rows: [{ id: 42 }] } : { rows: [] }
        );
        mockCreateLead.mockResolvedValue({ UUID: 'lead-uuid', SerialId: 1001, ClientId: '55' });
        mockBuildGreeting.mockResolvedValue('Hi Kim, ...');
        mockSendEmail.mockResolvedValue({ provider_message_id: 'sent-1' });

        await maybeHandleYelpLead(COMPANY, yNew());

        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        const claimOrder = mockQuery.mock.invocationCallOrder[0];
        const createOrder = mockCreateLead.mock.invocationCallOrder[0];
        expect(claimOrder).toBeLessThan(createOrder);
    });
});
