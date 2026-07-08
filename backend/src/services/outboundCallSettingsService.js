/**
 * outboundCallSettingsService.js — single source of truth for per-company retry settings
 * of the outbound "part arrived → book the finish visit" robot call
 * (OUTBOUND-PARTS-CALL-001, FR-10). Owns the DEFAULTS and the resolve/get logic.
 *
 * Mirrors slotEngineSettingsService (REC-SETTINGS-001): one row per company in
 * outbound_call_settings (company_id PK = FK). `resolve` NEVER throws — the retry worker
 * and startRobotCall must keep working even if the settings table is unreadable
 * (safe-failure parity). There is no Settings UI in v1: only the Boston Masters row need
 * exist; every caller passes job.company_id.
 */
const db = require('../db/connection');

const DEFAULTS = {
    max_attempts: 3,
    backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
    next_morning_hour: 9,
    enabled: true,
};

/**
 * Overlay stored row values onto DEFAULTS, per-key. A missing/corrupt individual value
 * falls back to that key's default, so the returned object is ALWAYS complete and typed.
 */
function coerceStored(row) {
    if (!row || typeof row !== 'object') return { ...DEFAULTS };
    const out = { ...DEFAULTS };

    if (Number.isInteger(row.max_attempts) && row.max_attempts > 0) {
        out.max_attempts = row.max_attempts;
    }
    if (Array.isArray(row.backoff_schedule) && row.backoff_schedule.length > 0) {
        out.backoff_schedule = row.backoff_schedule;
    }
    if (Number.isInteger(row.next_morning_hour) && row.next_morning_hour >= 0 && row.next_morning_hour <= 23) {
        out.next_morning_hour = row.next_morning_hour;
    }
    if (typeof row.enabled === 'boolean') {
        out.enabled = row.enabled;
    }
    return out;
}

/**
 * get(companyId) — the resolved stored settings (row-or-defaults). Missing/malformed
 * individual keys fall back to DEFAULTS. A hard DB error propagates to the caller.
 */
async function get(companyId) {
    const { rows } = await db.query(
        `SELECT max_attempts, backoff_schedule, next_morning_hour, enabled
         FROM outbound_call_settings
         WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]) return { ...DEFAULTS };
    return coerceStored(rows[0]);
}

/**
 * resolve(companyId) — like get, but degrades to DEFAULTS on ANY DB/query error and
 * NEVER throws (safe-fail). Used by the retry worker / startRobotCall so the outbound
 * call keeps working even if the settings table is unreadable or the row is absent.
 */
async function resolve(companyId) {
    try {
        return await get(companyId);
    } catch (err) {
        console.warn('[OutboundCallSettings] resolve failed, using DEFAULTS:', err.message);
        return { ...DEFAULTS };
    }
}

module.exports = { DEFAULTS, get, resolve };
