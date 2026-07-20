/**
 * confirmLeadBooking — OUTBOUND-LEAD-CALL-001 (§9). The in-call booking write
 * for the OUTBOUND lead-call scenario: the customer picked a window → write a
 * schedule HOLD on the triggering lead (byte-same hold shape as bookOnLead /
 * VAPI-SLOT-ENGINE-001) and flip our own dialing attempt to 'booked' (CC-07
 * analog — the end-of-call webhook then no-ops idempotently).
 *
 * L0 on the outbound surface (confirmPartsVisit "Deviation 1" pattern): an
 * outbound robo-call has no caller-claimed identity to verify — identity
 * (leadUuid/companyId) is SERVER-INJECTED via assistantOverrides.variableValues,
 * which vapi-tools.buildSkillInput spreads LAST over the model args, so the
 * model can never override them. All isolation is in-skill.
 *
 * bookOnLead is deliberately NOT reused: it is L1 contact-gated and targets
 * "the newest open lead of the verified contact" — wrong for contactless
 * Pro Referral leads and multi-lead contacts. This skill targets EXACTLY the
 * injected lead.
 *
 * Injection-hardening (FR-8, fail-closed): the model's ONLY parameter is
 * `chosenSlot`. Its derived key must equal the injected pre-dial `slotKey`,
 * OR re-validate live against the slot engine (targetDay run) — anything else
 * is a polite refusal. No false success: every write is guarded.
 */

const resultShapes = require('../resultShapes');
const { windowPhrase, isConfirmedSlot } = require('./rescheduleAppointment');
const { slotSpanIsPositive } = require('./confirmPartsVisit');

