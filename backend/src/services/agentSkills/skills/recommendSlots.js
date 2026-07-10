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
 *
 * OUTBOUND-PARTS-CALL-TECHSLOT-001 (§4, additive — legacy inputs byte-identical):
 *   - `technicianId` (server-injected via variableValues; the model never sends
 *     it) → `new_job.technician_id`: the engine is constrained to that ONE tech.
 *   - `targetDay` ('YYYY-MM-DD', model-resolved) → `earliest = latest = targetDay`
 *     (that day only; up to MAX_SLOTS windows) — req 4.
 *   - `targetTime` ('HH:MM' 24h, meaningful only WITH targetDay) → EXACTLY ONE
 *     window: the one whose [start,end) contains T (distance 0), else
 *     argmin |start − T|, tie → earlier start. Never a list — req 5.
 *   Malformed targetDay/targetTime → the arg is ignored (behaves as absent);
 *   the output shape and the SLOT_FALLBACK safe-fail contract are unchanged.
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
// 12-hour, speech-friendly time ("10:00" -> "10 AM", "14:30" -> "2:30 PM"). The voice
// agent reads slotLabel verbatim, so keep it natural — never 24h "14:00" or a dash range.
function to12h(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    if (!Number.isFinite(h)) return String(hhmm);
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = ((h + 11) % 12) + 1;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${period}` : `${h12} ${period}`;
}

// TECHSLOT-001 req-4: strict 'YYYY-MM-DD' — anything else is ignored (the engine's
// own past/horizon filter handles well-formed-but-impossible dates → empty → fallback).
const TARGET_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'HH:MM' (24h, lenient 'H:MM') → minutes since midnight, or null when malformed. */
function parseHHMM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/**
 * TECHSLOT-001 req-5 single-nearest re-rank (the engine has no target-time
 * concept — this is the in-skill re-rank over ONE day's windows). Pick the
 * window whose [start,end) contains T (distance 0); else the one minimizing
 * |start − T|; tie → earlier start. Returns one slot or null (unparseable set).
 */
function pickNearestSlot(slots, targetMinutes) {
    let best = null;
    let bestDist = Infinity;
    let bestStart = Infinity;
    for (const slot of slots) {
        const start = parseHHMM(slot.start);
        if (start === null) continue;
        const end = parseHHMM(slot.end);
        const contains = end !== null && start <= targetMinutes && targetMinutes < end;
        const dist = contains ? 0 : Math.abs(start - targetMinutes);
        if (dist < bestDist || (dist === bestDist && start < bestStart)) {
            best = slot;
            bestDist = dist;
            bestStart = start;
        }
    }
    return best;
}

function formatSlotLabel(date, start, end) {
    const [y, mo, d] = String(date).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
        // Noon UTC keeps the weekday stable regardless of the runtime tz. FULL weekday +
        // month names so the agent says "Thursday, July 9" — not the abbreviated "Thu Jul 9".
        const dt = new Date(Date.UTC(y, mo - 1, d, 12));
        const dow = dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
        const mon = dt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
        return `${dow}, ${mon} ${d}, ${to12h(start)} to ${to12h(end)}`;
    }
    return `${date}, ${to12h(start)} to ${to12h(end)}`;
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
 * @param {{ zip?, lat?, lng?, address?, unitType?, durationMinutes?, excludeSlots?, daysAhead?,
 *           technicianId?, targetDay?, targetTime? }} input
 *   TECHSLOT-001: `technicianId` (server-injected) → one-tech constraint;
 *   `targetDay` 'YYYY-MM-DD' → that day only; `targetTime` 'HH:MM' (with
 *   targetDay) → exactly ONE nearest window. Malformed new args are ignored.
 * @returns {Promise<object>} Frozen legacy shape (no ok/speak); never throws.
 */
async function run(companyId, _verifiedContext, input = {}) {
    try {
        const {
            zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead,
            technicianId, targetDay, targetTime,
        } = input;

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

        // TECHSLOT-001: single-technician constraint. Server-injected via
        // variableValues (buildSkillInput spreads them AFTER model args, so this
        // value is authoritative — the model can't set it). Absent → all-tech.
        if (technicianId != null && String(technicianId).trim() !== '') {
            newJob.technician_id = technicianId;
        }

        // TECHSLOT-001 req-4: a specific day → that day only (earliest = latest).
        // Wins over daysAhead. Malformed → ignored (behaves as absent, never a fault);
        // a well-formed past/out-of-horizon day is dropped by the engine → fallback.
        const day = (typeof targetDay === 'string' && TARGET_DAY_RE.test(targetDay.trim()))
            ? targetDay.trim()
            : null;
        if (day) {
            newJob.earliest_allowed_date = day;
            newJob.latest_allowed_date = day;
        }
        // TECHSLOT-001 req-5: time-of-day is meaningful only WITH a valid targetDay
        // (no single day to search otherwise); malformed → ignored → day windows.
        const targetMinutes = day ? parseHHMM(targetTime) : null;

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
        //    excludeSlots. Drop excluded keys, dedup, cap to MAX_SLOTS — except in
        //    single-nearest mode (req 5), where ALL of the day's windows must be
        //    considered or the true nearest could sit past the cap.
        const wantNearest = targetMinutes !== null;
        const exclude = new Set(Array.isArray(excludeSlots) ? excludeSlots : []);
        const seen = new Set();
        const slots = [];
        for (const rec of recommendations) {
            const start = rec?.time_frame?.start;
            const end = rec?.time_frame?.end;
            if (!rec?.date || !start || !end) continue;
            // Defensive: with a day scope the engine already returns only that day;
            // never let a stray other-day window into a day-scoped offer.
            if (day && rec.date !== day) continue;
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
            if (!wantNearest && slots.length >= MAX_SLOTS) break;
        }

        if (slots.length === 0) return { ...SLOT_FALLBACK };

        // TECHSLOT-001 req-5: day+time → EXACTLY ONE window (never a list).
        if (wantNearest) {
            const nearest = pickNearestSlot(slots, targetMinutes);
            if (!nearest) return { ...SLOT_FALLBACK };
            return { available: true, slots: [nearest] };
        }

        return { available: true, slots };
    } catch (err) {
        console.error('[vapi-tools] recommendSlots error:', err.message);
        return { ...SLOT_FALLBACK };
    }
}

module.exports = { run, formatSlotLabel };
