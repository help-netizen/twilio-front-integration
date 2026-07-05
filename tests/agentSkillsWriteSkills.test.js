/**
 * agentSkillsWriteSkills.test.js — AGENT-SKILLS-001 T7 (G4 + G5, AR-4/AR-5)
 *
 * Drives the two L2 write skills through the real `runSkill` choke-point with the
 * reused services + verification gate mocked. Proves:
 *   - ownership pre-check (company + verified-contact) BEFORE any mutation (G2 / ASK-ISO-02/03/04),
 *   - reschedule happy path → rescheduleItem + 'AI Phone' note + job_rescheduled event (ASK-WRITE-01/02),
 *   - reschedule ZB-failure (rescheduleItem throws 409) → graceful "teammate" shape, NO false confirm (ASK-WRITE-03),
 *   - reschedule without a confirmed slot → no write (ASK-WRITE-04),
 *   - cancel retention discipline: never on first ask; reason required; strict retentionAttempted===true (G5 / ASK-WRITE-10/11/14),
 *   - cancel happy path → cancelJob + reason-bearing 'AI Phone' note + job_canceled event, no-fee copy (ASK-WRITE-12/13/16),
 *   - already-canceled → no duplicate cancelJob (ASK-WRITE-15),
 *   - AGENT-SKILLS-002: reschedule/cancel relaxed L2→L1 — an L1 (phone-identified) caller
 *     now reschedules/cancels their OWN job (ASK-WRITE-L1/L1b), while an L0/unresolved
 *     caller self-asserting verified:true is still refused (AC-8 core preserved). Ownership
 *     + retention discipline unchanged at L1.
 *
 * The `rescheduleItem` ZB seam itself is proven separately in
 * `tests/scheduleServiceRescheduleZb.test.js`; here `scheduleService` is mocked so
 * these assertions isolate the SKILL contract.
 */

'use strict';

const AGENT = '../backend/src/services/agentSkills';
const CO = '00000000-0000-0000-0000-000000000001';
const CONTACT = 501;

// The gate: default-grant L2 so happy paths run; override per-test for the L1 block.
// assert() is the REAL implementation so a genuine sub-L2 context throws exactly as
// in production (index.js turns it into the soft needsVerification shape).
jest.mock('../backend/src/services/agentSkills/verificationGate', () => {
    const REAL = jest.requireActual('../backend/src/services/agentSkills/verificationGate');
    return { ...REAL, deriveLevel: jest.fn() };
});
const gate = require('../backend/src/services/agentSkills/verificationGate');

jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    cancelJob: jest.fn(async () => ({ blanc_status: 'Canceled', zb_canceled: true })),
    addNote: jest.fn(async () => ({ notes: [] })),
    syncFromZenbooker: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    rescheduleItem: jest.fn(async () => ({ entity_type: 'job', entity_id: 7, start_at: 'x', end_at: 'y', zb: { linked: true, pushed: true, skipped: null } })),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn(() => {}) }));

const jobsService = require('../backend/src/services/jobsService');
const scheduleService = require('../backend/src/services/scheduleService');
const eventService = require('../backend/src/services/eventService');
const { runSkill } = require(AGENT);

const L2JOB = { id: 7, contact_id: CONTACT, blanc_status: 'Submitted', zb_canceled: false, zenbooker_job_id: 'zb_7' };
const SLOT = { date: '2026-07-10', start: '10:00', end: '12:00' };

beforeEach(() => {
    jest.clearAllMocks();
    gate.deriveLevel.mockResolvedValue({ level: 'L2', contactId: CONTACT, customerName: 'Jane Doe', matchedPhone: '6175551212' });
});

