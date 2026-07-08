/**
 * OUTBOUND-PARTS-CALL-001 — POST /api/vapi/call-status webhook (unit, mocked).
 *
 * Binding: Docs/test-cases/OUTBOUND-PARTS-CALL-001.md U18 (+ S9/S10 unit slices)
 * (spec §C.6 / S9 · arch §6). VAPI is a machine caller — the route is guarded by a
 * SHARED SECRET, not a session. company/job/attempt are read from the correlated
 * outbound_call_attempts row (matched on message.call.id), NEVER from the body.
 *
 * All external legs mocked: db (attempt SELECT/UPDATE/INSERT + task/job reads),
 * jobsService (getJobById booked-detect + addNote), the worker's scheduling
 * primitives (computeNextScheduledAt / resolveBusinessHoursGroup),
 * outboundCallSettingsService, eventService. No real HTTP/DB.
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGetJobById = jest.fn();
const mockAddNote = jest.fn(async () => {});
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: (...a) => mockGetJobById(...a),
    addNote: (...a) => mockAddNote(...a),
}));

jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));

const mockResolveSettings = jest.fn();
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: (...a) => mockResolveSettings(...a),
}));

// Reuse the worker's scheduling primitives — mocked so we assert wiring, not math.
const mockComputeNext = jest.fn();
const mockResolveGroup = jest.fn();
jest.mock('../backend/src/services/outboundCallWorker', () => ({
    computeNextScheduledAt: (...a) => mockComputeNext(...a),
    resolveBusinessHoursGroup: (...a) => mockResolveGroup(...a),
}));

const SECRET = 'test-webhook-secret';
process.env.VAPI_WEBHOOK_SECRET = SECRET;

const vapiCallStatusRouter = require('../backend/src/routes/vapiCallStatus');
const eventService = require('../backend/src/services/eventService');

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

function endReport(callId, endedReason) {
    return { message: { type: 'end-of-call-report', call: { id: callId }, endedReason } };
}

// A `dialing` attempt row matched by vapi_call_id. company from THIS row.
function attemptRow(over = {}) {
    return {
        id: 100, company_id: COMPANY, job_id: 50, task_id: 7, attempt_no: 1,
        status: 'dialing', phone: '+16170001111', contact_id: 9, slot_json: null,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockGetJobById.mockReset();
    mockAddNote.mockClear();
    mockResolveSettings.mockReset();
    mockComputeNext.mockReset();
    mockResolveGroup.mockReset();

    // Defaults for the transient-retry path.
    mockResolveSettings.mockResolvedValue({ max_attempts: 3 });
    mockResolveGroup.mockResolvedValue('default-group');
    mockComputeNext.mockReturnValue(new Date('2026-07-08T14:00:00.000Z'));
    // booked-detect default: job is NOT rescheduled.
    mockGetJobById.mockResolvedValue({ id: 50, blanc_status: 'Part arrived' });
});

// Helper: queue the correlation SELECT (first db.query) → the attempt row.
function withAttempt(row = attemptRow()) {
    mockQuery.mockResolvedValueOnce({ rows: row ? [row] : [] }); // correlation SELECT
}

// ── S9/S10 — secret auth (fail-closed) ────────────────────────────────────────
describe('secret auth (U18, S10)', () => {
    test('no configured secret → 503', async () => {
        const saved = process.env.VAPI_WEBHOOK_SECRET;
        const savedTools = process.env.VAPI_TOOLS_SECRET;
        delete process.env.VAPI_WEBHOOK_SECRET;
        delete process.env.VAPI_TOOLS_SECRET;
        try {
            const res = await post(endReport('vc1', 'voicemail'), { secret: 'anything' });
            expect(res.status).toBe(503);
            expect(mockQuery).not.toHaveBeenCalled();
        } finally {
            process.env.VAPI_WEBHOOK_SECRET = saved;
            if (savedTools !== undefined) process.env.VAPI_TOOLS_SECRET = savedTools;
        }
    });

    test('wrong secret → 401, no correlation query', async () => {
        const res = await post(endReport('vc1', 'voicemail'), { secret: 'nope' });
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('valid secret → 200', async () => {
        withAttempt(attemptRow());
        mockQuery.mockResolvedValue({ rows: [] }); // UPDATE/INSERT
        const res = await post(endReport('vc1', 'voicemail'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

// ── S10 — company from the correlated row, NEVER the body ─────────────────────
describe('company derived from attempt row, not body (S10)', () => {
    test('spoofed companyId in body is ignored; writes scoped to row company', async () => {
        withAttempt(attemptRow({ company_id: COMPANY })); // row company = A
        mockQuery.mockResolvedValue({ rows: [] });
        const body = endReport('vc_iso', 'customer-did-not-answer');
        body.message.companyId = 'c0000000-0000-4000-8000-0000000000f1'; // spoof B
        body.companyId = 'c0000000-0000-4000-8000-0000000000f1';

        const res = await post(body);
        expect(res.status).toBe(200);
        // The correlation SELECT keys ONLY on the vapi_call_id from the body.
        expect(mockQuery.mock.calls[0][1]).toEqual(['vc_iso']);
        // Retry settings resolved against the ROW company, not the spoofed body.
        expect(mockResolveSettings).toHaveBeenCalledWith(COMPANY);
        // The retry INSERT is scoped to the row company (A), never B.
        const insert = mockQuery.mock.calls.find(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])));
        expect(insert[1][0]).toBe(COMPANY);
        expect(JSON.stringify(insert[1])).not.toContain('0000000000f1');
    });

    test('unknown call.id → 200 no-op (no leak, no writes)', async () => {
        withAttempt(null); // correlation SELECT → no row
        const res = await post(endReport('unknown-id', 'voicemail'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        // Only the correlation SELECT ran; no UPDATE/INSERT.
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('no call.id in body → 200 no-op, not even a correlation query', async () => {
        const res = await post({ message: { type: 'end-of-call-report' } });
        expect(res.status).toBe(200);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('non-end-of-call message (mid-call status-update, same call.id) → 200 no-op, no correlation/classification', async () => {
        // A live-call server message that shares this server.url and carries the
        // dialing attempt's call.id must NOT terminate the attempt or retry.
        withAttempt(attemptRow()); // would match if it ever queried
        const res = await post({ message: { type: 'status-update', call: { id: 'vc_dialing' } } });
        expect(res.status).toBe(200);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockComputeNext).not.toHaveBeenCalled();
    });
});

// ── S9 — idempotence: a non-dialing (terminal) attempt is a no-op ─────────────
describe('idempotence — terminal attempt (S9, edge-6)', () => {
    test('already booked → duplicate webhook is a 200 no-op (no 2nd update)', async () => {
        withAttempt(attemptRow({ status: 'booked' }));
        const res = await post(endReport('vc_dup', 'assistant-ended-call'));
        expect(res.status).toBe(200);
        // Only the correlation SELECT; no further update (terminal guard).
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockAddNote).not.toHaveBeenCalled();
    });

    test('already exhausted → no-op', async () => {
        withAttempt(attemptRow({ status: 'exhausted' }));
        const res = await post(endReport('vc_dup', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });
});

// ── S9 — booked detection (job Rescheduled OR task done) → terminal booked ────
describe('booked detection (S9)', () => {
    test('job blanc_status Rescheduled → attempt marked booked, no retry', async () => {
        withAttempt(attemptRow());
        mockGetJobById.mockResolvedValueOnce({ id: 50, blanc_status: 'Rescheduled' });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE ... booked
        const res = await post(endReport('vc_booked', 'assistant-ended-call'));
        expect(res.status).toBe(200);
        const upd = mockQuery.mock.calls.find(c => /SET status = 'booked'/i.test(String(c[0])));
        expect(upd).toBeTruthy();
        // No retry INSERT.
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(false);
    });

    test('task status done → booked (even when job not yet Rescheduled)', async () => {
        withAttempt(attemptRow());
        mockGetJobById.mockResolvedValueOnce({ id: 50, blanc_status: 'Part arrived' });
        mockQuery.mockResolvedValueOnce({ rows: [{ status: 'done' }] }); // task status SELECT
        mockQuery.mockResolvedValueOnce({ rows: [] });                    // UPDATE booked
        const res = await post(endReport('vc_booked2', 'assistant-ended-call'));
        expect(res.status).toBe(200);
        expect(mockQuery.mock.calls.some(c => /SET status = 'booked'/i.test(String(c[0])))).toBe(true);
    });
});

// ── U18 — endedReason classification → next state ─────────────────────────────
describe('endedReason classification (U18)', () => {
    // Each maps to a transient status. The FIRST update sets the attempt's terminal
    // transient status; a retry INSERT follows (attempt_no < max).
    const transientCases = [
        ['customer-did-not-answer', 'no_answer'],
        ['customer-busy', 'no_answer'],
        ['voicemail-detected', 'voicemail'],
        ['assistant-forwarded', 'failed'],
        ['pipeline-error-failed-to-place', 'failed'],
    ];

    test.each(transientCases)('%s → attempt status %s + retry scheduled', async (reason, expected) => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] }); // UPDATE (mark) + INSERT (retry)
        const res = await post(endReport('vc_t', reason));
        expect(res.status).toBe(200);
        // The mark-update sets the classified status.
        const markUpd = mockQuery.mock.calls.find(c => /UPDATE outbound_call_attempts SET status = \$2/.test(String(c[0])));
        expect(markUpd).toBeTruthy();
        expect(markUpd[1][1]).toBe(expected);
        // A next attempt was inserted (pending).
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(true);
        // A per-attempt job note + a domain event were written.
        expect(mockAddNote).toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry', expect.any(Object), 'system'
        );
    });

    test('declined → terminal declined, NO retry INSERT', async () => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        const res = await post(endReport('vc_decl', 'customer-declined-all'));
        expect(res.status).toBe(200);
        const upd = mockQuery.mock.calls.find(c => /SET status = 'declined'/i.test(String(c[0])));
        expect(upd).toBeTruthy();
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(false);
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_declined', expect.any(Object), 'system'
        );
    });
});

// ── S9 / S5 — retry-or-exhaust: last attempt → exhausted, no next attempt ─────
describe('retry-or-exhaust (U18, S5 slice)', () => {
    test('attempt_no < max → next pending attempt scheduled via worker primitives', async () => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        const res = await post(endReport('vc_r', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        // Reuses the worker's backoff math + business-hours group resolution.
        expect(mockResolveGroup).toHaveBeenCalledWith(COMPANY);
        expect(mockComputeNext).toHaveBeenCalledWith(1, expect.any(Object), 'default-group', expect.any(Date));
        const insert = mockQuery.mock.calls.find(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])));
        expect(insert[1]).toContain(2); // attempt_no + 1
    });

    test('attempt_no == max → exhausted marker, NO next pending attempt', async () => {
        withAttempt(attemptRow({ attempt_no: 3 }));
        mockResolveSettings.mockResolvedValue({ max_attempts: 3 });
        mockQuery.mockResolvedValue({ rows: [] });
        const res = await post(endReport('vc_ex', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        // The mark-update (no_answer) ran, then an 'exhausted' marker INSERT.
        const exhausted = mockQuery.mock.calls.find(
            c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])) && /'exhausted'/.test(String(c[0]))
        );
        expect(exhausted).toBeTruthy();
        // The worker's next-scheduling math is NOT invoked when exhausted.
        expect(mockComputeNext).not.toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_exhausted', expect.any(Object), 'system'
        );
    });
});