async function run(companyId, _verifiedContext, input) {
    const src = input && typeof input === 'object' ? input : {};

    // 1. Identity — server-injected wins; the transport companyId ARGUMENT
    // (DEFAULT_COMPANY_ID on the VAPI seam) is never used for scoping.
    const leadUuid = src.leadUuid;
    const cid = src.companyId;
    if (!leadUuid || !cid) {
        return resultShapes.refusal(
            "I couldn't pull up your request to book — let me have a teammate follow up with you."
        );
    }

    // 2. Slot guards (shape + non-inverted span).
    const slot = src.chosenSlot;
    if (!isConfirmedSlot(slot) || !slotSpanIsPositive(slot)) {
        return resultShapes.refusal(
            "Let's lock in a time first — which window works best for you?",
            { needsConfirmation: true }
        );
    }
    const derivedKey = `${slot.date}|${slot.start}|${slot.end}`;

    // 3. Offered-guard: injected pre-dial key OR live engine re-validation.
    if (derivedKey !== src.slotKey) {
        try {
            const recommendSlots = require('./recommendSlots');
            const recs = await recommendSlots.run(cid, {}, {
                zip: src.zip,
                lat: src.lat,
                lng: src.lng,
                targetDay: slot.date,
            });
            const offered = recs && recs.available === true && Array.isArray(recs.slots)
                && recs.slots.some(s => s && s.key === derivedKey);
            if (!offered) {
                return resultShapes.refusal(
                    'Let me have a teammate confirm that time and follow up with you shortly.'
                );
            }
        } catch {
            return resultShapes.refusal(
                'Let me have a teammate confirm that time and follow up with you shortly.'
            );
        }
    }

    // 4. Ownership — tenant-scoped read; cross-company indistinguishable from missing.
    const leadsService = require('../../leadsService');
    let lead;
    try {
        lead = await leadsService.getLeadByUUID(leadUuid, cid);
    } catch {
        return resultShapes.refusal(
            "I couldn't find that request on file — let me have a teammate follow up with you."
        );
    }
    const status = String((lead && lead.Status) || '').toUpperCase();
    if (status === 'LOST' || status === 'CONVERTED') {
        return resultShapes.refusal(
            'That request is already closed — let me have a teammate follow up with you.'
        );
    }

    // 4.5. Service address — REQUIRED before a booking can land (owner rule: the
    // agent must collect/confirm the address; an empty lead must be asked). Prefer
    // the address the customer just confirmed on the call (re-validated
    // server-side via Geocoding — the model's spoken coords are never trusted);
    // fall back to a usable address already on the lead. Neither → refuse and ask.
    let resolvedCoords = (Number.isFinite(src.lat) && Number.isFinite(src.lng))
        ? { lat: src.lat, lng: src.lng } : null;
    let addressUpdate = null;
    const provided = src.serviceAddress && typeof src.serviceAddress === 'object' ? src.serviceAddress : null;

    if (provided && (String(provided.street || '').trim() || String(provided.zip || '').trim())) {
        let v = null;
        try {
            const validateAddress = require('./validateAddress');
            v = await validateAddress.run(cid, {}, {
                street: provided.street, apt: provided.apt,
                city: provided.city, state: provided.state, zip: provided.zip,
            });
        } catch { v = null; }
        if (!v || !v.valid) {
            return resultShapes.refusal(
                "I want to make sure the technician comes to the right place — could you give me the full service address again, with the street, city, and ZIP code?",
                { needsAddress: true }
            );
        }
        resolvedCoords = (Number.isFinite(v.lat) && Number.isFinite(v.lng)) ? { lat: v.lat, lng: v.lng } : resolvedCoords;
        addressUpdate = {
            Address: [provided.street, provided.apt].filter(Boolean).join(' ') || provided.street || null,
            City: provided.city || null,
            State: provided.state || null,
            PostalCode: v.correctedZip || provided.zip || null,
            ...(resolvedCoords ? { Latitude: resolvedCoords.lat, Longitude: resolvedCoords.lng } : {}),
        };
    } else {
        // No address collected on this call — is there a usable one on the lead?
        const hasStored = !!(lead && String(lead.Address || '').trim()
            && (String(lead.City || '').trim() || String(lead.PostalCode || '').trim()));
        if (!hasStored) {
            return resultShapes.refusal(
                "Before I lock this in — what's the service address where you'd like the technician to come?",
                { needsAddress: true }
            );
        }
    }

    // 5. Hold write — byte-same shape as bookOnLead (VAPI-SLOT-ENGINE-001),
    // plus the collected/validated service address when the customer gave one.
    try {
        const slotEngineService = require('../../slotEngineService');
        const tz = await slotEngineService.resolveTimezone(cid);
        const hold = {
            LeadDateTime: slotEngineService.tzCombine(slot.date, slot.start, tz),
            LeadEndDateTime: slotEngineService.tzCombine(slot.date, slot.end, tz),
            // OLC-POSTCALL-001: an AI-booked window is TENTATIVE — a human dispatcher
            // must confirm it. Flip the lead to 'Review' the instant the hold lands
            // (reliable: this is the tool call, not the end-of-call webhook that may
            // be missed). The Pulse timeline call entry + the end-of-call review task
            // carry the summary; the hold already shows on the dispatcher calendar.
            Status: 'Review',
        };
        if (addressUpdate) Object.assign(hold, addressUpdate);
        else if (resolvedCoords) { hold.Latitude = resolvedCoords.lat; hold.Longitude = resolvedCoords.lng; }
        await leadsService.updateLead(leadUuid, hold, cid);
    } catch (err) {
        // Keep the caller-safe refusal, but retain enough PII-free context for one
        // grep to diagnose the next occurrence. Never log serviceAddress, ZIP,
        // coordinates, names, or phone numbers.
        const safeArgs = {
            companyId: cid,
            leadUuid,
            chosenSlot: { date: slot.date, start: slot.start, end: slot.end },
            slotKeyMatched: derivedKey === src.slotKey,
            hasServiceAddress: Boolean(provided),
            hasCoordinates: Boolean(resolvedCoords),
        };
        console.error(
            `[agentSkills] confirmLeadBooking failed: ${err && err.stack ? err.stack : String(err)}`,
            safeArgs
        );
        return resultShapes.refusal(
            'I had trouble locking that time in — let me have a teammate confirm it with you.'
        );
    }

    // 6. Own-attempt flip (CC-07 analog) — NON-FATAL: the hold already landed.
    try {
        const db = require('../../../db/connection');
        await db.query(
            `UPDATE outbound_call_attempts
             SET status = 'booked', updated_at = now()
             WHERE company_id = $1 AND lead_uuid = $2 AND status = 'dialing'`,
            [cid, leadUuid]
        );
    } catch (err) {
        console.error('[confirmLeadBooking] attempt flip failed (non-fatal):', err && err.message);
    }

    // 7. Audit + speak.
    try {
        const eventService = require('../../eventService');
        eventService.logEvent(cid, 'lead', leadUuid, 'lead_slot_held',
            { window: windowPhrase(slot), actor: 'AI Phone', scenario: 'lead_call' }, 'system');
    } catch { /* non-fatal */ }

    return resultShapes.ok(
        `You're all set — I've got you down for ${windowPhrase(slot)}. A dispatcher will confirm shortly.`,
        { success: true, booked: true, bookedWindow: windowPhrase(slot), leadId: leadUuid }
    );
}

module.exports = { run };
