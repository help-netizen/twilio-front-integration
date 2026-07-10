/**
 * outboundCallWorker.test.js — OUTBOUND-PARTS-CALL-001, TC-OPC-U09/U10/U11.
 *
 * Unit (mocked db + mocked deps): pins the claim-loop dispatch, business-hours
 * clamp, retry/exhaust scheduling, and the pure tz-aware backoff helpers of
 * `outboundCallWorker` (spec §C.4, Decision F). The worker's exported internals
 * (tick / processAttempt / computeNextScheduledAt / nextBusinessMorning /
 * resolveBusinessHoursGroup) are invoked DIRECTLY.
 *
 * Every external leg is mocked — NO real DB, NO real VAPI. `placeCall` is a stub;
 * `groupRouting.isBusinessHours` is a stub toggled per-test.
 */

'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    addNote: jest.fn(async () => ({})),
    getJobBalanceDue: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallService', () => ({
    placeCall: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: jest.fn(),
}));
jest.mock('../backend/src/services/groupRouting', () => ({
    isBusinessHours: jest.fn(),
}));
// OUTBOUND-CALL-TIMELINE-001 (CT-04): the placement→timeline mirror seam. Mocked
// so no real DB/SSE runs; the worker only calls recordPlacement.
jest.mock('../backend/src/services/vapiCallTimelineService', () => ({
    recordPlacement: jest.fn(),
}));

const jobsService = require('../backend/src/services/jobsService');
const outboundCallService = require('../backend/src/services/outboundCallService');
const settings = require('../backend/src/services/outboundCallSettingsService');
const groupRouting = require('../backend/src/services/groupRouting');
const vapiCallTimeline = require('../backend/src/services/vapiCallTimelineService');
const worker = require('../backend/src/services/outboundCallWorker');

const CO = '00000000-0000-0000-0000-000000000001';
const DEFAULT_SETTINGS = {
    max_attempts: 3,
    backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
    next_morning_hour: 9,
    enabled: true,
};

function mkAttempt(over = {}) {
    return {
        id: 900,
        company_id: CO,
        job_id: 50,
        task_id: 70,
        contact_id: 501,
        phone: '+16175551212',
        attempt_no: 1,
        status: 'dialing',
        slot_json: { date: '2026-07-10', start: '10:00', end: '12:00', label: 'Tue 10-12' },
        ...over,
    };
}
const DIALABLE_JOB = {
    id: 50,
    blanc_status: 'Part arrived',
    zb_canceled: false,
    customer_name: 'Jane',
    customer_phone: '+16175551212',
};

