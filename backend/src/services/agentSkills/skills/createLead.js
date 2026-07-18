/**
 * agentSkills / skills / createLead — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3; slot-persist from VAPI-SLOT-ENGINE-001).
 *
 * Byte-identical relocation of `handleCreateLead` (+ `buildCallSummary`) from
 * `routes/vapi-tools.js` (the pre-T4 source of truth). Internals RELOCATED, NOT
 * rewritten — every branch preserved verbatim:
 *   - phone guard: valid leads require a phone (≥5 chars); disqualified leads are
 *     logged without one → { success:false, error:'Phone number is required…' };
 *   - field mapping: FirstName/LastName (+ callerName split fallback), Phone,
 *     optional Email, Status:'Review', JobType, JobSource ('AI Phone' / 'AI Phone
 *     (Invalid)'), Comments (summary / 'INVALID LEAD — …'), optional Address/Unit,
 *     City/State/PostalCode(normalizeZip);
 *   - chosenSlot slot-persist (Decision D): a valid chosenSlot writes real
 *     TIMESTAMPTZ columns LeadDateTime/LeadEndDateTime via tzCombine, + optional
 *     Latitude/Longitude when both finite; malformed/absent chosenSlot ⇒ none of
 *     the four keys; a slot-compose fault never blocks lead creation;
 *   - 1-retry: on failure wait 2s and retry once; two failures →
 *     { success:false, error:'Lead creation failed after retry' } (HTTP 200);
 *   - success → { success:true, leadId }.
 *
 * FROZEN shape (no ok/speak). This skill is a WRITE but stays requiredLevel:'L0'
 * (it IS the new-lead flow — the gate must never block it). Only change vs. the
 * old handler: `companyId` arrives as the arg (adapter passes DEFAULT_COMPANY_ID)
 * instead of the module constant. UNKNOWN-CALLER-LEAD-001 additionally consumes
 * the server-derived `verifiedContext`: a unique resolved contact supplies both
 * `contact_id` and the stored real name; absent/shared identity keeps the legacy
 * Unknown Caller fallback.
 */

'use strict';

const leadsService = require('../../leadsService');
const slotEngineService = require('../../slotEngineService');
// ZIP normalization (recover a dropped leading zero) — shared util.
const { normalizeZip } = require('../../../utils/zip');

function buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested }) {
    const parts = [
        unitType          && `Unit: ${unitType}`,
        brand             && `Brand: ${brand}`,
        `Age: ${unitAge || 'unknown'}`,
        problemDescription && `Problem: ${problemDescription}`,
        'Fee agreed: Yes',
        `Slot: ${preferredSlot || 'pending callback'}`,
        `Address validated: ${addressValidated ? 'yes' : 'no'}`,
        escalationRequested && 'escalation_requested: true',
    ].filter(Boolean);
    return parts.join(' | ');
}

/**
 * Project the server-derived identity into lead fields. The model input is never
 * consulted for contact ownership. Shared-phone and otherwise ambiguous contexts
 * fail closed so createLead cannot attach a guessed contact.
 * @param {object} verifiedContext Context produced by verificationGate.
 * @returns {{ contactId: number|string, firstName: string, lastName: string }|null}
 */
function resolvedLeadIdentity(verifiedContext) {
    const ctx = verifiedContext && typeof verifiedContext === 'object' ? verifiedContext : {};
    const isVerified = ctx.level === 'L1' || ctx.level === 'L2';
    const candidateCount = Number(ctx.phoneCandidateCount || 0);
    const customerName = String(ctx.customerName || '').trim().replace(/\s+/g, ' ');

    if (!isVerified || ctx.contactId == null || ctx.ambiguous || candidateCount > 1 || !customerName) {
        return null;
    }

    const [firstName, ...lastNameParts] = customerName.split(' ');
    return {
        contactId: ctx.contactId,
        firstName,
        lastName: lastNameParts.join(' '),
    };
}

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on the voice surface).
 * @param {object} verifiedContext Server-derived caller identity.
 * @param {object} input The tool arguments (see field destructuring below).
 * @returns {Promise<object>} Frozen legacy shape { success, leadId? | error }.
 */
