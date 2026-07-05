/**
 * agentSkills / skills / cancelAppointment  — WRITE, L2 (retention-gated)
 * (AGENT-SKILLS-001, spec §4.6 / §5.4 · architecture §5, S6 · task T7 — P0 gate G5)
 *
 * Cancel a VERIFIED customer's appointment — but ONLY after exactly one genuine
 * retention attempt, and ONLY with a captured reason recorded on the job note.
 *
 * RETENTION DISCIPLINE (G5), enforced server-side (not just in the prompt):
 *   - `reason` is REQUIRED (non-empty). A cancel with an empty/missing reason is
 *     REJECTED — soft "I need to note why" shape, no cancel (ASK-WRITE-11 / E14).
 *   - `retentionAttempted:true` is REQUIRED. The offer/save-attempt happens in the
 *     conversation across turns; the write skill requires the flag as proof that
 *     EXACTLY ONE save attempt already happened. A call with the flag falsey/absent
 *     is REJECTED — NEVER cancel on the first ask (ASK-WRITE-10 / E14). The skill
 *     does not itself loop retention or cancel twice (ASK-WRITE-14).
 *
 * P0 GUARANTEES:
 *   - Verification: L2 already enforced by the choke-point (registry requiredLevel).
 *   - Company + contact isolation: `cancelJob(jobId)` takes ONLY `jobId` (no company
 *     arg — the P0 trap), so we FIRST `getJobById(jobId, companyId)` and confirm the
 *     job belongs to `companyId` AND to `verifiedContext.contactId` BEFORE calling
 *     `cancelJob`. A cross-company / cross-contact job → safe refusal, no cancel
 *     (ASK-ISO-02 / ASK-ISO-03).
 *   - Audit note "AI Phone" INCLUDING the reason on EVERY successful cancel (AR-5 /
 *     ASK-WRITE-13) + a `job_canceled` domain event with { reason, retentionAttempted }.
 *   - Cancel is free before the visit; the skill captures the reason and states no
 *     fee (Decided default A / ASK-WRITE-16).
 *
 * `cancelJob` already ZB-pushes (`zenbookerClient.cancelJob` + `forceSyncOnZbError`)
 * and pre-checks `zb_canceled` — so the ZB side-effect + recovery is inherited; this
 * skill adds only the ownership gate, the retention gate, the reason note, and the event.
 */

'use strict';

const resultShapes = require('../resultShapes');

/**
 * A speech-safe phrase for a captured cancel reason (used in the confirming
 * `speak`). Unknown/free-text reasons fall through to a neutral phrase; the raw
 * reason is still recorded verbatim on the note + event.
 * @param {string} reason
 * @returns {string}
 */
function reasonPhrase(reason) {
    switch (String(reason || '').trim().toLowerCase()) {
        case 'price': return 'the price';
        case 'timing': return 'the timing';
        case 'found-someone': return 'having found someone else';
        case 'fixed-itself': return 'the issue resolving on its own';
        case 'no-longer-needed': return 'no longer needing it';
        default: return 'that';
    }
}

/**
 * The retention gate: a cancel may proceed ONLY when a non-empty reason is present
 * AND exactly one save attempt has been made (`retentionAttempted === true`, strict).
 * @param {{ reason?: string, retentionAttempted?: * }} src
 * @returns {{ ok: boolean, missing: 'reason'|'retention'|null, reason: string }}
 */
function retentionGate(src) {
    const reason = String(src && src.reason != null ? src.reason : '').trim();
    if (!reason) return { ok: false, missing: 'reason', reason: '' };
    // Strict true — a truthy string/1 does NOT satisfy the "exactly one genuine
    // attempt" proof; the conversation must send the boolean after the save attempt.
    if (src.retentionAttempted !== true) return { ok: false, missing: 'retention', reason };
    return { ok: true, missing: null, reason };
}

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on voice/public-MCP).
 * @param {{ level: string, contactId: number|null }} verifiedContext Server-derived; L2 guaranteed by the gate.
 * @param {{ jobId?: string|number, reason?: string, retentionAttempted?: boolean }} input Skill-specific fields (+ identity block, ignored here).
 * @returns {Promise<object>} A provider-neutral, speech-safe cancel result.
 */
async function run(companyId, verifiedContext, input) {
    const jobsService = require('../../jobsService');
    const eventService = require('../../eventService');

    const src = input && typeof input === 'object' ? input : {};
    const jobId = src.jobId;
    const verifiedContactId = verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;

    // --- Guard 0: need a job id and a resolved verified contact.
    if (jobId == null || verifiedContactId == null) {
        return resultShapes.refusal("I couldn't find that appointment to cancel — let me have a teammate follow up with you.");
    }

    // --- Retention gate (G5) BEFORE the ownership read/mutation. Reject cancel-on-
    //     first-ask (no retentionAttempted) and empty reason — no cancel either way.
    const gate = retentionGate(src);
    if (!gate.ok) {
        if (gate.missing === 'reason') {
            return resultShapes.refusal(
                "I want to make sure I note this correctly — can you tell me the main reason you'd like to cancel?",
                { needsReason: true },
            );
        }
        // missing retention attempt → offer to try ONE thing first (the save attempt
        // itself is the conversation's job; we just refuse to cancel until it's done).
        return resultShapes.refusal(
            "Before I cancel, let me see if there's anything I can do to keep your appointment — can I try one thing first?",
            { retentionRequired: true },
        );
    }

    // --- Ownership pre-check (P0 isolation) BEFORE cancelJob (which takes only jobId).
    let job;
    try {
        job = await jobsService.getJobById(jobId, companyId);
    } catch (_e) {
        job = null;
    }
    if (!job || String(job.contact_id) !== String(verifiedContactId)) {
        return resultShapes.refusal("I couldn't find that appointment on your account — let me have a teammate follow up with you.");
    }

    // --- Already canceled (E8 / ASK-WRITE-15): no duplicate cancelJob, no error.
    if (job.blanc_status === 'Canceled' || job.zb_canceled) {
        return resultShapes.ok('That appointment is already canceled.', { success: true, status: 'That appointment is canceled.', alreadyCanceled: true });
    }

    // --- The cancel. cancelJob already pushes ZB + recovers (forceSyncOnZbError); a
    //     ZB failure it can't reconcile throws → the choke-point returns SAFE_FALLBACK
    //     (E5). We only write the reason note + event AFTER a successful cancel, so a
    //     cancel that didn't happen is never falsely audited.
    await jobsService.cancelJob(jobId);

    // AR-5: reason note ("AI Phone") — MUST include the captured reason every time.
    const noteText = `Appointment canceled via AI Phone. Reason: ${gate.reason}. Retention attempt made. No cancellation fee (free before the visit).`;
    try {
        await jobsService.addNote(jobId, noteText, [], 'AI Phone', 'AI Phone');
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] cancelAppointment addNote failed (non-fatal): ${e && e.message}`);
    }
    try {
        eventService.logEvent(
            companyId, 'job', jobId, 'job_canceled',
            { reason: gate.reason, retentionAttempted: true, actor: 'AI Phone' }, 'system',
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] cancelAppointment logEvent failed (non-fatal): ${e && e.message}`);
    }

    return resultShapes.ok(
        `Okay, I've canceled that appointment given ${reasonPhrase(gate.reason)}. There's no cancellation fee since it's before the visit. Is there anything else I can help with?`,
        { success: true, status: 'That appointment is canceled.' },
    );
}

module.exports = {
    run,
    // Exported for unit tests.
    retentionGate,
    reasonPhrase,
};
