/**
 * agentSkills / skills / confirmPartsVisit — WRITE, L0 (OUTBOUND surface)
 * (OUTBOUND-PARTS-CALL-001, spec §C.5 / S2 / S3 / S8 · architecture Decision E + Deviation 1 · task OPC1-T13)
 *
 * The in-call booking write for the OUTBOUND "part arrived → finish the visit"
 * assistant. Server-initiated to a PRE-BOUND known contact; identity
 * (contactId / jobId / taskId / companyId) is injected from the assistant's
 * `assistantOverrides.variableValues` into the skill input, NOT a caller claim.
 *
 * It is a THIN COMPOSITION of pieces that already exist and are verified:
 *   - `scheduleService.rescheduleItem`  (SAME-job reschedule + AR-4 ZB write-through)
 *   - `jobsService.updateBlancStatus`   (FSM flip to 'Rescheduled')
 *   - `jobsService.addNote` + `eventService.logEvent`  (AI-Phone audit)
 *   - `tasksQueries.updateTask`         (close the open part_arrived_call task)
 * Nothing here is forked — the skill only orders and isolates.
 *
 * CANCEL-001 (CC-07, booked-before-flip): between the committed reschedule and
 * the status flip, the skill terminalizes its OWN in-flight attempt
 * (`outbound_call_attempts` company+job+'dialing' → 'booked', non-fatal) so the
 * updateBlancStatus leave-hook no-ops instead of writing a false "robot call
 * canceled" note + marker on the robot's own successful booking.
 *
 * ── L0 on the outbound surface (Deviation 1) ────────────────────────────────
 *   Registered `requiredLevel:'L0'`, so it is NOT gated behind the inbound
 *   `verificationGate` (an outbound call has no caller-claimed identity to
 *   verify). Isolation is preserved ENTIRELY in-skill:
 *     (a) companyId comes from the argument (DEFAULT_COMPANY_ID on the VAPI seam);
 *     (b) an ownership pre-check reads the bound job scoped to companyId AND
 *         re-confirms it belongs to the bound contact BEFORE any mutation.
 *   A cross-company / cross-contact job is indistinguishable from "not found" →
 *   safe refusal, no write, no ZB push, no status flip, no task-close.
 *
 *   Ownership key = the bound contactId. `deriveLevel` returns
 *   `verifiedContext.contactId:null` at L0 (no confident phone match on an
 *   outbound dial), so the authoritative key is the `contactId` injected via
 *   variableValues into `input`. We prefer `verifiedContext.contactId` when the
 *   gate DID resolve one (defensive), else fall back to `input.contactId`.
 *
 * ── POSTURE — no false success (spec §C.5 step 3 / S8 / edge-4) ─────────────
 *   Reschedule FIRST, flip the status ONLY after it commits. On a ZB 409 /
 *   conflict, return a graceful conflict shape — NO status flip, NO note, NO
 *   task-close, NO attempt-booked — identical to `rescheduleAppointment.js`.
 *   If the reschedule LANDS but the downstream status-flip throws (edge-4), the
 *   visit IS booked (Albusto + ZB already committed): we do NOT report a
 *   conflict (that would be a false failure), we DO surface success but leave
 *   the task OPEN and skip attempt-booked so a dispatcher confirms the flip.
 */

'use strict';

const resultShapes = require('../resultShapes');
// Reuse the slot helpers verbatim from rescheduleAppointment (single source of
// truth for DST-aware slotPartsToIso / windowPhrase / isConfirmedSlot / the ZB
// conflict classifier) — same reschedule + ZB seam, so the same interpretation.
const {
    slotPartsToIso,
    windowPhrase,
    isConfirmedSlot,
    isConflictLike,
} = require('./rescheduleAppointment');

/**
 * The confirmed slot must ALSO be non-inverted: `end` strictly after `start` on
 * the same date. `isConfirmedSlot` only validates the string SHAPE, so a
 * malformed `end < start` (TC-OPC-U13, edge-9) would otherwise yield a negative
 * `arrival_window_minutes`. Guard it before deriving the ISO instants.
 * @param {{ date?: string, start?: string, end?: string }} slot
 * @returns {boolean} true when start/end parse and end is strictly after start.
 */