async function run(companyId, verifiedContext, input = {}) {
    const {
        firstName, lastName, phone, email,
        street, apt, zip, city, state,
        unitType, brand, unitAge, problemDescription,
        preferredSlot, addressValidated, escalationRequested,
        disqualified, disqualReason,
        callerName,
        chosenSlot, lat, lng,
    } = input;

    // Disqualified leads (out-of-area / unsupported appliance) are logged for
    // lead-gen refund tracking even without full contact details — the call
    // transcript is the evidence. Valid leads still require a phone number.
    if (!disqualified && (!phone || phone.length < 5)) {
        return { success: false, error: 'Phone number is required to create lead' };
    }

    const resolvedIdentity = resolvedLeadIdentity(verifiedContext);
    const summary = buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested });
    const body = {
        FirstName: resolvedIdentity?.firstName || firstName || callerName?.split(' ')[0] || 'Unknown',
        LastName:  resolvedIdentity ? resolvedIdentity.lastName : (lastName || callerName?.split(' ').slice(1).join(' ') || 'Caller'),
        Phone:     phone || '',
        ...(resolvedIdentity && { contact_id: resolvedIdentity.contactId }),
        ...(email && { Email: email }),
        Status:    'Review',
        JobType:   unitType ? `${unitType} Repair` : 'Appliance Repair',
        JobSource: disqualified ? 'AI Phone (Invalid)' : 'AI Phone',
        Comments:  disqualified
            ? `INVALID LEAD — ${disqualReason || 'disqualified'}. ${summary}`.trim()
            : summary,
        ...(street && { Address: street }),
        ...(apt && { Unit: apt }),
        City:      city || '',
        State:     state || '',
        PostalCode: normalizeZip(zip),
    };

    // VAPI-SLOT-ENGINE-001 (Decision D): when the caller picked an engine-offered
    // window, persist it as a schedule-blocking hold on the LEAD — real TIMESTAMPTZ
    // columns (lead_date_time/lead_end_date_time), not just the Comments "Slot:"
    // text. FIELD_MAP maps LeadDateTime/LeadEndDateTime/Latitude/Longitude → columns.
    // Back-compat: no chosenSlot ⇒ none of these four keys are added (columns NULL).
    // Edge 6: malformed chosenSlot ⇒ treated as absent (never block the call).
    if (chosenSlot && /^\d{4}-\d{2}-\d{2}$/.test(String(chosenSlot.date))
        && /^\d{1,2}:\d{2}$/.test(String(chosenSlot.start))
        && /^\d{1,2}:\d{2}$/.test(String(chosenSlot.end))) {
        try {
            const tz = await slotEngineService.resolveTimezone(companyId);
            body.LeadDateTime = slotEngineService.tzCombine(chosenSlot.date, chosenSlot.start, tz);
            body.LeadEndDateTime = slotEngineService.tzCombine(chosenSlot.date, chosenSlot.end, tz);
            // Edge 7: coords optional — write them only when both are finite.
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                body.Latitude = lat;
                body.Longitude = lng;
            }
        } catch (err) {
            // Never let a slot-compose fault block lead creation.
            console.error('[vapi-tools] createLead slot-persist skipped:', err.message);
            delete body.LeadDateTime;
            delete body.LeadEndDateTime;
            delete body.Latitude;
            delete body.Longitude;
        }
    }

    // Attempt with 1 retry on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const lead = await leadsService.createLead(body, companyId);
            return { success: true, leadId: lead?.UUID || lead?.uuid || lead?.id || null };
        } catch (err) {
            console.error(`[vapi-tools] createLead attempt ${attempt} failed:`, err.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { success: false, error: 'Lead creation failed after retry' };
}

module.exports = { run };
