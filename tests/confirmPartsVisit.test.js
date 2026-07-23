/**
 * confirmPartsVisit.test.js — OUTBOUND-PARTS-CALL-001, TC-OPC-U12/U13/U14.
 *
 * Unit (mocked deps): drives the outbound booking-write skill `confirmPartsVisit.run`
 * DIRECTLY, with every reused service mocked (spec §C.5 / S2 / S8 / edge-4,
 * Decision E + Deviation 1). Proves:
 *   U12 — ownership pre-check: bound-contact match → proceed; mismatch / foreign
 *         job → safe refusal, NO write (no rescheduleItem/flip/note/task-close).
 *   U13 — confirmed-slot guard + slotSpanIsPositive: malformed / end<start → refusal.
 *   U14 — success call ORDER: getJobById → rescheduleItem → updateBlancStatus →
 *         addNote + logEvent → updateTask(done); ZB-409 → conflict shape, NO flip,
 *         NO task-close; "reschedule ok but flip throws" → success with
 *         statusFlipped:false, task left OPEN, booked:false.
 *   CC-07 (CANCEL-001 booked-before-flip) — the committed success path stamps the
 *         robot's OWN 'dialing' attempt 'booked' BEFORE the status flip, so the
 *         updateBlancStatus leave-hook (cancelScheduledRobotCalls) sees no active
 *         row and can never write the false "robot call canceled" note/marker on
 *         a successful robot booking. Stamp fault → non-fatal; no attempt → 0-row
 *         no-op; ZB-409 → NO stamp (nothing landed).
 *
 * The skill require()s its deps lazily inside run(), so they are jest.mocked at
 * the module boundary. NO real DB, NO real ZB, NO dial.
 */

'use strict';

// CC-07: the booked-stamp goes straight through db/connection (lazy-required in
// the success path only) — same mock idiom as partsCallService.test.js.
const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    updateBlancStatus: jest.fn(async () => ({})),
    addNote: jest.fn(async () => ({})),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    rescheduleItem: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(() => {}),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    updateTask: jest.fn(async () => ({ id: 70, status: 'done' })),
}));

