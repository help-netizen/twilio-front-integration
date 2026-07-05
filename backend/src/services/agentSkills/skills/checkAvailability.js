/**
 * agentSkills / skills / checkAvailability — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3).
 *
 * Byte-identical relocation of `handleCheckAvailability` from
 * `routes/vapi-tools.js` (the pre-T4 source of truth). Internals RELOCATED, NOT
 * rewritten — same `scheduleService.getAvailableSlots(companyId, { days,
 * slotDurationMin:120, maxSlots:3 })` call, same defaults, same passthrough:
 *   success   → { slots }           (whatever scheduleService returns)
 *   no-slots  → { slots:[], error } (passthrough, unchanged)
 *   throws    → { slots:[], error } (LEGACY shape — NOT SAFE_FALLBACK; byte-compat
 *                                    wins over the generic fallback for L0 tools)
 *
 * FROZEN shape (no ok/speak). Only change vs. the old handler: `companyId`
 * arrives as the arg (adapter passes DEFAULT_COMPANY_ID). `verifiedContext`
 * unused (L0).
 */

'use strict';

const scheduleService = require('../../scheduleService');

const AVAILABILITY_DAYS = 5;
const APPOINTMENT_DURATION_MIN = 120;
const MAX_SLOTS = 3;

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on the voice surface).
 * @param {object} _verifiedContext Unused for this L0 tool.
 * @param {{ zip?, unitType?, days? }} input The tool arguments.
 * @returns {Promise<object>} Frozen legacy shape (no ok/speak); never throws.
 */
async function run(companyId, _verifiedContext, input = {}) {
    const { days } = input;
    try {
        return await scheduleService.getAvailableSlots(companyId, {
            days: days || AVAILABILITY_DAYS,
            slotDurationMin: APPOINTMENT_DURATION_MIN,
            maxSlots: MAX_SLOTS,
        });
    } catch (err) {
        console.error('[vapi-tools] checkAvailability error:', err.message);
        return { slots: [], error: err.message };
    }
}

module.exports = { run };
