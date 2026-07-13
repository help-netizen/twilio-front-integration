'use strict';

/**
 * YELP-CALL-TASK-001 — a NEW Yelp lead (first message ONLY) puts a dispatcher
 * "call the customer if a phone number is available" task on the lead's conv-id
 * Pulse timeline (thread_id → AR bar) with the lead as subject. Yelp's relay email
 * carries no phone and Phase-1b extraction is parked — the task is the human
 * touchpoint (check Yelp Business, call if a number shows).
 *
 * NAMED SABOTAGE SAB-CALLTASK-ON-REPLY: move the createYelpCallTask hook from
 * maybeHandleYelpLead into the reply path (or call it in both) → YCT-03 turns RED
 * (a mid-conversation customer reply must NOT spawn another call task).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpCallTask.test.js \
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
    threadAlreadyGreeted: jest.fn(),
}));

// The task write seam (MAIL-AGENT pattern): thread-attached dispatcher task.
const mockTlCreateTask = jest.fn();
jest.mock('../backend/src/db/timelinesQueries', () => ({ createTask: mockTlCreateTask }));

// Ingest path must do zero LLM/SMTP work regardless.
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: jest.fn() }));

const svc = require('../backend/src/services/yelpLeadService');
const { yNew, yReplyRespondable, CONV_ID, DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const TIMELINE_ID = 3213;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.YELP_CONVO_ENABLED; // greeter switch irrelevant here
    mockQuery.mockImplementation(async (sql) => {
        if (/from timelines/i.test(sql)) return { rows: [{ id: TIMELINE_ID }] }; // conv-id → timeline
        if (/insert into tasks/i.test(sql)) return { rows: [{ id: 900 }] };      // greeter enqueue
        return { rows: [] };
    });
    mockClaimYelpLead.mockResolvedValue({ claimed: true, id: 7 });
    mockCreateLead.mockResolvedValue({ UUID: 'u1', SerialId: 1001, ClientId: '55' });
    mockTlCreateTask.mockResolvedValue({ id: 4242 });
});

describe('YCT-01 · NEW lead → ONE call-task on the conv-id timeline, lead as subject', () => {
    it('createTask({threadId, subjectType:lead, title "Call … phone…", p1, created_by agent})', async () => {
        const out = await svc.maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(out).toMatchObject({ handled: true });
        expect(mockTlCreateTask).toHaveBeenCalledTimes(1);
        const arg = mockTlCreateTask.mock.calls[0][0];
        expect(arg.companyId).toBe(DEFAULT_COMPANY_ID);
        expect(arg.threadId).toBe(TIMELINE_ID);
        expect(arg.subjectType).toBe('lead');
        expect(arg.subjectId).toBe(55);
        expect(arg.title).toMatch(/^Call /);
        expect(arg.title).toMatch(/phone number/i);
        expect(arg.title).toMatch(/Yelp/);
        expect(arg.priority).toBe('p1');
        expect(arg.createdBy).toBe('agent');
        // NEVER a queued agent-work task — the agentWorker must not claim it.
        expect(arg.agentStatus).toBeUndefined();
        // the timeline was resolved by the STABLE conv-id, company-scoped
        const tlSelect = mockQuery.mock.calls.find(([sql]) => /from timelines/i.test(sql));
        expect(tlSelect[1]).toEqual([DEFAULT_COMPANY_ID, CONV_ID]);
    });
});

describe('YCT-02 · call-task fault is non-fatal (fail-open)', () => {
    it('createTask throws → lead still created, greeter still enqueued, handled', async () => {
        mockTlCreateTask.mockRejectedValue(new Error('tasks table on fire'));

        const out = await svc.maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(out).toMatchObject({ handled: true, leadId: 55 });
        // greeter enqueue still happened (the raw INSERT INTO tasks)
        const greeterInserts = mockQuery.mock.calls.filter(([sql]) => /insert into tasks/i.test(sql));
        expect(greeterInserts).toHaveLength(1);
    });
});

describe('YCT-03 · customer REPLY (not a new lead) → NO call-task (SAB-CALLTASK-ON-REPLY)', () => {
    it('maybeHandleYelpReply never creates the call task', async () => {
        await svc.maybeHandleYelpReply(DEFAULT_COMPANY_ID, yReplyRespondable());
        expect(mockTlCreateTask).not.toHaveBeenCalled();
    });
});

describe('YCT-04 · no conv-id timeline resolved → skip silently', () => {
    it('timelines SELECT empty → no createTask, flow unaffected', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/insert into tasks/i.test(sql)) return { rows: [{ id: 900 }] };
            return { rows: [] }; // timelines SELECT → empty
        });

        const out = await svc.maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew());

        expect(out).toMatchObject({ handled: true });
        expect(mockTlCreateTask).not.toHaveBeenCalled();
    });
});
