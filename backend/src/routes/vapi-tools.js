/**
 * VAPI Tool Call Handler — public endpoint, secured by x-vapi-secret header
 *
 * POST /api/vapi-tools
 *
 * VAPI sends:
 *   { message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments } }], call: { ... } } }
 *
 * Tools handled:
 *   - checkServiceArea({ zip })              — check zip against service_territories DB
 *   - validateAddress({ street, apt, ... })  — Google Maps Geocoding (uses GOOGLE_GEOCODING_KEY)
 *   - checkAvailability({ zip, unitType })   — Albusto scheduleService.getAvailableSlots (dispatch_settings + booked items)
 *   - createLead({ ... })                    — create qualified lead in CRM
 *
 * Response format (VAPI expects):
 *   { results: [{ toolCallId, result }] }
 */
const express = require('express');
const router = express.Router();
const https = require('https');
const stQueries = require('../db/serviceTerritoryQueries');
const leadsService = require('../services/leadsService');
const scheduleService = require('../services/scheduleService');
const marketplaceService = require('../services/marketplaceService');
const slotEngineService = require('../services/slotEngineService');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const AVAILABILITY_DAYS = 5;
const APPOINTMENT_DURATION_MIN = 120;
const MAX_SLOTS = 3;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function vapiSecretAuth(req, res, next) {
    const secret = process.env.VAPI_TOOLS_SECRET;
    if (!secret) {
        // Fail closed: a public endpoint must never run unauthenticated.
        console.error('[vapi-tools] VAPI_TOOLS_SECRET not set — refusing requests (fail-closed)');
        return res.status(503).json({ error: 'vapi tools not configured' });
    }
    const header = req.headers['x-vapi-secret'];
    if (header !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ZIP normalization (recover a dropped leading zero) now lives in a shared util,
// so the service-territory query layer and every caller normalize identically.
const { normalizeZip } = require('../utils/zip');

// ─── Tool: checkServiceArea ───────────────────────────────────────────────────

async function handleCheckServiceArea({ zip }) {
    const z = normalizeZip(zip);
    if (!z) return { inServiceArea: false, error: 'zip is required' };

    const row = await stQueries.search(DEFAULT_COMPANY_ID, z);
    if (!row) return { inServiceArea: false, zip: z };

    return {
        inServiceArea: true,
        area: row.area || '',
        city: row.city || '',
        state: row.state || '',
        zip: row.zip || z,
    };
}

// ─── Tool: validateAddress ────────────────────────────────────────────────────

async function handleValidateAddress({ street, apt, city, state, zip }) {
    // Dedicated server-side Geocoding key (IP-restricted). Falls back to the
    // frontend Maps key for back-compat if the dedicated one isn't set.
    const apiKey = process.env.GOOGLE_GEOCODING_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[vapi-tools] GOOGLE_GEOCODING_KEY not set — address validation skipped');
        return { valid: false, error: 'GOOGLE_GEOCODING_KEY not configured' };
    }

    try {
        const z = normalizeZip(zip);
        const parts = [street, apt, city, state, z].filter(Boolean);
        const addressQuery = parts.join(', ');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressQuery)}&key=${apiKey}`;

        const data = await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('Invalid JSON from Geocoding API')); }
                });
            }).on('error', reject);
        });

        if (!data.results || data.results.length === 0 || data.status === 'ZERO_RESULTS') {
            return { valid: false };
        }

        const result = data.results[0];
        const components = result.address_components || [];

        const postalComponent = components.find(c => c.types.includes('postal_code'));
        const correctedZip = postalComponent?.short_name || z || '';

        // Strip ", USA" from formatted address for cleaner speech output
        const standardized = (result.formatted_address || '').replace(/, USA$/, '').trim();

        return {
            valid: true,
            standardized,
            correctedZip,
            lat: result.geometry?.location?.lat ?? null,
            lng: result.geometry?.location?.lng ?? null,
        };
    } catch (err) {
        console.error('[vapi-tools] validateAddress error:', err.message);
        return { valid: false };
    }
}

// ─── Tool: checkAvailability ──────────────────────────────────────────────────

async function handleCheckAvailability({ zip, unitType, days }) {
    try {
        return await scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, {
            days: days || AVAILABILITY_DAYS,
            slotDurationMin: APPOINTMENT_DURATION_MIN,
            maxSlots: MAX_SLOTS,
        });
    } catch (err) {
        console.error('[vapi-tools] checkAvailability error:', err.message);
        return { slots: [], error: err.message };
    }
}

// ─── Tool: recommendSlots ─────────────────────────────────────────────────────

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
 * @param {{ zip?, lat?, lng?, address?, unitType?, durationMinutes?, excludeSlots?, daysAhead? }} args
 */
async function handleRecommendSlots(args = {}) {
    try {
        const { zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead } = args;

        // 1. Gate: don't touch the engine unless the app is connected.
        const connected = await marketplaceService.isAppConnected(
            DEFAULT_COMPANY_ID,
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
            const tz = await slotEngineService.resolveTimezone(DEFAULT_COMPANY_ID);
            const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
            const base = new Date(`${today}T00:00:00Z`);
            base.setUTCDate(base.getUTCDate() + daysAhead);
            newJob.latest_allowed_date = base.toISOString().slice(0, 10);
        }

        // 3. Call the engine directly.
        const { recommendations, engine_status } = await slotEngineService.getRecommendations(
            DEFAULT_COMPANY_ID,
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

// ─── Tool: createLead ─────────────────────────────────────────────────────────

function buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested }) {
    const parts = [
        unitType          && `Unit: ${unitType}`,
        brand             && `Brand: ${brand}`,
        `Age: ${unitAge || 'unknown'}`,
        problemDescription && `Problem: ${problemDescription}`,
        'Fee agreed: Yes',
        `Slot: ${preferredSlot || 'pending callback'}`,
        `Address validated: ${addressValidated ? 'yes' : 'no'}`,
        escalationRequested && 'escalation_requested: true',
    ].filter(Boolean);
    return parts.join(' | ');
}

async function handleCreateLead(args) {
    const {
        firstName, lastName, phone, email,
        street, apt, zip, city, state,
        unitType, brand, unitAge, problemDescription,
        preferredSlot, addressValidated, escalationRequested,
        disqualified, disqualReason,
        callerName,
        chosenSlot, lat, lng,
    } = args;

    // Disqualified leads (out-of-area / unsupported appliance) are logged for
    // lead-gen refund tracking even without full contact details — the call
    // transcript is the evidence. Valid leads still require a phone number.
    if (!disqualified && (!phone || phone.length < 5)) {
        return { success: false, error: 'Phone number is required to create lead' };
    }

    const summary = buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested });
    const body = {
        FirstName: firstName || callerName?.split(' ')[0] || 'Unknown',
        LastName:  lastName  || callerName?.split(' ').slice(1).join(' ') || 'Caller',
        Phone:     phone || '',
        ...(email && { Email: email }),
        Status:    'Review',
        JobType:   unitType ? `${unitType} Repair` : 'Appliance Repair',
        JobSource: disqualified ? 'AI Phone (Invalid)' : 'AI Phone',
        Comments:  disqualified
            ? `INVALID LEAD — ${disqualReason || 'disqualified'}. ${summary}`.trim()
            : summary,
        ...(street && { Address: street }),
        ...(apt && { Unit: apt }),
        City:      city || '',
        State:     state || '',
        PostalCode: normalizeZip(zip),
    };

    // VAPI-SLOT-ENGINE-001 (Decision D): when the caller picked an engine-offered
    // window, persist it as a schedule-blocking hold on the LEAD — real TIMESTAMPTZ
    // columns (lead_date_time/lead_end_date_time), not just the Comments "Slot:"
    // text. FIELD_MAP maps LeadDateTime/LeadEndDateTime/Latitude/Longitude → columns.
    // Back-compat: no chosenSlot ⇒ none of these four keys are added (columns NULL).
    // Edge 6: malformed chosenSlot ⇒ treated as absent (never block the call).
    if (chosenSlot && /^\d{4}-\d{2}-\d{2}$/.test(String(chosenSlot.date))
        && /^\d{1,2}:\d{2}$/.test(String(chosenSlot.start))
        && /^\d{1,2}:\d{2}$/.test(String(chosenSlot.end))) {
        try {
            const tz = await slotEngineService.resolveTimezone(DEFAULT_COMPANY_ID);
            body.LeadDateTime = slotEngineService.tzCombine(chosenSlot.date, chosenSlot.start, tz);
            body.LeadEndDateTime = slotEngineService.tzCombine(chosenSlot.date, chosenSlot.end, tz);
            // Edge 7: coords optional — write them only when both are finite.
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                body.Latitude = lat;
                body.Longitude = lng;
            }
        } catch (err) {
            // Never let a slot-compose fault block lead creation.
            console.error('[vapi-tools] createLead slot-persist skipped:', err.message);
            delete body.LeadDateTime;
            delete body.LeadEndDateTime;
            delete body.Latitude;
            delete body.Longitude;
        }
    }

    // Attempt with 1 retry on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const lead = await leadsService.createLead(body, DEFAULT_COMPANY_ID);
            return { success: true, leadId: lead?.UUID || lead?.uuid || lead?.id || null };
        } catch (err) {
            console.error(`[vapi-tools] createLead attempt ${attempt} failed:`, err.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { success: false, error: 'Lead creation failed after retry' };
}

// ─── Router ───────────────────────────────────────────────────────────────────

router.post('/', vapiSecretAuth, async (req, res) => {
    try {
        const message = req.body?.message;
        if (!message || message.type !== 'tool-calls') {
            return res.json({});
        }

        const toolCallList = message.toolCallList || [];
        const results = [];

        for (const toolCall of toolCallList) {
            const name = toolCall.function?.name;
            const args = (() => {
                try {
                    return typeof toolCall.function?.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : (toolCall.function?.arguments || {});
                } catch {
                    return {};
                }
            })();

            let result;
            try {
                if (name === 'checkServiceArea') {
                    result = await handleCheckServiceArea(args);
                } else if (name === 'validateAddress') {
                    result = await handleValidateAddress(args);
                } else if (name === 'checkAvailability') {
                    result = await handleCheckAvailability(args);
                } else if (name === 'recommendSlots') {
                    result = await handleRecommendSlots(args);
                } else if (name === 'createLead') {
                    result = await handleCreateLead(args);
                } else {
                    result = { error: `Unknown tool: ${name}` };
                }
            } catch (err) {
                console.error(`[vapi-tools] Tool "${name}" unhandled error:`, err.message);
                result = { error: err.message };
            }

            results.push({
                toolCallId: toolCall.id,
                result: JSON.stringify(result),
            });
        }

        res.json({ results });
    } catch (err) {
        console.error('[vapi-tools] Handler error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
