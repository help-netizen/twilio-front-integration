/**
 * agentSkills / skills / checkServiceArea — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3).
 *
 * Byte-identical relocation of `handleCheckServiceArea` from
 * `routes/vapi-tools.js` (the pre-T4 source of truth). Internals are RELOCATED,
 * NOT rewritten — same `stQueries.search(companyId, zip)` call, same frozen
 * output shapes:
 *   in-area   → { inServiceArea:true, area, city, state, zip }
 *   out-area  → { inServiceArea:false, zip }        (echoes the normalized zip)
 *   no zip    → { inServiceArea:false, error:'zip is required' }
 *
 * FROZEN shape (spec §7.3 / AC-11): NO `ok`/`speak` for this L0 legacy tool —
 * byte-compat wins over the generic resultShapes envelope. Only change vs. the
 * old handler: `companyId` arrives as the arg (the adapter passes
 * DEFAULT_COMPANY_ID, so runtime behavior is identical) instead of the module
 * constant. `verifiedContext` is unused (L0 — the gate never blocks this tool).
 */

'use strict';

// ZIP normalization (recover a dropped leading zero) — shared util, so the
// service-territory query layer and every caller normalize identically.
const { normalizeZip } = require('../../../utils/zip');
const stQueries = require('../../../db/serviceTerritoryQueries');

/**
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on the voice surface).
 * @param {object} _verifiedContext Unused for this L0 tool.
 * @param {{ zip?: string|number }} input The tool arguments.
 * @returns {Promise<object>} Frozen legacy shape (no ok/speak).
 */
async function run(companyId, _verifiedContext, input = {}) {
    const { zip } = input;
    const z = normalizeZip(zip);
    if (!z) return { inServiceArea: false, error: 'zip is required' };

    const row = await stQueries.search(companyId, z);
    if (!row) return { inServiceArea: false, zip: z };

    return {
        inServiceArea: true,
        area: row.area || '',
        city: row.city || '',
        state: row.state || '',
        zip: row.zip || z,
    };
}

module.exports = { run };
