/**
 * Record a non-booking inbound lead outcome with a deliberately small provider
 * contract. Disqualification and human escalation are dispositions, not the
 * qualified-lead creation payload; both still reuse createLead's durable CRM
 * write and server-derived caller identity.
 */

'use strict';

const createLead = require('./createLead');

const DISQUALIFICATION_REASONS = new Set([
    'out_of_area',
    'unsupported_appliance',
]);

async function run(companyId, verifiedContext, input = {}) {
    const disqualified = input.disqualified === true;
    const escalationRequested = input.escalationRequested === true;
    const disqualReason = typeof input.disqualReason === 'string'
        ? input.disqualReason.trim()
        : '';

    if (disqualified && !DISQUALIFICATION_REASONS.has(disqualReason)) {
        return { success: false, error: 'A supported disqualification reason is required' };
    }
    if (!disqualified && !escalationRequested) {
        return { success: false, error: 'A disposition is required' };
    }

    return createLead.run(companyId, verifiedContext, {
        phone: input.phone,
        disqualified,
        ...(disqualified ? { disqualReason } : {}),
        escalationRequested,
    });
}

module.exports = { DISQUALIFICATION_REASONS, run };
