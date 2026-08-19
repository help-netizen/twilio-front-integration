'use strict';

/**
 * OB-66 deterministic booking guard for inbound Sara calls.
 *
 * A chosen slot is writable only when the exact key exists in this tenant's
 * persisted recommendSlots result for the same provider call and a fresh,
 * day-scoped recommendSlots run still returns that exact key. The model cannot
 * supply or override the transport marker; vapi-tools adds it after parsing the
 * model arguments. Any missing evidence or engine fallback fails closed.
 */

const db = require('../db/connection');
const { isConfirmedSlot } = require('./agentSkills/skills/rescheduleAppointment');
const { slotSpanIsPositive } = require('./agentSkills/skills/confirmPartsVisit');

const TRANSPORT_FIELD = '__vapiInboundBookingGuard';
const REVALIDATION_ARGUMENTS = [
    'zip',
    'lat',
    'lng',
    'address',
    'unitType',
    'durationMinutes',
    'technicianId',
];

function transportMarker(input) {
    const marker = input && typeof input === 'object' ? input[TRANSPORT_FIELD] : null;
    return marker && marker.required === true ? marker : null;
}

function slotKey(slot) {
    if (!isConfirmedSlot(slot) || !slotSpanIsPositive(slot)) return null;
    return `${slot.date}|${slot.start}|${slot.end}`;
}

function findOffer(invocations, key, slot) {
    if (!Array.isArray(invocations)) return null;
    for (let index = invocations.length - 1; index >= 0; index -= 1) {
        const invocation = invocations[index];
        const result = invocation && invocation.result;
        if (!result || result.available !== true || !Array.isArray(result.slots)) continue;
        const exact = result.slots.some((offered) => offered
            && offered.key === key
            && offered.date === slot.date
            && offered.start === slot.start
            && offered.end === slot.end);
        if (exact) return invocation;
    }
    return null;
}

function revalidationInput(invocation, targetDay) {
    const original = invocation?.arguments && typeof invocation.arguments === 'object'
        ? invocation.arguments
        : {};
    const input = { targetDay };
    for (const field of REVALIDATION_ARGUMENTS) {
        if (Object.prototype.hasOwnProperty.call(original, field)) {
            input[field] = original[field];
        }
    }
    return input;
}

async function validateChosenSlot(companyId, input, dependencies = {}) {
    const marker = transportMarker(input);
    if (!marker) return { required: false, allowed: true };

    const providerCallId = String(marker.providerCallId || '').trim();
    const chosenSlot = input?.chosenSlot;
    const key = slotKey(chosenSlot);
    if (!companyId || !providerCallId || !key) {
        return { required: true, allowed: false };
    }

    try {
        const query = dependencies.query || db.query.bind(db);
        const audit = await query(
            `SELECT invocations
             FROM vapi_recommend_slots_call_audits
             WHERE company_id = $1 AND provider_call_id = $2
             LIMIT 1`,
            [companyId, providerCallId],
        );
        const invocation = findOffer(audit.rows[0]?.invocations, key, chosenSlot);
        if (!invocation) return { required: true, allowed: false };

        const recommendSlots = dependencies.recommendSlots
            || require('./agentSkills/skills/recommendSlots');
        const fresh = await recommendSlots.run(
            companyId,
            {},
            revalidationInput(invocation, chosenSlot.date),
        );
        const stillAvailable = fresh?.available === true
            && Array.isArray(fresh.slots)
            && fresh.slots.some((slot) => slot
                && slot.key === key
                && slot.date === chosenSlot.date
                && slot.start === chosenSlot.start
                && slot.end === chosenSlot.end);
        return { required: true, allowed: stillAvailable };
    } catch (error) {
        console.error('[inboundSlotBookingGuard] re-validation unavailable', {
            companyId,
            providerCallId,
            code: error?.code || 'INBOUND_SLOT_GUARD_UNAVAILABLE',
        });
        return { required: true, allowed: false };
    }
}

module.exports = {
    TRANSPORT_FIELD,
    findOffer,
    revalidationInput,
    slotKey,
    validateChosenSlot,
};
