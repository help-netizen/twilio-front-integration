/**
 * featureFlags.js — small env-driven feature toggles.
 * Keep boolean parsing in one place so "unset" has an intentional default.
 */

function envBool(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * SCHED-ROUTE-001 C-12 / FR-001.4: best-effort create of new Albusto jobs back
 * into ZenBooker during the wind-down. Default ON (set FEATURE_ZENBOOKER_SYNC=0
 * to disable). Never blocks or rolls back the local job.
 */
function isZenbookerSyncEnabled() {
    return envBool('FEATURE_ZENBOOKER_SYNC', true);
}

const COMPANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TECHNICIAN_DIRECTORY_MODES = new Set(['legacy', 'compare', 'native']);

/**
 * ZB-DECOUPLE-001 Phase A: roster cutover is explicit per company. Invalid
 * modes, invalid UUIDs, malformed allowlists, and companies not present in the
 * allowlist all resolve to legacy; there is no implicit/default company.
 */
function getTechnicianDirectoryMode(companyId) {
    try {
        const mode = String(process.env.TECHNICIAN_DIRECTORY_MODE || 'legacy')
            .trim()
            .toLowerCase();
        if (!TECHNICIAN_DIRECTORY_MODES.has(mode) || mode === 'legacy') return 'legacy';

        const normalizedCompanyId = String(companyId || '').trim().toLowerCase();
        if (!COMPANY_UUID_RE.test(normalizedCompanyId)) return 'legacy';

        const rawAllowlist = process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS;
        if (rawAllowlist == null || rawAllowlist.trim() === '') return 'legacy';
        const companyIds = rawAllowlist.split(',').map(value => value.trim().toLowerCase());
        if (companyIds.some(value => !value || !COMPANY_UUID_RE.test(value))) return 'legacy';

        return new Set(companyIds).has(normalizedCompanyId) ? mode : 'legacy';
    } catch {
        return 'legacy';
    }
}

module.exports = { envBool, isZenbookerSyncEnabled, getTechnicianDirectoryMode };
