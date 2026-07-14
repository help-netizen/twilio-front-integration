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
};

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
        `SELECT enabled_sources, max_attempts, backoff_schedule, updated_at
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

module.exports = {
    DEFAULTS,
    normalizeSource,
    isSourceEnabled,
    coerceStored,
    get,
    resolve,
    saveSources,
};
