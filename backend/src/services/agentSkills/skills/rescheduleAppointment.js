/**
 * agentSkills / skills / rescheduleAppointment  — WRITE, L2
 * (AGENT-SKILLS-001, spec §4.5 / §5.2 / §5.3 · architecture §5, S5 · task T7 — P0 gate G4)
 *
 * Move a VERIFIED customer's appointment: write Albusto (authoritative,
 * synchronous — the dispatcher schedule reflects it immediately) AND push
 * Zenbooker through the AR-4 seam now wired into `scheduleService.rescheduleItem`.
 *
 * POSTURE — blocking-with-recovery at the service layer, graceful at the skill
 * layer (spec §5.3 / edge E4):
 *   - The service (`rescheduleItem`) commits the local write first, then pushes ZB;
 *     if ZB fails it reconciles from the master and THROWS a friendly 409.
 *   - This skill CATCHES that 409 (and any conflict) and returns a graceful shape
 *     that does NOT falsely confirm — "let me have a teammate confirm that time" —
 *     leaving state recoverable. The customer is never told it succeeded when the
 *     master didn't accept it.
 *
 * P0 GUARANTEES:
 *   - Verification: the choke-point already enforced L2 before `run` is reached
 *     (registry requiredLevel:'L2'); `verifiedContext.contactId` is the DB-derived,
 *     server-confirmed contact — never a client claim.
 *   - Company + contact isolation: `rescheduleItem`'s target takes only `jobId`, so
 *     we FIRST `getJobById(jobId, companyId)` and confirm the job belongs to
 *     `companyId` AND to `verifiedContext.contactId` BEFORE any mutation. A
 *     cross-company / cross-contact job → safe refusal, no write, no ZB push, no note
 *     (ASK-ISO-04).
 *   - Confirm old→new before writing (AC-4 / ASK-WRITE-04): no write without a
 *     valid confirmed `newPreferredSlot` (the offer/confirm happen across turns; this
 *     write skill only runs after confirmation).
 *   - Audit note "AI Phone" + a `job_rescheduled` domain event on EVERY successful
 *     write (AR-5) — never on a failed/blocked write.
 */

'use strict';

const resultShapes = require('../resultShapes');

/**
 * Combine a slot `date` (YYYY-MM-DD) + `HH:MM` time into an ISO 8601 instant in the
 * dispatch timezone (default America/New_York). The reschedule offer surfaces slots
 * in ET (`scheduleService.getAvailableSlots`), so we interpret the confirmed slot in
 * the same zone and hand ZB a correct absolute instant.
 * @param {string} date  YYYY-MM-DD
 * @param {string} hhmm  HH:MM (24h)
 * @param {string} timeZone IANA zone (default America/New_York)
 * @returns {string|null} ISO 8601 string, or null if the inputs don't parse.
 */
function slotPartsToIso(date, hhmm, timeZone = 'America/New_York') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
    if (!/^\d{1,2}:\d{2}$/.test(String(hhmm || ''))) return null;
    const [h, m] = hhmm.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    // Resolve the timezone's UTC offset for THIS local wall-clock date/time, then
    // build the exact UTC instant. Two-pass (guess UTC, measure the zone's rendered
    // offset, correct) so DST is handled without a date library.
    const [Y, Mo, D] = date.split('-').map(Number);
    const guess = Date.UTC(Y, Mo - 1, D, h, m, 0);
    const offsetMin = tzOffsetMinutes(guess, timeZone);
    const actual = guess - offsetMin * 60000;
    const d = new Date(actual);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The offset (minutes east of UTC) the given IANA zone applies at instant `utcMs`.
 * e.g. America/New_York in July → -240. Uses Intl only (no date library).
 * @param {number} utcMs
 * @param {string} timeZone
 * @returns {number}
 */
function tzOffsetMinutes(utcMs, timeZone) {
    try {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const parts = dtf.formatToParts(new Date(utcMs));
        const map = {};
        for (const p of parts) map[p.type] = p.value;
        const asUTC = Date.UTC(
            Number(map.year), Number(map.month) - 1, Number(map.day),
            Number(map.hour), Number(map.minute), Number(map.second),
        );
        return Math.round((asUTC - utcMs) / 60000);
    } catch (_e) {
        return 0; // fall back to UTC if the zone is unknown
    }
}

/**
 * 24h "HH:MM" → a speech-safe 12h phrase ("10:00" → "10am", "13:30" → "1:30pm").
 * @param {string} hhmm
 * @returns {string}
 */
function speakHour(hhmm) {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    if (Number.isNaN(h)) return '';
    const suffix = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

/**
 * Build the human window range ("between 10am and 12pm") from the confirmed slot,
 * preferring the slot's own `label` when it already reads as a full phrase.
 * @param {{ date?: string, start?: string, end?: string, label?: string }} slot
 * @returns {string}
 */
function windowPhrase(slot) {
    if (slot && typeof slot.label === 'string' && slot.label.trim()) return slot.label.trim();
    const a = speakHour(slot && slot.start);
    const b = speakHour(slot && slot.end);
    if (a && b) return `between ${a} and ${b}`;
    return a || b || 'the new time';
}

/**
 * A confirmed slot must carry a parseable date + start + end. Missing/empty → not
 * confirmed (offer/confirm happen across turns; the write only runs after it).
 * @param {*} slot
 * @returns {boolean}
 */
function isConfirmedSlot(slot) {
    return Boolean(
        slot && typeof slot === 'object' &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(slot.date || '')) &&
        /^\d{1,2}:\d{2}$/.test(String(slot.start || '')) &&
        /^\d{1,2}:\d{2}$/.test(String(slot.end || '')),
    );
}

