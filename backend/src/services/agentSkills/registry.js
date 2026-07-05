/**
 * agentSkills / registry
 *
 * The MANIFEST of every skill in the provider-neutral layer
 * (AGENT-SKILLS-001, spec §0/§4 / architecture §1, §6). One entry per skill:
 *
 *   { name, kind: 'read'|'write', requiredLevel: 'L0'|'L1'|'L2', run }
 *
 * 14 skills total:
 *   - 9 NEW skills (identifyCaller + 3 L1 reads + 3 L2 sensitive reads + 2 L2 writes)
 *   - 5 RELOCATED legacy L0 tools (checkServiceArea / validateAddress /
 *     checkAvailability / recommendSlots / createLead), moved verbatim in T3.
 *
 * Level assignment (spec §2.4, architecture §6 per-skill table):
 *   L0  identifyCaller (derives L1/L2) + the 5 legacy tools (never block the call)
 *   L1  getCustomerOverview, getJobStatus, getAppointments
 *   L2  getJobHistory, getEstimateSummary, getInvoiceSummary,
 *       rescheduleAppointment (write), cancelAppointment (write)
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
    { name: 'getJobHistory', kind: 'read', requiredLevel: 'L2', run: lazyRun('getJobHistory') },
    { name: 'getEstimateSummary', kind: 'read', requiredLevel: 'L2', run: lazyRun('getEstimateSummary') },
    { name: 'getInvoiceSummary', kind: 'read', requiredLevel: 'L2', run: lazyRun('getInvoiceSummary') },
    { name: 'rescheduleAppointment', kind: 'write', requiredLevel: 'L2', run: lazyRun('rescheduleAppointment') },
    { name: 'cancelAppointment', kind: 'write', requiredLevel: 'L2', run: lazyRun('cancelAppointment') },

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
