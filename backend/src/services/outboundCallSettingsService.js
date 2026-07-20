/**
 * outboundCallSettingsService.js — single source of truth for per-company retry settings
 * of the outbound "part arrived → book the finish visit" robot call
 * (OUTBOUND-PARTS-CALL-001, FR-10). Owns the DEFAULTS and the resolve/get logic.
 *
 * Mirrors slotEngineSettingsService (REC-SETTINGS-001): one row per company in
 * outbound_call_settings (company_id PK = FK). `resolve` NEVER throws — the retry worker
 * and startRobotCall must keep working even if the settings table is unreadable
 * (safe-failure parity). AGENT-CALL-WINDOW-001 adds the independent nullable
 * parts-caller window surfaced by its marketplace app page.
 */
const db = require('../db/connection');

const DEFAULTS = {
    max_attempts: 3,
    backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
    next_morning_hour: 9,
    enabled: true,
    calling_window_mode: null,
    custom_start_time: null,
    custom_end_time: null,
    calling_window_work_days: null,
};

const CALLING_WINDOW_MODES = ['custom'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isUsableCustomWindow(start, end, workDays) {
    return typeof start === 'string' && typeof end === 'string'
        && HHMM_RE.test(start) && HHMM_RE.test(end) && start < end
        && Array.isArray(workDays) && workDays.length > 0
        && workDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6);
}

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
    if (row.calling_window_mode === 'custom'
        && isUsableCustomWindow(
            row.custom_start_time,
            row.custom_end_time,
            row.calling_window_work_days
        )) {
        out.calling_window_mode = 'custom';
        out.custom_start_time = row.custom_start_time;
        out.custom_end_time = row.custom_end_time;
        out.calling_window_work_days = [...new Set(row.calling_window_work_days)].sort((a, b) => a - b);
    }
    if (row.updated_at !== undefined) out.updated_at = row.updated_at;
    return out;
}

/**
 * get(companyId) — the resolved stored settings (row-or-defaults). Missing/malformed
 * individual keys fall back to DEFAULTS. A hard DB error propagates to the caller.
 */
async function get(companyId) {
    const { rows } = await db.query(
        `SELECT max_attempts, backoff_schedule, next_morning_hour, enabled,
                calling_window_mode, custom_start_time, custom_end_time,
                calling_window_work_days, updated_at
         FROM outbound_call_settings
         WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]) return { ...DEFAULTS };
    if (rows[0].calling_window_mode != null
        && !CALLING_WINDOW_MODES.includes(rows[0].calling_window_mode)) {
        throw new Error('invalid stored parts caller mode');
    }
    if (rows[0].calling_window_mode === 'custom' && !isUsableCustomWindow(
        rows[0].custom_start_time,
        rows[0].custom_end_time,
        rows[0].calling_window_work_days
    )) {
        throw new Error('invalid stored parts caller window');
    }
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

/** Persist only the parts robot's schedule override; retry settings are untouched. */
async function saveCallingWindow(companyId, fields = {}) {
    let mode = CALLING_WINDOW_MODES.includes(fields.calling_window_mode)
        ? fields.calling_window_mode
        : null;
    let start = null;
    let end = null;
    let workDays = null;
    if (mode === 'custom' && isUsableCustomWindow(
        fields.custom_start_time,
        fields.custom_end_time,
        fields.calling_window_work_days
    )) {
        start = fields.custom_start_time;
        end = fields.custom_end_time;
        workDays = [...new Set(fields.calling_window_work_days)].sort((a, b) => a - b);
    } else if (mode === 'custom') {
        mode = null;
    }

    const { rows } = await db.query(
        `INSERT INTO outbound_call_settings
            (company_id, calling_window_mode, custom_start_time,
             custom_end_time, calling_window_work_days)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (company_id) DO UPDATE SET
             calling_window_mode = EXCLUDED.calling_window_mode,
             custom_start_time = EXCLUDED.custom_start_time,
             custom_end_time = EXCLUDED.custom_end_time,
             calling_window_work_days = EXCLUDED.calling_window_work_days,
             updated_at = NOW()
         RETURNING *`,
        [companyId, mode, start, end, workDays ? JSON.stringify(workDays) : null]
    );
    return coerceStored(rows[0]);
}

module.exports = {
    DEFAULTS,
    CALLING_WINDOW_MODES,
    isUsableCustomWindow,
    coerceStored,
    get,
    resolve,
    saveCallingWindow,
};
