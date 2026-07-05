/**
 * agentSkills / skills / bookOnLead  — WRITE, L1
 * (AGENT-SKILLS-002, spec §3.4 · task T3 — P0 lead-ownership)
 *
 * The identified existing customer with an OPEN lead picks a slot (from
 * `recommendSlots`, or confirms the lead's already-proposed window) and we write
 * it as a schedule-blocking HOLD onto the EXISTING lead:
 * LeadDateTime/LeadEndDateTime (+ optional Latitude/Longitude). This is an
 * UPDATE of the existing lead — NEVER a new/duplicate lead. The dispatcher later
 * converts lead→job (unchanged flow); because the hold columns are written in the
 * SAME shape a VAPI-SLOT-ENGINE `createLead` uses (same `tzCombine`, same
 * `FIELD_MAP` columns), the dispatcher schedule + slot-engine occupancy treat a
 * bookOnLead hold identically to a createLead hold.
 *
 * UPDATE-vs-CREATE (spec §3.4.3):
 *   - contact has ≥1 open lead → UPDATE the newest open lead's hold (`created:false`).
 *   - contact has 0 open leads → delegate to the `createLead` SKILL verbatim so the
 *     exact createLead body-mapping (phone guard, JobSource 'AI Phone',
 *     chosenSlot→LeadDateTime, 1-retry) is reused, no duplication (`created:true`).
 *     A duplicate is NEVER created while an open lead exists.
 *
 * P0 GUARANTEES:
 *   - Verification: the choke-point already enforced L1 before `run` is reached
 *     (registry requiredLevel:'L1'); `verifiedContext.contactId` is the DB-derived,
 *     server-confirmed contact — never a client claim (`input.contactId` is ignored
 *     for scoping).
 *   - Lead ownership (P0): the lead we UPDATE is found via
 *     `getOpenLeadsByContact(contactId, companyId)`, which returns ONLY leads where
 *     `contact_id = contactId AND company_id = companyId`. So `updateLead` targets a
 *     lead the identified contact owns in the identified company. A defensive
 *     re-assert (`String(lead.ContactId) === String(contactId)`) runs before the
 *     write; a foreign lead is invisible to the scoped read → the create branch,
 *     which itself writes under `companyId`. No foreign lead is ever mutated.
 *   - Confirm-before-write: no write without a valid confirmed `chosenSlot` (same
 *     guard as createLead / rescheduleAppointment). Malformed/absent → soft refusal,
 *     no write. A `tzCombine` fault → refusal, no write (mirrors createLead.js:110-117).
 *   - Never a false success: on failure → `resultShapes.refusal` (the choke-point
 *     also backstops any throw to SAFE_FALLBACK).
 */

'use strict';

const resultShapes = require('../resultShapes');
// REUSE the shipped slot-confirmation guard + speech-safe window phrase from the
// reschedule skill — identical validation (`/^\d{4}-\d{2}-\d{2}$/`, `/^\d{1,2}:\d{2}$/`)
// so a bookOnLead slot and a reschedule/createLead slot are validated the same way.
const { isConfirmedSlot, windowPhrase } = require('./rescheduleAppointment');

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on voice/public-MCP).
 * @param {{ level: string, contactId: number|null }} verifiedContext Server-derived; L1 guaranteed by the gate.
 * @param {object} input Skill-specific fields: `chosenSlot` {date,start,end} (required),
 *   optional `lat`/`lng`, plus the identity block + no-lead fallback booking fields
 *   (firstName/lastName/phone/email/street/apt/zip/city/state/unitType/problemDescription)
 *   forwarded verbatim to createLead only when the contact has no open lead.
 * @returns {Promise<object>} A provider-neutral, speech-safe book-on-lead result.
 */
