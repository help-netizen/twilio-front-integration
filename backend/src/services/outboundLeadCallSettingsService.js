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
    // OLC-WINDOW-001: when Sara is allowed to dial.
    //   office_hours → dispatch business hours (the pre-feature behaviour),
    //   always       → 24/7,
    //   custom       → custom_start_time..custom_end_time daily (company tz).
    calling_window_mode: 'office_hours',
    custom_start_time: null,
    custom_end_time: null,
};

// OLC-WINDOW-001 shared vocabulary.
const CALLING_WINDOW_MODES = ['office_hours', 'always', 'custom'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A custom window is usable only when BOTH ends are HH:MM and start < end
 * (same-day; overnight windows are what 'always' is for). Lexicographic compare
 * is chronological for zero-padded 24h. Pure.
 */
function isUsableCustomWindow(start, end) {
    return typeof start === 'string' && typeof end === 'string'
        && HHMM_RE.test(start) && HHMM_RE.test(end) && start < end;
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

    // OLC-WINDOW-001 — mode + custom times. A 'custom' mode with an unusable
    // window degrades to 'office_hours' so the dialer never freezes on garbage.
    if (typeof row.calling_window_mode === 'string' && CALLING_WINDOW_MODES.includes(row.calling_window_mode)) {
        out.calling_window_mode = row.calling_window_mode;
    }
    out.custom_start_time = (typeof row.custom_start_time === 'string' && HHMM_RE.test(row.custom_start_time))
        ? row.custom_start_time : null;
    out.custom_end_time = (typeof row.custom_end_time === 'string' && HHMM_RE.test(row.custom_end_time))
        ? row.custom_end_time : null;
    if (out.calling_window_mode === 'custom' && !isUsableCustomWindow(out.custom_start_time, out.custom_end_time)) {
        out.calling_window_mode = 'office_hours';
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
                calling_window_mode, custom_start_time, custom_end_time, updated_at
         FROM outbound_lead_call_settings
         WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]) return { ...DEFAULTS };
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
 * surface: enabled sources + calling-window mode/custom times. Normalizes the
 * window server-side (defense in depth; the route validates too): a non-'custom'
 * mode clears the custom times, and a 'custom' mode with an unusable window
 * degrades to 'office_hours' rather than persisting a window the dialer can't
 * honor. Returns the coerced stored row.
 */
async function saveSettings(companyId, fields = {}) {
    let mode = CALLING_WINDOW_MODES.includes(fields.calling_window_mode)
        ? fields.calling_window_mode : 'office_hours';
    let cs = (typeof fields.custom_start_time === 'string' && HHMM_RE.test(fields.custom_start_time))
        ? fields.custom_start_time : null;
    let ce = (typeof fields.custom_end_time === 'string' && HHMM_RE.test(fields.custom_end_time))
        ? fields.custom_end_time : null;
    if (mode === 'custom' && !isUsableCustomWindow(cs, ce)) { mode = 'office_hours'; }
    if (mode !== 'custom') { cs = null; ce = null; }
    const sources = Array.isArray(fields.enabled_sources) ? fields.enabled_sources : [];

    const { rows } = await db.query(
        `INSERT INTO outbound_lead_call_settings
             (company_id, enabled_sources, calling_window_mode, custom_start_time, custom_end_time)
         VALUES ($1, $2::jsonb, $3, $4, $5)
         ON CONFLICT (company_id) DO UPDATE SET
             enabled_sources     = EXCLUDED.enabled_sources,
             calling_window_mode = EXCLUDED.calling_window_mode,
             custom_start_time   = EXCLUDED.custom_start_time,
             custom_end_time     = EXCLUDED.custom_end_time,
             updated_at          = NOW()
         RETURNING *`,
        [companyId, JSON.stringify(sources), mode, cs, ce]
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
