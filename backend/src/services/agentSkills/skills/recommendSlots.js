/**
 * agentSkills / skills / recommendSlots — RELOCATED legacy L0 tool
 * (AGENT-SKILLS-001, spec §7.3 / task T3; origin VAPI-SLOT-ENGINE-001).
 *
 * Byte-identical relocation of `handleRecommendSlots` (+ `formatSlotLabel`,
 * `SLOT_FALLBACK`, `MONTHS`, `WEEKDAYS`) from `routes/vapi-tools.js` (the pre-T4
 * source of truth). Internals RELOCATED, NOT rewritten — the `smart-slot-engine`
 * marketplace gate, the `SLOT_FALLBACK` safe-fail on EVERY fault (app not
 * connected / engine unavailable / no location / empty recs / throw), the
 * location resolution (lat+lng → address → zip), the `daysAhead` horizon
 * extension, and the keyed-slot mapping (stable `date|start|end` key, exclude,
 * dedup, cap to MAX_SLOTS) are all preserved verbatim:
 *   not-connected / any fault → { available:false, slots:[], fallback:true }
 *   happy                     → { available:true, slots:[{ key, date, start, end,
 *                                 label, techName, confidence }] }
 *
 * FROZEN shape (no ok/speak). Only change vs. the old handler: `companyId`
 * arrives as the arg (adapter passes DEFAULT_COMPANY_ID) instead of the module
 * constant. `verifiedContext` unused (L0 — never blocked).
 */

'use strict';

const marketplaceService = require('../../marketplaceService');
const slotEngineService = require('../../slotEngineService');

const APPOINTMENT_DURATION_MIN = 120;
const MAX_SLOTS = 3;

// ZIP normalization (recover a dropped leading zero) — shared util.
const { normalizeZip } = require('../../../utils/zip');

const SLOT_FALLBACK = { available: false, slots: [], fallback: true };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Human-readable spoken window, e.g. "Tue Jul 8, 10:00–13:00".
 * Built from the date + the company-local 'HH:MM' window the engine already
 * returns (tech-agnostic), so no tz math is needed here — the engine's times are
 * already company-local wall-clock. Falls back to a bare "date start–end" string
 * if the date can't be parsed.
 */
function formatSlotLabel(date, start, end) {
    const [y, mo, d] = String(date).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
        // Noon UTC keeps the weekday stable regardless of the runtime tz.
        const dow = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay()] || '';
        const mon = MONTHS[mo - 1] || '';
        return `${dow} ${mon} ${d}, ${start}–${end}`.trim();
    }
    return `${date}, ${start}–${end}`;
}

/**
 * recommendSlots — offer engine-ranked concrete arrival windows to the caller.
 * Gated on the smart-slot-engine marketplace app; calls slotEngineService
 * DIRECTLY (not the auth'd proxy). Everything is inside one try/catch: any fault
 * (app not connected, engine unavailable, no location, empty recs, or a throw)
 * degrades to {available:false, slots:[], fallback:true} — never a 500, never a
 * fabricated window, the call always continues.
 *
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on the voice surface).
 * @param {object} _verifiedContext Unused for this L0 tool.
 * @param {{ zip?, lat?, lng?, address?, unitType?, durationMinutes?, excludeSlots?, daysAhead? }} input
 * @returns {Promise<object>} Frozen legacy shape (no ok/speak); never throws.
 */
async function run(companyId, _verifiedContext, input = {}) {
    try {
        const { zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead } = input;

        // 1. Gate: don't touch the engine unless the app is connected.
        const connected = await marketplaceService.isAppConnected(
            companyId,
            marketplaceService.SMART_SLOT_ENGINE_APP_KEY,
        );
        if (!connected) return { ...SLOT_FALLBACK };

        // 2. Location: prefer lat+lng (both finite) → else address → else zip.
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
        const locStr = (address && String(address).trim()) || normalizeZip(zip) || undefined;
        const newJob = {
            ...(hasCoords ? { lat, lng } : {}),
            ...(locStr ? { address: locStr } : {}),
            job_type: unitType ? `${unitType} Repair` : 'Appliance Repair',
            duration_minutes: Number.isFinite(durationMinutes) ? durationMinutes : APPOINTMENT_DURATION_MIN,
        };
        // Deeper mode: extend the horizon via latest_allowed_date (company-local).
        if (Number.isFinite(daysAhead)) {
            const tz = await slotEngineService.resolveTimezone(companyId);
            const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
            const base = new Date(`${today}T00:00:00Z`);
            base.setUTCDate(base.getUTCDate() + daysAhead);
            newJob.latest_allowed_date = base.toISOString().slice(0, 10);
        }

        // 3. Call the engine directly.
        const { recommendations, engine_status } = await slotEngineService.getRecommendations(
            companyId,
            { new_job: newJob },
        );
        if (engine_status !== 'ok' || !Array.isArray(recommendations) || recommendations.length === 0) {
            return { ...SLOT_FALLBACK };
        }

        // 4. Map recs → slots. Stable, tech-agnostic key `date|start|end` collapses
        //    the same window from different techs to one offer and round-trips via
        //    excludeSlots. Drop excluded keys, dedup, cap to MAX_SLOTS.
        const exclude = new Set(Array.isArray(excludeSlots) ? excludeSlots : []);
        const seen = new Set();
        const slots = [];
        for (const rec of recommendations) {
            const start = rec?.time_frame?.start;
            const end = rec?.time_frame?.end;
            if (!rec?.date || !start || !end) continue;
            const key = `${rec.date}|${start}|${end}`;
            if (exclude.has(key) || seen.has(key)) continue;
            seen.add(key);
            slots.push({
                key,
                date: rec.date,
                start,
                end,
                label: formatSlotLabel(rec.date, start, end),
                techName: rec.technicians?.[0]?.name,
                confidence: rec.confidence,
            });
            if (slots.length >= MAX_SLOTS) break;
        }

        if (slots.length === 0) return { ...SLOT_FALLBACK };
        return { available: true, slots };
    } catch (err) {
        console.error('[vapi-tools] recommendSlots error:', err.message);
        return { ...SLOT_FALLBACK };
    }
}

module.exports = { run };
