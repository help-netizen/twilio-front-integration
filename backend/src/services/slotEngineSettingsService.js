/**
 * slotEngineSettingsService.js — single source of truth for per-company recommendation
 * settings (REC-SETTINGS-001). Owns the DEFAULTS, validation ranges, resolve/get/save
 * logic, and the engine config_override mapping (buildConfigOverride).
 *
 * Exactly 5 parameters are user-editable; 2 further values are always injected into the
 * built override but never stored or shown. `resolve` NEVER throws — recommendations must
 * keep working even if the settings table is unreadable (safe-failure parity with
 * slotEngineService).
 */
const queries = require('../db/slotEngineSettingsQueries');

const DEFAULTS = {
    max_distance_miles: 10,
    overlap_minutes: 0,
    min_buffer_minutes: 15,
    horizon_days: 3,
    recommendations_shown: 3,
};

// Inclusive integer ranges, server-enforced (RS-R5).
const VALIDATION = {
    max_distance_miles: { min: 1, max: 100 },
    overlap_minutes: { min: 0, max: 240 },
    min_buffer_minutes: { min: 0, max: 240 },
    horizon_days: { min: 1, max: 14 },
    recommendations_shown: { min: 1, max: 10 },
};

const KEYS = Object.keys(DEFAULTS);

function invalid(field, message) {
    const err = new Error(message);
    err.httpStatus = 422;
    err.code = 'INVALID_SETTINGS';
    err.field = field;
    return err;
}

/**
 * Coerce a single value to an integer if it cleanly represents one ("15" -> 15),
 * otherwise return null (rejects 12.5, "abc", NaN, null, undefined, booleans, ...).
 */
function toInt(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isInteger(n) ? n : null;
    }
    return null;
}

/**
 * validate(input) — reads ONLY the 5 known keys (unknown keys stripped), coerces each to
 * an integer, and range-checks it. All-or-nothing: every key is validated before anything
 * is returned. On any failure throws { httpStatus:422, code:'INVALID_SETTINGS', field,
 * message }. Returns a fresh object with exactly the 5 cleaned integer values (PUT replaces
 * all 5).
 */
function validate(input) {
    const src = input && typeof input === 'object' ? input : {};
    const cleaned = {};
    for (const key of KEYS) {
        const range = VALIDATION[key];
        const n = toInt(src[key]);
        if (n === null) {
            throw invalid(key, `${key} must be an integer between ${range.min} and ${range.max}.`);
        }
        if (n < range.min || n > range.max) {
            throw invalid(key, `${key} must be between ${range.min} and ${range.max}.`);
        }
        cleaned[key] = n;
    }
    return cleaned;
}

/**
 * Overlay any valid stored keys onto DEFAULTS. Per-key fallback: a missing or corrupt
 * (non-integer / out-of-range) stored value falls back to that key's default, so the
 * returned object is ALWAYS complete and integer-typed (never partial/undefined).
 */
function coerceStored(config) {
    const src = config && typeof config === 'object' ? config : {};
    const out = {};
    for (const key of KEYS) {
        const range = VALIDATION[key];
        const n = toInt(src[key]);
        out[key] = (n !== null && n >= range.min && n <= range.max) ? n : DEFAULTS[key];
    }
    return out;
}

/**
 * get(companyId) — the resolved stored config (row-or-defaults). Missing/malformed
 * individual keys fall back to DEFAULTS. A hard DB error propagates (the GET route
 * surfaces it as 500).
 */
async function get(companyId) {
    const config = await queries.getByCompany(companyId);
    if (!config) return { ...DEFAULTS };
    return coerceStored(config);
}

/**
 * resolve(companyId) — like get, but degrades to DEFAULTS on ANY DB/query error and NEVER
 * throws. Used by slotEngineService so recommendations keep working even if the settings
 * table is unreadable.
 */
async function resolve(companyId) {
    try {
        return await get(companyId);
    } catch (err) {
        console.warn('[SlotEngineSettings] resolve failed, using DEFAULTS:', err.message);
        return { ...DEFAULTS };
    }
}

/**
 * save(companyId, input) — validate (all-or-nothing) then upsert; returns the saved 5
 * values. Validation runs fully before any write, so a 422 never partially persists.
 */
async function save(companyId, input) {
    const cleaned = validate(input);
    const stored = await queries.upsert(companyId, cleaned);
    return coerceStored(stored);
}

/**
 * buildConfigOverride(settings) — the exact deep-merge override sent to the engine. Input
 * is a fully-resolved settings object (all 5 keys present). The 2 fixed values
 * (allow_empty_day_candidates, max_day_utilization) are emitted unconditionally. Each key
 * path is verified present in slot-engine/src/config.js DEFAULT_CONFIG.
 */
function buildConfigOverride(settings) {
    return {
        geography: {
            max_distance_from_existing_job_miles: settings.max_distance_miles,
            max_distance_from_base_if_empty_day_miles: settings.max_distance_miles, // ONE radius -> BOTH keys
            allow_empty_day_candidates: true, // fixed, always
        },
        overlap: { max_timeframe_overlap_minutes: settings.overlap_minutes },
        feasibility: { min_required_slack_minutes: settings.min_buffer_minutes },
        planning: { horizon_days: settings.horizon_days },
        ranking: { top_n: settings.recommendations_shown },
        workload: { max_day_utilization: 0.95 }, // fixed, always
    };
}

module.exports = { DEFAULTS, get, resolve, validate, save, buildConfigOverride };