beforeEach(() => {
    jest.clearAllMocks();
    settings.resolve.mockResolvedValue({ ...DEFAULT_SETTINGS });
    groupRouting.isBusinessHours.mockResolvedValue(true);
    // Default: no local invoice → balance omitted (prior behavior). Overridden
    // per-test where the balance-injection path is exercised.
    jobsService.getJobBalanceDue.mockResolvedValue({ balanceDue: null, total: null, amountPaid: null });
    // resolveBusinessHoursGroup reads companies/user_groups — default a group row.
    mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
    // CT-04 placement mirror: default resolves (non-fatal seam). clearAllMocks
    // above wipes call history each test; this resets the impl (e.g. after a
    // per-test mockRejectedValue) so leaks can't cross tests.
    vapiCallTimeline.recordPlacement.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// TC-OPC-U10/U11 helpers: computeNextScheduledAt + nextBusinessMorning (pure)
// ---------------------------------------------------------------------------

describe('TC-OPC-U10: computeNextScheduledAt — tz-aware backoff tokens', () => {
    const group = { id: 'g1', timezone: 'America/New_York' };

    test('immediate token → same instant as now', () => {
        const now = new Date('2026-07-07T15:00:00.000Z');
        // attempt 1 just failed → next attempt index 1 in a schedule whose [1] we test
        const s = { ...DEFAULT_SETTINGS, backoff_schedule: ['immediate', 'immediate', 'immediate'] };
        const out = worker.computeNextScheduledAt(1, s, group, now);
        expect(out.getTime()).toBe(now.getTime());
    });

    test('+2h token → now + 2 hours', () => {
        const now = new Date('2026-07-07T15:00:00.000Z');
        // justFailedNo=1 → next token at index 1 = '+2h'
        const out = worker.computeNextScheduledAt(1, DEFAULT_SETTINGS, group, now);
        expect(out.getTime()).toBe(now.getTime() + 2 * 60 * 60 * 1000);
    });

    test('next_business_morning token → next-day 09:00 company-local', () => {
        const now = new Date('2026-07-07T15:00:00.000Z'); // Tue 11:00 EDT
        // justFailedNo=2 → next token at index 2 = 'next_business_morning'
        const out = worker.computeNextScheduledAt(2, DEFAULT_SETTINGS, group, now);
        // 2026-07-08 09:00 America/New_York (EDT = UTC-4) → 13:00Z
        expect(out.toISOString()).toBe('2026-07-08T13:00:00.000Z');
    });

    test('unknown/absent token → conservative immediate', () => {
        const now = new Date('2026-07-07T15:00:00.000Z');
        const s = { ...DEFAULT_SETTINGS, backoff_schedule: [] };
        const out = worker.computeNextScheduledAt(0, s, group, now);
        expect(out.getTime()).toBe(now.getTime());
    });
});

describe('nextBusinessMorning — 09:00 local of the next calendar day (tz-aware)', () => {
    test('EDT: Tuesday 11:00 → Wednesday 09:00 local (13:00Z)', () => {
        const from = new Date('2026-07-07T15:00:00.000Z');
        const out = worker.nextBusinessMorning(from, 'America/New_York', 9);
        expect(out.toISOString()).toBe('2026-07-08T13:00:00.000Z');
    });

    test('honors a custom morning hour (e.g. 8) in the company tz', () => {
        const from = new Date('2026-07-07T15:00:00.000Z');
        const out = worker.nextBusinessMorning(from, 'America/New_York', 8);
        expect(out.toISOString()).toBe('2026-07-08T12:00:00.000Z');
    });

    test('a different tz (Los Angeles, PDT UTC-7) resolves to that wall clock', () => {
        const from = new Date('2026-07-07T15:00:00.000Z');
        const out = worker.nextBusinessMorning(from, 'America/Los_Angeles', 9);
        // 2026-07-08 09:00 PDT → 16:00Z
        expect(out.toISOString()).toBe('2026-07-08T16:00:00.000Z');
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U09: tick — claim query filters + in-hours dial path
// ---------------------------------------------------------------------------

describe('TC-OPC-U09: tick — claims only due pending rows with FOR UPDATE SKIP LOCKED', () => {
    test('claim UPDATE filters status=pending AND scheduled_at<=now() and SKIP LOCKED', async () => {
        // First query = the claim UPDATE → return no rows so the tick short-circuits.
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const claimed = await worker.tick();
        expect(claimed).toBe(0);

        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toMatch(/UPDATE outbound_call_attempts/i);
        expect(sql).toMatch(/SET status = 'dialing'/i);
        expect(sql).toMatch(/status = 'pending'/i);
        expect(sql).toMatch(/scheduled_at <= now\(\)/i);
        expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    });

    test('claimed in-hours row → placeCall dialed + vapi_call_id stored', async () => {
        const attempt = mkAttempt();
        // 1) claim UPDATE returns the row.
        mockQuery.mockResolvedValueOnce({ rows: [attempt] });
        // processAttempt: getJobById → dialable
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        // resolveBusinessHoursGroup query
        mockQuery.mockResolvedValueOnce({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        // placeCall ok
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_call_ok' });
        // store vapi_call_id UPDATE
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const claimed = await worker.tick();
        expect(claimed).toBe(1);

        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
        expect(outboundCallService.placeCall).toHaveBeenCalledWith(
            expect.objectContaining({ companyId: CO, jobId: 50, customerNumber: '+16175551212' }),
        );
        // The vapi_call_id store UPDATE was issued.
        const storeCall = mockQuery.mock.calls.find(
            (c) => /vapi_call_id = \$2/i.test(c[0]) && c[1] && c[1][1] === 'vapi_call_ok',
        );
        expect(storeCall).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U10: processAttempt outside business hours → push scheduled_at, no dial
// ---------------------------------------------------------------------------

describe('TC-OPC-U10: processAttempt — outside business hours → reschedule, do NOT dial', () => {
    test('isBusinessHours=false → scheduled_at pushed, status pending, placeCall NOT called', async () => {
        groupRouting.isBusinessHours.mockResolvedValue(false);
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        // resolveBusinessHoursGroup query + the push UPDATE
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });

        await worker.processAttempt(mkAttempt());

        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        const pushCall = mockQuery.mock.calls.find((c) => /SET status = 'pending', scheduled_at = \$2/i.test(c[0]));
        expect(pushCall).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U11: dispatch guards — non-dialable job, retry vs exhaust
// ---------------------------------------------------------------------------

describe('TC-OPC-U11: processAttempt — job/status guards + retry-or-exhaust', () => {
    test('job not Part arrived (canceled meanwhile) → terminated, NO dial', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, blanc_status: 'Canceled' });
        mockQuery.mockResolvedValue({ rows: [] }); // terminate UPDATE

        await worker.processAttempt(mkAttempt());

        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        const termCall = mockQuery.mock.calls.find(
            (c) => /SET status = \$2, reason = \$3/i.test(c[0]) && c[1] && c[1][1] === 'failed',
        );
        expect(termCall).toBeTruthy();
    });

    test('job not found → terminated failed (job_not_found), NO dial', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        mockQuery.mockResolvedValue({ rows: [] });

        await worker.processAttempt(mkAttempt());
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        const termCall = mockQuery.mock.calls.find(
            (c) => c[1] && c[1][2] === 'job_not_found',
        );
        expect(termCall).toBeTruthy();
    });

    test('placeCall ok:false, attempt_no < max → mark failed + enqueue next attempt + note', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: false, error: 'vapi_http_500' });

        await worker.processAttempt(mkAttempt({ attempt_no: 1 }));

        // THIS attempt flipped to 'failed'.
        const failCall = mockQuery.mock.calls.find(
            (c) => /SET status = 'failed', reason = \$2/i.test(c[0]) && c[1] && c[1][1] === 'vapi_http_500',
        );
        expect(failCall).toBeTruthy();
        // A NEW pending attempt inserted for attempt_no+1.
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        expect(insertCall[1]).toContain(2); // attempt_no + 1
        // A per-attempt job note written.
        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote).toHaveBeenCalledWith(
            50, expect.stringMatching(/next attempt/i), [], 'AI Phone', 'AI Phone',
        );
    });

    test('placeCall ok:false, attempt_no == max → exhausted, NO new attempt, exhausted note', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: false, error: 'vapi_http_500' });

        await worker.processAttempt(mkAttempt({ attempt_no: 3 }));

        // No new pending attempt inserted.
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
        // Exhausted note written.
        expect(jobsService.addNote).toHaveBeenCalledWith(
            50, expect.stringMatching(/exhausted/i), [], 'AI Phone', 'AI Phone',
        );
    });

    test('a thrown placeCall inside tick is isolated → attempt marked failed, tick does not throw', async () => {
        const attempt = mkAttempt();
        mockQuery.mockResolvedValueOnce({ rows: [attempt] }); // claim
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValueOnce({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] }); // group
        outboundCallService.placeCall.mockRejectedValue(new Error('boom'));
        mockQuery.mockResolvedValue({ rows: [] }); // terminate

        await expect(worker.tick()).resolves.toBe(1);
        // The per-row catch marked the attempt failed (worker_error).
        const termCall = mockQuery.mock.calls.find(
            (c) => c[1] && typeof c[1][2] === 'string' && c[1][2].startsWith('worker_error'),
        );
        expect(termCall).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Balance injection (OUTBOUND-PARTS-CALL) — processAttempt resolves the job's
// outstanding balance (company-scoped, non-fatal) and passes a speak-safe STRING
// into placeCall so the voice agent can answer "how much do I owe?".
// ---------------------------------------------------------------------------
describe('processAttempt — outstanding-balance injection into placeCall', () => {
    test('balance > 0 → placeCall gets balanceDue formatted "$X.XX", company-scoped lookup', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        jobsService.getJobBalanceDue.mockResolvedValue({ balanceDue: 200, total: 300, amountPaid: 100 });
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });

        await worker.processAttempt(mkAttempt());

        // Resolved with the attempt's company + job (company scoping).
        expect(jobsService.getJobBalanceDue).toHaveBeenCalledWith(50, CO);
        expect(outboundCallService.placeCall).toHaveBeenCalledWith(
            expect.objectContaining({ balanceDue: '$200.00' }),
        );
    });

    test('balance === 0 → "paid in full, nothing due"', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        jobsService.getJobBalanceDue.mockResolvedValue({ balanceDue: 0, total: 0, amountPaid: 0 });
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });

        await worker.processAttempt(mkAttempt());

        expect(outboundCallService.placeCall).toHaveBeenCalledWith(
            expect.objectContaining({ balanceDue: 'paid in full, nothing due' }),
        );
    });

    test('balanceDue null (no local invoice) → placeCall called with balanceDue undefined (omitted)', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        jobsService.getJobBalanceDue.mockResolvedValue({ balanceDue: null, total: null, amountPaid: null });
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });

        await worker.processAttempt(mkAttempt());

        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
        expect(outboundCallService.placeCall.mock.calls[0][0].balanceDue).toBeUndefined();
    });

    test('getJobBalanceDue THROWS → non-fatal, call still placed (balanceDue omitted)', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        jobsService.getJobBalanceDue.mockRejectedValue(new Error('db boom'));
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await worker.processAttempt(mkAttempt());

        // The dial happened despite the balance lookup throwing.
        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
        expect(outboundCallService.placeCall.mock.calls[0][0].balanceDue).toBeUndefined();
        warnSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// OUTBOUND-CALL-TIMELINE-001 (CT-04) — placement → Pulse timeline mirror.
// After a successful placeCall + vapi_call_id stamp, processAttempt calls
// vapiCallTimelineService.recordPlacement to create the live "Ringing" row.
// It is a NON-FATAL best-effort side-effect: a timeline failure must never
// block or re-classify the dial, and a call that never placed gets no row.
// ---------------------------------------------------------------------------
describe('CT-04: recordPlacement placement mirror (non-fatal timeline row)', () => {
    test('successful placeCall → recordPlacement ONCE with {attempt, vapiCallId, dialedNumber, callerId}', async () => {
        const attempt = mkAttempt();
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ct04_ok' });

        await worker.processAttempt(attempt);

        expect(vapiCallTimeline.recordPlacement).toHaveBeenCalledTimes(1);
        const arg = vapiCallTimeline.recordPlacement.mock.calls[0][0];
        // vapiCallId is the id placeCall just returned.
        expect(arg.vapiCallId).toBe('vapi_ct04_ok');
        // The company-bearing attempt row is threaded through verbatim (company
        // scoping is derived from attempt.company_id inside the service).
        expect(arg.attempt).toBe(attempt);
        expect(arg.attempt.company_id).toBe(CO);
        // dialedNumber mirrors the number handed to placeCall as customerNumber.
        expect(arg.dialedNumber).toBe('+16175551212');
        expect(arg).toHaveProperty('callerId');
    });

    test('dialedNumber falls back to job.customer_phone when attempt.phone is null', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });

        await worker.processAttempt(mkAttempt({ phone: null }));

        // Same expression placeCall received as customerNumber (job fallback).
        expect(vapiCallTimeline.recordPlacement.mock.calls[0][0].dialedNumber)
            .toBe(DIALABLE_JOB.customer_phone);
    });

    test('callerId comes from VAPI_OUTBOUND_TWILIO_NUMBER env (business line)', async () => {
        const prev = process.env.VAPI_OUTBOUND_TWILIO_NUMBER;
        process.env.VAPI_OUTBOUND_TWILIO_NUMBER = '+16175006181';
        try {
            jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
            mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
            outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });

            await worker.processAttempt(mkAttempt());

            expect(vapiCallTimeline.recordPlacement.mock.calls[0][0].callerId).toBe('+16175006181');
        } finally {
            if (prev === undefined) delete process.env.VAPI_OUTBOUND_TWILIO_NUMBER;
            else process.env.VAPI_OUTBOUND_TWILIO_NUMBER = prev;
        }
    });

    // KEY non-fatal guarantee: a recordPlacement throw must NOT fail processAttempt,
    // the vapi_call_id stamp still stands, and the dial is NOT re-classified into
    // the failed/retry path. (Negative control: delete the try/catch around
    // recordPlacement in outboundCallWorker.js and this test goes red — the
    // rejection propagates out of processAttempt.)
    test('recordPlacement THROWS → processAttempt still succeeds, vapi_call_id stamped, dial NOT re-classified', async () => {
        const attempt = mkAttempt();
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_ok' });
        vapiCallTimeline.recordPlacement.mockRejectedValue(new Error('timeline db down'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        // Does not throw / reject — the guard swallows the timeline failure.
        await expect(worker.processAttempt(attempt)).resolves.toBeUndefined();

        // vapi_call_id was still stamped (it happens BEFORE the hook, unchanged).
        const storeCall = mockQuery.mock.calls.find(
            (c) => /vapi_call_id = \$2/i.test(c[0]) && c[1] && c[1][1] === 'vapi_ok',
        );
        expect(storeCall).toBeTruthy();
        // The placed dial was NOT flipped to failed nor a retry enqueued.
        const failFlip = mockQuery.mock.calls.find((c) => /SET status = 'failed', reason = \$2/i.test(c[0]));
        expect(failFlip).toBeFalsy();
        const insertNext = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertNext).toBeFalsy();
        warnSpy.mockRestore();
    });

    test('FAILED placeCall (ok:false) → recordPlacement NOT called (no row for a call that never placed)', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        mockQuery.mockResolvedValue({ rows: [{ group_id: 'g1', timezone: 'America/New_York' }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: false, error: 'vapi_http_500' });

        await worker.processAttempt(mkAttempt({ attempt_no: 1 }));

        expect(vapiCallTimeline.recordPlacement).not.toHaveBeenCalled();
    });
});
