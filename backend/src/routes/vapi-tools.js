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
 *   - validateAddress({ street, apt, ... })  — Google Maps Geocoding (uses VITE_GOOGLE_MAPS_API_KEY)
 *   - checkAvailability({ zip, unitType })   — Blanc scheduleService.getAvailableSlots (dispatch_settings + booked items)
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

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const AVAILABILITY_DAYS = 5;
const APPOINTMENT_DURATION_MIN = 120;
const MAX_SLOTS = 3;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function vapiSecretAuth(req, res, next) {
    const secret = process.env.VAPI_TOOLS_SECRET;
    if (!secret) {
        console.warn('[vapi-tools] VAPI_TOOLS_SECRET not set — skipping auth (dev mode)');
        return next();
    }
    const header = req.headers['x-vapi-secret'];
    if (header !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Tool: checkServiceArea ───────────────────────────────────────────────────

async function handleCheckServiceArea({ zip }) {
    if (!zip) return { inServiceArea: false, error: 'zip is required' };

    const row = await stQueries.search(DEFAULT_COMPANY_ID, String(zip).trim());
    if (!row) return { inServiceArea: false };

    return {
        inServiceArea: true,
        area: row.area || '',
        city: row.city || '',
        state: row.state || '',
        zip: row.zip || zip,
    };
}

// ─── Tool: validateAddress ────────────────────────────────────────────────────

async function handleValidateAddress({ street, apt, city, state, zip }) {
    const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[vapi-tools] VITE_GOOGLE_MAPS_API_KEY not set — address validation skipped');
        return { valid: false, error: 'VITE_GOOGLE_MAPS_API_KEY not configured' };
    }

    try {
        const parts = [street, apt, city, state, zip].filter(Boolean);
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
        const correctedZip = postalComponent?.short_name || zip || '';

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
        zip, city, state,
        unitType, brand, unitAge, problemDescription,
        preferredSlot, addressValidated, escalationRequested,
        callerName,
    } = args;

    if (!phone || phone.length < 5) {
        return { success: false, error: 'Phone number is required to create lead' };
    }

    const body = {
        FirstName: firstName || callerName?.split(' ')[0] || 'Unknown',
        LastName:  lastName  || callerName?.split(' ').slice(1).join(' ') || 'Caller',
        Phone:     phone,
        ...(email && { Email: email }),
        JobType:   unitType ? `${unitType} Repair` : 'Appliance Repair',
        JobSource: 'AI Phone',
        Comments:  buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested }),
        City:      city || '',
        State:     state || '',
        PostalCode: zip || '',
    };

    // Attempt with 1 retry on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const lead = await leadsService.createLead(body, DEFAULT_COMPANY_ID);
            return { success: true, leadId: lead?.uuid || lead?.id || null };
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
