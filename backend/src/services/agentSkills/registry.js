/**
 * agentSkills / registry
 *
 * The MANIFEST of every skill in the provider-neutral layer
 * (AGENT-SKILLS-001, spec §0/§4 / architecture §1, §6). One entry per skill:
 *
 *   { name, kind: 'read'|'write', requiredLevel: 'L0'|'L1'|'L2', run }
 *
 * 15 skills total (AGENT-SKILLS-001: 14 + AGENT-SKILLS-002: +bookOnLead):
 *   - 10 NEW skills (identifyCaller + existing-customer reads/writes + bookOnLead)
 *   - 5 RELOCATED legacy L0 tools (checkServiceArea / validateAddress /
 *     checkAvailability / recommendSlots / createLead), moved verbatim in 001-T3.
 *
 * Level assignment (AGENT-SKILLS-002 §2.1 relaxed the existing-customer skills to L1):
 *   L0  identifyCaller (derives level) + the 5 legacy tools (never block the call)
 *   L1  getCustomerOverview, getJobStatus, getAppointments, getJobHistory,
 *       getEstimateSummary, getInvoiceSummary, rescheduleAppointment (write),
 *       cancelAppointment (write), bookOnLead (write)
 *   (isolation + per-contact ownership + cancel retention stay enforced in-skill)
 *
 * LAZY `run` resolution (CRITICAL for parallel implementation): each entry's
 * `run` does `require('./skills/<name>').run(...args)` at CALL time, not at
 * module-load time. This lets the 9 skill modules (T3/T5/T6/T7) be implemented
 * independently afterward WITHOUT editing this file again, and keeps registry.js
 * (and the whole scaffold) loadable BEFORE those modules exist.
 */

'use strict';

/**
 * Build a lazily-resolved `run` for a skill module. The require happens only
 * when the skill is actually invoked, so the registry loads even while the
 * skill files are still being written (they arrive in later tasks).
 * @param {string} moduleName Basename under ./skills (e.g. 'identifyCaller').
 * @returns {(...args: any[]) => Promise<object>} The skill's async run().
 */
function lazyRun(moduleName) {
    return (...args) => require(`./skills/${moduleName}`).run(...args);
}

/**
 * @typedef {Object} SkillEntry
 * @property {string} name Provider-neutral skill name (matches the module basename).
 * @property {'read'|'write'} kind Read vs. state-mutating write.
 * @property {'L0'|'L1'|'L2'} requiredLevel Verification level the gate enforces.
 * @property {(companyId: string, verifiedContext: object, input: object) => Promise<object>} run
 *   Lazily-resolved skill entry point.
 */

/** @type {SkillEntry[]} */
const SKILLS = [
    // --- 9 NEW skills --------------------------------------------------------
    // identifyCaller is L0 but DERIVES L1/L2 for the rest of the call (spec §4.1).
    { name: 'identifyCaller', kind: 'read', requiredLevel: 'L0', run: lazyRun('identifyCaller') },
    { name: 'getCustomerOverview', kind: 'read', requiredLevel: 'L1', run: lazyRun('getCustomerOverview') },
    { name: 'getJobStatus', kind: 'read', requiredLevel: 'L1', run: lazyRun('getJobStatus') },
    { name: 'getAppointments', kind: 'read', requiredLevel: 'L1', run: lazyRun('getAppointments') },
    // AGENT-SKILLS-002: relaxed L2→L1 — an identified caller (phone OR name+zip) is
    // served without a separate name+ZIP re-confirmation ("phone-identify is enough;
    // no sensitive info here"). Company isolation + per-contactId ownership pre-check
    // + cancel retention + no-card-by-voice are UNCHANGED (enforced in the skills).
    { name: 'getJobHistory', kind: 'read', requiredLevel: 'L1', run: lazyRun('getJobHistory') },
    { name: 'getEstimateSummary', kind: 'read', requiredLevel: 'L1', run: lazyRun('getEstimateSummary') },
    { name: 'getInvoiceSummary', kind: 'read', requiredLevel: 'L1', run: lazyRun('getInvoiceSummary') },
    { name: 'rescheduleAppointment', kind: 'write', requiredLevel: 'L1', run: lazyRun('rescheduleAppointment') },
    { name: 'cancelAppointment', kind: 'write', requiredLevel: 'L1', run: lazyRun('cancelAppointment') },
    // AGENT-SKILLS-002: book a chosen slot as a schedule-blocking HOLD onto the
    // identified contact's EXISTING open lead (update, never a dup); L1. Module in T3.
    { name: 'bookOnLead', kind: 'write', requiredLevel: 'L1', run: lazyRun('bookOnLead') },

    // OUTBOUND-PARTS-CALL-001 (OPC1-T13): in-call booking write for the OUTBOUND
    // "part arrived → finish the visit" assistant. L0 on the outbound surface
    // (Deviation 1) — the call is server-initiated to a pre-bound known contact,
    // so it is NOT gated behind the inbound verificationGate; isolation is fully
    // in-skill (companyId + bound contactId ownership pre-check). Inbound Sara's
    // tool-set is unchanged — this additive entry only makes the skill executable.
    { name: 'confirmPartsVisit', kind: 'write', requiredLevel: 'L0', run: lazyRun('confirmPartsVisit') },

    // OUTBOUND-LEAD-CALL-001: in-call booking write for the OUTBOUND lead-call
    // scenario. L0 on the outbound surface (Deviation 1) — identity (leadUuid/
    // companyId) is server-injected via variableValues, never a caller claim;
    // isolation is fully in-skill. Inbound Sara's tool-set is unchanged.
    { name: 'confirmLeadBooking', kind: 'write', requiredLevel: 'L0', run: lazyRun('confirmLeadBooking') },

    // --- 5 RELOCATED legacy L0 tools (byte-compat; own legacy shapes) --------
    // L0 so deriveLevel never blocks them → "never block the call" preserved.
    { name: 'checkServiceArea', kind: 'read', requiredLevel: 'L0', run: lazyRun('checkServiceArea') },
    { name: 'validateAddress', kind: 'read', requiredLevel: 'L0', run: lazyRun('validateAddress') },
    { name: 'checkAvailability', kind: 'read', requiredLevel: 'L0', run: lazyRun('checkAvailability') },
    { name: 'recommendSlots', kind: 'read', requiredLevel: 'L0', run: lazyRun('recommendSlots') },
    { name: 'createLead', kind: 'write', requiredLevel: 'L0', run: lazyRun('createLead') },
];

/**
 * name → SkillEntry index for O(1) lookup by the choke-point.
 * @type {Map<string, SkillEntry>}
 */
const BY_NAME = new Map(SKILLS.map((skill) => [skill.name, skill]));

/**
 * Resolve a skill entry by name, or undefined if unknown (the choke-point turns
 * an unknown skill into SAFE_FALLBACK — never a crash).
 * @param {string} name Skill name.
 * @returns {SkillEntry|undefined}
 */
function getSkill(name) {
    return BY_NAME.get(name);
}

/**
 * List all registered skills' public metadata (name/kind/requiredLevel). Used
 * by `agentSkills.listSkills` and, later, by the MCP registry projection.
 * @returns {{ name: string, kind: 'read'|'write', requiredLevel: 'L0'|'L1'|'L2' }[]}
 */
function listSkills() {
    return SKILLS.map(({ name, kind, requiredLevel }) => ({ name, kind, requiredLevel }));
}

module.exports = {
    SKILLS,
    getSkill,
    listSkills,
};
