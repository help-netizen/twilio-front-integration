/**
 * outboundLeadCallSettingsService.js — single source of truth for per-company
 * settings of the outbound "new lead → book it" robot call
 * (OUTBOUND-LEAD-CALL-001, FR-2/FR-5). Owns DEFAULTS, resolve/get, source
 * normalization, and the sources upsert used by the settings route.
 *
 * Mirrors outboundCallSettingsService (OUTBOUND-PARTS-CALL-001): one row per
 * company in outbound_lead_call_settings (company_id PK = FK). `resolve` NEVER
 * throws — the eligibility gauntlet and the dialer keep working even if the
 * settings table is unreadable (safe-failure parity). The two ladders are fully
 * independent: this module never reads outbound_call_settings.
 */
const db = require('../db/connection');

const DEFAULTS = {
    enabled_sources: ['ProReferral'],
    max_attempts: 3,
    backoff_schedule: ['immediate', '+30m', '+2h'],
    // AGENT-CALL-WINDOW-001: null means inherit the company dispatch schedule.
    calling_window_mode: null,
    custom_start_time: null,
    custom_end_time: null,
    calling_window_work_days: null,
};

// 'always' is retained for existing saved lead-caller settings. The new UI
// exposes inherit/custom only.
const CALLING_WINDOW_MODES = ['always', 'custom'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A custom window is usable only when BOTH ends are HH:MM and start < end
 * (same-day; overnight windows are what 'always' is for). Lexicographic compare
 * is chronological for zero-padded 24h. Pure.
 */
function isUsableCustomWindow(start, end, workDays = [0, 1, 2, 3, 4, 5, 6]) {
    return typeof start === 'string' && typeof end === 'string'
        && HHMM_RE.test(start) && HHMM_RE.test(end) && start < end
        && Array.isArray(workDays) && workDays.length > 0
        && workDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6);
}

/**
 * Canonical source key: trims, strips ALL whitespace, lowercases —
 * "Pro Referral" ≡ "ProReferral" ≡ "  pro   referral " → 'proreferral'.
 * Pure; never throws (non-strings coerce via String()).
 */