/**
 * Is this thrown error the blocking-with-recovery 409 (or any conflict/not-found)?
 * `forceSyncOnZbError` throws `{ statusCode: 409 }`; `ScheduleServiceError` carries
 * `httpStatus`/`code`. Either way the correct customer-facing outcome is the same
 * graceful "teammate will confirm" shape — NEVER a false success.
 * @param {*} err
 * @returns {boolean}
 */
function isConflictLike(err) {
    if (!err) return false;
    if (err.statusCode === 409 || err.httpStatus === 409) return true;
    if (err.code === 'NOT_FOUND') return true;
    return false;
}

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on voice/public-MCP).
 * @param {{ level: string, contactId: number|null }} verifiedContext Server-derived; L2 guaranteed by the gate.
 * @param {{ jobId?: string|number, newPreferredSlot?: object }} input Skill-specific fields (+ identity block, ignored here).
 * @returns {Promise<object>} A provider-neutral, speech-safe reschedule result.
 */
async function run(companyId, verifiedContext, input) {
    const jobsService = require('../../jobsService');
    const scheduleService = require('../../scheduleService');
    const eventService = require('../../eventService');

    const src = input && typeof input === 'object' ? input : {};
    const jobId = src.jobId;
    const slot = src.newPreferredSlot;
    const verifiedContactId = verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;

    // --- Guard 0: we must have a job id and a resolved verified contact.
    if (jobId == null || verifiedContactId == null) {
        return resultShapes.refusal("I couldn't find that appointment to move — let me have a teammate follow up with you.");
    }

    // --- Guard 1 (P0 isolation): ownership pre-check BEFORE any mutation. The
    //     reschedule target takes only jobId, so we scope the read to companyId and
    //     re-confirm the job belongs to the VERIFIED contact. A foreign / cross-
    //     contact job is indistinguishable from "not found" — safe refusal, no write.
    let job;
    try {
        job = await jobsService.getJobById(jobId, companyId);
    } catch (_e) {
        job = null;
    }
    if (!job || String(job.contact_id) !== String(verifiedContactId)) {
        return resultShapes.refusal("I couldn't find that appointment on your account — let me have a teammate follow up with you.");
    }

    // --- Guard 2: a canceled job can't be rescheduled.
    if (job.blanc_status === 'Canceled' || job.zb_canceled) {
        return resultShapes.refusal("That appointment is canceled, so there's nothing to move — I can help you book a new one.");
    }

    // --- Guard 3 (AC-4 / ASK-WRITE-04): no write without a confirmed new window.
    if (!isConfirmedSlot(slot)) {
        return resultShapes.refusal("Let's lock in a new time first — which window works best for you?", { needsConfirmation: true });
    }

    // Build the absolute instants (ET) for the confirmed slot.
    const newStartAt = slotPartsToIso(slot.date, slot.start);
    const newEndAt = slotPartsToIso(slot.date, slot.end);
    if (!newStartAt || !newEndAt) {
        return resultShapes.refusal("Let's lock in a new time first — which window works best for you?", { needsConfirmation: true });
    }
    const newWindow = windowPhrase(slot);

    // --- The write. rescheduleItem: authoritative local write FIRST (synchronous →
    //     visible on the dispatcher schedule immediately), THEN the AR-4 ZB push.
    //     On ZB failure it reconciles from the master and throws the friendly 409 →
    //     we return the graceful shape below and DO NOT write the audit note.
    try {
        await scheduleService.rescheduleItem(companyId, 'job', jobId, newStartAt, newEndAt);
    } catch (err) {
        if (isConflictLike(err)) {
            // Blocking-with-recovery: never a false confirm. State stays recoverable.
            return {
                ok: false,
                success: false,
                conflict: true,
                newWindow: null,
                speak: 'Let me have a teammate confirm that time and follow up with you shortly.',
            };
        }
        // Any other unexpected throw → the choke-point's SAFE_FALLBACK (no false success).
        throw err;
    }

    // --- Success: audit note ("AI Phone") + domain event (AR-5). Both are guarded so
    //     a note/event hiccup can't turn a successful reschedule into a failure —
    //     the write already landed in Albusto + ZB.
    const noteText = `Appointment rescheduled to ${newWindow} via AI Phone.`;
    try {
        await jobsService.addNote(
            jobId,
            noteText,
            [],
            'AI Phone',
            'AI Phone',
            null,
            companyId
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] rescheduleAppointment addNote failed (non-fatal): ${e && e.message}`);
    }
    try {
        eventService.logEvent(
            companyId, 'job', jobId, 'job_rescheduled',
            { newWindow, newStartAt, actor: 'AI Phone' }, 'system',
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] rescheduleAppointment logEvent failed (non-fatal): ${e && e.message}`);
    }

    return resultShapes.ok(
        `You're all set — I've moved your appointment to ${newWindow}.`,
        { success: true, newWindow, conflict: false },
    );
}

module.exports = {
    run,
    // Exported for unit tests.
    slotPartsToIso,
    windowPhrase,
    isConfirmedSlot,
    isConflictLike,
};
