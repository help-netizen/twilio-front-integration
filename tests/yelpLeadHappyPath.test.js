'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — HAPPY PATH (YLA-H-01, YLA-H-02).
 * Full pipeline with collaborators stubbed: won claim → ONE lead (JobSource='Yelp')
 * + ONE greeting to the relay; parsed detail reaches the lead body and the greeting.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadHappyPath.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockCreateLead = jest.fn();
const mockBuildGreeting = jest.fn();
const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));

const { maybeHandleYelpLead, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

const GREETING = 'Hi Kim, thanks for reaching out about your dishwasher. What is the best number to reach you?';

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.GEMINI_API_KEY;
    // claim INSERT → won; every other query (threadAlreadyGreeted, markGreeted) → empty.
    mockQuery.mockImplementation(async (sql) =>
        /insert into yelp_lead_events/i.test(sql) ? { rows: [{ id: 7 }] } : { rows: [] }
    );
    mockCreateLead.mockResolvedValue({ UUID: 'lead-uuid', SerialId: 1001, ClientId: '55' });
    mockBuildGreeting.mockResolvedValue(GREETING);
    mockSendEmail.mockResolvedValue({ provider_message_id: '<sent-x>' });
});

describe('maybeHandleYelpLead — happy path (P0/P1)', () => {
    it('YLA-H-01: ONE lead (JobSource=Yelp) + ONE greeting to the relay; handled signal', async () => {
        const res = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        // --- exactly one lead, correctly shaped ---
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        const [fields, companyArg] = mockCreateLead.mock.calls[0];
        expect(fields).toMatchObject({
            JobSource: 'Yelp',
            Status: 'Submitted',
            FirstName: 'Kim',
        });
        expect(fields.Phone).toBeFalsy(); // no phone in Phase 1a
        expect(fields.Comments).toEqual(expect.stringContaining('dishwasher repair'));
        expect(fields.Comments).toEqual(expect.stringContaining('Maytag'));
        expect(companyArg).toBe(DEFAULT_COMPANY_ID);

        // --- exactly one greeting, sent to the relay reply address ---
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [sendCompany, sendArgs] = mockSendEmail.mock.calls[0];
        expect(sendCompany).toBe(DEFAULT_COMPANY_ID);
        expect(sendArgs.to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        expect(sendArgs.body).toBe(GREETING);
        expect(String(sendArgs.subject || '')).not.toHaveLength(0);

        // --- handled signal ---
        expect(res).toMatchObject({ handled: true, skipped: 'yelp_lead', greeted: true });
    });

    it('YLA-H-02: parsed detail reaches the lead body and the greeting target', async () => {
        await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        // Lead body reflects zip + problem text.
        const [fields] = mockCreateLead.mock.calls[0];
        expect(fields.PostalCode).toBe('02467');
        expect(fields.Comments).toEqual(expect.stringContaining('02467'));
        expect(fields.Comments).toEqual(expect.stringContaining('mid cycle'));

        // buildGreeting saw the PARSED context, not the raw email.
        expect(mockBuildGreeting).toHaveBeenCalledTimes(1);
        expect(mockBuildGreeting).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Kim', service: 'dishwasher repair' })
        );

        // send target equals the parsed reply_to.
        const [, sendArgs] = mockSendEmail.mock.calls[0];
        expect(sendArgs.to).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
    });
});
