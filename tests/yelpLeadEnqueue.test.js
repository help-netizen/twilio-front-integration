'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-002 — DETECTOR ENQUEUES (does not greet), mocked.
 * Target: yelpLeadService.maybeHandleYelpLead. The detector creates the lead and
 * ENQUEUES one yelp_lead agent task; the greeting now lives in the handler
 * (tests/yelpLeadHandler.test.js). Re-homes the retired 001 YLA-H-01/02 + YLA-S-*.
 * Covers B-01..B-04 + the B1 reconcile of a lost greeting task.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadEnqueue.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockCreateLead = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));

const mockClaimYelpLead = jest.fn();
const mockReleaseClaim = jest.fn();
const mockGetClaimByMessage = jest.fn();
const mockAttachLead = jest.fn();
const mockAttachTask = jest.fn();
jest.mock('../backend/src/db/yelpLeadQueries', () => ({
    claimYelpLead: mockClaimYelpLead,
    releaseClaim: mockReleaseClaim,
    getClaimByMessage: mockGetClaimByMessage,
    attachLead: mockAttachLead,
    attachTask: mockAttachTask,
    markGreeted: jest.fn(),          // detector must NOT use these (moved to handler)
    threadAlreadyGreeted: jest.fn(),
}));

// Spies to PROVE the ingest path does zero LLM/SMTP work.
const mockSendEmail = jest.fn();
const mockBuildGreeting = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));

const { maybeHandleYelpLead, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

const taskInserts = () => mockQuery.mock.calls.filter(([sql]) => /insert into tasks/i.test(sql));

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    // Enqueue INSERT → a task id; every other db.query → empty.
    mockQuery.mockImplementation(async (sql) =>
        /insert into tasks/i.test(sql) ? { rows: [{ id: 900 }] } : { rows: [] }
    );
    mockClaimYelpLead.mockResolvedValue({ claimed: true, id: 7 });
    mockCreateLead.mockResolvedValue({ UUID: 'u', SerialId: 1001, ClientId: '55' });
});

// ── B-01 · DETECTOR-no-send-in-ingest (P0, req #4) ────────────────────────────
describe('B-01 · DETECTOR-no-send-in-ingest (SAB-DETECTOR-STILL-GREETS)', () => {
    it('detect → createLead once + ONE agent-task INSERT; NO sendEmail / buildGreeting', async () => {
        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        // (1) exactly one lead, correctly shaped, company-scoped
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        const [fields, companyArg] = mockCreateLead.mock.calls[0];
        expect(fields).toMatchObject({ JobSource: 'Yelp', Status: 'Submitted', FirstName: 'Kim' });
        expect(companyArg).toBe(DEFAULT_COMPANY_ID);

        // (2) exactly one INSERT INTO tasks with the enqueue contract
        const inserts = taskInserts();
        expect(inserts).toHaveLength(1);
        const [sql, params] = inserts[0];
        expect(sql).toMatch(/kind/i);
        expect(sql).toMatch(/'agent'/);
        expect(sql).toMatch(/'yelp_lead'/);
        expect(sql).toMatch(/'queued'/);
        expect(sql).toMatch(/'queued',\s*3\s*,/);   // agent_status='queued', max_attempts LITERAL 3
        expect(sql).toMatch(/'lead'/);              // subject_type
        expect(params[3]).toBe(55);                 // lead_id param
        const input = JSON.parse(params[1]);        // agent_input jsonb
        expect(input).toMatchObject({
            claim_id: 7,
            reply_to: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
            thread_token: '8160b36a1c2d3e4f',
            service_type: 'dishwasher repair',
            zip: '02467',
            lead_id: 55,
        });
        expect(input.problem_text).toEqual(expect.stringContaining('Maytag'));

        // (3) the ingest thread does ZERO LLM/SMTP work
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockBuildGreeting).not.toHaveBeenCalled();

        // (4) handled signal (short-circuits the Mail Secretary)
        expect(r).toMatchObject({ handled: true, skipped: 'yelp_lead' });
    });
});