const jobsService = require('../backend/src/services/jobsService');
const scheduleService = require('../backend/src/services/scheduleService');
const eventService = require('../backend/src/services/eventService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const confirmPartsVisit = require('../backend/src/services/agentSkills/skills/confirmPartsVisit');

const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;
const JOB = { id: 50, contact_id: CONTACT, blanc_status: 'Part arrived', zb_canceled: false };
const GOOD_SLOT = { date: '2026-07-10', start: '10:00', end: '12:00' };
// Identity is injected via variableValues → the skill input (contactId/jobId/taskId).
const INPUT = { chosenSlot: GOOD_SLOT, jobId: 50, taskId: 70, contactId: CONTACT };
// L0 outbound context: contactId null (no confident phone match on an outbound dial).
const L0 = { level: 'L0', contactId: null };

beforeEach(() => {
    jest.clearAllMocks();
    scheduleService.rescheduleItem.mockResolvedValue({ ok: true });
    jobsService.updateBlancStatus.mockResolvedValue({});
    jobsService.addNote.mockResolvedValue({});
    tasksQueries.updateTask.mockResolvedValue({ id: 70, status: 'done' });
    // CC-07 default: the booked-stamp UPDATE matches the one dialing row.
    mockDbQuery.mockResolvedValue({ rowCount: 1, rows: [] });
});

// ---------------------------------------------------------------------------
// TC-OPC-U12: ownership pre-check
// ---------------------------------------------------------------------------

describe('TC-OPC-U12: confirmPartsVisit — ownership pre-check (Deviation 1)', () => {
    test('bound-contact MATCH → proceeds to rescheduleItem', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(jobsService.getJobById).toHaveBeenCalledWith(50, CO);
        expect(scheduleService.rescheduleItem).toHaveBeenCalledTimes(1);
        expect(out.ok).toBe(true);
    });

    test('contact MISMATCH → safe refusal, NO write of any kind', async () => {
        jobsService.getJobById.mockResolvedValue({ ...JOB, contact_id: 999 });
        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(out.ok).toBe(false);
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(tasksQueries.updateTask).not.toHaveBeenCalled();
    });

    test('foreign job (getJobById → null) → safe refusal, NO write', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(out.ok).toBe(false);
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
    });

    test('getJobById THROWS → treated as not-found → safe refusal, no write', async () => {
        jobsService.getJobById.mockRejectedValue(new Error('db down'));
        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(out.ok).toBe(false);
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
    });

    test('missing bound identity (no jobId/contactId) → refusal before any lookup', async () => {
        const out = await confirmPartsVisit.run(CO, L0, { chosenSlot: GOOD_SLOT });
        expect(out.ok).toBe(false);
        expect(jobsService.getJobById).not.toHaveBeenCalled();
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
    });

    test('canceled bound job → refusal, no reschedule', async () => {
        jobsService.getJobById.mockResolvedValue({ ...JOB, blanc_status: 'Canceled' });
        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(out.ok).toBe(false);
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U13: confirmed-slot guard + slotSpanIsPositive
// ---------------------------------------------------------------------------

describe('TC-OPC-U13: confirmPartsVisit — slot validation, no write on bad slot', () => {
    beforeEach(() => jobsService.getJobById.mockResolvedValue(JOB));

    test.each([
        ['bad date', { date: '2026/07/07', start: '10:00', end: '12:00' }],
        ['bad start', { date: '2026-07-10', start: '25:99', end: '12:00' }],
        ['end before start (inverted span)', { date: '2026-07-10', start: '12:00', end: '10:00' }],
        ['equal start/end (zero span)', { date: '2026-07-10', start: '10:00', end: '10:00' }],
        ['absent slot', undefined],
    ])('%s → soft refusal, NO rescheduleItem / flip', async (_label, slot) => {
        const out = await confirmPartsVisit.run(CO, L0, { ...INPUT, chosenSlot: slot });
        expect(out.ok).toBe(false);
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
    });

    test('slotSpanIsPositive helper: end<start → false; valid span → true', () => {
        expect(confirmPartsVisit.slotSpanIsPositive({ date: '2026-07-10', start: '12:00', end: '10:00' })).toBe(false);
        expect(confirmPartsVisit.slotSpanIsPositive({ date: '2026-07-10', start: '10:00', end: '12:00' })).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U14: success call order + ZB-409 + flip-fault
// ---------------------------------------------------------------------------

describe('TC-OPC-U14: confirmPartsVisit — success order + failure postures', () => {
    test('success order: getJobById → rescheduleItem → updateBlancStatus → addNote/logEvent → updateTask(done)', async () => {
        const seq = [];
        jobsService.getJobById.mockImplementation(async () => { seq.push('getJobById'); return JOB; });
        scheduleService.rescheduleItem.mockImplementation(async () => { seq.push('rescheduleItem'); return { ok: true }; });
        jobsService.updateBlancStatus.mockImplementation(async () => { seq.push('updateBlancStatus'); return {}; });
        jobsService.addNote.mockImplementation(async () => { seq.push('addNote'); return {}; });
        eventService.logEvent.mockImplementation(() => { seq.push('logEvent'); });
        tasksQueries.updateTask.mockImplementation(async () => { seq.push('updateTask'); return {}; });

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        // rescheduleItem BEFORE the flip; getJobById first; task-close last.
        expect(seq[0]).toBe('getJobById');
        expect(seq.indexOf('rescheduleItem')).toBeLessThan(seq.indexOf('updateBlancStatus'));
        expect(seq.indexOf('updateBlancStatus')).toBeLessThan(seq.indexOf('addNote'));
        expect(seq.indexOf('updateBlancStatus')).toBeLessThan(seq.indexOf('logEvent'));
        expect(seq[seq.length - 1]).toBe('updateTask');

        // Correct arg contracts.
        expect(scheduleService.rescheduleItem).toHaveBeenCalledWith(CO, 'job', 50, expect.any(String), expect.any(String));
        expect(jobsService.updateBlancStatus).toHaveBeenCalledWith(50, 'Rescheduled', CO);
        expect(jobsService.addNote).toHaveBeenCalledWith(
            50, expect.stringMatching(/via AI Phone/i), [], 'AI Phone', 'AI Phone', null, CO
        );
        expect(eventService.logEvent).toHaveBeenCalledWith(CO, 'job', 50, 'job_rescheduled', expect.objectContaining({ actor: 'AI Phone' }), 'system');
        expect(tasksQueries.updateTask).toHaveBeenCalledWith(CO, 70, { status: 'done' });

        expect(out).toMatchObject({ ok: true, success: true, conflict: false, statusFlipped: true, booked: true });
    });

    test('ZB 409 from rescheduleItem → conflict shape; status NOT flipped, task NOT closed, no note', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        const zbErr = new Error('conflict'); zbErr.statusCode = 409;
        scheduleService.rescheduleItem.mockRejectedValue(zbErr);

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        expect(out).toMatchObject({ ok: false, success: false, conflict: true, booked: false });
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(tasksQueries.updateTask).not.toHaveBeenCalled();
        // CC-07 honesty: nothing landed → the attempt is NOT terminalized (it
        // stays 'dialing' for the webhook to classify by endedReason).
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('reschedule OK but flip throws → success with statusFlipped:false, booked:false, task left OPEN', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        jobsService.updateBlancStatus.mockRejectedValue(new Error('fsm flip failed'));

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        expect(out).toMatchObject({ ok: true, success: true, statusFlipped: false, booked: false });
        // Reschedule DID land, so the note/event still write (guarded, non-fatal).
        expect(scheduleService.rescheduleItem).toHaveBeenCalledTimes(1);
        // But the task is NOT closed on an unflipped booking.
        expect(tasksQueries.updateTask).not.toHaveBeenCalled();
    });

    test('note/event throw after a landed booking → still success (guarded, non-fatal)', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        jobsService.addNote.mockRejectedValue(new Error('note hiccup'));
        eventService.logEvent.mockImplementation(() => { throw new Error('event hiccup'); });

        const out = await confirmPartsVisit.run(CO, L0, INPUT);
        expect(out).toMatchObject({ ok: true, success: true, statusFlipped: true, booked: true });
        // A note failure does not block the task-close on a fully committed booking.
        expect(tasksQueries.updateTask).toHaveBeenCalledWith(CO, 70, { status: 'done' });
    });
});

// ---------------------------------------------------------------------------
// CC-07 (CANCEL-001): booked-before-flip — the robot's own attempt is
// terminalized BEFORE the status transition, so the jobsService leave-hook
// (fireRobotCallLeaveHook → cancelScheduledRobotCalls) no-ops on the robot's
// own successful booking instead of writing a false "robot call canceled"
// note + mid-flight marker beside the "Appointment rescheduled" note.
// ---------------------------------------------------------------------------

describe('CC-07: confirmPartsVisit — booked-before-flip terminalizes own attempt', () => {
    test('PIN: dialing attempt is UPDATEd to booked BEFORE the flip; leave-hook would see no active row; no canceled note', async () => {
        const seq = [];
        // Simulated attempt row: the mock db flips it exactly as the real UPDATE
        // (company+job+'dialing' → 'booked') would.
        const attemptRow = { status: 'dialing' };

        jobsService.getJobById.mockImplementation(async () => { seq.push('getJobById'); return JOB; });
        scheduleService.rescheduleItem.mockImplementation(async () => { seq.push('rescheduleItem'); return { ok: true }; });
        mockDbQuery.mockImplementation(async (sql) => {
            seq.push('stampBooked');
            if (/SET status = 'booked'/.test(sql) && attemptRow.status === 'dialing') {
                attemptRow.status = 'booked';
                return { rowCount: 1, rows: [] };
            }
            return { rowCount: 0, rows: [] };
        });
        jobsService.updateBlancStatus.mockImplementation(async () => {
            seq.push('updateBlancStatus');
            // Integration-reasoning pin: at flip time — the moment the REAL
            // leave-hook fires its active-rows SELECT
            // (WHERE status IN ('pending','dialing'), partsCallService cancel
            // core) — the robot's own attempt is ALREADY terminal, so the hook
            // finds nothing → {canceled:0} → no note, no marker, no event.
            expect(['pending', 'dialing']).not.toContain(attemptRow.status);
            expect(attemptRow.status).toBe('booked');
            return {};
        });

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        // SQL ORDER: committed reschedule → booked-stamp → status flip.
        expect(seq.indexOf('rescheduleItem')).toBeLessThan(seq.indexOf('stampBooked'));
        expect(seq.indexOf('stampBooked')).toBeLessThan(seq.indexOf('updateBlancStatus'));

        // Exact UPDATE contract: terminal 'booked', scoped company+job+'dialing'
        // (no vapi call id reaches the skill input — job-scope is sufficient by
        // the partial-unique active-attempt index).
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/UPDATE outbound_call_attempts/);
        expect(sql).toMatch(/SET status = 'booked'/);
        expect(sql).toMatch(/status = 'dialing'/);
        expect(params).toEqual([CO, 50]);

        // NO cancel side-effects anywhere in this flow: the only db write is the
        // booked-stamp (no 'canceled' SQL), and the only job note is the
        // reschedule note — never the FR-3 "robot call canceled" copy.
        expect(mockDbQuery.mock.calls.every(([q]) => !/canceled/i.test(q))).toBe(true);
        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote).toHaveBeenCalledWith(
            50, expect.stringMatching(/^Appointment rescheduled/), [], 'AI Phone', 'AI Phone', null, CO
        );
        expect(jobsService.addNote).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/canceled/i), expect.anything(), expect.anything(), expect.anything());

        expect(out).toMatchObject({ ok: true, success: true, statusFlipped: true, booked: true });
    });

    test('booked-stamp UPDATE rejects → booking still completes (non-fatal): flip, note, task-close all land', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        mockDbQuery.mockRejectedValue(new Error('attempts table down'));

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        expect(out).toMatchObject({ ok: true, success: true, conflict: false, statusFlipped: true, booked: true });
        expect(jobsService.updateBlancStatus).toHaveBeenCalledWith(50, 'Rescheduled', CO);
        expect(jobsService.addNote).toHaveBeenCalledWith(
            50, expect.stringMatching(/via AI Phone/i), [], 'AI Phone', 'AI Phone', null, CO
        );
        expect(tasksQueries.updateTask).toHaveBeenCalledWith(CO, 70, { status: 'done' });
    });

    test('no dialing attempt (inbound booking, no robot plan) → UPDATE matches 0 rows, flow unchanged', async () => {
        jobsService.getJobById.mockResolvedValue(JOB);
        mockDbQuery.mockResolvedValue({ rowCount: 0, rows: [] });

        const out = await confirmPartsVisit.run(CO, L0, INPUT);

        // The stamp still ran once (harmless 0-row no-op)…
        expect(mockDbQuery).toHaveBeenCalledTimes(1);
        expect(mockDbQuery.mock.calls[0][1]).toEqual([CO, 50]);
        // …and the booking flow is byte-identical to the pre-CC-07 success path.
        expect(jobsService.updateBlancStatus).toHaveBeenCalledWith(50, 'Rescheduled', CO);
        expect(tasksQueries.updateTask).toHaveBeenCalledWith(CO, 70, { status: 'done' });
        expect(out).toMatchObject({ ok: true, success: true, statusFlipped: true, booked: true });
    });
});