function slotSpanIsPositive(slot) {
    const startIso = slotPartsToIso(slot.date, slot.start);
    const endIso = slotPartsToIso(slot.date, slot.end);
    if (!startIso || !endIso) return false;
    return new Date(endIso).getTime() > new Date(startIso).getTime();
}

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on the VAPI seam).
 * @param {{ level: string, contactId: number|null }} verifiedContext Server-built; L0 on outbound (contactId usually null).
 * @param {{ chosenSlot?: object, jobId?: string|number, taskId?: string|number, contactId?: string|number }} input
 *   Skill payload — `chosenSlot` from the tool args; identity (jobId/taskId/contactId) injected from variableValues.
 * @returns {Promise<object>} A provider-neutral, speech-safe booking result.
 */
async function run(companyId, verifiedContext, input) {
    const jobsService = require('../../jobsService');
    const scheduleService = require('../../scheduleService');
    const eventService = require('../../eventService');
    const tasksQueries = require('../../../db/tasksQueries');

    const src = input && typeof input === 'object' ? input : {};
    // `chosenSlot` is the outbound tool's slot param; accept `newPreferredSlot`
    // as a defensive alias so the same skill also works if driven like reschedule.
    const slot = src.chosenSlot || src.newPreferredSlot;
    const jobId = src.jobId;
    const taskId = src.taskId;
    // Ownership key: prefer a gate-resolved contactId (defensive), else the
    // bound contactId injected from variableValues.
    const boundContactId =
        verifiedContext && verifiedContext.contactId != null
            ? verifiedContext.contactId
            : (src.contactId != null ? src.contactId : null);

    // --- Guard 0: we must have a bound job AND a bound contact to isolate against.
    if (jobId == null || boundContactId == null) {
        return resultShapes.refusal(
            "I couldn't pull up that visit to book — let me have a teammate follow up with you.",
        );
    }

    // --- Guard 1 (P0 isolation, Deviation 1): ownership pre-check BEFORE any
    //     mutation. Scope the read to companyId and re-confirm the job belongs to
    //     the BOUND contact. Foreign / cross-company / cross-contact is
    //     indistinguishable from "not found" → safe refusal, no write.
    let job;
    try {
        job = await jobsService.getJobById(jobId, companyId);
    } catch (_e) {
        job = null;
    }
    if (!job || String(job.contact_id) !== String(boundContactId)) {
        return resultShapes.refusal(
            "I couldn't find that visit on your account — let me have a teammate follow up with you.",
        );
    }

    // --- Guard 2: a canceled job can't be booked.
    if (job.blanc_status === 'Canceled' || job.zb_canceled) {
        return resultShapes.refusal(
            "That visit is canceled, so there's nothing to schedule — I can help you set up a new one.",
        );
    }

    // --- Guard 3 (confirmed-slot guard, TC-OPC-U13 / edge-9): valid shape AND a
    //     positive span. Malformed / inverted → soft refusal, no write. Only past
    //     this point is `arrival_window_minutes = end − start` derivable (OQ-4).
    if (!isConfirmedSlot(slot) || !slotSpanIsPositive(slot)) {
        return resultShapes.refusal(
            "Let's lock in a time first — which window works best for you?",
            { needsConfirmation: true },
        );
    }

    const newStartAt = slotPartsToIso(slot.date, slot.start);
    const newEndAt = slotPartsToIso(slot.date, slot.end);
    const newWindow = windowPhrase(slot);

    // --- The write. rescheduleItem: authoritative local write FIRST (visible on
    //     the dispatcher schedule immediately), THEN the AR-4 ZB push with
    //     arrival_window_minutes = end − start. On ZB failure it reconciles from
    //     the master and throws the friendly 409 → graceful conflict below, and
    //     NOTHING downstream runs (no flip, no note, no task-close, no booked).
    try {
        await scheduleService.rescheduleItem(companyId, 'job', jobId, newStartAt, newEndAt);
    } catch (err) {
        if (isConflictLike(err)) {
            // Blocking-with-recovery: never a false confirm; state stays recoverable.
            return {
                ok: false,
                success: false,
                conflict: true,
                booked: false,
                newWindow: null,
                speak: 'Let me have a teammate confirm that time and follow up with you shortly.',
            };
        }
        // Any other unexpected throw → the choke-point's SAFE_FALLBACK (no false success).
        throw err;
    }

    // --- CANCEL-001 (CC-07, booked-before-flip): the reschedule is COMMITTED —
    //     if this booking is happening DURING the robot's own call, the attempt
    //     row is still 'dialing', and the status flip below fires the jobsService
    //     leave-hook (fireRobotCallLeaveHook → cancelScheduledRobotCalls), which
    //     would find that row active and write a FALSE "AI: robot call canceled"
    //     note + a mid-flight 'canceled' marker right beside the "Appointment
    //     rescheduled" note — on EVERY successful robot booking. Terminalize the
    //     attempt as honest 'booked' FIRST: the hook's active-rows SELECT then
    //     finds nothing → {canceled:0} no-op (no note, no marker), and the
    //     end-of-call webhook hits its idempotence early-return
    //     (vapiCallStatus.js — non-'dialing' is terminal; 'booked' is the same
    //     value it would have stamped). No VAPI call id reaches the skill input
    //     (variableValues are injected at call-open, before the call id exists),
    //     so the scope is company+job+'dialing' — the partial-unique active index
    //     allows at most ONE such row per job. Also correct on an INBOUND (Sara)
    //     booking while a robot attempt dials the same job: the visit just got
    //     booked, the plan is moot → 'booked' is the honest terminal state.
    //     No-plan bookings simply match 0 rows. NON-FATAL: a stamp fault must
    //     never break the landed booking (require inside the guard too).
    try {
        const db = require('../../../db/connection');
        await db.query(
            `UPDATE outbound_call_attempts
                SET status = 'booked', updated_at = now()
              WHERE company_id = $1 AND job_id = $2 AND status = 'dialing'`,
            [companyId, jobId],
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
            `[agentSkills] confirmPartsVisit attempt booked-stamp failed (non-fatal): ${e && e.message}`,
        );
    }

    // --- Reschedule landed. Flip the status to 'Rescheduled' (reschedule FIRST,
    //     then flip — a flip without a committed reschedule would be wrong).
    //
    //     Edge-4: the reschedule already committed (Albusto + ZB). If the flip
    //     throws, the visit IS booked — reporting a conflict here would be a FALSE
    //     FAILURE. Instead: keep success, but leave the task OPEN and mark the
    //     result `booked:false` so the webhook does NOT mark the attempt `booked`
    //     and a dispatcher reconciles the status. `statusFlipped` tells the caller
    //     which happened.
    let statusFlipped = true;
    try {
        await jobsService.updateBlancStatus(jobId, 'Rescheduled', companyId);
    } catch (e) {
        statusFlipped = false;
        // eslint-disable-next-line no-console
        console.error(
            `[agentSkills] confirmPartsVisit status flip failed after committed reschedule (booked, dispatcher to reconcile): ${e && e.message}`,
        );
    }

    // --- Audit note ("AI Phone") + domain event — guarded so a note/event hiccup
    //     can't turn a landed booking into a failure.
    const noteText = `Appointment rescheduled to ${newWindow} via AI Phone.`;
    try {
        await jobsService.addNote(jobId, noteText, [], 'AI Phone', 'AI Phone');
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] confirmPartsVisit addNote failed (non-fatal): ${e && e.message}`);
    }
    try {
        eventService.logEvent(
            companyId, 'job', jobId, 'job_rescheduled',
            { newWindow, newStartAt, actor: 'AI Phone' }, 'system',
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] confirmPartsVisit logEvent failed (non-fatal): ${e && e.message}`);
    }

    // --- Auto-close the open part_arrived_call task — ONLY when the status flip
    //     also landed (a fully-committed booking). company-scoped: updateTask's
    //     `WHERE company_id = $1 AND id = $2` refuses a foreign id (returns null),
    //     so this can never close another tenant's task. Guarded (non-fatal).
    const attemptBooked = statusFlipped;
    if (statusFlipped && taskId != null) {
        try {
            await tasksQueries.updateTask(companyId, taskId, { status: 'done' });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(`[agentSkills] confirmPartsVisit task close failed (non-fatal): ${e && e.message}`);
        }
    }

    return resultShapes.ok(
        `You're all set — I've booked your visit for ${newWindow}.`,
        {
            success: true,
            conflict: false,
            newWindow,
            statusFlipped,
            // The webhook keys the terminal `booked` attempt off this — false on a
            // landed-but-unflipped booking so a dispatcher reconciles first.
            booked: attemptBooked,
        },
    );
}

module.exports = {
    run,
    // Exported for unit tests.
    slotSpanIsPositive,
};
