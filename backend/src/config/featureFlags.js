/**
 * featureFlags.js — small env-driven feature toggles.
 * Keep boolean parsing in one place so "unset" has an intentional default.
 */

function envBool(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

module.exports = { envBool };
