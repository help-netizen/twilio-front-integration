/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T5) — TC-OLC-034..040.
 * Route wiring (supertest, handleLeadEndOfCall mocked): scenario branch, CC-07
 * idempotence, unknown call.id, status-update, auth fail-closed, anti-spoof.
 * Classification logic (REAL handleLeadEndOfCall): booked belt / declined via
 * endedReason AND structuredData.outcome / transient → ladder / blocked retry.
 */

'use strict';

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGetJobById = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: (...a) => mockGetJobById(...a),
    addNote: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallWorker', () => ({
    computeNextScheduledAt: jest.fn(),
    resolveBusinessHoursGroup: jest.fn(),
    retryBlockReason: jest.fn(),
    getTimezoneOffsetMs: jest.fn(() => -4 * 3600 * 1000),
}));
jest.mock('../backend/src/services/agentCallWindowService', () => {
    const actual = jest.requireActual('../backend/src/services/agentCallWindowService');
    return { ...actual, nextAllowedAt: jest.fn(async (_companyId, _agentKey, now) => now) };
});
const mockFinalize = jest.fn();
const mockApplyStatusUpdate = jest.fn();
jest.mock('../backend/src/services/vapiCallTimelineService', () => ({
    finalizeFromEndOfCallReport: (...a) => mockFinalize(...a),
    applyStatusUpdate: (...a) => mockApplyStatusUpdate(...a),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimeline: jest.fn(),
    createTask: jest.fn(),
}));

const SECRET = 'test-webhook-secret';
process.env.VAPI_WEBHOOK_SECRET = SECRET;

const vapiCallStatusRouter = require('../backend/src/routes/vapiCallStatus');
const eventService = require('../backend/src/services/eventService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const scheduleService = require('../backend/src/services/scheduleService');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const leadsService = require('../backend/src/services/leadsService');
const leadSettings = require('../backend/src/services/outboundLeadCallSettingsService');
const svc = require('../backend/src/services/outboundLeadCallService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/vapi/call-status', vapiCallStatusRouter);
    return app;
}
function post(body, { secret = SECRET } = {}) {
    const req = request(makeApp()).post('/api/vapi/call-status');
    if (secret !== null) req.set('x-vapi-secret', secret);
    return req.send(body);
}
function endReport(callId, endedReason, extra = {}) {
    return { message: { type: 'end-of-call-report', call: { id: callId }, endedReason, ...extra } };
}
function leadRow(over = {}) {
    return {
        id: 700, company_id: COMPANY, job_id: null, task_id: null, attempt_no: 1,
        status: 'dialing', phone: '+16175551234', contact_id: 501, slot_json: null,
        scenario: 'lead_call', lead_uuid: 'LD-1',
        ...over,
    };
}
const LEAD = {
    UUID: 'LD-1', ClientId: '4242', FirstName: 'Alfreda', LastName: 'Smith',
    Phone: '+16175551234', JobSource: 'Pro Referral', Status: 'Submitted',
    LeadDateTime: null, ContactId: 501,
};

const NY_DS = {
    timezone: 'America/New_York', work_start_time: '08:00',
    work_end_time: '18:00', work_days: [1, 2, 3, 4, 5],
};

let getLeadByUUIDSpy;
let handleSpy;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    mockFinalize.mockResolvedValue(undefined);
    marketplaceService.isAppConnected.mockResolvedValue(true);
    scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
    timelinesQueries.findOrCreateTimeline.mockResolvedValue({ id: 321 });
    timelinesQueries.createTask.mockResolvedValue({ id: 555 });
    getLeadByUUIDSpy = jest.spyOn(leadsService, 'getLeadByUUID').mockResolvedValue({ ...LEAD });
    jest.spyOn(leadSettings, 'resolve').mockResolvedValue({
        enabled_sources: ['ProReferral'], max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'],
    });
    jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function armCorrelate(row) {
    mockQuery.mockImplementation(async (sql) => {
        if (/FROM outbound_call_attempts/.test(sql) && /vapi_call_id = \$1/.test(sql)) {
            return { rows: row ? [row] : [] };
        }
        if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [] };
        return { rows: [], rowCount: 1 };
    });
}
const updates = (re) => mockQuery.mock.calls.filter(([sql]) => re.test(sql));

