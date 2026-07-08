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
 *
 * The skill require()s its deps lazily inside run(), so they are jest.mocked at
 * the module boundary. NO real DB, NO real ZB, NO dial.
 */

'use strict';

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
        expect(jobsService.addNote).toHaveBeenCalledWith(50, expect.stringMatching(/via AI Phone/i), [], 'AI Phone', 'AI Phone');
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
