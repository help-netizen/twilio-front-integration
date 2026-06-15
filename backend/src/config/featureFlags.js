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

module.exports = { envBool, isZenbookerSyncEnabled };