describe('rescheduleAppointment (L2 write) — G4 / AR-4 / AR-5', () => {
    test('ASK-WRITE-01/02: happy path → rescheduleItem + AI Phone note + job_rescheduled event + confirmed shape', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('rescheduleAppointment', CO, { source: 'test' }, { jobId: 7, newPreferredSlot: SLOT });
        expect(scheduleService.rescheduleItem).toHaveBeenCalledWith(CO, 'job', 7, expect.any(String), expect.any(String));
        expect(jobsService.addNote).toHaveBeenCalledWith(7, expect.stringMatching(/rescheduled/i), [], 'AI Phone', 'AI Phone');
        expect(eventService.logEvent).toHaveBeenCalledWith(CO, 'job', 7, 'job_rescheduled', expect.objectContaining({ actor: 'AI Phone' }), 'system');
        expect(out).toMatchObject({ ok: true, success: true, conflict: false });
        expect(out.newWindow).toMatch(/between 10am and 12pm/);
        // the start handed to rescheduleItem is a real ISO 8601 instant
        const startArg = scheduleService.rescheduleItem.mock.calls[0][3];
        expect(new Date(startArg).toISOString()).toBe(startArg);
    });

    test('ASK-ISO-04: foreign job (getJobById → null) → NO rescheduleItem, safe refusal, no note', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 999, newPreferredSlot: SLOT });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('cross-contact job (contact_id mismatch) → NO rescheduleItem, safe refusal', async () => {
        jobsService.getJobById.mockResolvedValue({ ...L2JOB, contact_id: 999 });
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 7, newPreferredSlot: SLOT });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('ASK-WRITE-04: no confirmed newPreferredSlot → no write, needsConfirmation', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 7, newPreferredSlot: { date: '2026-07-10' } });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: false, needsConfirmation: true });
    });

    test('ASK-WRITE-03: ZB failure (rescheduleItem throws 409) → graceful teammate shape, NO false confirm, NO note/event', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        scheduleService.rescheduleItem.mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 }));
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 7, newPreferredSlot: SLOT });
        expect(out).toMatchObject({ ok: false, success: false, conflict: true });
        expect(out.speak).toMatch(/teammate confirm that time/i);
        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    test('canceled job → refusal, no reschedule write', async () => {
        jobsService.getJobById.mockResolvedValue({ ...L2JOB, blanc_status: 'Canceled', zb_canceled: true });
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 7, newPreferredSlot: SLOT });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('AC-8: an L0 (unresolved) caller self-asserting verified:true → needsVerification, rescheduleItem NEVER called (claim ignored)', async () => {
        // AGENT-SKILLS-002 relaxed reschedule L2→L1, so an L1 caller now PASSES (see
        // ASK-WRITE-L1 below). The AC-8 core (a client verified:true / level:L2 has NO
        // effect) is re-expressed at the boundary that DIDN'T move: an L0/unresolved
        // caller is STILL refused — the gate re-derives L0 from the DB, never the claim.
        gate.deriveLevel.mockResolvedValue({ level: 'L0', contactId: null, customerName: null });
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('rescheduleAppointment', CO, {}, { verified: true, level: 'L2', jobId: 7, newPreferredSlot: SLOT });
        expect(out).toMatchObject({ ok: false, needsVerification: true });
        expect(scheduleService.rescheduleItem).not.toHaveBeenCalled();
        expect(jobsService.getJobById).not.toHaveBeenCalled(); // gate refused before the skill ran
    });

    test('ASK-WRITE-L1: an L1 (phone-identified) caller now reschedules their OWN job (L2→L1 relaxation), ownership + write happen', async () => {
        // The relaxation makes reschedule reachable at L1. A phone-only identity (no L2
        // second factor: zips empty) now clears the gate; the skill's own ownership
        // pre-check passes (the job is the verified contact's) → the real write path runs.
        gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane', matchedPhone: '6175551212' });
        jobsService.getJobById.mockResolvedValue(L2JOB);
        // Explicit happy-path stub — clearAllMocks() keeps a prior mockRejectedValue impl,
        // so restore the successful reschedule for this case (order-independent).
        scheduleService.rescheduleItem.mockResolvedValue({ entity_type: 'job', entity_id: 7, start_at: 'x', end_at: 'y', zb: { linked: true, pushed: true, skipped: null } });
        const out = await runSkill('rescheduleAppointment', CO, {}, { jobId: 7, newPreferredSlot: SLOT });
        expect(out).toMatchObject({ ok: true, success: true, conflict: false });
        expect(out.needsVerification).toBeUndefined();
        expect(scheduleService.rescheduleItem).toHaveBeenCalledWith(CO, 'job', 7, expect.any(String), expect.any(String));
    });

    test('ASK-WRITE-L1b: an L1 caller cancels their OWN job (L2→L1) with the retention discipline intact', async () => {
        gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane', matchedPhone: '6175551212' });
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'timing', retentionAttempted: true });
        expect(out).toMatchObject({ ok: true, success: true });
        expect(jobsService.cancelJob).toHaveBeenCalledWith(7);
        // retention still enforced at L1: first-ask (no retention) is still refused
        jest.clearAllMocks();
        gate.deriveLevel.mockResolvedValue({ level: 'L1', contactId: CONTACT, customerName: 'Jane', matchedPhone: '6175551212' });
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const firstAsk = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price', retentionAttempted: false });
        expect(firstAsk).toMatchObject({ ok: false, retentionRequired: true });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
    });
});

