/**
 * agentSkills / skills / createLead — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3; slot-persist from VAPI-SLOT-ENGINE-001).
 *
 * Originally relocated from `routes/vapi-tools.js`. The speech-safe result shape
 * remains backward compatible; OB-61 additionally derives address-validation
 * evidence server-side instead of trusting model-echoed flags/coordinates:
 *   - phone guard: valid leads require a phone (≥5 chars); disqualified leads are
 *     logged without one → { success:false, error:'Phone number is required…' };
 *   - field mapping: FirstName/LastName (+ callerName split fallback), Phone,
 *     optional Email, Status:'Review', JobType, JobSource ('AI Phone' / 'AI Phone
 *     (Invalid)'), Comments (summary / 'INVALID LEAD — …'), optional Address/Unit,
 *     City/State/PostalCode(normalizeZip);
 *   - chosenSlot slot-persist (Decision D): a valid chosenSlot writes real
 *     TIMESTAMPTZ columns LeadDateTime/LeadEndDateTime via tzCombine, + optional
 *     server-validated Latitude/Longitude when both finite; malformed/absent
 *     chosenSlot ⇒ none of the four keys; a slot-compose fault never blocks lead
 *     creation;
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
const validateAddress = require('./validateAddress');
const { aiActor } = require('../../leadContactActivityService');
const inboundSlotBookingGuardService = require('../../inboundSlotBookingGuardService');
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
        preferredSlot, escalationRequested,
        disqualified, disqualReason,
        callerName,
        chosenSlot,
    } = input;

    // Disqualified leads (out-of-area / unsupported appliance) are logged for
    // lead-gen refund tracking even without full contact details — the call
    // transcript is the evidence. Valid leads still require a phone number.
    if (!disqualified && (!phone || phone.length < 5)) {
        return { success: false, error: 'Phone number is required to create lead' };
    }

    // Provider arguments are not authoritative evidence that an address was
    // validated. Re-run the server-owned validator from the address fields so
    // the reduced provider schema never has to echo lat/lng/addressValidated
    // through the model. Old payloads may still contain those keys during the
    // rollout; they are deliberately accepted and ignored.
    let serverAddress = {
        valid: false,
        correctedZip: normalizeZip(zip),
        lat: null,
        lng: null,
    };
    if (street) {
        serverAddress = await validateAddress.run(companyId, verifiedContext, {
            street,
            apt,
            city,
            state,
            zip,
        });
    }

    const addressValidated = serverAddress?.valid === true;
    const lat = serverAddress?.lat;
    const lng = serverAddress?.lng;
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
        PostalCode: normalizeZip(serverAddress?.correctedZip || zip),
    };
    let slotBookingRefused = false;
    let inboundBookingGuardRequired = false;

    // VAPI-SLOT-ENGINE-001 (Decision D): when the caller picked an engine-offered
    // window, persist it as a schedule-blocking hold on the LEAD — real TIMESTAMPTZ
    // columns (lead_date_time/lead_end_date_time), not just the Comments "Slot:"
    // text. FIELD_MAP maps LeadDateTime/LeadEndDateTime/Latitude/Longitude → columns.
    // Back-compat: no chosenSlot ⇒ none of these four keys are added (columns NULL).
    // Edge 6: malformed chosenSlot ⇒ treated as absent (never block the call).
    if (chosenSlot) {
        const bookingGuard = await inboundSlotBookingGuardService.validateChosenSlot(
            companyId,
            input,
        );
        inboundBookingGuardRequired = bookingGuard.required;
        if (bookingGuard.required && !bookingGuard.allowed) {
            slotBookingRefused = true;
        }
    }
    if (!slotBookingRefused
        && chosenSlot
        && /^\d{4}-\d{2}-\d{2}$/.test(String(chosenSlot.date))
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
            if (inboundBookingGuardRequired) slotBookingRefused = true;
            delete body.LeadDateTime;
            delete body.LeadEndDateTime;
            delete body.Latitude;
            delete body.Longitude;
        }
    }

    // Attempt with 1 retry on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const lead = await leadsService.createLead(body, companyId, {
                activityActor: aiActor('AI Phone', 'agent'),
            });
            const leadId = lead?.UUID || lead?.uuid || lead?.id || null;
            if (slotBookingRefused) {
                return {
                    success: false,
                    leadId,
                    needsCallback: true,
                    error: 'That appointment time could not be confirmed. A teammate will follow up.',
                };
            }
            return { success: true, leadId };
        } catch (err) {
            console.error(`[vapi-tools] createLead attempt ${attempt} failed:`, err.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { success: false, error: 'Lead creation failed after retry' };
}

module.exports = { run };