// ── B-02 · lead-at-least-once: createLead throws → releaseClaim, NO enqueue ────
describe('B-02 · lead-at-least-once (createLead throws)', () => {
    it('does not throw; releaseClaim(7) once; NO task enqueued; handled sentinel', async () => {
        mockCreateLead.mockRejectedValue(new Error('DB down'));

        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(mockReleaseClaim).toHaveBeenCalledTimes(1);
        expect(mockReleaseClaim).toHaveBeenCalledWith(7);
        expect(taskInserts()).toHaveLength(0);
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(r).toEqual({ handled: true, skipped: 'yelp_lead', reason: 'lead_create_failed' });
    });
});

// ── B-03 · enqueue INSERT throws AFTER the lead exists → hold claim (no dup lead) ──
describe('B-03 · enqueue failure after a committed lead', () => {
    it('does not throw; releaseClaim NOT called; error logged; handled sentinel', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/insert into tasks/i.test(sql)) throw new Error('tasks INSERT failed');
            return { rows: [] };
        });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        // releasing the claim would let a re-poll create a SECOND lead → must NOT release
        expect(mockReleaseClaim).not.toHaveBeenCalled();
        expect(errSpy).toHaveBeenCalled();
        expect(r).toMatchObject({ handled: true, skipped: 'yelp_lead' });
        errSpy.mockRestore();
    });
});

// ── B-04 · env gate OFF / non-default company → total no-op (P1, req #11) ──────
describe('B-04 · gate + tenant scope', () => {
    it('gate OFF → {handled:false} without claim/createLead/enqueue/greet', async () => {
        process.env.YELP_AUTORESPONDER_ENABLED = 'false';

        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(r).toEqual({ handled: false });
        expect(mockClaimYelpLead).not.toHaveBeenCalled();
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(taskInserts()).toHaveLength(0);
        expect(mockBuildGreeting).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('gate ON but non-default company → {handled:false}, no side effects', async () => {
        process.env.YELP_AUTORESPONDER_ENABLED = 'true';

        const r = await maybeHandleYelpLead('22222222-2222-2222-2222-222222222222', yNew());

        expect(r).toEqual({ handled: false });
        expect(mockClaimYelpLead).not.toHaveBeenCalled();
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(taskInserts()).toHaveLength(0);
    });
});

// ── B1 reconcile: lost greeting task (task_id NULL, greeted_at NULL) re-enqueued ──
describe('B1 reconcile — a claimed-but-never-enqueued row re-enqueues on re-ingest', () => {
    it('claim lost + row task_id NULL & greeted_at NULL & lead_id set → re-enqueue ONE task, NO 2nd lead', async () => {
        mockClaimYelpLead.mockResolvedValue({ claimed: false }); // re-ingest lost the claim
        mockGetClaimByMessage.mockResolvedValue({
            id: 7, lead_id: 55, task_id: null, greeted_at: null, status: 'claimed',
            thread_token: '8160b36a1c2d3e4f',
        });

        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(mockCreateLead).not.toHaveBeenCalled();          // never a 2nd lead
        const inserts = taskInserts();
        expect(inserts).toHaveLength(1);                        // exactly one re-enqueue
        const [, params] = inserts[0];
        const input = JSON.parse(params[1]);
        expect(input).toMatchObject({ claim_id: 7, lead_id: 55, service_type: 'dishwasher repair' });
        expect(mockAttachTask).toHaveBeenCalled();              // task_id re-stamped
        expect(r).toMatchObject({ handled: true, skipped: 'yelp_lead', reason: 'reconciled_enqueue' });
    });

    it('claim lost but row already enqueued (task_id set) → NO re-enqueue, already_claimed', async () => {
        mockClaimYelpLead.mockResolvedValue({ claimed: false });
        mockGetClaimByMessage.mockResolvedValue({
            id: 7, lead_id: 55, task_id: 900, greeted_at: null, status: 'claimed',
            thread_token: '8160b36a1c2d3e4f',
        });

        const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(taskInserts()).toHaveLength(0);
        expect(mockCreateLead).not.toHaveBeenCalled();
        expect(r).toMatchObject({ handled: true, skipped: 'yelp_lead', reason: 'already_claimed' });
    });
});
