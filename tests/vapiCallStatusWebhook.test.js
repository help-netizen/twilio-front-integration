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
// retryBlockReason (CANCEL-001 CC-04) is the SHARED no-resurrection guard: the
// route must consult it after the honest mark-update and skip the retry INSERT /
// exhausted marker / notes when it returns a block reason. Its predicate internals
// (job re-read + partsCallService.isChainCanceled) are pinned against the REAL
// helper in tests/outboundCallWorker.test.js — here we assert the route's WIRING.
const mockComputeNext = jest.fn();
const mockResolveGroup = jest.fn();
const mockRetryBlockReason = jest.fn();
jest.mock('../backend/src/services/outboundCallWorker', () => ({
    computeNextScheduledAt: (...a) => mockComputeNext(...a),
    resolveBusinessHoursGroup: (...a) => mockResolveGroup(...a),
    retryBlockReason: (...a) => mockRetryBlockReason(...a),
}));
const mockNextAllowedAt = jest.fn();
jest.mock('../backend/src/services/agentCallWindowService', () => ({
    AGENT_KEYS: { PARTS: 'outbound-parts-caller', LEADS: 'outbound-lead-caller' },
    nextAllowedAt: (...args) => mockNextAllowedAt(...args),
}));

// OUTBOUND-CALL-TIMELINE-001 (CT-05) — the timeline seam (CT-01). Mocked so we
// assert the ROUTE'S wiring (called once, {attempt, message}, non-fatal), not the
// service internals (those are covered by vapiCallTimelineService.test.js).
const mockFinalize = jest.fn();
const mockApplyStatusUpdate = jest.fn();
jest.mock('../backend/src/services/vapiCallTimelineService', () => ({
    finalizeFromEndOfCallReport: (...a) => mockFinalize(...a),
    applyStatusUpdate: (...a) => mockApplyStatusUpdate(...a),
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

function statusUpdate(callId, status, over = {}) {
    return { message: { type: 'status-update', status, call: { id: callId, ...over } } };
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
    mockNextAllowedAt.mockReset();
    mockRetryBlockReason.mockReset();
    mockFinalize.mockReset();
    mockApplyStatusUpdate.mockReset();

    // Defaults for the transient-retry path.
    mockResolveSettings.mockResolvedValue({ max_attempts: 3 });
    mockResolveGroup.mockResolvedValue('default-group');
    mockComputeNext.mockReturnValue(new Date('2026-07-08T14:00:00.000Z'));
    mockNextAllowedAt.mockImplementation(async (_companyId, _agentKey, now) => now);
    // CC-04 guard default: not blocked → retries behave exactly as before.
    mockRetryBlockReason.mockResolvedValue(null);
    // booked-detect default: job is NOT rescheduled.
    mockGetJobById.mockResolvedValue({ id: 50, blanc_status: 'Part arrived' });
    // Timeline seam succeeds by default (returns the effective sid). CT-05 asserts
    // the ROUTE stays 200 + FSM intact even when these resolve OR reject.
    mockFinalize.mockResolvedValue('CA_final');
    mockApplyStatusUpdate.mockResolvedValue('CA_mid');
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

    test('mid-call status-update (same call.id) → timeline transition, NEVER terminates the attempt or retries', async () => {
        // A live-call server message shares this server.url and carries the dialing
        // attempt's call.id. Post-CT-05 it drives a TIMELINE transition (via the
        // correlated row) but must still NOT classify the attempt or schedule a
        // retry — the outbound_call_attempts table is untouched by this branch.
        withAttempt(attemptRow()); // the status-update correlation SELECT
        const res = await post(statusUpdate('vc_dialing', 'in-progress'));
        expect(res.status).toBe(200);
        // Correlated once; the timeline seam got the ROW-scoped attempt.
        expect(mockApplyStatusUpdate).toHaveBeenCalledTimes(1);
        expect(mockApplyStatusUpdate.mock.calls[0][0].attempt.company_id).toBe(COMPANY);
        // NO attempt state-machine work: no retry math, no end-of-call finalize,
        // and only the single correlation SELECT ran (no UPDATE/INSERT).
        expect(mockComputeNext).not.toHaveBeenCalled();
        expect(mockFinalize).not.toHaveBeenCalled();
        expect(mockQuery.mock.calls.some(c => /UPDATE|INSERT/i.test(String(c[0])))).toBe(false);
        expect(mockQuery).toHaveBeenCalledTimes(1);
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
        expect(mockNextAllowedAt).toHaveBeenCalledWith(
            COMPANY,
            'outbound-parts-caller',
            new Date('2026-07-08T14:00:00.000Z')
        );
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

// ── OUTBOUND-PARTS-CALL-CANCEL-001 (CC-04) — no-resurrection guard (S9/S10) ───
// After the honest mark-update, the route consults the SHARED guard
// (outboundCallWorker.retryBlockReason — job re-read + isChainCanceled; its
// predicate is pinned in tests/outboundCallWorker.test.js). Blocked → NO retry
// INSERT, NO exhausted marker, NO notes (the cancel event already noted the
// job), only an `outbound_call_retry_skipped` event + 200. Fail-open: a guard
// fault means "not blocked" — retries proceed exactly as before.
describe('no-resurrection retry guard (CC-04, TC-CC-11…13)', () => {
    // TC-CC-11 wiring: every block reason the predicate can emit → same skip.
    test.each([
        ['job left Part arrived', 'job_status_Canceled'],
        ['job gone', 'job_not_found'],
        ['job zb-canceled', 'job_canceled'],
        ['chain canceled (marker newer than attempt, TC-CC-12)', 'chain_canceled'],
    ])('blocked (%s) → honest mark kept, NO retry INSERT, NO note, retry_skipped event', async (_label, blockReason) => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        mockRetryBlockReason.mockResolvedValue(blockReason);

        const res = await post(endReport('vc_guard', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        // The failing attempt still got its HONEST terminal transient status.
        const markUpd = mockQuery.mock.calls.find(c => /UPDATE outbound_call_attempts SET status = \$2/.test(String(c[0])));
        expect(markUpd).toBeTruthy();
        expect(markUpd[1][1]).toBe('no_answer');
        // Guard consulted with the correlated ROW (company scope from the row).
        expect(mockRetryBlockReason).toHaveBeenCalledTimes(1);
        expect(mockRetryBlockReason).toHaveBeenCalledWith(
            expect.objectContaining({ id: 100, company_id: COMPANY, job_id: 50 })
        );
        // NO resurrection: no INSERT of any kind, no retry math, no note.
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(false);
        expect(mockComputeNext).not.toHaveBeenCalled();
        expect(mockAddNote).not.toHaveBeenCalled();
        // Only the skip event — never outbound_call_retry.
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry_skipped',
            expect.objectContaining({ attemptNo: 1, outcome: 'no_answer', blockedBy: blockReason }), 'system'
        );
        expect(eventService.logEvent).not.toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry', expect.any(Object), 'system'
        );
    });

    // TC-CC-12 converse — regression pin: guard clean → retry byte-identical to today.
    test('NOT blocked → retry INSERT (attempt_no+1, slot copied) + "next attempt" note as today', async () => {
        withAttempt(attemptRow({ attempt_no: 1, slot_json: { date: '2026-07-11', label: 'Fri 10-12' } }));
        mockQuery.mockResolvedValue({ rows: [] });
        mockRetryBlockReason.mockResolvedValue(null);

        const res = await post(endReport('vc_clean', 'customer-did-not-answer'));
        expect(res.status).toBe(200);

        const insert = mockQuery.mock.calls.find(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])));
        expect(insert).toBeTruthy();
        expect(insert[1]).toContain(2); // attempt_no + 1
        expect(insert[1]).toContain(JSON.stringify({ date: '2026-07-11', label: 'Fri 10-12' })); // slot_json copied
        expect(mockAddNote).toHaveBeenCalledWith(
            50,
            expect.stringMatching(/next attempt/i),
            [],
            'AI Phone',
            'AI Phone',
            null,
            COMPANY
        );
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry', expect.any(Object), 'system'
        );
        expect(eventService.logEvent).not.toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry_skipped', expect.any(Object), 'system'
        );
    });

    // TC-CC-13: the exhausted insertion site is guarded by the SAME check.
    test('blocked at attempt_no == max → NO exhausted marker INSERT, NO exhausted note; honest mark kept', async () => {
        withAttempt(attemptRow({ attempt_no: 3 }));
        mockQuery.mockResolvedValue({ rows: [] });
        mockRetryBlockReason.mockResolvedValue('chain_canceled');

        const res = await post(endReport('vc_exh_guard', 'customer-did-not-answer'));
        expect(res.status).toBe(200);

        const markUpd = mockQuery.mock.calls.find(c => /UPDATE outbound_call_attempts SET status = \$2/.test(String(c[0])));
        expect(markUpd[1][1]).toBe('no_answer'); // honest terminal transient status
        expect(mockQuery.mock.calls.some(
            c => /INSERT INTO outbound_call_attempts/i.test(String(c[0]))
        )).toBe(false); // no exhausted marker
        expect(mockAddNote).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_exhausted', expect.any(Object), 'system'
        );
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry_skipped', expect.any(Object), 'system'
        );
    });

    // Fail-open + webhook safety: a guard FAULT can neither break the 200 nor
    // silently starve the retry chain (behaves as "not blocked").
    test('guard REJECTS → still 200 AND retry proceeds as today (fail-open)', async () => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        mockRetryBlockReason.mockRejectedValue(new Error('guard boom'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await post(endReport('vc_guard_boom', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        // Fail-open: the retry INSERT + note + event happened exactly as today.
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(true);
        expect(mockAddNote).toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry', expect.any(Object), 'system'
        );
        warnSpy.mockRestore();
    });

    // TC-CC-16: booked wins BEFORE the guard — a mid-call booking still lands
    // `booked` even when the guard would block (job Rescheduled IS the booking).
    test('booked branch untouched: job Rescheduled → booked; guard never consulted', async () => {
        withAttempt(attemptRow());
        mockGetJobById.mockResolvedValueOnce({ id: 50, blanc_status: 'Rescheduled' }); // booked-detect
        mockRetryBlockReason.mockResolvedValue('job_status_Rescheduled'); // would block, if reached
        mockQuery.mockResolvedValue({ rows: [] });

        const res = await post(endReport('vc_booked_guard', 'assistant-ended-call'));
        expect(res.status).toBe(200);
        expect(mockQuery.mock.calls.some(c => /SET status = 'booked'/i.test(String(c[0])))).toBe(true);
        expect(mockRetryBlockReason).not.toHaveBeenCalled(); // booked returns first
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(false);
    });
});