function normalizeSource(s) {
    return String(s ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * Whether the lead's raw source matches ANY enabled source, both sides
 * normalized. Empty raw source is never enabled. Pure.
 */
function isSourceEnabled(settings, rawSource) {
    const key = normalizeSource(rawSource);
    if (key === '') return false;
    const list = Array.isArray(settings?.enabled_sources) ? settings.enabled_sources : [];
    return list.some(s => normalizeSource(s) === key);
}

/**
 * Overlay stored row values onto DEFAULTS, per-key. A missing/corrupt individual
 * value falls back to that key's default, so the returned object is ALWAYS
 * complete and typed. Pure.
 */
function coerceStored(row) {
    if (!row || typeof row !== 'object') return { ...DEFAULTS };
    const out = { ...DEFAULTS };

    if (Array.isArray(row.enabled_sources)) {
        const cleaned = row.enabled_sources
            .map(x => String(x ?? '').trim())
            .filter(x => x !== '');
        out.enabled_sources = cleaned;
    }
    if (Number.isInteger(row.max_attempts) && row.max_attempts > 0) {
        out.max_attempts = row.max_attempts;
    }
    if (Array.isArray(row.backoff_schedule) && row.backoff_schedule.length > 0) {
        out.backoff_schedule = row.backoff_schedule;
    }

    if (row.calling_window_mode === 'always') {
        out.calling_window_mode = 'always';
    } else if (row.calling_window_mode === 'custom'
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

    if (row.updated_at !== undefined) {
        out.updated_at = row.updated_at;
    }
    return out;
}

/**
 * get(companyId) — resolved stored settings (row-or-defaults). Missing/malformed
 * individual keys fall back to DEFAULTS. A hard DB error propagates.
 */
async function get(companyId) {
    const { rows } = await db.query(
        `SELECT enabled_sources, max_attempts, backoff_schedule,
                calling_window_mode, custom_start_time, custom_end_time,
                calling_window_work_days, updated_at
         FROM outbound_lead_call_settings
         WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]) return { ...DEFAULTS };
    if (rows[0].calling_window_mode != null
        && !CALLING_WINDOW_MODES.includes(rows[0].calling_window_mode)) {
        throw new Error('invalid stored lead caller mode');
    }
    if (rows[0].calling_window_mode === 'custom' && !isUsableCustomWindow(
        rows[0].custom_start_time,
        rows[0].custom_end_time,
        rows[0].calling_window_work_days
    )) {
        throw new Error('invalid stored lead caller window');
    }
    return coerceStored(rows[0]);
}

/**
 * resolve(companyId) — like get, but degrades to DEFAULTS on ANY error and
 * NEVER throws (safe-fail; eligibility/dialer parity with the parts robot).
 */
async function resolve(companyId) {
    try {
        return await get(companyId);
    } catch (err) {
        console.warn('[OutboundLeadCallSettings] resolve failed, using DEFAULTS:', err.message);
        return { ...DEFAULTS };
    }
}

/**
 * saveSources(companyId, enabledSources) — upsert used by the PUT settings
 * route (spec §10.3). Ladder columns stay DB-editable only in v1 (no UI —
 * parts precedent). Returns the coerced stored row.
 */
async function saveSources(companyId, enabledSources) {
    const { rows } = await db.query(
        `INSERT INTO outbound_lead_call_settings (company_id, enabled_sources)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (company_id) DO UPDATE
             SET enabled_sources = EXCLUDED.enabled_sources, updated_at = NOW()
         RETURNING *`,
        [companyId, JSON.stringify(enabledSources)]
    );
    return coerceStored(rows[0]);
}

/**
 * saveSettings(companyId, fields) — OLC-WINDOW-001 upsert for the full settings
 * surface: enabled sources + calling-window override. Null mode/fields means
 * inherit. Existing 'always' rows remain supported; new UI writes null/custom.
 */
async function saveSettings(companyId, fields = {}) {
    let mode = CALLING_WINDOW_MODES.includes(fields.calling_window_mode)
        ? fields.calling_window_mode : null;
    let cs = null;
    let ce = null;
    let workDays = null;
    if (mode === 'custom' && isUsableCustomWindow(
        fields.custom_start_time,
        fields.custom_end_time,
        fields.calling_window_work_days
    )) {
        cs = fields.custom_start_time;
        ce = fields.custom_end_time;
        workDays = [...new Set(fields.calling_window_work_days)].sort((a, b) => a - b);
    } else if (mode === 'custom') {
        mode = null;
    }
    const sources = Array.isArray(fields.enabled_sources) ? fields.enabled_sources : [];

    const { rows } = await db.query(
        `INSERT INTO outbound_lead_call_settings
             (company_id, enabled_sources, calling_window_mode, custom_start_time,
              custom_end_time, calling_window_work_days)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb)
         ON CONFLICT (company_id) DO UPDATE SET
             enabled_sources     = EXCLUDED.enabled_sources,
             calling_window_mode = EXCLUDED.calling_window_mode,
             custom_start_time   = EXCLUDED.custom_start_time,
             custom_end_time     = EXCLUDED.custom_end_time,
             calling_window_work_days = EXCLUDED.calling_window_work_days,
             updated_at          = NOW()
         RETURNING *`,
        [companyId, JSON.stringify(sources), mode, cs, ce, workDays ? JSON.stringify(workDays) : null]
    );
    return coerceStored(rows[0]);
}

module.exports = {
    DEFAULTS,
    CALLING_WINDOW_MODES,
    isUsableCustomWindow,
    normalizeSource,
    isSourceEnabled,
    coerceStored,
    get,
    resolve,
    saveSources,
    saveSettings,
};