async function run(companyId, verifiedContext, input) {
    // Lazy-require the reused services so the module loads even while siblings
    // are still being written, and mirrors the reschedule skill's require style.
    const leadsService = require('../../leadsService');
    const slotEngineService = require('../../slotEngineService');
    const eventService = require('../../eventService');
    const createLeadSkill = require('./createLead');

    const src = input && typeof input === 'object' ? input : {};
    const chosenSlot = src.chosenSlot;
    const lat = src.lat;
    const lng = src.lng;
    // Server-verified contact ONLY — never trust input.contactId for scoping.
    const contactId =
        verifiedContext && verifiedContext.contactId != null ? verifiedContext.contactId : null;

    // --- Guard 0 (defensive; the gate guarantees L1 → a resolved contact + scope).
    //     A missing company scope or unresolved contact → safe refusal, no write.
    if (!companyId || contactId == null) {
        return resultShapes.refusal(
            "I couldn't pull up your request to book — let me have a teammate follow up with you.",
        );
    }

    // --- Guard 1 (confirm-before-write): no write without a confirmed window.
    //     Malformed/absent chosenSlot → soft refusal, never a partial write.
    if (!isConfirmedSlot(chosenSlot)) {
        return resultShapes.refusal(
            "Let's lock in a window first — which time works best for you?",
            { needsConfirmation: true },
        );
    }

    // --- Build the slot-hold body EXACTLY as createLead's slot-persist does
    //     (REUSE the same tzCombine → LeadDateTime/LeadEndDateTime, and the
    //     both-or-nothing Latitude/Longitude). A slot-compose fault must not 500
    //     — on fault → refusal, no write (mirrors createLead.js:110-117).
    let hold;
    try {
        const tz = await slotEngineService.resolveTimezone(companyId);
        hold = {
            LeadDateTime: slotEngineService.tzCombine(chosenSlot.date, chosenSlot.start, tz),
            LeadEndDateTime: slotEngineService.tzCombine(chosenSlot.date, chosenSlot.end, tz),
            // Edge B8: coords optional — write BOTH only when both are finite.
            ...(Number.isFinite(lat) && Number.isFinite(lng) ? { Latitude: lat, Longitude: lng } : {}),
        };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] bookOnLead slot-compose failed: ${err && err.message}`);
        return resultShapes.refusal(
            "I had trouble locking that time in — let me have a teammate confirm it with you.",
        );
    }

    const bookedWindow = windowPhrase(chosenSlot);

    // --- OWNERSHIP + branch: find THIS contact's open leads, company-scoped
    //     (non-suppressing read — surfaces the lead even when a job also exists).
    let openLeads = [];
    try {
        openLeads = await leadsService.getOpenLeadsByContact(contactId, companyId);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] bookOnLead lead-read failed: ${err && err.message}`);
        return resultShapes.refusal(
            "I couldn't pull up your request to book — let me have a teammate follow up with you.",
        );
    }

    let created;
    let leadId;

    if (Array.isArray(openLeads) && openLeads.length >= 1) {
        // --- B1/B3/B4: UPDATE the newest open lead's hold. Ownership is inherent
        //     (the read is scoped to contactId + companyId); a defensive re-assert
        //     guards against any surprise before the write.
        const lead = openLeads[0];
        if (String(lead.ContactId) !== String(contactId)) {
            // Should be impossible (scoped read) — refuse rather than touch a
            // lead we can't prove ownership of. No write.
            return resultShapes.refusal(
                "I couldn't confirm that request is on your account — let me have a teammate follow up with you.",
            );
        }
        try {
            await leadsService.updateLead(lead.UUID, hold, companyId);
        } catch (err) {
            // updateLead throws LEAD_NOT_FOUND / DB error → graceful refusal (the
            // choke-point also backstops any throw to SAFE_FALLBACK). No false success.
            // eslint-disable-next-line no-console
            console.error(`[agentSkills] bookOnLead updateLead failed: ${err && err.message}`);
            return resultShapes.refusal(
                "I had trouble locking that time in — let me have a teammate confirm it with you.",
            );
        }
        created = false;
        leadId = lead.UUID;
    } else {
        // --- B2: no open lead → fresh lead via the SAME createLead skill path.
        //     Delegate verbatim so createLead's body-mapping (phone guard, JobSource
        //     'AI Phone', chosenSlot→LeadDateTime, retry) is reused — no duplication,
        //     and (critically) a duplicate is only ever created when there is NO
        //     existing open lead to hold onto.
        let res;
        try {
            res = await createLeadSkill.run(companyId, verifiedContext, { ...src });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[agentSkills] bookOnLead createLead fallback failed: ${err && err.message}`);
            res = null;
        }
        if (!res || res.success !== true) {
            return resultShapes.refusal(
                "I couldn't get that booked just now — let me have a teammate lock that in for you.",
            );
        }
        created = true;
        leadId = res.leadId;
    }

    // --- Audit parity with the other writes (AR-5 style) — non-fatal: a logging
    //     hiccup must not turn a successful hold into a failure (the hold already
    //     landed). eventService.logEvent is itself fire-and-forget/guarded.
    try {
        eventService.logEvent(
            companyId,
            'lead',
            leadId,
            'lead_slot_held',
            { window: bookedWindow, actor: 'AI Phone', created },
            'system',
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] bookOnLead logEvent failed (non-fatal): ${e && e.message}`);
    }

    return resultShapes.ok(
        `You're all set — I've got you down for ${bookedWindow}. A dispatcher will confirm shortly.`,
        { success: true, bookedWindow, leadId, created },
    );
}

module.exports = { run };