// ── OUTBOUND-CALL-TIMELINE-001 (CT-05) — Pulse timeline hooks (TC-CT-008…011) ──
// The webhook feeds the correlated attempt (whose company_id IS the tenant scope)
// to the NON-FATAL timeline seam. A timeline fault can never break the 200 or the
// retry FSM; company ALWAYS flows from the row, never the webhook body.
describe('timeline hooks — CT-05', () => {
    // (a) — end-of-call with a correlating attempt calls finalize ONCE with
    // {attempt, message}, and the pre-existing attempt/note logic still runs.
    test('(a) end-of-call → finalizeFromEndOfCallReport once with {attempt, message}; attempt/note logic intact', async () => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        const res = await post(endReport('vc_fin', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(mockFinalize).toHaveBeenCalledTimes(1);
        const arg = mockFinalize.mock.calls[0][0];
        expect(arg.attempt.id).toBe(100);
        expect(arg.attempt.company_id).toBe(COMPANY);         // company from the ROW
        expect(arg.message.type).toBe('end-of-call-report');
        expect(arg.message.call.id).toBe('vc_fin');
        // Existing state machine undisturbed: mark-update + retry INSERT + note ran.
        expect(mockQuery.mock.calls.some(c => /UPDATE outbound_call_attempts SET status = \$2/.test(String(c[0])))).toBe(true);
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(true);
        expect(mockAddNote).toHaveBeenCalled();
        // The status-update seam is NOT touched on an end-of-call.
        expect(mockApplyStatusUpdate).not.toHaveBeenCalled();
    });

    // (b) — NON-FATAL: finalize THROWING must not break the 200 and, crucially,
    // must not starve the retry FSM (finalize runs BEFORE the state-machine writes;
    // the inner wrapper is what stops a throw from skipping them). This is the
    // negative-control target — remove the wrapper and these FSM assertions go red.
    test('(b) finalize THROWS → still 200 AND attempt state machine unaffected (non-fatal wrapper)', async () => {
        withAttempt(attemptRow({ attempt_no: 1 }));
        mockQuery.mockResolvedValue({ rows: [] });
        mockFinalize.mockRejectedValueOnce(new Error('timeline boom'));
        const res = await post(endReport('vc_boom', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mockFinalize).toHaveBeenCalledTimes(1);
        // The throw did NOT skip the FSM — mark-update + retry INSERT + note + event.
        expect(mockQuery.mock.calls.some(c => /UPDATE outbound_call_attempts SET status = \$2/.test(String(c[0])))).toBe(true);
        expect(mockQuery.mock.calls.some(c => /INSERT INTO outbound_call_attempts/i.test(String(c[0])))).toBe(true);
        expect(mockAddNote).toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            COMPANY, 'job', 50, 'outbound_call_retry', expect.any(Object), 'system'
        );
    });

    // (b2) — finalize also runs on a REPEAT (already-terminal) webhook, BEFORE the
    // idempotence no-op (граничный-2: "idempotence no-op happens AFTER finalize").
    test('(b2) repeat end-of-call on a terminal attempt → finalize still runs; NO 2nd FSM write', async () => {
        withAttempt(attemptRow({ status: 'no_answer' })); // already terminal
        const res = await post(endReport('vc_repeat', 'customer-did-not-answer'));
        expect(res.status).toBe(200);
        expect(mockFinalize).toHaveBeenCalledTimes(1);   // finalize re-runs (idempotent)
        // The idempotence guard fired: no attempt writes, no note, no retry math.
        expect(mockQuery).toHaveBeenCalledTimes(1);      // only the correlation SELECT
        expect(mockAddNote).not.toHaveBeenCalled();
        expect(mockComputeNext).not.toHaveBeenCalled();
    });

    // (c) — status-update with a correlating attempt calls applyStatusUpdate;
    // finalize is not called and the attempt table is untouched.
    test('(c) status-update (correlating attempt) → applyStatusUpdate({attempt, message}); no finalize, no attempt writes', async () => {
        withAttempt(attemptRow());
        const res = await post(statusUpdate('vc_live', 'ringing'));
        expect(res.status).toBe(200);
        expect(mockApplyStatusUpdate).toHaveBeenCalledTimes(1);
        const arg = mockApplyStatusUpdate.mock.calls[0][0];
        expect(arg.attempt.company_id).toBe(COMPANY);          // company from the ROW
        expect(arg.message.type).toBe('status-update');
        expect(arg.message.call.id).toBe('vc_live');
        expect(mockFinalize).not.toHaveBeenCalled();
        expect(mockComputeNext).not.toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledTimes(1);            // only the correlation SELECT
    });

    // (d) — a call we did not place: neither timeline fn fires (foreign call ignored).
    test('(d) status-update with NO correlating attempt → applyStatusUpdate NOT called (foreign call ignored)', async () => {
        withAttempt(null); // correlation SELECT → no row
        const res = await post(statusUpdate('foreign-live', 'ringing'));
        expect(res.status).toBe(200);
        expect(mockApplyStatusUpdate).not.toHaveBeenCalled();
        expect(mockFinalize).not.toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledTimes(1);           // only the SELECT, then drop
    });

    test('(d) end-of-call with NO correlating attempt → finalize NOT called (foreign call ignored)', async () => {
        withAttempt(null);
        const res = await post(endReport('foreign-eoc', 'voicemail'));
        expect(res.status).toBe(200);
        expect(mockFinalize).not.toHaveBeenCalled();
        expect(mockApplyStatusUpdate).not.toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    // (e) — company scoping: the ROW company is what reaches the seam; a spoofed
    // body companyId is never the source (the route hands over the attempt row).
    test('(e) company scoping — finalize gets the ROW company; spoofed body companyId ignored', async () => {
        withAttempt(attemptRow({ company_id: COMPANY }));
        mockQuery.mockResolvedValue({ rows: [] });
        const eoc = endReport('vc_scope', 'customer-did-not-answer');
        eoc.companyId = 'c0000000-0000-4000-8000-0000000000f1';          // spoof
        eoc.message.companyId = 'c0000000-0000-4000-8000-0000000000f1';  // spoof
        const res = await post(eoc);
        expect(res.status).toBe(200);
        expect(mockFinalize).toHaveBeenCalledTimes(1);
        // The company source is the attempt row, never the spoofed body.
        expect(mockFinalize.mock.calls[0][0].attempt.company_id).toBe(COMPANY);
        expect(JSON.stringify(mockFinalize.mock.calls[0][0].attempt)).not.toContain('0000000000f1');
    });

    test('(e) company scoping — status-update hands applyStatusUpdate the ROW company', async () => {
        withAttempt(attemptRow({ company_id: COMPANY }));
        const su = statusUpdate('vc_scope2', 'in-progress');
        su.companyId = 'c0000000-0000-4000-8000-0000000000f1';          // spoof
        su.message.companyId = 'c0000000-0000-4000-8000-0000000000f1';  // spoof
        const res = await post(su);
        expect(res.status).toBe(200);
        expect(mockApplyStatusUpdate.mock.calls[0][0].attempt.company_id).toBe(COMPANY);
        expect(JSON.stringify(mockApplyStatusUpdate.mock.calls[0][0].attempt)).not.toContain('0000000000f1');
    });
});