describe('cancelAppointment (L2 write, retention-gated) — G5 / AR-5', () => {
    test('ASK-WRITE-12/13: happy path → cancelJob + reason-bearing AI Phone note + job_canceled event', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'found-someone', retentionAttempted: true });
        expect(jobsService.cancelJob).toHaveBeenCalledWith(7);
        expect(jobsService.addNote).toHaveBeenCalledWith(7, expect.stringContaining('found-someone'), [], 'AI Phone', 'AI Phone');
        expect(eventService.logEvent).toHaveBeenCalledWith(CO, 'job', 7, 'job_canceled', expect.objectContaining({ reason: 'found-someone', retentionAttempted: true, actor: 'AI Phone' }), 'system');
        expect(out).toMatchObject({ ok: true, success: true, status: 'That appointment is canceled.' });
    });

    test('ASK-WRITE-10: retentionAttempted:false → REJECTED, cancelJob NOT called (never on first ask)', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price', retentionAttempted: false });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: false, retentionRequired: true });
    });

    test('ASK-WRITE-10: retentionAttempted ABSENT → REJECTED, no cancel', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price' });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('ASK-WRITE-14: retentionAttempted truthy-but-not-boolean ("true") → REJECTED (strict ===true)', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price', retentionAttempted: 'true' });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('ASK-WRITE-11: empty reason → REJECTED (needsReason), no cancel', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: '', retentionAttempted: true });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: false, needsReason: true });
    });

    test('ASK-ISO-02: foreign job (null) → refusal, cancelJob NOT called (retention gate passed first)', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 999, reason: 'price', retentionAttempted: true });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('ASK-ISO-03: contact mismatch → refusal, cancelJob NOT called (ownership is contact-scoped)', async () => {
        jobsService.getJobById.mockResolvedValue({ ...L2JOB, contact_id: 999 });
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price', retentionAttempted: true });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out.ok).toBe(false);
    });

    test('ASK-WRITE-15: already-canceled job → "already canceled", cancelJob NOT called (no duplicate)', async () => {
        jobsService.getJobById.mockResolvedValue({ ...L2JOB, blanc_status: 'Canceled', zb_canceled: true });
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'price', retentionAttempted: true });
        expect(jobsService.cancelJob).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: true, alreadyCanceled: true });
    });

    test('ASK-WRITE-16: happy-path speak states no cancellation fee (free before visit, Decided default A)', async () => {
        jobsService.getJobById.mockResolvedValue(L2JOB);
        const out = await runSkill('cancelAppointment', CO, {}, { jobId: 7, reason: 'timing', retentionAttempted: true });
        expect(out.speak).toMatch(/no cancellation fee/i);
    });
});