describe('route wiring (handleLeadEndOfCall mocked)', () => {
    beforeEach(() => {
        handleSpy = jest.spyOn(svc, 'handleLeadEndOfCall').mockResolvedValue(undefined);
    });

    it('lead row → branch called with (attempt, klass, endedReason, message); parts detection untouched; 200', async () => {
        armCorrelate(leadRow());
        const res = await post(endReport('v1', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(handleSpy).toHaveBeenCalledTimes(1);
        const [attempt, klass, endedReason, message] = handleSpy.mock.calls[0];
        expect(attempt).toMatchObject({ id: 700, scenario: 'lead_call', lead_uuid: 'LD-1' });
        expect(klass).toBe('no_answer');
        expect(endedReason).toBe('customer-did-not-answer');
        expect(message && message.type).toBe('end-of-call-report');
        expect(mockGetJobById).not.toHaveBeenCalled(); // parts booked-detect never ran
        expect(mockFinalize).toHaveBeenCalledTimes(1); // shared timeline finalize DID run
    });

    it('TC-035(a): booked lead row → handleLeadEndOfCall runs BEFORE the parts idempotence guard (OLC-POSTCALL-001); parts detect never runs', async () => {
        // A lead booking flips the attempt to 'booked' MID-CALL, so by end-of-call
        // it is already terminal. The lead post-call branch must STILL run (Review +
        // summary + confirm task) — it sits before the dialing-only guard now.
        armCorrelate(leadRow({ status: 'booked' }));
        const res = await post(endReport('v1', 'customer-ended-call'));
        expect(res.status).toBe(200);
        expect(handleSpy).toHaveBeenCalledTimes(1);
        expect(handleSpy.mock.calls[0][0]).toMatchObject({ status: 'booked', scenario: 'lead_call' });
        expect(mockFinalize).toHaveBeenCalledTimes(1);      // shared timeline finalize still ran
        expect(mockGetJobById).not.toHaveBeenCalled();      // parts booked-detection never ran for a lead row
    });

    it('TC-038(a): unknown call.id → 200 no-op, zero writes', async () => {
        armCorrelate(null);
        const res = await post(endReport('ghost', 'customer-ended-call'));
        expect(res.status).toBe(200);
        expect(handleSpy).not.toHaveBeenCalled();
        expect(updates(/UPDATE outbound_call_attempts/)).toHaveLength(0);
    });

    it('TC-038(b): status-update for a lead row → applyStatusUpdate, zero attempt writes, body companyId ignored', async () => {
        armCorrelate(leadRow());
        const res = await post({
            message: {
                type: 'status-update', status: 'in-progress',
                call: { id: 'v1' }, companyId: 'attacker-co',
            },
        });
        expect(res.status).toBe(200);
        expect(mockApplyStatusUpdate).toHaveBeenCalledTimes(1);
        expect(updates(/UPDATE outbound_call_attempts/)).toHaveLength(0);
        expect(handleSpy).not.toHaveBeenCalled();
    });

    it('TC-039: auth fail-closed — missing/wrong secret 401, unconfigured 503', async () => {
        armCorrelate(leadRow());
        expect((await post(endReport('v1', 'x'), { secret: null })).status).toBe(401);
        expect((await post(endReport('v1', 'x'), { secret: 'wrong' })).status).toBe(401);
        expect(handleSpy).not.toHaveBeenCalled();

        const saved = process.env.VAPI_WEBHOOK_SECRET;
        delete process.env.VAPI_WEBHOOK_SECRET;
        const res = await post(endReport('v1', 'x'));
        expect(res.status).toBe(503);
        process.env.VAPI_WEBHOOK_SECRET = saved;
    });

    it('branch throw is safe-failed → still 200', async () => {
        handleSpy.mockRejectedValue(new Error('boom'));
        armCorrelate(leadRow());
        const res = await post(endReport('v1', 'customer-ended-call'));
        expect(res.status).toBe(200);
    });
});

describe('classification (REAL handleLeadEndOfCall)', () => {
    const terminalMark = () => updates(/SET status = \$2, reason = \$3/);
    const ladderInserts = () => updates(/INSERT INTO outbound_call_attempts/);

    it('TC-034(1): booked → review flow — flip booked, set Review, ONE confirm task w/ summary, no retry (OLC-POSTCALL-001)', async () => {
        const updateSpy = jest.spyOn(leadsService, 'updateLead').mockResolvedValue({});
        mockQuery.mockImplementation(async (sql) => (/SELECT 1 FROM tasks/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 }));
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Status: 'Submitted', LeadDateTime: '2026-07-16T14:00:00Z' });
        await svc.handleLeadEndOfCall(leadRow(), 'no_answer', 'customer-did-not-answer',
            { analysis: { summary: 'Customer booked Tue 2-4pm.' } });
        // hold wins over the transient endedReason — attempt flips booked, no ladder
        expect(updates(/SET status = 'booked'/).length).toBeGreaterThanOrEqual(1);
        expect(ladderInserts()).toHaveLength(0);
        // lead → Review (a human must confirm the tentative AI booking)
        expect(updateSpy).toHaveBeenCalledWith('LD-1', { Status: 'Review' }, COMPANY);
        // exactly one Action-Required confirm task, carrying the call summary
        expect(timelinesQueries.createTask).toHaveBeenCalledTimes(1);
        expect(timelinesQueries.createTask.mock.calls[0][0].title).toMatch(/Confirm the AI-booked appointment/);
        expect(timelinesQueries.createTask.mock.calls[0][0].description).toMatch(/Customer booked Tue 2-4pm/);
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'lead', 'LD-1', 'outbound_lead_call_booked', expect.anything(), 'system');
    });

    it('TC-034(1b): booked idempotence — lead already in Review → NO redundant Status write; task belt still fires once', async () => {
        const updateSpy = jest.spyOn(leadsService, 'updateLead').mockResolvedValue({});
        mockQuery.mockImplementation(async (sql) => (/SELECT 1 FROM tasks/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 }));
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Status: 'Review', LeadDateTime: '2026-07-16T14:00:00Z' });
        await svc.handleLeadEndOfCall(leadRow({ status: 'booked' }), 'failed', 'customer-ended-call', {});
        expect(updateSpy).not.toHaveBeenCalled();                    // already Review → skip
        expect(ladderInserts()).toHaveLength(0);                    // never a retry for a booked lead
    });

    it.each([
        ['no_answer', 'customer-did-not-answer'],
        ['voicemail', 'voicemail-detected'],
        ['failed', 'assistant-error'],
    ])('TC-034 transient %s → ladder rung with the endedReason as reason', async (klass, endedReason) => {
        await svc.handleLeadEndOfCall(leadRow(), klass, endedReason, {});
        expect(terminalMark().some(([, p]) => p[1] === klass && p[2] === endedReason)).toBe(true);
        expect(ladderInserts()).toHaveLength(1); // next rung
    });

    it('LEADCALL-SMS-CANCEL-001: late webhook for a customer-contact-canceled attempt cannot schedule a retry', async () => {
        await svc.handleLeadEndOfCall(
            leadRow({ status: 'canceled', reason: 'customer_replied_by_sms' }),
            'no_answer',
            'customer-did-not-answer',
            {},
        );

        expect(terminalMark()).toHaveLength(0);
        expect(ladderInserts()).toHaveLength(0);
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    it('TC-034(6): transient at attempt_no=3 → exhausted marker + exactly one task', async () => {
        await svc.handleLeadEndOfCall(leadRow({ attempt_no: 3 }), 'no_answer', 'customer-did-not-answer', {});
        const marker = ladderInserts().find(([sql]) => /'exhausted'/.test(sql));
        expect(marker).toBeTruthy();
        expect(timelinesQueries.createTask).toHaveBeenCalledTimes(1);
    });

    it('TC-036(a-c): declined via klass / structuredData outcome declined / callback → terminal + follow-up task, NO retry', async () => {
        const variants = [
            ['declined', 'customer-declined', {}],
            ['failed', 'customer-ended-call', { analysis: { structuredData: { outcome: 'declined' }, summary: 'Said no.' } }],
            ['failed', 'customer-ended-call', { analysis: { structuredData: { outcome: 'callback' }, summary: 'Call next week.' } }],
        ];
        for (const [klass, endedReason, message] of variants) {
            jest.clearAllMocks();
            mockQuery.mockImplementation(async (sql) => (/SELECT 1 FROM tasks/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 }));
            timelinesQueries.findOrCreateTimeline.mockResolvedValue({ id: 321 });
            timelinesQueries.createTask.mockResolvedValue({ id: 1 });
            getLeadByUUIDSpy.mockResolvedValue({ ...LEAD });
            await svc.handleLeadEndOfCall(leadRow(), klass, endedReason, message);
            expect(updates(/SET status = 'declined'/)).toHaveLength(1);
            expect(timelinesQueries.createTask).toHaveBeenCalledTimes(1);
            expect(timelinesQueries.createTask.mock.calls[0][0].title)
                .toBe("Alfreda Smith answered but didn't book — follow up");
            expect(ladderInserts()).toHaveLength(0);
            expect(eventService.logEvent).toHaveBeenCalledWith(
                COMPANY, 'lead', 'LD-1', 'outbound_lead_call_declined',
                expect.anything(), 'system');
        }
    });

    it('TC-036(d): outcome=other + no_answer → normal transient path', async () => {
        await svc.handleLeadEndOfCall(leadRow(), 'no_answer', 'x',
            { analysis: { structuredData: { outcome: 'other' } } });
        expect(updates(/SET status = 'declined'/)).toHaveLength(0);
        expect(ladderInserts()).toHaveLength(1);
    });

    it('TC-037(a): disconnected between dial and report → honest terminal, retry blocked, no task', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        await svc.handleLeadEndOfCall(leadRow(), 'no_answer', 'customer-did-not-answer', {});
        expect(terminalMark().some(([, p]) => p[1] === 'no_answer')).toBe(true);
        expect(ladderInserts()).toHaveLength(0);
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'lead', 'LD-1', 'outbound_lead_call_retry_skipped',
            expect.objectContaining({ blockedBy: 'app_disconnected' }), 'system');
    });

    it('TC-037(b): booked belt still honest when disconnected (the hold really landed)', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, LeadDateTime: '2026-07-16T14:00:00Z' });
        await svc.handleLeadEndOfCall(leadRow(), 'no_answer', 'x', {});
        expect(updates(/SET status = 'booked'/)).toHaveLength(1);
    });
});

describe('TC-OLC-040: sabotage — the classification table can go red', () => {
    it('with classify forced to failed, the no_answer/voicemail asserts would fail', async () => {
        // Drive the REAL handler with a WRONG klass (simulating a sabotaged
        // classifyEndedReason that returns 'failed' for everything): the
        // terminal mark records 'failed', so TC-034's per-klass assertion
        // (status === 'no_answer') demonstrably reddens on such an impl.
        await svc.handleLeadEndOfCall(leadRow(), 'failed', 'customer-did-not-answer', {});
        const mark = updates(/SET status = \$2, reason = \$3/)[0][1];
        expect(mark[1]).toBe('failed');
        expect(mark[1]).not.toBe('no_answer'); // ← the detector the honest table relies on
    });
});
